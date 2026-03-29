/**
 * Memory Consolidation Cron — runs daily to promote/deprecate memory items.
 *
 * - Promotes CANDIDATE memories with high confidence + use count to APPROVED
 * - Deprecates APPROVED memories not used in 90 days
 * - Logs all consolidation activity
 */

import { prisma } from "../../lib/db";
import { logger } from "../../lib/logger";

const CONSOLIDATION_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

async function runConsolidation() {
  logger.info("Starting memory consolidation cron");

  try {
    // Get all tenants with companies
    const companies = await prisma.company.findMany({
      where: { status: "ACTIVE" },
      select: { id: true, tenantId: true },
    });

    let totalPromoted = 0;
    let totalDeprecated = 0;

    for (const company of companies) {
      // Promote candidates with high confidence and use count
      const promoted = await prisma.memoryItem.updateMany({
        where: {
          companyId: company.id,
          status: "CANDIDATE",
          confidence: { gte: 0.8 },
          useCount: { gte: 3 },
        },
        data: { status: "APPROVED", promotedAt: new Date() },
      });

      // Deprecate stale approved memories (not used in 90 days)
      const staleDate = new Date();
      staleDate.setDate(staleDate.getDate() - 90);
      const deprecated = await prisma.memoryItem.updateMany({
        where: {
          companyId: company.id,
          status: "APPROVED",
          lastUsedAt: { not: null, lt: staleDate },
        },
        data: { status: "DEPRECATED" },
      });

      totalPromoted += promoted.count;
      totalDeprecated += deprecated.count;

      if (promoted.count > 0 || deprecated.count > 0) {
        await prisma.activityLog.create({
          data: {
            tenantId: company.tenantId,
            actor: "system",
            action: "memory.consolidation",
            resource: "company",
            resourceId: company.id,
            details: { promoted: promoted.count, deprecated: deprecated.count },
          },
        });
      }
    }

    logger.info(
      { totalPromoted, totalDeprecated, companiesProcessed: companies.length },
      "Memory consolidation completed",
    );
  } catch (err) {
    logger.error({ error: err }, "Memory consolidation failed");
  }
}

let consolidationTimer: NodeJS.Timeout | null = null;

export function initConsolidationCron() {
  // Run once on startup (after 1 minute delay)
  setTimeout(() => {
    runConsolidation();
  }, 60_000);

  // Then run every 24 hours
  consolidationTimer = setInterval(runConsolidation, CONSOLIDATION_INTERVAL_MS);

  logger.info("Memory consolidation cron initialized (24h interval)");
}

export function stopConsolidationCron() {
  if (consolidationTimer) {
    clearInterval(consolidationTimer);
    consolidationTimer = null;
  }
}
