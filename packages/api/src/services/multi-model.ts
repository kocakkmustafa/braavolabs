/**
 * Multi-model compare-and-synthesize (E2/T8 — plan §2.5).
 *
 * `compareAcrossModels(tenantId, task, opts)` runs ONE toolless,
 * research-style task on up to MAX_CANDIDATES (3) of the tenant's OWN
 * configured providers in parallel (Promise.allSettled — a failed candidate
 * drops out of the result, it never fails the compare; only ALL candidates
 * failing does), then asks the tenant's DEFAULT provider to synthesize:
 * compare the answers, extract consensus + disagreements, and produce a
 * final merged answer (the STRICT-JSON distill pattern adapted from
 * research.service.ts).
 *
 * Key rulings honoured here:
 *   • Candidates come exclusively from the tenant's BYOK rows
 *     (listTenantProviderLinks) — never trial/system keys. Privacy rule
 *     §2.2 applies to compare mode too: user data only goes to providers
 *     the tenant explicitly configured.
 *   • Candidates dial through runAgentLoop({ aiConfigOverride }) (T5/D-010)
 *     so each one REALLY hits the provider it claims to measure, with the
 *     §2.4 model hierarchy and real per-model pricing (§2.6) applied.
 *   • The synthesizer runs through runAgentLoop({ tenantId }) — the
 *     tenant-default chain (T7), failover included.
 *   • Cost = sum of the candidates' REAL metered cost + the synthesizer's,
 *     reported in totalCostUsd so callers count it against the run budget
 *     (rule #8). Per-candidate maxTokens bounds each candidate's spend
 *     structurally; when the candidate phase alone reaches maxCostUsd the
 *     synthesis call is SKIPPED (budgetExceeded) instead of digging deeper.
 *
 * Surface (plan T8): research module — POST /api/v1/research/compare and
 * the `multiModel:true` research option (research.service.ts). Deliberately
 * NOT an agent-registry tool: the plan's T8 file list does not touch
 * registry.ts.
 */

import { logger } from "../lib/logger";
import { runAgentLoop } from "../modules/agent/claude";
import { listTenantProviderLinks } from "./provider-chain";
import type { AIProviderType } from "./ai-client";
import { assertReasoningEffortSupported, type ReasoningEffort } from "./reasoning-effort";

/** Plan §2.5: "≤3 aday" — hard ceiling regardless of options. */
export const MAX_CANDIDATES = 3;
const DEFAULT_MAX_TOKENS_PER_CANDIDATE = 1024;
const DEFAULT_MAX_COST_USD = 1.0;
/** Per-answer slice fed to the synthesizer (bounds the judge prompt). */
const ANSWER_SLICE = 4000;
/** Task snippet embedded in the synthesizer's system prompt. */
const TASK_SLICE = 2000;

export interface ModelCandidateAnswer {
  /** Submitted control, when explicit; no claim about measured hidden reasoning. */
  reasoningEffort?: ReasoningEffort;
  provider: AIProviderType;
  model: string;
  answer: string;
  tokens: { input: number; output: number };
  costUsd: number;
  durationMs: number;
}

export interface ModelCandidateFailure {
  provider: AIProviderType;
  model: string;
  error: string;
}

export type SynthesisStatus = "structured" | "plain_text" | "invalid_structured" | "unavailable" | "budget_skipped";

export interface MultiModelCompareResult {
  /** Successful candidates, in the selected or automatic configured order. */
  perModel: ModelCandidateAnswer[];
  /** Candidates that errored — recorded, never fatal (allSettled). */
  failed: ModelCandidateFailure[];
  /** Short comparison narrative from the synthesizer. */
  synthesis: string;
  /** Claims the candidate answers agree on. */
  consensus: string[];
  /** Points where the answers diverge (0-based answer indices). */
  disagreements: string[];
  /** Best merged answer — falls back to the synthesizer's raw text when
   * its reply wasn't parseable JSON, and to the first candidate's answer
   * when synthesis was skipped, unavailable or invalid structured output. */
  finalAnswer: string;
  /** False when the synthesizer's reply couldn't be parsed as strict JSON
   * (raw text fallback) — consumers can badge low-confidence syntheses. */
  synthesisParsed: boolean;
  /** Explicit format/outcome; malformed structured replies are never plain-text success. */
  synthesisStatus: SynthesisStatus;
  /** What actually judged (post-hierarchy provider/model), null when the
   * synthesis was skipped (budget) or failed. */
  synthesizer: {
    provider?: AIProviderType;
    model?: string;
    costUsd: number;
    durationMs: number;
  } | null;
  /** Non-fatal synthesizer failure detail (candidates still returned). */
  synthesizerError?: string;
  /** Candidates + synthesizer, real metered prices (§2.6). Callers count
   * this against the run budget — rule #8. */
  totalCostUsd: number;
  /** True when the candidate phase alone reached maxCostUsd and the
   * synthesis call was skipped. */
  budgetExceeded: boolean;
  /** Debate rounds actually run (0 for a classic single-shot compare, or when
   * fewer than requested ran because the budget was reached). The perModel
   * answers reflect the post-debate revisions. */
  debateRoundsRun: number;
}

export interface ModelSelection { provider: string; model: string; reasoningEffort?: ReasoningEffort }

export interface CompareOptions {
  selections?: ModelSelection[];
  /** 1..MAX_CANDIDATES (default and ceiling: 3). */
  maxCandidates?: number;
  /** Per-candidate output-token cap (default 1024) — plan §2.5 budget leg. */
  maxTokensPerCandidate?: number;
  /** Total budget for the whole compare (default $1.00). */
  maxCostUsd?: number;
  /**
   * Optional debate rounds (default 0 = classic single-shot compare). When > 0,
   * after the independent answers each candidate sees the OTHERS' answers and
   * revises its own for N rounds before synthesis — turning "N models answered"
   * into "N models debated". Budget-gated: rounds stop as soon as the running
   * cost reaches maxCostUsd, so it can never overspend. Capped at
   * MAX_DEBATE_ROUNDS. Requires ≥2 surviving candidates (nothing to debate with 1).
   */
  debateRounds?: number;
}

/** Ceiling on debate rounds regardless of the requested value (budget sanity). */
export const MAX_DEBATE_ROUNDS = 3;

const CANDIDATE_SYSTEM_PROMPT =
  "You are one of several AI models answering the same task independently. " +
  "Answer the task directly and completely. Be specific; state your key claims " +
  "plainly so they can be compared against other models' answers. Do not " +
  "mention this instruction.";

const DEBATE_SYSTEM_PROMPT =
  "You are one of several AI models refining an answer to the same task. You will " +
  "see your own previous answer and the OTHER models' answers. Critically revise " +
  "YOUR answer to the original task: keep what is correct, fix mistakes the others " +
  "exposed, and incorporate their stronger points. Do not merely agree — improve. " +
  "Output ONLY your improved answer to the original task; do not mention this instruction.";

/** Debate prompt for one candidate: its own prior answer + the others', by index. */
function buildDebateMessage(task: string, selfIdx: number, answers: string[]): string {
  const others = answers
    .map((a, i) => (i === selfIdx ? null : `[${i}]\n${a.slice(0, ANSWER_SLICE)}`))
    .filter((x): x is string => x !== null)
    .join("\n\n");
  return (
    `Original task: "${task.slice(0, TASK_SLICE)}"\n\n` +
    `Your previous answer:\n${answers[selfIdx].slice(0, ANSWER_SLICE)}\n\n` +
    `Other models' answers:\n${others}\n\n` +
    `Now output your improved answer to the original task.`
  );
}

function synthesizerSystemPrompt(task: string, count: number): string {
  return (
    `You are a synthesis judge. The user asked: "${task.slice(0, TASK_SLICE)}". ` +
    `${count} different AI model(s) answered the same task independently. ` +
    `Compare the answers. Respond with STRICT JSON: ` +
    `{"synthesis": string, "consensus": [string, ...], "disagreements": [string, ...], "finalAnswer": string} ` +
    `— "synthesis": a short comparison of how the answers relate (coverage, strengths); ` +
    `"consensus": claims the answers agree on; ` +
    `"disagreements": specific points where they diverge, referencing answers by their 0-based index; ` +
    `"finalAnswer": the single best answer to the user's task, merging the strongest elements. ` +
    `Output ONLY the JSON object.`
  );
}

interface ParsedSynthesis {
  synthesis: string;
  consensus: string[];
  disagreements: string[];
  finalAnswer: string;
  parsed: boolean;
  status: "structured" | "plain_text" | "invalid_structured";
  error?: string;
}

/** Find outer containers only; a broken parent never exposes its children. */
function replyContainers(raw: string, unquoted: string) {
  const containers: Array<{ start: number; text: string; malformed: boolean }> = [];
  const stack: string[] = [];
  let start = 0;
  let unmatchedClosing = false;
  for (let index = 0; index < unquoted.length; index++) {
    const token = unquoted[index];
    if (token === "{" || token === "[") {
      if (!stack.length) start = index;
      stack.push(token);
    } else if (token === "}" || token === "]") {
      if (!stack.length) { unmatchedClosing = true; continue; }
      if (stack.at(-1) !== (token === "}" ? "{" : "[")) {
        containers.push({ start, text: raw.slice(start), malformed: true });
        return { containers, unmatchedClosing: true };
      }
      stack.pop();
      if (!stack.length) containers.push({ start, text: raw.slice(start, index + 1), malformed: false });
    }
  }
  if (stack.length) containers.push({ start, text: raw.slice(start), malformed: true });
  return { containers, unmatchedClosing };
}

/** Validate JSON/fenced JSON as the full structured contract. Ordinary prose
 * remains an explicit text result; JSON-like malformed output never becomes it. */
export function parseSynthesisReply(raw: string): ParsedSynthesis {
  const invalid = (reason: string): ParsedSynthesis => ({
    synthesis: "", consensus: [], disagreements: [], finalAnswer: "", parsed: false,
    status: "invalid_structured", error: `Invalid structured synthesis: ${reason}`,
  });
  const trimmed = raw.trim();
  const plainText = (): ParsedSynthesis => {
    const text = raw.slice(0, ANSWER_SLICE);
    return { synthesis: text, consensus: [], disagreements: [], finalAnswer: text, parsed: false, status: "plain_text" };
  };
  const structuredPrefix = /^\{/.test(trimmed) || /^```json(?:\s|$)/i.test(trimmed) ||
    /^```\s*[\[{]/.test(trimmed);
  const fieldPattern = /["'](?:synthesis|consensus|disagreements|finalAnswer)["']\s*:/;
  const ownsContractField = (candidate: unknown): boolean => !!candidate && typeof candidate === "object" &&
    !Array.isArray(candidate) && ["synthesis", "consensus", "disagreements", "finalAnswer"].some(name => Object.hasOwn(candidate, name));
  const containsFullContract = (candidate: unknown): boolean => {
    const pending = [candidate];
    while (pending.length) {
      const item = pending.pop();
      if (!item || typeof item !== "object") continue;
      if (!Array.isArray(item) && ["synthesis", "consensus", "disagreements", "finalAnswer"].every(name => Object.hasOwn(item, name))) return true;
      for (const child of Object.values(item)) pending.push(child);
    }
    return false;
  };
  const intendedContainer = (candidate: unknown): boolean => ownsContractField(candidate) ||
    (Array.isArray(candidate) && candidate.some(ownsContractField)) || containsFullContract(candidate);
  let value: unknown;
  let decoded = false;
  let fence: RegExpMatchArray | undefined;
  let unquoted = "";
  // Decode complete JSON first: code fences inside an answer string are data.
  try { value = JSON.parse(trimmed); decoded = true; } catch { /* try fenced/wrapped synthesis */ }
  if (!decoded) {
    // Backticks inside JSON strings are data. Mask strings without changing
    // offsets, then recover each complete fence body from the original reply.
    unquoted = trimmed.replace(/"(?:\\.|[^"\\])*"/g, match => " ".repeat(match.length));
    const fences = [...unquoted.matchAll(/```(?:json)?\s*([\s\S]*?)(```|$)/gi)]
      .map(match => {
        const bodyStart = match.index! + match[0].length - match[1].length - match[2].length;
        match[1] = trimmed.slice(bodyStart, bodyStart + match[1].length);
        return match;
      })
      .filter(match => /^```json(?:\s|$)/i.test(match[0]) || /^[\[{]/.test(match[1].trim()));
    if (fences.length) {
      const intended = structuredPrefix || fences.some(match => {
        try { return intendedContainer(JSON.parse(match[1])); } catch { return fieldPattern.test(match[1]); }
      });
      if (!intended) return plainText();
      if (fences.length !== 1 || (unquoted.match(/```/g)?.length ?? 0) > 2) return invalid("multiple JSON fences");
      fence = fences[0];
      if (!fence[2]) return invalid("unclosed JSON fence");
      // Surrounding prose never licenses extracting an object from an array.
      try { value = JSON.parse(fence[1]); decoded = true; } catch { return invalid("malformed JSON"); }
    }
  }
  if (!decoded) {
    const scan = replyContainers(trimmed, unquoted);
    const attempts: Array<{ value: unknown; decoded: boolean }> = [];
    for (const container of scan.containers) {
      let embedded: unknown;
      let parsed = false;
      if (!container.malformed) {
        try { embedded = JSON.parse(container.text); parsed = true; } catch { /* classify malformed intent */ }
      }
      const rootArray = container.start === 0 && Array.isArray(embedded) && embedded.some(item => item && typeof item === "object");
      const intended = parsed ? intendedContainer(embedded) : fieldPattern.test(container.text);
      if ((structuredPrefix && container.start === 0) || rootArray || intended) attempts.push({ value: embedded, decoded: parsed });
    }
    if (attempts.length > 1) return invalid("multiple JSON containers");
    if (!attempts.length) return structuredPrefix ? invalid("malformed JSON") : plainText();
    if (scan.unmatchedClosing || !attempts[0].decoded) return invalid("malformed JSON container");
    value = attempts[0].value; decoded = true;
  }
  // A bare numeric/text scalar can be an ordinary answer (for example "42").
  // Successfully decoded containers still require the full object contract.
  if (!value || typeof value !== "object") return fence ? invalid("expected an object") : plainText();
  if (Array.isArray(value)) return invalid("expected an object");
  const obj = value as Record<string, unknown>;
  if (typeof obj.synthesis !== "string") return invalid("synthesis must be a string");
  if (typeof obj.finalAnswer !== "string" || !obj.finalAnswer.trim()) return invalid("finalAnswer must be a nonempty string");
  for (const name of ["consensus", "disagreements"] as const) {
    if (!Array.isArray(obj[name]) || !(obj[name] as unknown[]).every(item => typeof item === "string")) {
      return invalid(`${name} must be an array of strings`);
    }
  }
  return {
    synthesis: obj.synthesis, consensus: obj.consensus as string[], disagreements: obj.disagreements as string[],
    finalAnswer: obj.finalAnswer, parsed: true, status: "structured",
  };
}

/** Resolve only exact tenant-owned pairs; never fall back for explicit requests. */
export function resolveModelSelections(
  links: Awaited<ReturnType<typeof listTenantProviderLinks>>,
  selections: ModelSelection[] | undefined,
  maxCandidates = MAX_CANDIDATES,
) {
  if (selections === undefined) return links.slice(0, maxCandidates);
  if (!Array.isArray(selections) || selections.length < 1 || selections.length > MAX_CANDIDATES
      || selections.length > maxCandidates) throw new Error("Select between 1 and 3 models within maxCandidates");
  const seen = new Set<string>();
  return selections.map(selection => {
    if (!selection || typeof selection.provider !== "string" || typeof selection.model !== "string"
        || !selection.provider || !selection.model) throw new Error("Invalid model selection");
    const key = JSON.stringify([selection.provider, selection.model]);
    if (seen.has(key)) throw new Error("Duplicate model selection");
    seen.add(key);
    const matches = links.filter(link => link.provider === selection.provider && link.config.model === selection.model);
    if (matches.length !== 1) throw new Error("Model selection is unavailable or ambiguous for this tenant");
    assertReasoningEffortSupported(matches[0]!.config, selection.reasoningEffort);
    return matches[0]!;
  });
}

export async function validateModelSelections(tenantId: string, selections: ModelSelection[], maxCandidates?: number) {
  resolveModelSelections(await listTenantProviderLinks(tenantId), selections, maxCandidates);
}

/**
 * Run `task` on ≤3 of the tenant's configured providers in parallel and
 * synthesize the answers with the tenant's default provider.
 *
 * Throws only when the tenant has no usable configured provider or when
 * EVERY candidate failed — partial failure returns partial results
 * (plan T8: "kısmi hata = kısmi sonuç, run FAIL olmaz").
 */
export async function compareAcrossModels(
  tenantId: string,
  task: string,
  opts: CompareOptions = {},
): Promise<MultiModelCompareResult> {
  const maxCandidates = Math.min(
    MAX_CANDIDATES,
    Math.max(1, Math.floor(opts.maxCandidates ?? MAX_CANDIDATES)),
  );
  const maxTokensPerCandidate = opts.maxTokensPerCandidate ?? DEFAULT_MAX_TOKENS_PER_CANDIDATE;
  const maxCostUsd = opts.maxCostUsd ?? DEFAULT_MAX_COST_USD;

  const links = await listTenantProviderLinks(tenantId);
  if (links.length === 0) {
    throw new Error(
      "Multi-model compare requires at least one configured AI provider with a usable key. Add providers in Settings → AI Provider.",
    );
  }
  // Keep each option beside its resolved link through failure filtering and debate.
  const candidates = resolveModelSelections(links, opts.selections, maxCandidates).map((link, i) => ({
    link, ...(opts.selections?.[i].reasoningEffort !== undefined
      ? { reasoningEffort: opts.selections[i].reasoningEffort } : {}),
  }));

  // maxCostUsd is the budget for the WHOLE compare (not per candidate). Split it
  // evenly across the candidates so the candidate phase total stays within the
  // documented ceiling — passing the full maxCostUsd to each let the parallel
  // fan-out spend up to N× the budget (audit finding C-LOGIC-budget).
  const perCandidateBudget = candidates.length > 0 ? maxCostUsd / candidates.length : maxCostUsd;

  const settled = await Promise.allSettled(
    candidates.map(async ({link, reasoningEffort}) => {
      const start = Date.now();
      const result = await runAgentLoop({
        systemPrompt: CANDIDATE_SYSTEM_PROMPT,
        userMessage: task,
        toolNames: [], // toolless, research-style single task (plan §2.5)
        maxTurns: 1,
        maxTokens: maxTokensPerCandidate,
        budgetUsd: perCandidateBudget,
        // T5/D-010: force the REAL provider×model this candidate claims —
        // skips tenant resolution, trial and local-CLI mode.
        aiConfigOverride: link.config,
        ...(reasoningEffort !== undefined ? {reasoningEffort} : {}),
      });
      return {
        ...(reasoningEffort !== undefined ? {reasoningEffort} : {}),
        provider: result.provider ?? link.provider,
        model: result.model ?? link.config.model,
        answer: result.finalContent,
        tokens: { input: result.totalInputTokens, output: result.totalOutputTokens },
        costUsd: result.totalCostUsd,
        durationMs: Date.now() - start,
      } satisfies ModelCandidateAnswer;
    }),
  );

  const perModel: ModelCandidateAnswer[] = [];
  // Parallel to perModel: the provider link for each surviving candidate, so a
  // debate round can re-dispatch on the SAME provider×model (aiConfigOverride).
  const perModelCandidates: typeof candidates = [];
  const failed: ModelCandidateFailure[] = [];
  settled.forEach((s, i) => {
    if (s.status === "fulfilled") {
      perModel.push(s.value);
      perModelCandidates.push(candidates[i]);
    } else {
      const message = s.reason instanceof Error ? s.reason.message : String(s.reason);
      failed.push({
        provider: candidates[i].link.provider,
        model: candidates[i].link.config.model,
        error: message.slice(0, 300),
      });
      logger.warn(
        { tenantId, provider: candidates[i].link.provider, err: message.slice(0, 300) },
        "Multi-model candidate failed — dropped from the compare (allSettled)",
      );
    }
  });

  if (perModel.length === 0) {
    throw new Error(
      `All ${candidates.length} candidate provider(s) failed in multi-model compare: ` +
        failed.map((f) => `${f.provider}/${f.model} (${f.error})`).join("; "),
    );
  }

  // ── Optional debate rounds (opt-in) ──────────────────────────────────────
  // Each surviving candidate revises its answer after seeing the others'. Runs
  // in parallel per round; a failed revision keeps the prior answer. Strictly
  // budget-gated: stop before a round if the running cost already reached
  // maxCostUsd, and bound each round's per-candidate budget to what's left.
  const requestedRounds = Math.max(0, Math.min(MAX_DEBATE_ROUNDS, Math.floor(opts.debateRounds ?? 0)));
  let debateRoundsRun = 0;
  if (requestedRounds > 0 && perModel.length >= 2) {
    for (let round = 0; round < requestedRounds; round++) {
      const spent = perModel.reduce((s, c) => s + c.costUsd, 0);
      const remaining = maxCostUsd - spent;
      if (remaining <= 0) break; // budget reached → stop debating
      const roundBudget = remaining / perModel.length;
      const answersSnapshot = perModel.map((c) => c.answer); // all debate the same round-state

      const revised = await Promise.allSettled(
        perModel.map(async (_cand, idx) => {
          const start = Date.now();
          const r = await runAgentLoop({
            systemPrompt: DEBATE_SYSTEM_PROMPT,
            userMessage: buildDebateMessage(task, idx, answersSnapshot),
            toolNames: [],
            maxTurns: 1,
            maxTokens: maxTokensPerCandidate,
            budgetUsd: roundBudget,
            aiConfigOverride: perModelCandidates[idx].link.config,
            ...(perModelCandidates[idx].reasoningEffort !== undefined
              ? {reasoningEffort: perModelCandidates[idx].reasoningEffort} : {}),
          });
          return {
            idx,
            answer: r.finalContent,
            costUsd: r.totalCostUsd,
            input: r.totalInputTokens,
            output: r.totalOutputTokens,
            durationMs: Date.now() - start,
          };
        }),
      );

      revised.forEach((rr) => {
        if (rr.status !== "fulfilled") return; // failed revision → keep prior answer
        const c = perModel[rr.value.idx];
        c.answer = rr.value.answer;
        c.costUsd += rr.value.costUsd;
        c.tokens.input += rr.value.input;
        c.tokens.output += rr.value.output;
        c.durationMs += rr.value.durationMs;
      });
      debateRoundsRun++;
    }
  }

  const candidateCost = perModel.reduce((s, c) => s + c.costUsd, 0);

  // Rule #8 total check (plan §2.5 budget leg): the candidate phase alone
  // exhausted the budget → do NOT dig deeper with a synthesis call.
  if (candidateCost >= maxCostUsd) {
    logger.warn(
      { tenantId, candidateCost, maxCostUsd },
      "Multi-model compare budget exhausted by the candidate phase — skipping synthesis",
    );
    return {
      perModel,
      failed,
      synthesis: "",
      consensus: [],
      disagreements: [],
      finalAnswer: perModel[0].answer,
      synthesisParsed: false,
      synthesisStatus: "budget_skipped",
      synthesizer: null,
      totalCostUsd: candidateCost,
      budgetExceeded: true,
      debateRoundsRun,
    };
  }

  // Synthesizer = the tenant's DEFAULT provider: tenantId resolution walks
  // the T7 chain (default row head, failover included).
  const judgeInput = perModel
    .map((c, i) => `[${i}] ${c.provider} ${c.model}\n${c.answer.slice(0, ANSWER_SLICE)}`)
    .join("\n\n---\n\n");

  const synthStart = Date.now();
  try {
    const synth = await runAgentLoop({
      systemPrompt: synthesizerSystemPrompt(task, perModel.length),
      userMessage: judgeInput,
      toolNames: [],
      maxTurns: 1,
      budgetUsd: Math.max(0.01, maxCostUsd - candidateCost),
      tenantId,
    });
    const parsed = parseSynthesisReply(synth.finalContent);
    return {
      perModel,
      failed,
      synthesis: parsed.synthesis,
      consensus: parsed.consensus,
      disagreements: parsed.disagreements,
      finalAnswer: parsed.status === "invalid_structured" ? perModel[0].answer : parsed.finalAnswer,
      synthesisParsed: parsed.parsed,
      synthesisStatus: parsed.status,
      ...(parsed.error ? { synthesizerError: parsed.error } : {}),
      synthesizer: {
        provider: synth.provider,
        model: synth.model,
        costUsd: synth.totalCostUsd,
        durationMs: Date.now() - synthStart,
      },
      totalCostUsd: candidateCost + synth.totalCostUsd,
      budgetExceeded: false,
      debateRoundsRun,
    };
  } catch (err) {
    // Candidate answers are already paid for — a dead synthesizer degrades
    // the result instead of discarding it.
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      { tenantId, err: message.slice(0, 300) },
      "Multi-model synthesizer failed — returning candidates without a synthesis (non-fatal)",
    );
    return {
      perModel,
      failed,
      synthesis: "",
      consensus: [],
      disagreements: [],
      finalAnswer: perModel[0].answer,
      synthesisParsed: false,
      synthesisStatus: "unavailable",
      synthesizer: null,
      synthesizerError: message.slice(0, 300),
      totalCostUsd: candidateCost,
      budgetExceeded: false,
      debateRoundsRun,
    };
  }
}
