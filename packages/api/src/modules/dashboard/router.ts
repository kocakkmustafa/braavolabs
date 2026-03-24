import { Router } from "express";
import { authMiddleware } from "../../middleware/auth";
import { prisma } from "../../lib/db";

export const dashboardRouter = Router();
dashboardRouter.use(authMiddleware);

// GET /api/v1/dashboard/health — system health
dashboardRouter.get("/health", async (req, res, next) => {
  try {
    const tenantId = req.auth!.tenantId;

    const [companyCount, activeRuns, pendingApprovals] = await Promise.all([
      prisma.company.count({ where: { tenantId, status: "ACTIVE" } }),
      prisma.run.count({
        where: {
          status: "RUNNING",
          pipeline: { company: { tenantId } },
        },
      }),
      prisma.approval.count({
        where: {
          status: "PENDING",
          run: { pipeline: { company: { tenantId } } },
        },
      }),
    ]);

    res.json({
      status: "healthy",
      activeCompanies: companyCount,
      activeRuns,
      pendingApprovals,
      timestamp: new Date().toISOString(),
    });
  } catch (err) { next(err); }
});

// GET /api/v1/dashboard/usage — usage stats
dashboardRouter.get("/usage", async (req, res, next) => {
  try {
    const tenantId = req.auth!.tenantId;

    const now = new Date();
    const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const [totalRuns, completedRuns, failedRuns] = await Promise.all([
      prisma.run.count({
        where: {
          createdAt: { gte: periodStart },
          pipeline: { company: { tenantId } },
        },
      }),
      prisma.run.count({
        where: {
          status: "COMPLETED",
          createdAt: { gte: periodStart },
          pipeline: { company: { tenantId } },
        },
      }),
      prisma.run.count({
        where: {
          status: "FAILED",
          createdAt: { gte: periodStart },
          pipeline: { company: { tenantId } },
        },
      }),
    ]);

    res.json({
      period: { start: periodStart.toISOString(), end: now.toISOString() },
      totalRuns,
      completedRuns,
      failedRuns,
      successRate: totalRuns > 0 ? completedRuns / totalRuns : 0,
    });
  } catch (err) { next(err); }
});

// GET /api/v1/dashboard/runs — recent runs list
dashboardRouter.get("/runs", async (req, res, next) => {
  try {
    const tenantId = req.auth!.tenantId;
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const offset = Number(req.query.offset) || 0;

    const runs = await prisma.run.findMany({
      where: { pipeline: { company: { tenantId } } },
      include: {
        pipeline: { include: { company: { select: { id: true, name: true } } } },
        _count: { select: { steps: true } },
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
    });

    const total = await prisma.run.count({
      where: { pipeline: { company: { tenantId } } },
    });

    res.json({ runs, total, limit, offset });
  } catch (err) { next(err); }
});

// GET /api/v1/dashboard/activity — recent activity log
dashboardRouter.get("/activity", async (req, res, next) => {
  try {
    const tenantId = req.auth!.tenantId;
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const offset = Number(req.query.offset) || 0;

    const logs = await prisma.activityLog.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
    });

    const total = await prisma.activityLog.count({ where: { tenantId } });

    res.json({ logs, total, limit, offset });
  } catch (err) { next(err); }
});

// GET /api/v1/dashboard/risk-events — risk stops and anomalies from activity log
dashboardRouter.get("/risk-events", async (req, res, next) => {
  try {
    const tenantId = req.auth!.tenantId;
    const limit = Math.min(Number(req.query.limit) || 50, 100);

    const events = await prisma.activityLog.findMany({
      where: {
        tenantId,
        action: {
          in: [
            "governance.hard_stop",
            "governance.loop_stop",
            "governance.cost_anomaly_stop",
            "governance.spam_stop",
            "governance.brand_violation_stop",
            "run.failed",
            "run.stop",
          ],
        },
      },
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    res.json(events);
  } catch (err) { next(err); }
});

// GET /api/v1/dashboard/finance — cost summary
dashboardRouter.get("/finance", async (req, res, next) => {
  try {
    const tenantId = req.auth!.tenantId;

    const now = new Date();
    const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const runs = await prisma.run.findMany({
      where: {
        createdAt: { gte: periodStart },
        pipeline: { company: { tenantId } },
        costUsd: { not: null },
      },
      select: { costUsd: true },
    });

    const totalCost = runs.reduce(
      (sum, r) => sum + Number(r.costUsd ?? 0),
      0,
    );

    res.json({
      period: { start: periodStart.toISOString(), end: now.toISOString() },
      totalCostUsd: totalCost,
      runCount: runs.length,
      avgCostPerRun: runs.length > 0 ? totalCost / runs.length : 0,
    });
  } catch (err) { next(err); }
});
