/**
 * Governance Router — Faz 6
 *
 * Risk detection, safety stops, policy enforcement.
 */

import { Router } from "express";
import { requirePermission } from "../../middleware/require-permission";
import { authMiddleware } from "../../middleware/auth";
import { prisma } from "../../lib/db";
import { AppError } from "../../middleware/error";
import { getGovernanceConfig, getRiskSummary } from "./engine";
import { DEFAULT_GOVERNANCE_CONFIG, RISK_STOP_DESCRIPTIONS } from "@ai-company-os/core";
import { ACTIVITY_REVISION_SELECT } from "../../lib/activity-projection";

export const governanceRouter = Router();
governanceRouter.use(authMiddleware);

// GET /api/v1/governance/config — get governance config
governanceRouter.get("/config", async (_req, res) => {
  const config = DEFAULT_GOVERNANCE_CONFIG;
  res.json({
    config,
    stopDescriptions: RISK_STOP_DESCRIPTIONS,
  });
});

// GET /api/v1/governance/risks — risk event summary
governanceRouter.get("/risks", async (req, res, next) => {
  try {
    const summary = await getRiskSummary(req.auth!.tenantId);
    res.json(summary);
  } catch (err) { next(err); }
});

// GET /api/v1/governance/stops — recent risk stops with details
governanceRouter.get("/stops", async (req, res, next) => {
  try {
    const tenantId = req.auth!.tenantId;
    const limit = Math.min(Number(req.query.limit) || 50, 100);

    const stops = await prisma.activityLog.findMany({
      // The route's own contract is "recent risk stops WITH DETAILS", and the
      // payload is the diagnostic: engine.ts writes { reason, stopType, ... }.
      // Narrowing this to the feed silently emptied the thing the endpoint
      // exists to return — the same mistake as /dashboard/risk-events, caught
      // here by reading the route's stated contract rather than its types.
      // Scoped to `governance.*` actions, so this is operational diagnostics,
      // not the billing/PII class that motivated the split. Still no `ip`.
      select: ACTIVITY_REVISION_SELECT,
      where: {
        tenantId,
        action: { startsWith: "governance." },
      },
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    res.json(stops);
  } catch (err) { next(err); }
});

// POST /api/v1/governance/hard-stop/:runId — manually trigger a hard stop on a run
governanceRouter.post("/hard-stop/:runId", requirePermission("governance:hard-stop"), async (req, res, next) => {
  try {
    const run = await prisma.run.findUnique({
      where: { id: req.params.runId },
      include: { pipeline: { include: { company: true } } },
    });

    if (!run || run.pipeline.company.tenantId !== req.auth!.tenantId) {
      throw new AppError(404, "Run not found");
    }

    if (run.status !== "RUNNING" && run.status !== "PAUSED" && run.status !== "WAITING_APPROVAL") {
      throw new AppError(400, "Run is not in a stoppable state");
    }

    // Create hard stop activity log
    await prisma.activityLog.create({
      data: {
        tenantId: req.auth!.tenantId,
        actor: req.auth!.userId,
        action: "governance.hard_stop",
        resource: "run",
        resourceId: run.id,
        details: { reason: req.body.reason ?? "Manual hard stop" },
      },
    });

    // Update run status
    await prisma.run.update({
      where: { id: run.id },
      data: {
        status: "FAILED",
        error: `Hard stop: ${req.body.reason ?? "Manually stopped by governance policy"}`,
        completedAt: new Date(),
      },
    });

    res.json({ success: true, status: "FAILED", stopType: "hard_stop" });
  } catch (err) { next(err); }
});

// GET /api/v1/governance/eval-results — eval run results
governanceRouter.get("/eval-results", async (req, res, next) => {
  try {
    const tenantId = req.auth!.tenantId;
    const limit = Math.min(Number(req.query.limit) || 50, 100);

    const results = await prisma.evalResult.findMany({
      where: { company: { tenantId } },
      orderBy: { createdAt: "desc" },
      take: limit,
      include: { company: { select: { name: true } } },
    });

    res.json(results);
  } catch (err) { next(err); }
});
