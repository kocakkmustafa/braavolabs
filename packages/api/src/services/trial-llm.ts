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
 * primitives are reused here, not reimplemented. Unlike the run counter,
 * this is a plain check-before / settle-after (no upfront reservation):
 * trial-credit.service.ts reserves upfront because a single validation
 * ping is cheap enough to lock atomically end-to-end; a full trial-served
 * pipeline run is not, and this module's own race tolerance above already
 * accepts the equivalent imprecision for the run counter. Same trade,
 * applied consistently — cheaper to live with a small race than to hold a
 * reservation open across an entire agent-loop run.
 */

import { prisma } from "../lib/db";
import { env } from "../config/env";
import { logger } from "../lib/logger";
import type { AIClientConfig } from "./ai-client";
import {
  trialCreditEnabled,
  getForgeTrialCreditStatus,
  settleTrialCredit,
} from "../modules/billing/trial-credit.service";

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

  // $0.30 total cost cap — checked last (most expensive: a DB read against
  // the shared credit bucket) and short-circuited entirely while the cap is
  // disabled (env.FORGE_TRIAL_CREDIT_USD_CAP=0, prod's current default), so
  // this is a complete no-op until that value is deliberately raised.
  if (trialCreditEnabled()) {
    const creditStatus = await getForgeTrialCreditStatus(tenantId);
    if (creditStatus.exhausted) {
      logger.info(
        { tenantId, spentUsd: creditStatus.spentUsd, capUsd: creditStatus.capUsd },
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
 * `costUsd`, when given, retires that REAL cost from the shared $0.30
 * hosted-trial bucket (see the module docblock) — passed as `reservationUsd
 * = 0` to settleTrialCredit since nothing was reserved upfront here, so the
 * whole cost becomes the delta. A no-op whenever the cap is disabled or no
 * cost was measured, and never allowed to fail the run-count commit: the
 * counter is the run-count source of truth and must land even if the cost
 * bucket write has a transient hiccup (mirrors trial-credit.service.ts's
 * own "non-fatal, self-corrects" stance on bucket writes).
 */
export async function commitTrialRun(tenantId: string, costUsd?: number): Promise<void> {
  await prisma.tenant.update({
    where: { id: tenantId },
    data: { trialRunsUsed: { increment: 1 } },
  });
  logger.info({ tenantId }, "Trial run committed");

  if (costUsd !== undefined && trialCreditEnabled()) {
    try {
      await settleTrialCredit(tenantId, 0, costUsd);
    } catch (err) {
      logger.warn(
        { tenantId, costUsd, err: (err as Error).message },
        "commitTrialRun: settling the hosted-trial cost bucket failed (non-fatal — run-count commit already landed)",
      );
    }
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
