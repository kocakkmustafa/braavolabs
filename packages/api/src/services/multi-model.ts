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

/** Plan §2.5: "≤3 aday" — hard ceiling regardless of options. */
export const MAX_CANDIDATES = 3;
const DEFAULT_MAX_TOKENS_PER_CANDIDATE = 1024;
const DEFAULT_MAX_COST_USD = 1.0;
/** Per-answer slice fed to the synthesizer (bounds the judge prompt). */
const ANSWER_SLICE = 4000;
/** Task snippet embedded in the synthesizer's system prompt. */
const TASK_SLICE = 2000;

export interface ModelCandidateAnswer {
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

export interface MultiModelCompareResult {
  /** Successful candidates, in configured order (default row first). */
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
   * when the synthesis was skipped/failed. */
  finalAnswer: string;
  /** False when the synthesizer's reply couldn't be parsed as strict JSON
   * (raw text fallback) — consumers can badge low-confidence syntheses. */
  synthesisParsed: boolean;
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

export interface CompareOptions {
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
}

/** STRICT-JSON parse with the same resilience ladder as the research
 * distill: direct parse → first {...} block → raw-text fallback. */
export function parseSynthesisReply(raw: string): ParsedSynthesis {
  const attempt = (s: string): Record<string, unknown> | null => {
    try {
      const p = JSON.parse(s);
      return p && typeof p === "object" && !Array.isArray(p)
        ? (p as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  };
  let obj = attempt(raw.trim());
  if (!obj) {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) obj = attempt(match[0]);
  }
  if (!obj) {
    const text = raw.slice(0, ANSWER_SLICE);
    return { synthesis: text, consensus: [], disagreements: [], finalAnswer: text, parsed: false };
  }
  const strArray = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  const finalAnswer =
    typeof obj.finalAnswer === "string" && obj.finalAnswer.trim()
      ? obj.finalAnswer
      : raw.slice(0, ANSWER_SLICE);
  return {
    synthesis: typeof obj.synthesis === "string" ? obj.synthesis : "",
    consensus: strArray(obj.consensus),
    disagreements: strArray(obj.disagreements),
    finalAnswer,
    parsed: true,
  };
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
  const candidates = links.slice(0, maxCandidates);

  // maxCostUsd is the budget for the WHOLE compare (not per candidate). Split it
  // evenly across the candidates so the candidate phase total stays within the
  // documented ceiling — passing the full maxCostUsd to each let the parallel
  // fan-out spend up to N× the budget (audit finding C-LOGIC-budget).
  const perCandidateBudget = candidates.length > 0 ? maxCostUsd / candidates.length : maxCostUsd;

  const settled = await Promise.allSettled(
    candidates.map(async (link) => {
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
      });
      return {
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
  const perModelLinks: typeof candidates = [];
  const failed: ModelCandidateFailure[] = [];
  settled.forEach((s, i) => {
    if (s.status === "fulfilled") {
      perModel.push(s.value);
      perModelLinks.push(candidates[i]);
    } else {
      const message = s.reason instanceof Error ? s.reason.message : String(s.reason);
      failed.push({
        provider: candidates[i].provider,
        model: candidates[i].config.model,
        error: message.slice(0, 300),
      });
      logger.warn(
        { tenantId, provider: candidates[i].provider, err: message.slice(0, 300) },
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
            aiConfigOverride: perModelLinks[idx].config,
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
      finalAnswer: parsed.finalAnswer,
      synthesisParsed: parsed.parsed,
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
      synthesizer: null,
      synthesizerError: message.slice(0, 300),
      totalCostUsd: candidateCost,
      budgetExceeded: false,
      debateRoundsRun,
    };
  }
}
