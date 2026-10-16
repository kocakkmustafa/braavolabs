/**
 * Tenant cascade orchestration (Forge P1 — wiring `lib/cascade.ts`'s pure
 * triage-first orchestrator to a REAL provider call path).
 *
 * `lib/cascade.ts#runCascade` is fully unit-tested but deliberately takes an
 * INJECTED runner — it never dials a provider itself. This file is the
 * wiring layer: it builds the tenant's own `ModelSpec[]` (from their
 * configured BYOK providers — never trial/system keys, same tenant-
 * isolation contract as `services/multi-model.ts#compareAcrossModels`) and a
 * `CascadeRunner` that dials each candidate through
 * `runAgentLoop({ aiConfigOverride })` (T5/D-010 — forces the REAL
 * provider×model the candidate claims, skipping tenant/trial resolution),
 * exactly the pattern `compareAcrossModels` already uses for its candidate
 * phase.
 *
 * Model set: one ModelSpec per tenant-configured provider row
 * (`services/provider-chain.ts#listTenantProviderLinks` — already
 * `WHERE tenantId`-scoped, so cross-tenant key leakage is structurally
 * impossible). Tier comes from the shared `lib/routing.ts#deriveTier`
 * (also used by `modules/billing/savings.service.ts`) so the frontier/
 * cheap/local boundary is defined exactly once. Capabilities are kept
 * deliberately flat (every candidate tagged `"chat"`) — this is a
 * general-purpose prompt cascade, not capability-gated tool routing.
 *
 * ─── Confidence signal (v1 — deterministic heuristic) ───────────────
 * `lib/cascade.ts`'s runner contract only requires a confidence in [0,1];
 * HOW it's produced is this wiring layer's choice. v1 does NOT ask the
 * model to self-report — it scores the completion deterministically from
 * signals `runAgentLoop` already returns for free:
 *   • empty answer                              → 0.0
 *   • truncated (last turn stopReason "max_tokens") → 0.2 (can't trust a
 *     cut-off answer regardless of what's visible)
 *   • refusal / uncertainty phrasing detected     → 0.15
 *   • answer shorter than MIN_CONFIDENT_LENGTH    → 0.35 (too thin to trust,
 *     but not a refusal)
 *   • otherwise (complete, no refusal signal, adequate length) → 0.9
 * This is intentionally coarse and over-escalates on borderline cases
 * (cheap/false-negative is the safe failure direction for a cost-routing
 * feature — worst case we pay for a redundant frontier call, never worse
 * than that).
 *
 * ─── v2 hybrid (self-report ∧ heuristic) ────────────────────────────
 * The candidate is now asked to emit `{answer, confidence}` JSON, so the
 * model SELF-REPORTS. But self-report alone is gameable (a wrong-but-sure
 * model reports 0.9), so the final confidence is `min(structural, self)`:
 * the structural heuristic (empty/truncated/refusal/too-short) is a CEILING
 * a model cannot inflate past, and the self-report can only LOWER confidence
 * within a structurally-clean answer (finer routing — a complete-but-unsure
 * answer still escalates). Graceful: a non-JSON reply falls back to the raw
 * answer + heuristic-only. See `parseCascadeCandidate` + the runner.
 *
 * Failure handling: a per-candidate dial failure (network error, revoked
 * key, rate limit) is NOT caught here — it propagates out of `runCascade`
 * and the whole cascade call fails. Silently degrading a dial failure into
 * "confidence 0, cost 0" would let a broken cheap-tier key masquerade as a
 * legitimate low-confidence answer instead of surfacing the real error; the
 * router below turns it into a normal error response.
 */

import { runAgentLoop } from "../agent/claude";
import { AppError } from "../../middleware/error";
import { listTenantProviderLinks, type ProviderChainLink } from "../../services/provider-chain";
import { resolveModelSelections, type ModelSelection } from "../../services/multi-model";
import {
  runCascade,
  type CascadeOptions,
  type CascadeRunner,
} from "../../lib/cascade";
import {
  modelSpecFromPricing,
  deriveTier,
  type ModelSpec,
  type RouteRequest,
} from "../../lib/routing";

/** Toolless, single-turn candidate call. Asks for a STRICT JSON envelope so the
 * model can SELF-REPORT its confidence (v2 hybrid — see header). Graceful: a
 * model that emits prose instead of JSON still works (raw text becomes the
 * answer, confidence falls back to the structural heuristic). */
const CASCADE_SYSTEM_PROMPT =
  "Answer the user's request directly and completely. Respond with STRICT JSON: " +
  '{"answer": string, "confidence": number} where "confidence" is your own honest ' +
  "0..1 estimate that your answer is correct and complete — use a LOW value if you " +
  "are unsure or lack information; do NOT guess high. Output ONLY the JSON object.";

/** Clamp any number-ish input into [0,1]; non-finite → undefined (no self-report). */
function clamp01(n: unknown): number | undefined {
  const v = Number(n);
  if (!Number.isFinite(v)) return undefined;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Extract the answer + optional self-reported confidence from a candidate's
 * completion. Tolerates a ```json fence and leading/trailing prose. When the
 * reply isn't a valid `{answer, confidence}` envelope, the WHOLE raw content is
 * the answer and there is no self-report (caller uses the heuristic only).
 */
export function parseCascadeCandidate(content: string): { answer: string; selfConfidence?: number } {
  const raw = content.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(raw);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      const obj = JSON.parse(candidate.slice(start, end + 1));
      if (obj && typeof obj.answer === "string") {
        return { answer: obj.answer, selfConfidence: clamp01(obj.confidence) };
      }
    } catch {
      // fall through to raw
    }
  }
  return { answer: content };
}

/** Per-attempt output-token cap — bounds each cascade rung's spend
 * structurally, same role as multi-model's DEFAULT_MAX_TOKENS_PER_CANDIDATE. */
const DEFAULT_MAX_TOKENS_PER_ATTEMPT = 1024;

/** Below this many characters a non-empty, non-refusing answer is still
 * treated as too thin to trust outright. */
const MIN_CONFIDENT_LENGTH = 40;

/** Deterministic-heuristic confidence buckets (see file header). */
const CONFIDENCE_EMPTY = 0;
const CONFIDENCE_REFUSAL = 0.15;
const CONFIDENCE_TRUNCATED = 0.2;
const CONFIDENCE_TOO_SHORT = 0.35;
const CONFIDENCE_COMPLETE = 0.9;

/** Common refusal / uncertainty phrasing across providers. Deliberately
 * conservative — false positives here just cost one extra escalation. */
const REFUSAL_PATTERNS: RegExp[] = [
  /\bi'?m not sure\b/i,
  /\bi am not sure\b/i,
  /\bi don'?t know\b/i,
  /\bi do not know\b/i,
  /\bi can'?t\b/i,
  /\bi cannot\b/i,
  /\bi'?m unable to\b/i,
  /\bi am unable to\b/i,
  /\bunable to (?:answer|determine|verify|help)\b/i,
  /\binsufficient (?:information|data|context)\b/i,
  /\bnot enough (?:information|data|context)\b/i,
  /\bno (?:way|information|data) to know\b/i,
  /\bas an ai\b/i,
];

/**
 * Score a completed candidate answer in [0,1]. See the file header for the
 * bucket rationale — this is the ONLY place the heuristic lives, so a
 * future self-report swap touches just this function.
 */
export function computeHeuristicConfidence(
  answer: string,
  lastTurnStopReason: string | undefined,
): number {
  const trimmed = answer.trim();
  if (trimmed.length === 0) return CONFIDENCE_EMPTY;
  // A cut-off completion can't be trusted regardless of what's visible —
  // check before the refusal/length buckets so a truncated-but-otherwise-
  // clean-looking answer still degrades.
  if (lastTurnStopReason === "max_tokens") return CONFIDENCE_TRUNCATED;
  if (REFUSAL_PATTERNS.some((re) => re.test(trimmed))) return CONFIDENCE_REFUSAL;
  if (trimmed.length < MIN_CONFIDENT_LENGTH) return CONFIDENCE_TOO_SHORT;
  return CONFIDENCE_COMPLETE;
}

export interface TenantCascadeOptions {
  /** Escalate while confidence < this. Default (lib/cascade.ts): 0.7. */
  confidenceThreshold?: number;
  /** Force at least one escalation past the first answer. */
  secondOpinion?: boolean;
  /** Stop further escalation after an attempt reaches this cumulative USD threshold. */
  budgetUsdCap?: number;
  /** Per-attempt output-token cap. Default 1024. */
  maxTokensPerAttempt?: number;
}

export interface TenantCascadeAttempt {
  provider: string;
  model: string;
  tier: string;
  confidence: number;
  costUsd: number;
}

export interface TenantCascadeResult {
  answer: string;
  provider: string;
  model: string;
  tier: string;
  confidence: number;
  escalated: boolean;
  totalCostUsd: number;
  stoppedReason: string;
  rationale: string;
  attempts: TenantCascadeAttempt[];
}

/**
 * Run `prompt` through the tenant's cheapest-capable-first cascade,
 * escalating to a costlier tenant-configured provider only when the
 * cheaper one's answer scores below `confidenceThreshold`.
 *
 * Candidates come EXCLUSIVELY from the tenant's own BYOK rows
 * (listTenantProviderLinks — `WHERE tenantId`) — the same privacy
 * boundary multi-model compare enforces; this never dials a trial or
 * system key on the tenant's behalf.
 *
 * Throws AppError(400) when the tenant has no usable configured provider.
 * A per-candidate dial failure propagates (see file header) — callers
 * should treat it like any other provider error.
 */
export async function runTenantCascade(
  tenantId: string,
  prompt: string,
  opts: TenantCascadeOptions = {},
): Promise<TenantCascadeResult> {
  return runCascadeWithLinks(prompt, await listTenantProviderLinks(tenantId), opts);
}

export interface TenantSelectedCascadeResult extends TenantCascadeResult {
  selection: ModelSelection;
}

/** Re-resolve one exact tenant-owned pair on every call. No Compare, synthesis,
 * failover chain or automatic model substitution is used by this path. */
export async function runTenantSelectedCascade(
  tenantId: string,
  prompt: string,
  selection: ModelSelection,
  opts: TenantCascadeOptions = {},
): Promise<TenantSelectedCascadeResult> {
  if (opts.secondOpinion === true) throw new AppError(400, "Selected cascade does not support a second opinion");
  // The provider runner trims stored model IDs and defaults an empty ID. Reject
  // those configurations here, before inference can reinterpret an exact choice.
  if (!selection.provider || selection.provider.trim() !== selection.provider
      || !selection.model || selection.model.trim() !== selection.model) {
    throw new AppError(400, "Invalid exact model selection");
  }
  const accepted: ModelSelection = {
    provider: selection.provider, model: selection.model,
    ...(selection.reasoningEffort !== undefined ? {reasoningEffort: selection.reasoningEffort} : {}),
  };
  const links = await listTenantProviderLinks(tenantId);
  let selected: ProviderChainLink[];
  try {
    selected = resolveModelSelections(links, [accepted], 1);
  } catch {
    throw new AppError(400, "Model selection is unavailable or unsupported for this tenant");
  }
  const result = await runCascadeWithLinks(prompt, selected, opts, accepted);
  return {...result, selection: accepted};
}

async function runCascadeWithLinks(
  prompt: string,
  links: ProviderChainLink[],
  opts: TenantCascadeOptions,
  selection?: ModelSelection,
): Promise<TenantCascadeResult> {
  if (links.length === 0) {
    throw new AppError(
      400,
      "Cascade requires at least one configured AI provider with a usable key. Add providers in Settings → AI Provider.",
    );
  }

  // One ModelSpec per configured provider row, keyed by model id so the
  // runner below can dial back to the exact link that produced it. When
  // two providers happen to share a model id, the first configured link
  // wins (listTenantProviderLinks' deterministic default-first order) —
  // rare in practice (BYOK model ids are provider-specific strings) and
  // harmless either way (both links are equally "the tenant's own key").
  const linkByModelId = new Map<string, ProviderChainLink>();
  const models: ModelSpec[] = [];
  for (const link of links) {
    const id = link.config.model;
    if (linkByModelId.has(id)) continue;
    linkByModelId.set(id, link);
    models.push(modelSpecFromPricing(id, deriveTier(id), ["chat"]));
  }

  const req: RouteRequest = { taskType: "cascade", requiredCapabilities: ["chat"] };
  const maxTokens = opts.maxTokensPerAttempt ?? DEFAULT_MAX_TOKENS_PER_ATTEMPT;

  const run: CascadeRunner = async (model) => {
    const link = linkByModelId.get(model.id);
    if (!link) {
      // Defensive — every ModelSpec in `models` was built from
      // linkByModelId above, so this can only happen if lib/cascade.ts
      // is ever handed a foreign ModelSpec. Fail loudly rather than
      // silently mis-dialing.
      throw new Error(`cascade: no tenant provider link for model "${model.id}"`);
    }
    const result = await runAgentLoop({
      systemPrompt: CASCADE_SYSTEM_PROMPT,
      userMessage: prompt,
      toolNames: [],
      maxTurns: 1,
      maxTokens,
      // T5/D-010: force the REAL provider×model this rung claims.
      aiConfigOverride: link.config,
      ...(selection ? {rejectToolCalls: true} : {}),
      ...(selection?.reasoningEffort !== undefined ? {reasoningEffort: selection.reasoningEffort} : {}),
    });
    if (selection && (result.provider !== selection.provider || result.model !== selection.model)) {
      throw new AppError(502, "Selected model response identity mismatch");
    }
    const lastTurn = result.turns[result.turns.length - 1];
    const { answer, selfConfidence } = parseCascadeCandidate(result.finalContent);
    // Hybrid confidence (v2): the structural heuristic (empty / truncated /
    // refusal / too-short) is a CEILING a model can't fake past; the model's
    // own self-report can only LOWER confidence within a structurally-clean
    // answer (finer routing — a complete-but-unsure answer still escalates). A
    // model can never inflate above the structural signal.
    const structural = computeHeuristicConfidence(answer, lastTurn?.stopReason);
    const confidence = selfConfidence != null ? Math.min(structural, selfConfidence) : structural;
    return { answer, confidence, costUsd: result.totalCostUsd };
  };

  const cascadeOpts: CascadeOptions = {
    confidenceThreshold: opts.confidenceThreshold,
    secondOpinion: opts.secondOpinion,
    budgetUsdCap: opts.budgetUsdCap,
  };

  const result = await runCascade(req, models, run, cascadeOpts);

  const toAttempt = (a: { model: ModelSpec; confidence: number; costUsd: number }): TenantCascadeAttempt => ({
    provider: linkByModelId.get(a.model.id)?.provider ?? "unknown",
    model: a.model.id,
    tier: a.model.tier,
    confidence: a.confidence,
    costUsd: a.costUsd,
  });

  return {
    answer: result.answer,
    provider: linkByModelId.get(result.model.id)?.provider ?? "unknown",
    model: result.model.id,
    tier: result.model.tier,
    confidence: result.confidence,
    escalated: result.escalated,
    totalCostUsd: result.totalCostUsd,
    stoppedReason: result.stoppedReason,
    rationale: result.rationale,
    attempts: result.attempts.map(toAttempt),
  };
}
