/**
 * Forge trial-credit — fail-closed, atomic USD spend cap (FAZ1-1C).
 *
 * DISTINCT from services/trial-llm.ts (the existing Groq per-tenant RUN
 * COUNT gate that feeds the main pipeline/agent-loop provider chain —
 * services/provider-chain.ts's `tryConsumeTrialRun`/`commitTrialRun`). That
 * mechanism is untouched by this file. This module gates a NEW, separate
 * surface: the Forge onboarding wizard's "try a provider before you add your
 * own key" flow (modules/onboarding-forge/router.ts), which — when the
 * tenant has no BYOK key of their own for a catalogue provider — dials
 * Braavolabs' OWN held key for that provider (Cerebras / Groq / Zhipu; see
 * SYSTEM_HELD_KEY_ENV below) instead of the tenant's. Because that call is
 * funded by Braavolabs, not the tenant, its cost must be bounded — this is
 * that bound.
 *
 * Design (mirrors two existing patterns in this codebase):
 *
 *   1. The atomic fail-closed guard idiom from modules/draft/router.ts:45-49
 *      (`claimEmailQuota`) and modules/billing/metering.ts (`claimQuota`):
 *      a single `INSERT … ON CONFLICT … DO UPDATE … WHERE <condition>` so the
 *      check-and-increment is one indivisible SQL statement — no
 *      read-then-write race window.
 *
 *   2. The reserve-then-commit-or-refund lifecycle from services/trial-llm.ts
 *      (`tryConsumeTrialRun` / `commitTrialRun`): a call's real USD cost is
 *      unknown until the provider responds, so we can't gate on the exact
 *      amount up front. We reserve a conservative flat ceiling atomically
 *      BEFORE dialing (this is the part that must never be raced past the
 *      cap), then true the reservation up to the real `cost_usd` after the
 *      call succeeds, or refund it in full if the call throws.
 *
 * Unit: usage_meters.value is a Postgres/Prisma `Int` column (see
 * prisma/schema.prisma UsageMeter). Trial spend is tracked in MICRO-USD
 * (1 USD = 1_000_000 micro-usd) under metric "forge_trial_credit_usd" so
 * sub-cent per-call costs (a validation ping can cost $0.0003) don't round
 * away to zero. FORGE_TRIAL_CREDIT_USD_CAP (env.ts) is a plain USD number —
 * this module is the ONLY place that converts between the two.
 *
 * The bucket is a single lifetime total per tenant (not a rolling monthly
 * period like other usage_meters rows) — LIFETIME_PERIOD_START/_END below
 * are a fixed sentinel range so every reservation for a tenant lands on the
 * same row regardless of when it happens, mirroring the "once you BYOK or
 * upgrade you're off the trial" semantics of trialRunsLimit.
 */

import { prisma, tenantTx } from "../../lib/db";
import { logger } from "../../lib/logger";
import { env } from "../../config/env";
import { FREE_PROVIDERS, priceForModel } from "../../lib/modelPricing";
import {
  chatCompletion,
  type AIClientConfig,
  type AIProviderType,
  type ChatCompletionResult,
} from "../../services/ai-client";

const METRIC = "forge_trial_credit_usd";
const MICRO_PER_USD = 1_000_000;

// Fixed sentinel bucket — every reservation for a tenant lands on the SAME
// usage_meters row (tenantId, metric, periodStart) regardless of wall-clock
// time, making this a lifetime total rather than a rolling period. Chosen
// far in the past / future so it can never collide with a real calendar
// period boundary used by other metrics on the same table.
const LIFETIME_PERIOD_START = new Date("1970-01-01T00:00:00.000Z");
const LIFETIME_PERIOD_END = new Date("9999-12-31T00:00:00.000Z");

/**
 * Conservative flat ceiling reserved atomically BEFORE a trial-funded call,
 * in USD. Real onboarding validation/demo pings are tiny (≤16 output tokens
 * against free-tier models — see modules/onboarding-forge/router.ts), so
 * this is deliberately generous headroom, not a tight estimate: it only has
 * to (a) be reserved atomically so concurrent calls can't jointly blow past
 * the cap, and (b) get trued-up to the REAL cost_usd right after, refunded
 * in full on failure. A tenant can never be charged more than the true cost
 * of calls that actually succeeded.
 */
export const TRIAL_CALL_RESERVATION_USD = 0.02;

/**
 * P2-F fix (Opus adversarial review, 2026-07-23): minimum USD retired from
 * the trial-credit bucket per SUCCESSFUL trial call, regardless of the
 * model's real metered cost.
 *
 * lib/modelPricing.ts genuinely prices some catalogue models at $0 (e.g.
 * ZHIPU's default model "glm-4.7-flash" — Flash tiers are permanently
 * free). Without a floor, `costForTrialUsage()` returns EXACTLY 0 for
 * those calls, `settleTrialCredit` nets the full reservation back out
 * (delta = 0 − reservationUsd), and the bucket returns to its pre-call
 * value every single time — the USD cap becomes a total no-op for any
 * $0-priced model, and a tenant could make effectively UNLIMITED trial
 * calls against Braavolabs' held key for it (the only remaining bound
 * would be the 5/min rate limiter on POST /validate — far too loose for a
 * cost-control mechanism whose entire purpose is a dollar ceiling).
 *
 * The floor makes the bucket monotonically non-decreasing per successful
 * call even at $0 metered cost, which turns the single USD cap into an
 * EFFECTIVE call-count ceiling too for zero-priced models — no second
 * "trial run count" knob is introduced; `FORGE_TRIAL_CREDIT_USD_CAP`
 * remains the only operator-facing setting. (Once the bucket is deep
 * enough into the cap that a fresh `TRIAL_CALL_RESERVATION_USD`
 * reservation no longer fits, `reserveTrialCredit` refuses further calls
 * regardless of the floor — see its docblock.)
 *
 * NEVER applied to `refundTrialCredit` — a call that THREW consumed
 * nothing and must be refunded in full, not floored.
 */
export const MIN_TRIAL_UNIT_USD = 0.0001; // $0.0001 = 100 micro-usd

function usdToMicros(usd: number): number {
  return Math.round(usd * MICRO_PER_USD);
}

function microsToUsd(micros: number): number {
  return Math.round((micros / MICRO_PER_USD) * 1e6) / 1e6;
}

/**
 * Braavolabs-held system key for `provider`, read FRESH from env on every
 * call (never captured into a module-level constant — env is a singleton
 * for the life of the process, but reading it live keeps this testable and
 * mirrors trialEnabled()'s pattern in services/trial-llm.ts). Only
 * providers with an env-configured key can serve a trial — everything else
 * falls through to "BYOK required" from the caller's perspective. Kept to
 * the free-tier-friendly catalogue (Bölüm A) — ANTHROPIC's system key
 * (env.ANTHROPIC_API_KEY) is deliberately excluded: that key is the main
 * agent-loop's paid system fallback (provider-chain.ts) and is out of scope
 * for this onboarding-trial mechanism. */
function systemHeldKeyFor(provider: AIProviderType): string | undefined {
  switch (provider) {
    case "CEREBRAS": return env.CEREBRAS_API_KEY;
    case "GROQ": return env.GROQ_API_KEY;
    case "ZHIPU": return env.ZHIPU_API_KEY;
    default: return undefined;
  }
}

/** True when Braavolabs holds a usable system key for `provider` — i.e. the
 * Forge trial path can even be attempted for it, independent of whether the
 * tenant's own credit is exhausted. */
export function hasSystemHeldKey(provider: AIProviderType): boolean {
  const key = systemHeldKeyFor(provider);
  return !!key && key.length > 0;
}

/** Whether the trial-credit gate is enabled at all — cap must be a positive
 * finite number. `env.ts` already coerces/clamps to `>= 0`; treat non-finite
 * defensively too so a corrupt env value fails closed rather than throwing
 * deep inside a SQL template. */
export function trialCreditEnabled(): boolean {
  const cap = env.FORGE_TRIAL_CREDIT_USD_CAP;
  return Number.isFinite(cap) && cap > 0;
}

export interface TrialCreditReservation {
  /** USD ceiling atomically reserved for this call — pass back verbatim to
   * `settleTrialCredit` / `refundTrialCredit`. */
  reservationUsd: number;
}

/**
 * Atomically reserve `TRIAL_CALL_RESERVATION_USD` against the tenant's
 * lifetime Forge trial-credit bucket. Returns `null` (never throws) when the
 * gate is closed (cap=0 / unset), the cap itself is smaller than a single
 * reservation, or the reservation would push the bucket past the cap — the
 * caller MUST treat `null` as "no trial call may be made" and fall back to
 * BYOK or a plain error. Never fail-open.
 *
 * The `WHERE usage_meters.value + reservation <= cap` guard (rather than the
 * draft/router.ts-style `WHERE value < cap`) means the reservation itself
 * can NEVER push the bucket over the cap even for the very first caller of a
 * concurrent burst — every accepted reservation keeps the running total
 * `<= cap` by construction, not just "was under cap before this one landed".
 *
 * P2-A2 fix (Opus adversarial review, 2026-07-23): the ON CONFLICT…DO UPDATE
 * WHERE only guards the UPDATE branch — a plain `INSERT … VALUES (…)` with
 * no matching row yet is UNCONDITIONAL, so a tenant's very FIRST reservation
 * used to bypass the cap check entirely (it always inserted, regardless of
 * whether `reservation > cap`). Fixed two ways, belt-and-suspenders:
 *   1. `INSERT … SELECT … WHERE reservation <= cap` — the INSERT's source
 *      rowset is now itself conditioned on the cap, so it also produces ZERO
 *      rows (and therefore never reaches ON CONFLICT) when a reservation
 *      alone would already exceed the cap, on the very first row.
 *   2. An explicit early return in this function for the same condition —
 *      cheaper (skips a DB round trip for a permanently-pathological
 *      cap/reservation combination) and keeps that case unit-testable
 *      without depending on exact Postgres INSERT…SELECT semantics.
 */
export async function reserveTrialCredit(
  tenantId: string,
): Promise<TrialCreditReservation | null> {
  if (!trialCreditEnabled()) return null;

  const capMicros = usdToMicros(env.FORGE_TRIAL_CREDIT_USD_CAP);
  const reservationMicros = usdToMicros(TRIAL_CALL_RESERVATION_USD);

  // A cap smaller than a single call's reservation ceiling can never admit
  // even the FIRST trial call — refuse before touching the DB (P2-A2).
  if (reservationMicros > capMicros) {
    logger.warn(
      { tenantId, capUsd: env.FORGE_TRIAL_CREDIT_USD_CAP, reservationUsd: TRIAL_CALL_RESERVATION_USD },
      "Forge trial-credit cap is smaller than the per-call reservation ceiling — every trial call refused (fail-closed)",
    );
    return null;
  }

  const rows = await tenantTx((tx) => tx.$queryRaw<Array<{ value: number }>>`
    INSERT INTO usage_meters (id, tenant_id, metric, value, period_start, period_end, created_at, updated_at)
    SELECT gen_random_uuid()::text, ${tenantId}, ${METRIC}, ${reservationMicros}, ${LIFETIME_PERIOD_START}, ${LIFETIME_PERIOD_END}, NOW(), NOW()
    WHERE ${reservationMicros} <= ${capMicros}
    ON CONFLICT (tenant_id, metric, period_start) DO UPDATE
      SET value = usage_meters.value + ${reservationMicros}, updated_at = NOW()
      WHERE usage_meters.value + ${reservationMicros} <= ${capMicros}
    RETURNING value
  `);

  if (rows.length === 0) {
    logger.warn(
      { tenantId, capUsd: env.FORGE_TRIAL_CREDIT_USD_CAP },
      "Forge trial-credit cap reached — trial-funded call refused (fail-closed)",
    );
    return null;
  }

  return { reservationUsd: TRIAL_CALL_RESERVATION_USD };
}

/** Shared atomic delta-apply — both settleTrialCredit and refundTrialCredit
 * bottom out here. Skips the DB round trip for a true no-op delta. Non-fatal
 * on failure — the same self-corrects-next-period stance as releaseQuota in
 * metering.ts, except this bucket has no next period, so a missed apply just
 * leaves a few cents of unclaimed headroom rather than corrupting state. */
async function applyBucketDeltaMicros(
  tenantId: string,
  deltaMicros: number,
  failureLogMessage: string,
  logContext: Record<string, unknown>,
): Promise<void> {
  if (deltaMicros === 0) return;
  try {
    await tenantTx((tx) => tx.$executeRaw`
      UPDATE usage_meters
      SET value = GREATEST(0, value + ${deltaMicros}), updated_at = NOW()
      WHERE tenant_id = ${tenantId} AND metric = ${METRIC} AND period_start = ${LIFETIME_PERIOD_START}
    `);
  } catch (err) {
    logger.warn({ err, tenantId, ...logContext }, failureLogMessage);
  }
}

/**
 * True the reservation up to the REAL cost after a trial-funded call
 * SUCCEEDS: `delta = effectiveCostUsd - reservationUsd` is applied to the
 * bucket (negative when the real call was cheaper than the reservation —
 * the common case — refunding the difference; positive in the rare case the
 * real cost exceeded the flat ceiling, which is bookkeeping-only at this
 * point since the call already happened and can't be un-served). The
 * bucket-level GREATEST(0, …) clamp still guards against ever going
 * negative.
 *
 * `effectiveCostUsd` applies two P3/P2-F hardenings on top of the raw
 * `actualCostUsd` the caller measured:
 *   - NaN / Infinity / negative input collapses to the floor rather than
 *     propagating into the delta math or the SQL template (a corrupt cost
 *     must never produce a corrupt or negative bucket write).
 *   - `MIN_TRIAL_UNIT_USD` floor (P2-F) — see that constant's docblock: a
 *     genuinely $0-priced model must still retire at least the floor from
 *     the bucket, or the USD cap is a no-op for it.
 */
export async function settleTrialCredit(
  tenantId: string,
  reservationUsd: number,
  actualCostUsd: number,
): Promise<void> {
  const safeCostUsd =
    Number.isFinite(actualCostUsd) && actualCostUsd >= 0 ? actualCostUsd : MIN_TRIAL_UNIT_USD;
  const effectiveCostUsd = Math.max(safeCostUsd, MIN_TRIAL_UNIT_USD);
  const deltaMicros = usdToMicros(effectiveCostUsd) - usdToMicros(reservationUsd);
  await applyBucketDeltaMicros(
    tenantId,
    deltaMicros,
    "settleTrialCredit failed (non-fatal — bucket keeps the flat reservation until the next successful settle)",
    { actualCostUsd },
  );
}

/**
 * Refund a reservation in FULL — the trial-funded call THREW before we
 * could learn its real cost, so the tenant must not be charged for it at
 * all. Deliberately NOT implemented as `settleTrialCredit(tenantId,
 * reservationUsd, 0)` anymore (P2-F): that would now run the cost through
 * the floor and retire `MIN_TRIAL_UNIT_USD` even though the call never
 * completed and consumed nothing. This function always gives back exactly
 * `reservationUsd`, unfloored.
 */
export async function refundTrialCredit(
  tenantId: string,
  reservationUsd: number,
): Promise<void> {
  const deltaMicros = -usdToMicros(reservationUsd);
  await applyBucketDeltaMicros(
    tenantId,
    deltaMicros,
    "refundTrialCredit failed (non-fatal — bucket keeps the reservation until the next successful refund/settle)",
    { reservationUsd },
  );
}

export interface ForgeTrialCreditStatus {
  enabled: boolean;
  capUsd: number;
  spentUsd: number;
  remainingUsd: number;
  exhausted: boolean;
}

/** Read-only snapshot for GET /onboarding/forge/status and any future
 * dashboard banner. NOT the gate itself — `reserveTrialCredit` is (same
 * checkQuota-vs-claimQuota split as metering.ts). */
export async function getForgeTrialCreditStatus(
  tenantId: string,
): Promise<ForgeTrialCreditStatus> {
  const capUsd = env.FORGE_TRIAL_CREDIT_USD_CAP;
  if (!trialCreditEnabled()) {
    return { enabled: false, capUsd: 0, spentUsd: 0, remainingUsd: 0, exhausted: false };
  }

  const meter = await prisma.usageMeter.findUnique({
    where: {
      tenantId_metric_periodStart: {
        tenantId,
        metric: METRIC,
        periodStart: LIFETIME_PERIOD_START,
      },
    },
    select: { value: true },
  });

  const spentUsd = microsToUsd(meter?.value ?? 0);
  const remainingUsd = Math.max(0, Math.round((capUsd - spentUsd) * 1e6) / 1e6);
  return {
    enabled: true,
    capUsd,
    spentUsd,
    remainingUsd,
    exhausted: remainingUsd <= 0,
  };
}

// ─── cost accounting ───────────────────────────────────────
//
// Mirrors modules/agent/claude.ts's costForUsage: real prices from
// lib/modelPricing.ts, local/free providers $0, unknown models priced
// fail-expensive (never fail-cheap — an unpriced model must not look free
// and silently drain the cap without the meter noticing).

const UNKNOWN_MODEL_FALLBACK_PRICE = { inputPerM: 10.0, outputPerM: 30.0 };

/** Exported for reuse by trial-llm.ts's completion call sites, which settle
 * against this SAME bucket (see that module's cost-cap section) — the
 * roadmap's "$0.30 hosted trial" figure is one TOTAL cap across every
 * trial-funded surface, not a separate allowance per flow. */
export function costForTrialUsage(
  provider: AIProviderType,
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  if (FREE_PROVIDERS.has(provider)) return 0;
  const price = priceForModel(model);
  if (!price) {
    logger.warn(
      { provider, model },
      "Forge trial: unknown model — pricing fail-expensive so the cap can't be silently drained",
    );
  }
  const p = price ?? UNKNOWN_MODEL_FALLBACK_PRICE;
  return (inputTokens / 1_000_000) * p.inputPerM + (outputTokens / 1_000_000) * p.outputPerM;
}

export class TrialCreditExhaustedError extends Error {
  constructor(public readonly tenantId: string) {
    super(
      "Forge trial credit exhausted or disabled for this tenant — add your own API key to continue.",
    );
    this.name = "TrialCreditExhaustedError";
  }
}

export class NoSystemHeldKeyError extends Error {
  constructor(public readonly provider: AIProviderType) {
    super(`Braavolabs holds no system key for ${provider} — a trial run is not available for it.`);
    this.name = "NoSystemHeldKeyError";
  }
}

/**
 * The single wiring point: dial a Forge-catalogue provider on Braavolabs'
 * OWN held key, gated end-to-end by the trial-credit guard.
 *
 *   1. Refuse up front if there's no system-held key for `provider` at all
 *      (independent of credit — BYOK is the only option for that provider).
 *   2. Atomically reserve `TRIAL_CALL_RESERVATION_USD` — throws
 *      TrialCreditExhaustedError (never dials, never fails open) when the
 *      cap is closed (0) or already reached.
 *   3. Calls chatCompletion with the system-held key.
 *   4. On success: true the reservation up to the REAL cost_usd, return the
 *      result (with `costUsd` attached for the caller's bookkeeping/response).
 *   5. On failure: refund the reservation in full, rethrow.
 *
 * The tenant's OWN BYOK config/path is never consulted or touched here —
 * this function only ever dials the SYSTEM key, so an exhausted trial
 * bucket cannot leak into or block a tenant's BYOK calls.
 */
export async function runForgeTrialCompletion(
  tenantId: string,
  provider: AIProviderType,
  model: string,
  systemPrompt: string,
  messages: Parameters<typeof chatCompletion>[2],
  maxTokens = 16,
): Promise<ChatCompletionResult & { costUsd: number }> {
  const systemKey = systemHeldKeyFor(provider);
  if (!systemKey) throw new NoSystemHeldKeyError(provider);

  const reservation = await reserveTrialCredit(tenantId);
  if (!reservation) throw new TrialCreditExhaustedError(tenantId);

  const config: AIClientConfig = { provider, model, apiKey: systemKey };

  try {
    const result = await chatCompletion(config, systemPrompt, messages, maxTokens);
    const costUsd = costForTrialUsage(provider, result.model, result.inputTokens, result.outputTokens);
    await settleTrialCredit(tenantId, reservation.reservationUsd, costUsd);
    return { ...result, costUsd };
  } catch (err) {
    await refundTrialCredit(tenantId, reservation.reservationUsd);
    throw err;
  }
}
