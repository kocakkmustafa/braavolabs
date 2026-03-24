/**
 * PQL (Product Qualified Lead) Scoring System
 *
 * Tracks user behaviors and scores them to identify high-intent free users
 * ready for upsell to paid plans.
 *
 * PQL signals (2+ of these = PQL):
 * - Completed onboarding (hero company created)
 * - 2+ successful pipeline runs
 * - Connected 1+ integration (CRM or email)
 * - Generated first draft proposal
 * - Started outreach sequence
 * - Revisited company health panel
 * - Visited spend approval screen
 * - Used draft edit/rollback/intervention
 * - Received first meaningful output
 *
 * High-Intent PQL (hot lead):
 * - Visited spend approval screen
 * - Tried creating 2nd company (hit limit)
 * - Hit usage limit
 * - Connected HubSpot/email integration
 * - Started auto follow-up
 */

import { prisma } from "../../lib/db";
import { logger } from "../../lib/logger";

export interface PQLSignal {
  key: string;
  label: string;
  triggered: boolean;
  highIntent: boolean;
}

export interface PQLScore {
  tenantId: string;
  score: number;
  isPQL: boolean;
  isHighIntent: boolean;
  signals: PQLSignal[];
  checkedAt: string;
}

/**
 * Calculate PQL score for a tenant.
 */
export async function calculatePQLScore(tenantId: string): Promise<PQLScore> {
  const signals: PQLSignal[] = [];

  // 1. Onboarding complete (has company)
  const companyCount = await prisma.company.count({ where: { tenantId } });
  signals.push({
    key: "onboarding_complete",
    label: "Completed onboarding",
    triggered: companyCount > 0,
    highIntent: false,
  });

  // 2. 2+ successful runs
  const successfulRuns = await prisma.run.count({
    where: { pipeline: { company: { tenantId } }, status: "COMPLETED" },
  });
  signals.push({
    key: "successful_runs",
    label: "2+ successful pipeline runs",
    triggered: successfulRuns >= 2,
    highIntent: false,
  });

  // 3. First draft created
  const draftCount = await prisma.draft.count({
    where: { company: { tenantId } },
  });
  signals.push({
    key: "first_draft",
    label: "Created first draft",
    triggered: draftCount > 0,
    highIntent: false,
  });

  // 4. Outreach sequence started
  const enrollmentCount = await prisma.outreachEnrollment.count({
    where: { sequence: { company: { tenantId } } },
  });
  signals.push({
    key: "outreach_started",
    label: "Started outreach sequence",
    triggered: enrollmentCount > 0,
    highIntent: false,
  });

  // 5. Dashboard health viewed (activity log)
  const healthViewed = await prisma.activityLog.count({
    where: { tenantId, action: "dashboard.health.viewed" },
  });
  signals.push({
    key: "health_revisited",
    label: "Revisited health dashboard",
    triggered: healthViewed >= 2,
    highIntent: false,
  });

  // 6. Draft edited / rollback used (intervention)
  const interventionCount = await prisma.activityLog.count({
    where: {
      tenantId,
      action: { in: ["draft.edit", "run_step.rollback", "run_step.rerun"] },
    },
  });
  signals.push({
    key: "used_intervention",
    label: "Used edit/rollback/rerun",
    triggered: interventionCount > 0,
    highIntent: false,
  });

  // --- High-Intent Signals ---

  // 7. Spend approval screen visited
  const approvalViewed = await prisma.activityLog.count({
    where: { tenantId, action: "approvals.viewed" },
  });
  signals.push({
    key: "spend_approval_visited",
    label: "Visited spend approval screen",
    triggered: approvalViewed > 0,
    highIntent: true,
  });

  // 8. Second company attempt (hit limit)
  const secondCompanyAttempt = await prisma.activityLog.count({
    where: { tenantId, action: "company.limit_reached" },
  });
  signals.push({
    key: "second_company_attempt",
    label: "Tried creating 2nd company",
    triggered: secondCompanyAttempt > 0,
    highIntent: true,
  });

  // 9. Hit usage limit
  const usageLimitHit = await prisma.activityLog.count({
    where: { tenantId, action: "usage.limit_reached" },
  });
  signals.push({
    key: "usage_limit_hit",
    label: "Hit usage limit",
    triggered: usageLimitHit > 0,
    highIntent: true,
  });

  // 10. Connected integration
  const integrationConnected = await prisma.activityLog.count({
    where: { tenantId, action: { startsWith: "integration.connected" } },
  });
  signals.push({
    key: "integration_connected",
    label: "Connected an integration",
    triggered: integrationConnected > 0,
    highIntent: true,
  });

  // Calculate score
  const triggeredCount = signals.filter((s) => s.triggered).length;
  const highIntentTriggered = signals.filter((s) => s.triggered && s.highIntent).length;
  const isPQL = triggeredCount >= 2;
  const isHighIntent = highIntentTriggered >= 1;

  const result: PQLScore = {
    tenantId,
    score: triggeredCount,
    isPQL,
    isHighIntent,
    signals,
    checkedAt: new Date().toISOString(),
  };

  // If PQL triggered, log it and create internal deal
  if (isPQL) {
    const alreadyFlagged = await prisma.activityLog.count({
      where: { tenantId, action: "pql.flagged" },
    });

    if (alreadyFlagged === 0) {
      await prisma.activityLog.create({
        data: {
          tenantId,
          actor: "system",
          action: "pql.flagged",
          resource: "tenant",
          resourceId: tenantId,
          details: {
            score: triggeredCount,
            isHighIntent,
            signals: signals.filter((s) => s.triggered).map((s) => s.key),
          },
        },
      });
      logger.info({ tenantId, score: triggeredCount, isHighIntent }, "PQL flagged");
    }
  }

  return result;
}

/**
 * Track a PQL-relevant activity event.
 */
export async function trackPQLEvent(
  tenantId: string,
  action: string,
  details?: Record<string, unknown>,
): Promise<void> {
  await prisma.activityLog.create({
    data: {
      tenantId,
      actor: "system",
      action,
      resource: "pql_event",
      details: (details ?? {}) as any,
    },
  });
}
