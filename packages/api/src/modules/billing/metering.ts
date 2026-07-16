/**
 * Usage Metering — Faz 5
 *
 * Tracks run usage per tenant. Updates local usage_meters table
 * and optionally reports to Stripe.
 */

import { prisma, tenantTx } from "../../lib/db";
import { logger } from "../../lib/logger";
import { PLAN_LIMITS } from "@ai-company-os/core";
import type { Plan } from "@ai-company-os/core";
import { env } from "../../config/env";

/**
 * Increment a usage meter for the current billing period.
 */
export async function incrementMeter(
  tenantId: string,
  metric: string,
  amount = 1,
): Promise<{ value: number; limit: number; exceeded: boolean }> {
  const now = new Date();
  // UTC anchored — local-tz constructors silently drift the period boundary
  // for servers in non-UTC zones (e.g. Europe/Istanbul +03:00). At month
  // rollover this caused the upsert key to land in the *previous* month's
  // row for runs in the first 3 hours of the new month UTC.
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

  // Upsert the meter
  const meter = await prisma.usageMeter.upsert({
    where: {
      tenantId_metric_periodStart: {
        tenantId,
        metric,
        periodStart,
      },
    },
    update: { value: { increment: amount } },
    create: {
      tenantId,
      metric,
      value: amount,
      periodStart,
      periodEnd,
    },
  });

  // Get tenant plan to check limits
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { plan: true },
  });

  const plan = (tenant?.plan ?? "FREE") as Plan;
  const limits = PLAN_LIMITS[plan];
  const limit = metric === "runs" ? limits.maxRunsPerMonth : -1;
  const exceeded = limit > 0 && meter.value > limit;

  if (exceeded) {
    logger.warn(
      { tenantId, metric, value: meter.value, limit },
      "Usage limit exceeded",
    );
  }

  return { value: meter.value, limit, exceeded };
}

/**
 * Atomically claim one unit of quota — single SQL statement that either
 * increments the meter (within limit) or refuses (over limit). Use this in
 * place of `checkQuota → incrementMeter` whenever the check and the bump
 * must be the same critical section, e.g. POST /pipelines/:id/run where
 * two concurrent requests at value=9, limit=10 must not both succeed
 * (ISS-010 TOCTOU race).
 *
 * Returns `{ claimed: true, value }` on success, `{ claimed: false, value, limit }`
 * when over limit, and short-circuits to `{ claimed: true, value: -1, limit: -1 }`
 * when BYPASS_BILLING is set or the metric has no plan limit.
 */
export async function claimQuota(
  tenantId: string,
  metric: string,
): Promise<{ claimed: boolean; value: number; limit: number }> {
  if (env.BYPASS_BILLING) {
    return { claimed: true, value: -1, limit: -1 };
  }

  // Resolve the plan limit first — cheap read, lets us short-circuit
  // unlimited metrics without touching usage_meters.
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { plan: true },
  });
  const plan = (tenant?.plan ?? "FREE") as Plan;
  const limits = PLAN_LIMITS[plan];
  const limit = metric === "runs" ? limits.maxRunsPerMonth : -1;

  if (limit < 0) {
    // Unlimited — still bump the counter for analytics, but don't gate.
    await incrementMeter(tenantId, metric, 1);
    return { claimed: true, value: -1, limit: -1 };
  }

  const now = new Date();
  // UTC anchored — local-tz constructors silently drift the period boundary
  // for servers in non-UTC zones (e.g. Europe/Istanbul +03:00). At month
  // rollover this caused the upsert key to land in the *previous* month's
  // row for runs in the first 3 hours of the new month UTC.
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

  // Single atomic upsert: insert with value=1 if no row exists, else
  // increment IFF still below the limit. The conditional WHERE on the
  // DO UPDATE branch is the critical section that closes the TOCTOU
  // window — two concurrent claims at value=9 with limit=10 will see
  // the second hit `WHERE value < limit` after the first commits, so
  // exactly one returns 1 row and the other returns 0.
  const rows = await tenantTx((tx) => tx.$queryRaw<Array<{ value: number }>>`
    INSERT INTO usage_meters (id, tenant_id, metric, value, period_start, period_end, created_at, updated_at)
    VALUES (gen_random_uuid()::text, ${tenantId}, ${metric}, 1, ${periodStart}, ${periodEnd}, NOW(), NOW())
    ON CONFLICT (tenant_id, metric, period_start) DO UPDATE
      SET value = usage_meters.value + 1, updated_at = NOW()
      WHERE usage_meters.value < ${limit}
    RETURNING value
  `);

  if (rows.length === 0) {
    // Conflict happened but the WHERE on UPDATE failed → over limit.
    // Read the current value so the caller can build a useful message.
    const current = await prisma.usageMeter.findUnique({
      where: {
        tenantId_metric_periodStart: { tenantId, metric, periodStart },
      },
      select: { value: true },
    });
    const value = current?.value ?? limit;
    logger.warn({ tenantId, metric, value, limit }, "Quota claim refused — over limit");
    return { claimed: false, value, limit };
  }

  return { claimed: true, value: rows[0]!.value, limit };
}

/**
 * Release one unit of quota previously taken by `claimQuota`. Used when a
 * claim succeeded but the work it was claimed for then failed to start
 * (e.g. the webhook fan-out claims a run, then `run.create`/`enqueueRun`
 * throws) — without this, a flapping enqueue path slowly burns a tenant's
 * monthly quota with no runs to show for it (FINDINGS M3). Decrement is
 * clamped at 0 so a double-release can't drive the meter negative. No-op
 * when billing is bypassed or the period row doesn't exist yet.
 */
export async function releaseQuota(tenantId: string, metric: string, amount = 1): Promise<void> {
  if (env.BYPASS_BILLING) return;
  const now = new Date();
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  try {
    await tenantTx((tx) => tx.$executeRaw`
      UPDATE usage_meters
      SET value = GREATEST(0, value - ${amount}), updated_at = NOW()
      WHERE tenant_id = ${tenantId} AND metric = ${metric} AND period_start = ${periodStart}
    `);
  } catch (err) {
    // Non-fatal — the meter will self-correct at the next period rollover.
    logger.warn({ err, tenantId, metric }, "releaseQuota failed");
  }
}

/**
 * Check if tenant has remaining quota for a metric.
 *
 * NOTE: This is the read-only check used for UI badges, billing summaries,
 * and pre-flight messages. It is NOT race-safe — for the actual gate at
 * POST /pipelines/:id/run, use `claimQuota()` instead. See ISS-010.
 */
export async function checkQuota(
  tenantId: string,
  metric: string,
): Promise<{ allowed: boolean; remaining: number; limit: number }> {
  // Bypass billing for testing/development
  if (env.BYPASS_BILLING) {
    return { allowed: true, remaining: -1, limit: -1 };
  }

  const now = new Date();
  // UTC anchored — must match the writer in incrementMeter/claimQuota.
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  const meter = await prisma.usageMeter.findUnique({
    where: {
      tenantId_metric_periodStart: {
        tenantId,
        metric,
        periodStart,
      },
    },
  });

  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { plan: true },
  });

  const plan = (tenant?.plan ?? "FREE") as Plan;
  const limits = PLAN_LIMITS[plan];
  const limit = metric === "runs" ? limits.maxRunsPerMonth : -1;
  const currentValue = meter?.value ?? 0;

  if (limit < 0) {
    return { allowed: true, remaining: -1, limit: -1 };
  }

  return {
    allowed: currentValue < limit,
    remaining: Math.max(0, limit - currentValue),
    limit,
  };
}
