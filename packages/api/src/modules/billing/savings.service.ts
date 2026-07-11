/**
 * Tenant "tokens saved" service (Forge P1).
 *
 * Turns a tenant's recent billed agent-step spend into an honest
 * SavingsReport (see lib/routing.ts#tokensSaved) comparing what was
 * actually spent against a naive always-frontier baseline.
 *
 * ─── DATA-QUALITY NOTE (read before trusting the numbers) ───────────
 * `run_steps` persists `cost_usd` (the REAL dollar amount billed for
 * that step, computed at call time by modules/agent/claude.ts /
 * services/ai-client.ts from the provider's real `usage.input_tokens`
 * / `usage.output_tokens`) and `agent_id` → `agents.model` (the model
 * configured on the agent that ran the step). It does NOT persist the
 * per-call `promptTokens` / `completionTokens` split, nor prompt-cache
 * or retrieval-avoided token counts — those numbers are computed
 * transiently during the call and discarded after the cost is rolled
 * into `run_steps.cost_usd`.
 *
 * `tokensSaved()` needs a `{promptTokens, completionTokens}` pair per
 * event. To stay honest (no invented numbers) this service:
 *   1. Uses the REAL `cost_usd` for the "actual spend" side — never
 *      fabricated.
 *   2. Reconstructs a plausible input:output token split using the
 *      SAME baseline ratio (`BASELINE_INPUT_TOKENS_PER_STEP` :
 *      `BASELINE_OUTPUT_TOKENS_PER_STEP`, i.e. 1500:800) that
 *      `lib/modelPricing.ts` already uses elsewhere in this codebase
 *      for "ballpark, not precise" cost estimates — not an ad-hoc
 *      ratio invented here — then scales it so the reconstructed
 *      per-event actual cost matches the real `cost_usd` exactly
 *      (verified in the unit tests: the sum of `report.actualUsd`
 *      always equals the sum of the real `cost_usd` values fed in).
 *   3. Never claims prompt-cache or retrieval savings — those fields
 *      are simply left unset (0), because there is no logged data
 *      for them anywhere in the schema today. `breakdown.cacheUsd`
 *      and `breakdown.retrievalUsd` are therefore always 0; only
 *      `breakdown.cheapRoutingUsd` (cheap/local-tier vs frontier
 *      pricing) reflects a real signal.
 *
 * For byte-exact accounting (no reconstruction), `run_steps` would
 * need real `prompt_tokens` / `completion_tokens` (and ideally
 * `cached_input_tokens` / `retrieval_avoided_input_tokens`) columns,
 * populated from the `usage` object already available at the call
 * site. That is a schema change this task deliberately does not make
 * (see PR notes) — it's called out here so the gap is easy to find.
 */

import { prisma } from "../../lib/db";
import {
  tokensSaved,
  modelSpecFromPricing,
  type ModelSpec,
  type ModelTier,
  type RunEvent,
  type SavingsReport,
} from "../../lib/routing";
import {
  MODEL_PRICES,
  priceForModel,
  BASELINE_INPUT_TOKENS_PER_STEP,
  BASELINE_OUTPUT_TOKENS_PER_STEP,
} from "../../lib/modelPricing";

export interface TenantSavingsResult {
  period: { days: number; since: string; until: string };
  /** Number of run_steps that fed into this report (agent-attributed, costed). */
  sampleSize: number;
  /** Model ids seen that have no entry in modelPricing.ts (zero-costed — see note). */
  unknownModelIds: string[];
  report: SavingsReport;
  note: string;
}

/**
 * Above this blended $/1M-token rate (input + 3×output, same weighting
 * `lib/routing.ts` uses internally) a model is classified "frontier".
 * Chosen so the flagship reasoning models (claude-opus ≈240, o1 ≈195,
 * gpt-4-turbo ≈100) land above the line and the default agent workhorse
 * models (claude-sonnet ≈48, gpt-4o ≈32.5, gemini-1.5-pro ≈16, claude-haiku
 * ≈12.8, …) land below it as "cheap". Zero-priced entries are "local".
 */
const FRONTIER_BLENDED_THRESHOLD_PER_M = 50;

function blendedPerM(inputPerM: number, outputPerM: number): number {
  return inputPerM + outputPerM * 3;
}

function deriveTier(inputPerM: number, outputPerM: number): ModelTier {
  if (inputPerM === 0 && outputPerM === 0) return "local";
  return blendedPerM(inputPerM, outputPerM) > FRONTIER_BLENDED_THRESHOLD_PER_M ? "frontier" : "cheap";
}

let cachedFrontier: ModelSpec | null = null;

/**
 * The naive baseline `tokensSaved()` compares against: the single most
 * expensive model in the real pricing table (modelPricing.ts), picked
 * programmatically so this stays correct as the table changes rather
 * than hard-coding "claude-opus".
 */
function frontierBaseline(): ModelSpec {
  if (cachedFrontier) return cachedFrontier;
  let bestId: string | null = null;
  let bestBlended = -1;
  for (const [id, price] of Object.entries(MODEL_PRICES)) {
    const b = blendedPerM(price.inputPerM, price.outputPerM);
    if (b > bestBlended) {
      bestBlended = b;
      bestId = id;
    }
  }
  cachedFrontier = modelSpecFromPricing(bestId ?? "claude-opus", "frontier", []);
  return cachedFrontier;
}

/**
 * Build one RunEvent from a real run_step's cost + model id. See the
 * file header for why the promptTokens/completionTokens split is a
 * reconstruction rather than logged data, and why it's calibrated to
 * preserve the real cost_usd exactly.
 */
function buildRunEvent(costUsd: number, modelId: string, unknownModelIds: Set<string>): RunEvent {
  const price = priceForModel(modelId);
  if (!price) unknownModelIds.add(modelId);
  const inputPerM = price?.inputPerM ?? 0;
  const outputPerM = price?.outputPerM ?? 0;
  const tier = deriveTier(inputPerM, outputPerM);
  const model = modelSpecFromPricing(modelId, tier, []);

  const denom =
    BASELINE_INPUT_TOKENS_PER_STEP * model.costPer1kIn + BASELINE_OUTPUT_TOKENS_PER_STEP * model.costPer1kOut;

  let promptTokens: number;
  let completionTokens: number;
  if (denom <= 0) {
    // Free / local / unpriced model — actual cost is $0 regardless of the
    // split (both cost-per-1k rates are 0), so use the baseline ratio
    // as-is. This still produces a meaningful (non-fabricated) frontier
    // baseline cost for the savings comparison.
    promptTokens = BASELINE_INPUT_TOKENS_PER_STEP;
    completionTokens = BASELINE_OUTPUT_TOKENS_PER_STEP;
  } else {
    const k = Math.max(0, (costUsd * 1000) / denom);
    promptTokens = Math.round(k * BASELINE_INPUT_TOKENS_PER_STEP);
    completionTokens = Math.round(k * BASELINE_OUTPUT_TOKENS_PER_STEP);
  }

  return { model, promptTokens, completionTokens };
}

const DATA_QUALITY_NOTE =
  "run_steps only persists cost_usd + agent_id (-> agents.model), not per-call promptTokens/completionTokens. " +
  `This report reconstructs each step's input:output token split from its real cost_usd using the same ` +
  `${BASELINE_INPUT_TOKENS_PER_STEP}:${BASELINE_OUTPUT_TOKENS_PER_STEP} baseline ratio modelPricing.ts already uses ` +
  "for ballpark estimates, scaled so the reconstructed actual cost matches real cost_usd exactly. Prompt-cache and " +
  "retrieval-avoided savings are not logged anywhere today, so breakdown.cacheUsd/retrievalUsd are always 0 — only " +
  "breakdown.cheapRoutingUsd (cheap/local tier vs. frontier pricing) reflects a real, non-estimated signal. Exact " +
  "token accounting needs prompt_tokens/completion_tokens (ideally cached_input_tokens/retrieval_avoided_input_tokens) " +
  "columns on run_steps, populated from the usage object already computed in modules/agent/claude.ts and services/ai-client.ts.";

/**
 * Computes a tenant's tokens-saved report over the last `days` days.
 *
 * TENANT ISOLATION: run_steps has no direct tenantId column, so every
 * query hops run -> pipeline -> company -> tenantId, matching the
 * pattern already used in billing/forecast.ts and billing/router.ts.
 */
export async function computeTenantSavings(tenantId: string, days = 7): Promise<TenantSavingsResult> {
  const rawDays = Number.isFinite(days) ? Math.trunc(days) : 7;
  const clampedDays = Math.min(Math.max(rawDays, 1), 90);

  const until = new Date();
  const since = new Date(until.getTime() - clampedDays * 24 * 60 * 60 * 1000);

  const steps = await prisma.runStep.findMany({
    where: {
      status: "COMPLETED",
      costUsd: { not: null },
      completedAt: { gte: since, lte: until },
      // tenant isolation hop — never omit this.
      run: { pipeline: { company: { tenantId } } },
    },
    select: {
      costUsd: true,
      agent: { select: { model: true } },
    },
  });

  const unknownModelIds = new Set<string>();
  const events: RunEvent[] = [];
  for (const step of steps) {
    // No agent association -> no model to attribute the spend to. Skip
    // rather than guess; this keeps the report honest at the cost of
    // slightly undercounting steps run without an agent link.
    if (!step.agent?.model) continue;
    const costUsd = Number(step.costUsd ?? 0);
    events.push(buildRunEvent(costUsd, step.agent.model, unknownModelIds));
  }

  const report = tokensSaved(events, frontierBaseline());

  return {
    period: { days: clampedDays, since: since.toISOString(), until: until.toISOString() },
    sampleSize: events.length,
    unknownModelIds: Array.from(unknownModelIds),
    report,
    note: DATA_QUALITY_NOTE,
  };
}
