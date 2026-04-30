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
 */

import { prisma } from "../lib/db";
import { env } from "../config/env";
import { logger } from "../lib/logger";
import type { AIClientConfig } from "./ai-client";

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
 */
export async function commitTrialRun(tenantId: string): Promise<void> {
  await prisma.tenant.update({
    where: { id: tenantId },
    data: { trialRunsUsed: { increment: 1 } },
  });
  logger.info({ tenantId }, "Trial run committed");
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
