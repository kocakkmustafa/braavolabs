/**
 * Usage Metering — Faz 5
 *
 * Tracks run usage per tenant. Updates local usage_meters table
 * and optionally reports to Stripe.
 */

import { prisma } from "../../lib/db";
import { logger } from "../../lib/logger";
import { PLAN_LIMITS } from "@ai-company-os/core";
import type { Plan } from "@ai-company-os/core";

/**
 * Increment a usage meter for the current billing period.
 */
export async function incrementMeter(
  tenantId: string,
  metric: string,
  amount = 1,
): Promise<{ value: number; limit: number; exceeded: boolean }> {
  const now = new Date();
  const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);

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
 * Check if tenant has remaining quota for a metric.
 */
export async function checkQuota(
  tenantId: string,
  metric: string,
): Promise<{ allowed: boolean; remaining: number; limit: number }> {
  const now = new Date();
  const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);

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
