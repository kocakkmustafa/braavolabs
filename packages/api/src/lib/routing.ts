/**
 * Least-token cost-aware routing + tokens-saved accounting (Vibe P2/P3/P7).
 *
 * The token-efficiency MOAT, operationalized as pure functions (fully unit-
 * testable, zero secrets/network). Two things competitors structurally can't/
 * won't copy:
 *   1) routeTask(): pick the CHEAPEST model that can plausibly handle a
 *      sub-task; escalate only on failure/low-confidence (§4 of the vision).
 *   2) tokensSaved(): make "tokens saved this week" a first-class, real number
 *      vs a naive always-frontier / always-full-context baseline (P7).
 *
 * Reference impl to drop into packages/api (routing over UserAIConfig +
 * modelPricing.ts). Deterministic + cost-honest.
 */

import { priceForModel } from "./modelPricing";

export type ModelTier = "local" | "cheap" | "frontier";

export interface ModelSpec {
  id: string;
  tier: ModelTier;
  /** USD per 1k input / output tokens (0 for local/on-device). */
  costPer1kIn: number;
  costPer1kOut: number;
  /** Capability tags the model can satisfy, e.g. 'summarize','codegen','vision','tools'. */
  capabilities: string[];
}

/** Ascending cost order for tiers (local cheapest, frontier most expensive). */
const TIER_RANK: Record<ModelTier, number> = { local: 0, cheap: 1, frontier: 2 };

export interface RouteRequest {
  taskType: string;
  requiredCapabilities: string[];
  /** Set true only for genuinely hard work that should start at the frontier. */
  hard?: boolean;
}

export interface RouteResult {
  model: ModelSpec;
  rationale: string;
}

/**
 * Pick the cheapest model that satisfies every required capability. Ties break
 * toward the lower tier (local < cheap < frontier), then lower blended cost.
 * `hard` tasks skip the cheap tiers and start at the frontier (still capable-checked).
 */
export function routeTask(req: RouteRequest, models: ModelSpec[]): RouteResult {
  const capable = models.filter((m) =>
    req.requiredCapabilities.every((c) => m.capabilities.includes(c)),
  );
  if (capable.length === 0) {
    throw new Error(
      `No model satisfies required capabilities [${req.requiredCapabilities.join(", ")}] for task "${req.taskType}"`,
    );
  }
  const pool = req.hard ? capable.filter((m) => m.tier === "frontier") : capable;
  const pick = (req.hard && pool.length ? pool : capable)
    .slice()
    .sort((a, b) => {
      if (TIER_RANK[a.tier] !== TIER_RANK[b.tier]) return TIER_RANK[a.tier] - TIER_RANK[b.tier];
      return blended(a) - blended(b);
    })[0]!;
  return {
    model: pick,
    rationale: req.hard
      ? `hard task → cheapest capable frontier model (${pick.id})`
      : `cheapest capable model (${pick.tier}/${pick.id}); escalate only on failure`,
  };
}

/** Next capable model strictly above the current tier — for escalate-on-failure. */
export function escalate(
  current: ModelSpec,
  req: RouteRequest,
  models: ModelSpec[],
): RouteResult | null {
  const higher = models
    .filter(
      (m) =>
        TIER_RANK[m.tier] > TIER_RANK[current.tier] &&
        req.requiredCapabilities.every((c) => m.capabilities.includes(c)),
    )
    .sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || blended(a) - blended(b));
  const next = higher[0];
  return next ? { model: next, rationale: `escalated ${current.tier}→${next.tier} (${next.id})` } : null;
}

function blended(m: ModelSpec): number {
  // A single comparable price: weight output 3× input (typical chat skew).
  return m.costPer1kIn + m.costPer1kOut * 3;
}

export interface RunEvent {
  model: ModelSpec;
  promptTokens: number;
  completionTokens: number;
  /** Input tokens served from a prompt cache (charged at ~0 / heavily discounted). */
  cachedInputTokens?: number;
  /** Input tokens avoided by top-K retrieval instead of stuffing the whole context. */
  retrievalAvoidedInputTokens?: number;
}

export interface SavingsReport {
  actualUsd: number;
  baselineUsd: number;
  savedUsd: number;
  savedTokens: number;
  savedPct: number;
  breakdown: { cheapRoutingUsd: number; cacheUsd: number; retrievalUsd: number };
}

/**
 * "Tokens saved this week" vs a naive baseline: every task on the most
 * expensive frontier model, no prompt cache, full context (no retrieval).
 * Honest: savings are computed, not hard-coded; provider-controlled cache
 * economics are reflected from the events, never assumed.
 */
export function tokensSaved(events: RunEvent[], frontier: ModelSpec): SavingsReport {
  let actualUsd = 0;
  let baselineUsd = 0;
  let savedTokens = 0;
  let cheapRoutingUsd = 0;
  let cacheUsd = 0;
  let retrievalUsd = 0;

  for (const e of events) {
    const cached = e.cachedInputTokens ?? 0;
    const avoided = e.retrievalAvoidedInputTokens ?? 0;
    const billedInput = Math.max(0, e.promptTokens - cached);

    // Actual cost: what we really billed on the chosen model (cache ~free).
    const actual =
      (billedInput / 1000) * e.model.costPer1kIn +
      (e.completionTokens / 1000) * e.model.costPer1kOut;
    actualUsd += actual;

    // Baseline: same work on the frontier, no cache, full context (add back the
    // retrieval-avoided input tokens the naive approach would have sent).
    const baseInput = e.promptTokens + avoided;
    const base =
      (baseInput / 1000) * frontier.costPer1kIn +
      (e.completionTokens / 1000) * frontier.costPer1kOut;
    baselineUsd += base;

    savedTokens += cached + avoided;

    // Attribution (approximate, sums to ~ savedUsd):
    cheapRoutingUsd +=
      (billedInput / 1000) * (frontier.costPer1kIn - e.model.costPer1kIn) +
      (e.completionTokens / 1000) * (frontier.costPer1kOut - e.model.costPer1kOut);
    cacheUsd += (cached / 1000) * frontier.costPer1kIn;
    retrievalUsd += (avoided / 1000) * frontier.costPer1kIn;
  }

  const savedUsd = baselineUsd - actualUsd;
  return {
    actualUsd: round(actualUsd),
    baselineUsd: round(baselineUsd),
    savedUsd: round(savedUsd),
    savedTokens,
    savedPct: baselineUsd > 0 ? round((savedUsd / baselineUsd) * 100) : 0,
    breakdown: {
      cheapRoutingUsd: round(cheapRoutingUsd),
      cacheUsd: round(cacheUsd),
      retrievalUsd: round(retrievalUsd),
    },
  };
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/**
 * Build a ModelSpec from the repo's real pricing table (modelPricing.ts,
 * the single-source cost map). Converts USD-per-1M -> USD-per-1k; local /
 * self-hosted models (no price entry) resolve to \$0. Ties the routing +
 * tokens-saved engine to the one pricing source of truth (Forge P2/P7).
 */
export function modelSpecFromPricing(
  id: string,
  tier: ModelTier,
  capabilities: string[],
): ModelSpec {
  const price = priceForModel(id);
  return {
    id,
    tier,
    costPer1kIn: price ? price.inputPerM / 1000 : 0,
    costPer1kOut: price ? price.outputPerM / 1000 : 0,
    capabilities,
  };
}
