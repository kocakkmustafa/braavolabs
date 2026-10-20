/**
 * Governance Engine — Faz 6
 *
 * Centralized risk detection and safety enforcement.
 * All risk checks run between pipeline steps and can halt execution.
 */

import { prisma } from "../../lib/db";
import { logger } from "../../lib/logger";
import { DEFAULT_GOVERNANCE_CONFIG } from "@ai-company-os/core";
import type { GovernanceConfig, RiskStopType } from "@ai-company-os/core";
import { notifyTenantUsers } from "../../services/push";
import { governanceReasonCopy } from "../../lib/notificationCopy";

export interface GovernanceCheckResult {
  allowed: boolean;
  stopType?: RiskStopType;
  reason?: string;
  details?: Record<string, unknown>;
}

/**
 * Run all governance checks for a given run at a given point in execution.
 */
export async function runGovernanceChecks(
  runId: string,
  currentCost: number,
  config: GovernanceConfig = DEFAULT_GOVERNANCE_CONFIG,
): Promise<GovernanceCheckResult> {
  const run = await prisma.run.findUnique({
    where: { id: runId },
    include: {
      steps: { orderBy: { stepIndex: "desc" } },
      pipeline: { include: { company: true } },
    },
  });

  if (!run) return { allowed: false, stopType: "hard_stop", reason: "Run not found" };

  const tenantId = run.pipeline.company.tenantId;
  const companyId = run.pipeline.company.id;

  // Run each enabled check
  for (const stopType of config.enabledStops) {
    const result = await runCheck(stopType, {
      run,
      currentCost,
      config,
      tenantId,
      companyId,
    });

    if (!result.allowed) {
      // Log the risk event
      await prisma.activityLog.create({
        data: {
          tenantId,
          actor: "governance",
          action: `governance.${stopType}`,
          resource: "run",
          resourceId: runId,
          details: {
            reason: result.reason,
            stopType: result.stopType,
            ...result.details,
          },
        },
      });

      logger.warn(
        { runId, stopType, reason: result.reason },
        "Governance check failed",
      );

      // Push to mobile companion app — `risks` pref defaults to ON
      // because cost anomalies / runaway loops are exactly what users
      // want to know about while away from their desk.
      const reasonCopy = governanceReasonCopy(result, config.costAnomalyThreshold);
      notifyTenantUsers(tenantId, "risk", {
        title: `Risk halted a run · ${stopType}`,
        body: result.reason ?? "A safety stop fired",
        data: { kind: "risk", id: runId, stopType },
        localized: {
          title: "push.riskTitle",
          body: reasonCopy?.key ?? (result.reason ? undefined : "push.riskFallback"),
          parameters: { ...reasonCopy?.parameters, stopType },
        },
      }).catch(() => {});

      return result;
    }
  }

  return { allowed: true };
}

interface CheckContext {
  run: any;
  currentCost: number;
  config: GovernanceConfig;
  tenantId: string;
  companyId: string;
}

async function runCheck(
  stopType: RiskStopType,
  ctx: CheckContext,
): Promise<GovernanceCheckResult> {
  switch (stopType) {
    case "cost_anomaly_stop":
      return checkCostAnomaly(ctx);
    case "loop_stop":
      return checkLoopDetection(ctx);
    case "spam_stop":
      return checkSpamProtection(ctx);
    case "brand_violation_stop":
      return checkBrandViolation(ctx);
    case "hard_stop":
      return checkHardStop(ctx);
    default:
      return { allowed: true };
  }
}

/**
 * Cost anomaly: run cost exceeds threshold % of budget.
 */
function checkCostAnomaly(ctx: CheckContext): GovernanceCheckResult {
  const budget = Number(ctx.run.budgetUsd ?? 0);
  if (budget <= 0) return { allowed: true };

  const threshold = budget * ctx.config.costAnomalyThreshold;
  if (ctx.currentCost > threshold) {
    return {
      allowed: false,
      stopType: "cost_anomaly_stop",
      reason: `Run cost $${ctx.currentCost.toFixed(4)} exceeds ${(ctx.config.costAnomalyThreshold * 100).toFixed(0)}% of budget ($${budget.toFixed(2)})`,
      details: { currentCost: ctx.currentCost, budget, threshold },
    };
  }
  return { allowed: true };
}

/**
 * Loop detection: N consecutive failed steps.
 */
function checkLoopDetection(ctx: CheckContext): GovernanceCheckResult {
  const maxFailures = ctx.config.maxConsecutiveFailures;
  const recentSteps = ctx.run.steps.slice(0, maxFailures);

  if (
    recentSteps.length >= maxFailures &&
    recentSteps.every((s: any) => s.status === "FAILED")
  ) {
    return {
      allowed: false,
      stopType: "loop_stop",
      reason: `${maxFailures} consecutive step failures detected`,
      details: { consecutiveFailures: maxFailures },
    };
  }
  return { allowed: true };
}

/**
 * Spam protection: check if outreach to same target exceeds limit.
 */
async function checkSpamProtection(ctx: CheckContext): Promise<GovernanceCheckResult> {
  // Check tool calls for outreach-related tools in this run
  const outreachCalls = await prisma.toolCall.findMany({
    where: {
      runStep: { runId: ctx.run.id },
      toolName: { in: ["send_email", "send_message", "outreach"] },
    },
    select: { input: true },
  });

  // Group by target
  const targetCounts = new Map<string, number>();
  for (const call of outreachCalls) {
    const input = call.input as any;
    const target = input?.to ?? input?.email ?? input?.target;
    if (target) {
      targetCounts.set(target, (targetCounts.get(target) ?? 0) + 1);
    }
  }

  for (const [target, count] of targetCounts) {
    if (count >= ctx.config.maxUnansweredOutreach) {
      return {
        allowed: false,
        stopType: "spam_stop",
        reason: `${count} unanswered outreach messages to ${target}`,
        details: { target, count, limit: ctx.config.maxUnansweredOutreach },
      };
    }
  }

  return { allowed: true };
}

/**
 * Brand violation: check for flagged content patterns.
 */
async function checkBrandViolation(ctx: CheckContext): Promise<GovernanceCheckResult> {
  // Check recent tool call outputs for brand violations
  const recentOutputs = await prisma.toolCall.findMany({
    where: {
      runStep: { runId: ctx.run.id },
      toolName: { in: ["generate_post", "create_draft"] },
    },
    select: { output: true },
    orderBy: { createdAt: "desc" },
    take: 5,
  });

  // Brand-safety patterns. Multilingual coverage so Turkish-content
  // pipelines (significant share of beta tenants) don't bypass the gate.
  // Categories:
  //   1. Defamation / negative competitor framing
  //   2. Get-rich-quick / financial scam language
  //   3. Risk-free / guaranteed-return claims (regulatory: SPK, FTC)
  //   4. Adult / illegal solicitation
  //   5. Hate speech / discrimination markers
  // Patterns deliberately conservative — false positives are auto-resumable
  // by the user via approval flow; false negatives ship spam to the world.
  const BLOCKED_PATTERNS = [
    // ── English ─────────────────────────────────────────────────────────
    /\b(competitor|lawsuit|scandal|fraud|scammer)\b/i,
    /\b(guaranteed returns?|get rich (quick|fast)|risk[\s-]?free profit)\b/i,
    /\b(free money|no risk|easy money|passive income guarantee)\b/i,
    /\b(buy now or miss out|act fast.*expires)\b/i,
    /\b(cure[s]? cancer|FDA approved.*(?!by)|clinically proven)\b/i,
    /\b(exclusive.*?one[\s-]?time only)\b/i,
    /\b(make \$?\d+k? in \d+ (days?|weeks?))\b/i,

    // ── Turkish ─────────────────────────────────────────────────────────
    /\b(rakip|dolandırıcı|skandal|dava|hile)\b/i,
    /\b(garanti(li)? (kazanç|kar)|risksiz (kazanç|kar))\b/i,
    /\b(kolay para|bedava para|sıfır risk)\b/i,
    /\b(hemen al(ma(yın)?|sın)?|kaç(ı|ır)\w* fırsat|son şans|stoklar tükeniyor)\b/i,
    /\b(\d+ (gün|hafta|ay) içinde \d+\s*(tl|usd|\$|₺))\b/i,
    /\b(bedava bitcoin|bedava kripto)\b/i,

    // ── Hate / discriminatory markers (multilingual) ────────────────────
    /\b(retard(ed)?|spaz|n[i1]gger|f[a4]g(g[o0]t)?|kike|chink|wetback)\b/i,

    // ── Adult / explicit ────────────────────────────────────────────────
    /\b(porn|xxx|escort service|onlyfans link)\b/i,
  ];

  for (const call of recentOutputs) {
    const output = JSON.stringify(call.output ?? "");
    for (const pattern of BLOCKED_PATTERNS) {
      if (pattern.test(output)) {
        return {
          allowed: false,
          stopType: "brand_violation_stop",
          reason: `Content flagged for brand safety: matched pattern "${pattern.source}"`,
          details: { pattern: pattern.source },
        };
      }
    }
  }

  return { allowed: true };
}

/**
 * Hard stop: check if run was manually flagged for stop.
 */
async function checkHardStop(ctx: CheckContext): Promise<GovernanceCheckResult> {
  // Check for hard stop activity log entries
  const hardStop = await prisma.activityLog.findFirst({
    where: {
      resourceId: ctx.run.id,
      action: "governance.hard_stop",
    },
  });

  if (hardStop) {
    return {
      allowed: false,
      stopType: "hard_stop",
      reason: "Run was manually stopped by governance policy",
    };
  }

  return { allowed: true };
}

/**
 * Get governance config for a company (uses defaults for now, configurable in future).
 */
export async function getGovernanceConfig(
  _companyId: string,
): Promise<GovernanceConfig> {
  // Future: load per-company overrides from DB
  return { ...DEFAULT_GOVERNANCE_CONFIG };
}

/**
 * Get summary of risk events for a tenant.
 */
export async function getRiskSummary(tenantId: string): Promise<{
  total: number;
  byType: Record<string, number>;
  recent: any[];
}> {
  const events = await prisma.activityLog.findMany({
    where: {
      tenantId,
      action: { startsWith: "governance." },
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  const byType: Record<string, number> = {};
  for (const e of events) {
    const type = e.action.replace("governance.", "");
    byType[type] = (byType[type] ?? 0) + 1;
  }

  return {
    total: events.length,
    byType,
    recent: events.slice(0, 20),
  };
}
