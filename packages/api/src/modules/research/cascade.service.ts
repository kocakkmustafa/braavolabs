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
 * than that). TODO(P2): swap for a model self-reported confidence (e.g.
 * require the candidate to emit a small JSON envelope with a `confidence`
 * field) once the BYOK matrix is trusted to self-report honestly — only
 * `computeHeuristicConfidence` below changes; `CascadeRunner`'s contract in
 * lib/cascade.ts already supports either source.
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

/** Toolless, single-turn candidate call — same shape as multi-model's
 * CANDIDATE_SYSTEM_PROMPT, but framed for a single answering model rather
 * than "one of several". */
const CASCADE_SYSTEM_PROMPT =
  "Answer the user's request directly and completely. If you are not " +
  "confident in your answer, or lack information to answer well, say so " +
  "plainly rather than guessing.";

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
  /** Hard cap on cumulative USD across every attempt. */
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
  const links = await listTenantProviderLinks(tenantId);
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
    });
    const lastTurn = result.turns[result.turns.length - 1];
    const confidence = computeHeuristicConfidence(result.finalContent, lastTurn?.stopReason);
    return { answer: result.finalContent, confidence, costUsd: result.totalCostUsd };
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
