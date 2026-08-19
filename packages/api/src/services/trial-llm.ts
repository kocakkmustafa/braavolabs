/**
 * Trial LLM gate — first N pipeline runs for new tenants are routed
 * through a holding-owned Groq key, so users can experience a real
 * autonomous run before deciding to BYOK or upgrade.
 *
 * Why Groq, not OpenAI/Anthropic free tiers?
 *   • Groq has the cheapest aggregate per-token cost on its current free
 *     tier (llama-3.3-70b-versatile is genuinely competent).
 *   • Inference is fast (~500 tok/s), so trial users see results in
 *     seconds — strongest demo-to-conversion signal we have.
 *   • Switching providers later is a 1-line change: GROQ_TRIAL_MODEL.
 *
 * Why not just put the Groq key on every account?
 *   Cost. We pay for trial usage. The counter caps the blast radius if a
 *   single account or scraper hits a tight loop. Subscribed tenants are
 *   never routed here — they always use their own BYOK config.
 *
 * Flow:
 *   1. Pipeline executor calls `tryConsumeTrialRun(tenantId)` BEFORE the
 *      AI call. Returns either { config, isTrial: true } or null.
 *   2. If null, executor falls back to `getTenantAIConfig` (BYOK or fail).
 *   3. After the AI call succeeds, executor calls `commitTrialRun(tenantId)`
 *      to increment the counter. Failed runs do NOT consume trial credit
 *      (that would punish users for our infra hiccups).
 *
 * Atomicity note: we increment in `commitTrialRun` after success, not in
 * `tryConsumeTrialRun`, because we want to refund the slot on failure.
 * The race window (two concurrent runs both seeing remaining=1) is fine
 * — worst case a tenant gets 4 trial runs instead of 3. Cheaper to live
 * with than to lock the row across the entire AI call.
 *
 * $0.30 TOTAL cost cap: the roadmap's "3 hosted guided run, $0.30 total
 * provider cost" is one requirement, not two independent ones — the run
 * COUNT above bounds the number of calls, but not what a single call could
 * cost (an oversized prompt could burn far more than a typical trial turn).
 * The dollar ceiling closes that gap, and it settles into the SAME bucket
 * trial-credit.service.ts already guards (FORGE_TRIAL_CREDIT_USD_CAP,
 * metric "forge_trial_credit_usd") — that module's atomic reserve/settle
 * primitives are reused here (with a reservation ceiling sized for this
 * flow, not reimplemented.
 *
 * ATOMIC, not check-then-settle (R2 fix, 2026-08-19 adversarial review):
 * an earlier version of this cap only READ the bucket's exhausted status
 * before serving, then settled the real cost after. That looked like the
 * same "small accepted race" the run counter above already tolerates, but
 * it is NOT — pipeline runs can execute up to MAX_STEPS_PER_RUN steps at
 * the same `order` truly concurrently (pipeline/runner.ts), each
 * independently resolving its own trial link and running up to
 * TRIAL_MAX_TURNS real Groq-funded turns before any of them settle. A
 * single crafted pipeline could fan out dozens of concurrent trial-funded
 * runs racing the same pre-settle check, blowing the cap by many multiples
 * — effectively no cap at all. reserveTrialCredit()'s atomic SQL guard
 * (INSERT/UPDATE ... WHERE running-total <= cap) closes this: concurrent
 * reservations physically cannot push the bucket past the cap, regardless
 * of fan-out width, because the database — not application logic —
 * arbitrates who gets a slot. TRIAL_LLM_RESERVATION_USD (not
 * trial-credit.service.ts's own $0.02, which is sized for a ≤16-token
 * validation ping) is sized for a real up-to-TRIAL_MAX_TURNS agent-loop
 * run, so a reservation almost always covers the real cost with headroom.
 * With a $0.30 cap this bounds concurrent in-flight trial spend to ~3
 * reservations worth (~$0.30) regardless of how many requests race it —
 * a fixed, provable ceiling instead of an unbounded one.
 *
 * Every code path that reserves MUST eventually either settle (real cost,
 * on success) or refund (on failure, or if a trial attempt failed over to
 * a non-trial provider mid-run and never actually spent) — an unsettled,
 * unrefunded reservation permanently strands part of the tenant's budget.
 * See refundTrialReservation() and its call sites in provider-chain.ts /
 * claude.ts.
 */

import { prisma } from "../lib/db";
import { env } from "../config/env";
import { logger } from "../lib/logger";
import type { AIClientConfig } from "./ai-client";
import {
  trialCreditEnabled,
  reserveTrialCredit,
  settleTrialCredit,
  refundTrialCredit,
} from "../modules/billing/trial-credit.service";

/**
 * Reservation ceiling for ONE trial-llm-served unit of work (a full
 * multi-turn pipeline run, capped at TRIAL_MAX_TURNS turns, or a single
 * completion). Sized from real GROQ llama-3.3-70b-versatile pricing
 * ($0.59/$0.79 per M tokens) against a worst-case heavy-tool-use turn —
 * deliberately generous headroom over a typical run's real cost (usually
 * ~$0.01-0.03), not a tight estimate, so settling almost never needs to
 * push the bucket past what was reserved.
 */
export const TRIAL_LLM_RESERVATION_USD = 0.1;

export interface TrialDecision {
  config: AIClientConfig;
  remainingBefore: number;
  remainingAfter: number;
}

/**
 * True when the holding-owned Groq key is configured. When false the
 * trial system is dormant — tenants without their own AI config fall
 * straight to the BYOK error path.
 */
export function trialEnabled(): boolean {
  return !!process.env.GROQ_API_KEY && process.env.GROQ_API_KEY.length > 0;
}

/**
 * Check whether a tenant is eligible for a trial run AND has remaining
 * credit. Returns a Groq AIClientConfig if so, null if not. Does NOT
 * mutate the counter — pair with `commitTrialRun()` after success.
 *
 * Tenants on any non-FREE plan are explicitly excluded — they pay us
 * already, so trial credits are pointless and would actually drain our
 * Groq budget for no reason.
 */
export async function tryConsumeTrialRun(tenantId: string): Promise<TrialDecision | null> {
  if (!trialEnabled()) return null;

  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { plan: true, trialRunsUsed: true, trialRunsLimit: true },
  });

  if (!tenant) {
    logger.warn({ tenantId }, "tryConsumeTrialRun: tenant not found");
    return null;
  }

  // Subscribed tenants are never routed through the trial pool.
  if (tenant.plan !== "FREE") return null;

  const remaining = tenant.trialRunsLimit - tenant.trialRunsUsed;
  if (remaining <= 0) return null;

  // Abuse guard: at least one user on the tenant must have a verified email.
  // User.emailVerifiedAt's own schema comment has promised this since it was
  // added ("free-tier abuse vectors are restricted") but nothing enforced it
  // — an unlimited number of unverified signups could each farm a fresh
  // trialRunsLimit. Checked after the cheap remaining-credit check so an
  // already-exhausted tenant never pays for the extra query.
  const verifiedUser = await prisma.user.findFirst({
    where: { tenantId, emailVerifiedAt: { not: null } },
    select: { id: true },
  });
  if (!verifiedUser) {
    logger.info(
      { tenantId },
      "tryConsumeTrialRun: no verified-email user on tenant — trial credit withheld (fail-closed)",
    );
    return null;
  }

  // $0.30 total cost cap — checked last (most expensive: an atomic DB
  // write against the shared credit bucket) and short-circuited entirely
  // while the cap is disabled (env.FORGE_TRIAL_CREDIT_USD_CAP=0, prod's
  // current default), so this is a complete no-op until that value is
  // deliberately raised. ATOMIC reservation, not a read-then-later-write
  // check — see the module docblock for why a plain check is unsafe here.
  // Whoever gets a reservation back from this call OWNS it: they MUST
  // settle (commitTrialRun with a real costUsd) or refund
  // (refundTrialReservation) it — the caller (buildTenantProviderChain via
  // runProviderAgentLoop, or resolveTenantCompletionLink's callers) does
  // this by branching on the returned config's presence, same as the run
  // counter above.
  if (trialCreditEnabled()) {
    const reservation = await reserveTrialCredit(tenantId, TRIAL_LLM_RESERVATION_USD);
    if (!reservation) {
      logger.info(
        { tenantId, reservationUsd: TRIAL_LLM_RESERVATION_USD },
        "tryConsumeTrialRun: hosted-trial cost cap reached — trial credit withheld (fail-closed)",
      );
      return null;
    }
  }

  const trialKey = process.env.GROQ_API_KEY!;
  const trialModel = process.env.GROQ_TRIAL_MODEL || "llama-3.3-70b-versatile";

  return {
    config: {
      provider: "GROQ",
      model: trialModel,
      apiKey: trialKey,
    },
    remainingBefore: remaining,
    remainingAfter: remaining - 1,
  };
}

/**
 * Commit a successful trial run — increments the counter atomically.
 * Called from the executor after the AI call returns. If the run failed,
 * skip this — we don't burn trial credit on our own errors.
 *
 * `costUsd`, when given, trues the ALREADY-RESERVED TRIAL_LLM_RESERVATION_USD
 * up to the REAL cost in the shared $0.30 hosted-trial bucket (see the
 * module docblock) — the caller must only pass costUsd when it actually
 * held a reservation (i.e. tryConsumeTrialRun returned non-null AND
 * trialCreditEnabled() was true for that call), otherwise settleTrialCredit
 * would incorrectly credit back a reservation that was never taken. A
 * no-op whenever the cap is disabled or no cost was measured, and never
 * allowed to fail the run-count commit: the counter is the run-count
 * source of truth and must land even if the cost bucket write has a
 * transient hiccup (mirrors trial-credit.service.ts's own "non-fatal,
 * self-corrects" stance on bucket writes).
 */
export async function commitTrialRun(tenantId: string, costUsd?: number): Promise<void> {
  await prisma.tenant.update({
    where: { id: tenantId },
    data: { trialRunsUsed: { increment: 1 } },
  });
  logger.info({ tenantId }, "Trial run committed");

  if (costUsd !== undefined && trialCreditEnabled()) {
    try {
      await settleTrialCredit(tenantId, TRIAL_LLM_RESERVATION_USD, costUsd);
    } catch (err) {
      logger.warn(
        { tenantId, costUsd, err: (err as Error).message },
        "commitTrialRun: settling the hosted-trial cost bucket failed (non-fatal — run-count commit already landed)",
      );
    }
  }
}

/**
 * Refund an unused hosted-trial cost reservation — call this whenever
 * tryConsumeTrialRun granted a decision (with the cap enabled) but the
 * work it funded did NOT end up settling: the call threw before
 * completing, or (agent-loop only) a trial attempt failed over to a
 * different, non-trial provider mid-run and never actually spent Groq
 * budget. Symmetric with commitTrialRun's settle path — every reservation
 * must end in exactly one of settle or refund, never both, never neither.
 * Non-fatal and self-correcting on failure, same stance as every other
 * bucket write in this cap (trial-credit.service.ts's own docblock).
 */
export async function refundTrialReservation(tenantId: string): Promise<void> {
  if (!trialCreditEnabled()) return;
  try {
    await refundTrialCredit(tenantId, TRIAL_LLM_RESERVATION_USD);
  } catch (err) {
    logger.warn(
      { tenantId, err: (err as Error).message },
      "refundTrialReservation: refunding the hosted-trial cost bucket failed (non-fatal)",
    );
  }
}

/**
 * Snapshot of trial state — exposed via /api/v1/users/me and the
 * dashboard banner so users see how many runs they have left.
 */
export async function getTrialStatus(tenantId: string): Promise<{
  enabled: boolean;
  used: number;
  limit: number;
  remaining: number;
  exhausted: boolean;
}> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { plan: true, trialRunsUsed: true, trialRunsLimit: true },
  });

  if (!tenant) {
    return { enabled: false, used: 0, limit: 0, remaining: 0, exhausted: true };
  }

  // Trial is irrelevant for paid plans — pretend it doesn't exist.
  if (tenant.plan !== "FREE") {
    return { enabled: false, used: 0, limit: 0, remaining: 0, exhausted: false };
  }

  const remaining = Math.max(0, tenant.trialRunsLimit - tenant.trialRunsUsed);
  return {
    enabled: trialEnabled(),
    used: tenant.trialRunsUsed,
    limit: tenant.trialRunsLimit,
    remaining,
    exhausted: remaining === 0,
  };
}

// Cheap re-export so executor can avoid importing env directly.
export const trialModel = () => env.GROQ_TRIAL_MODEL || "llama-3.3-70b-versatile";
