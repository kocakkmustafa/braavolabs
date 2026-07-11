/**
 * Tenant "tokens saved" service (Forge P1).
 *
 * Turns a tenant's recent billed agent-step spend into an honest
 * SavingsReport (see lib/routing.ts#tokensSaved) comparing what was
 * actually spent against a naive always-frontier baseline.
 *
 * ─── DATA-QUALITY NOTE (read before trusting the numbers) ───────────
 * `run_steps` persists `cost_usd` (the REAL dollar amount billed for
 * that step) AND, as of the `prompt_tokens` / `completion_tokens` /
 * `cached_input_tokens` migration, the REAL per-call token counts —
 * both written at the same call site (modules/pipeline/executor.ts,
 * modules/pipeline/hierarchical-runner.ts) from the same
 * `AgentLoopResult` the provider actually returned (ultimately
 * `usage.input_tokens` / `usage.output_tokens` off
 * modules/agent/claude.ts / services/ai-client.ts). `agent_id` →
 * `agents.model` still supplies the model id used to price/tier the
 * event.
 *
 * Those new columns are nullable and were added additively — every
 * `run_steps` row written BEFORE the migration landed has them NULL.
 * `tokensSaved()` needs a `{promptTokens, completionTokens}` pair per
 * event, so this service branches per row:
 *   1. **Real data available** (`prompt_tokens` AND `completion_tokens`
 *      both non-null): use them directly — no reconstruction, no
 *      estimation. `cached_input_tokens` (when logged) feeds
 *      `tokensSaved()`'s cache-savings term directly, so
 *      `breakdown.cacheUsd` can now reflect a REAL signal for these
 *      rows instead of always being 0.
 *   2. **Legacy row** (either column NULL): falls back to the original
 *      reconstruction — a plausible input:output split using the SAME
 *      baseline ratio (`BASELINE_INPUT_TOKENS_PER_STEP` :
 *      `BASELINE_OUTPUT_TOKENS_PER_STEP`, i.e. 1500:800) that
 *      `lib/modelPricing.ts` already uses elsewhere in this codebase
 *      for "ballpark, not precise" cost estimates, scaled so the
 *      reconstructed actual cost matches the row's real `cost_usd`
 *      exactly. No `cachedInputTokens` is invented for these rows —
 *      cache savings on a reconstructed row are always 0.
 *
 * `sampleSize` in the result is `realTokenSampleSize +
 * reconstructedSampleSize`; `note` reports the real/reconstructed
 * split in plain language so a caller can see at a glance how much of
 * the report is byte-exact vs. estimated. As older rows age out of the
 * lookback window and new runs land, `reconstructedSampleSize` trends
 * to 0 on its own — no migration/backfill needed.
 */

import { prisma } from "../../lib/db";
import {
  tokensSaved,
  modelSpecFromPricing,
  deriveTier,
  type ModelSpec,
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
  /** Of `sampleSize`, how many used REAL logged prompt_tokens/completion_tokens (no reconstruction). */
  realTokenSampleSize: number;
  /** Of `sampleSize`, how many predate the token-count migration and used cost-based reconstruction. */
  reconstructedSampleSize: number;
  /** Model ids seen that have no entry in modelPricing.ts (zero-costed — see note). */
  unknownModelIds: string[];
  report: SavingsReport;
  note: string;
}

// Tier boundary (frontier/cheap/local) now lives in lib/routing.ts —
// deriveTier(modelId) — shared with the Forge-P1 cascade wiring
// (modules/research/cascade.service.ts) so the classification line is
// defined exactly once. This module keeps only its own picking-the-
// priciest-entry helper (frontierBaseline below), a distinct concern.
function blendedPerM(inputPerM: number, outputPerM: number): number {
  return inputPerM + outputPerM * 3;
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

/** Resolve a run_step's model id to a priced+tiered ModelSpec, flagging unknown ids. */
function resolveModelSpec(modelId: string, unknownModelIds: Set<string>): ModelSpec {
  const price = priceForModel(modelId);
  if (!price) unknownModelIds.add(modelId);
  const tier = deriveTier(modelId);
  return modelSpecFromPricing(modelId, tier, []);
}

/**
 * Build one RunEvent from a run_step's REAL logged token counts (Forge
 * P1 migration: run_steps.prompt_tokens / completion_tokens /
 * cached_input_tokens, populated at the same call site as cost_usd — no
 * reconstruction, no estimation). `cachedInputTokens` is only set when
 * the row actually logged one (most rows today — no call site requests
 * prompt caching yet), so `tokensSaved()`'s cache-savings term stays
 * honest rather than defaulting to a fabricated 0 or non-zero value.
 */
function buildRealRunEvent(
  promptTokens: number,
  completionTokens: number,
  cachedInputTokens: number | null,
  modelId: string,
  unknownModelIds: Set<string>,
): RunEvent {
  const model = resolveModelSpec(modelId, unknownModelIds);
  return {
    model,
    promptTokens,
    completionTokens,
    ...(cachedInputTokens != null ? { cachedInputTokens } : {}),
  };
}

/**
 * Build one RunEvent from a run_step's cost + model id, for rows that
 * predate the token-count migration (`prompt_tokens`/`completion_tokens`
 * NULL). See the file header for why this split is a reconstruction
 * rather than logged data, and why it's calibrated to preserve the real
 * cost_usd exactly. Never fabricates cache savings — cachedInputTokens
 * is left unset.
 */
function buildReconstructedRunEvent(
  costUsd: number,
  modelId: string,
  unknownModelIds: Set<string>,
): RunEvent {
  const model = resolveModelSpec(modelId, unknownModelIds);

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

/** Builds the `note` field with the real/reconstructed split spelled out numerically. */
function buildDataQualityNote(realCount: number, reconstructedCount: number): string {
  const total = realCount + reconstructedCount;
  return (
    `${realCount}/${total} run_steps used REAL logged prompt_tokens/completion_tokens ` +
    `(and cached_input_tokens where logged) — no reconstruction. ${reconstructedCount}/${total} ` +
    "predate the token-count migration (prompt_tokens/completion_tokens NULL) and fall back to " +
    `reconstructing each step's input:output split from its real cost_usd using the same ` +
    `${BASELINE_INPUT_TOKENS_PER_STEP}:${BASELINE_OUTPUT_TOKENS_PER_STEP} baseline ratio modelPricing.ts already ` +
    "uses for ballpark estimates, scaled so the reconstructed actual cost matches real cost_usd exactly — those " +
    "reconstructed rows never claim cache savings (cachedInputTokens left unset). breakdown.cheapRoutingUsd " +
    "(cheap/local tier vs. frontier pricing) is always a real, non-estimated signal; breakdown.cacheUsd is real " +
    "for rows with logged cached_input_tokens and 0 otherwise; breakdown.retrievalUsd is always 0 — retrieval-" +
    "avoided token counts are not logged anywhere in the schema today."
  );
}

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
      promptTokens: true,
      completionTokens: true,
      cachedInputTokens: true,
      agent: { select: { model: true } },
    },
  });

  const unknownModelIds = new Set<string>();
  const events: RunEvent[] = [];
  let realTokenSampleSize = 0;
  let reconstructedSampleSize = 0;
  for (const step of steps) {
    // No agent association -> no model to attribute the spend to. Skip
    // rather than guess; this keeps the report honest at the cost of
    // slightly undercounting steps run without an agent link.
    if (!step.agent?.model) continue;
    const costUsd = Number(step.costUsd ?? 0);
    // Prefer the REAL logged token counts (Forge P1 migration). Both
    // must be present — a step with only one of the two would produce
    // a nonsensical split, so treat it like any other legacy row and
    // fall back to reconstruction.
    if (step.promptTokens != null && step.completionTokens != null) {
      events.push(
        buildRealRunEvent(
          step.promptTokens,
          step.completionTokens,
          step.cachedInputTokens,
          step.agent.model,
          unknownModelIds,
        ),
      );
      realTokenSampleSize++;
    } else {
      events.push(buildReconstructedRunEvent(costUsd, step.agent.model, unknownModelIds));
      reconstructedSampleSize++;
    }
  }

  const report = tokensSaved(events, frontierBaseline());

  return {
    period: { days: clampedDays, since: since.toISOString(), until: until.toISOString() },
    sampleSize: events.length,
    realTokenSampleSize,
    reconstructedSampleSize,
    unknownModelIds: Array.from(unknownModelIds),
    report,
    note: buildDataQualityNote(realTokenSampleSize, reconstructedSampleSize),
  };
}
