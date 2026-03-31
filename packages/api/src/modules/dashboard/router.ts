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

// GET /api/v1/dashboard/agent-performance — per-agent metrics
dashboardRouter.get("/agent-performance", async (req, res, next) => {
  try {
    const tenantId = req.auth!.tenantId;
    const now = new Date();
    const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);

    // Get all agents belonging to this tenant
    const agents = await prisma.agent.findMany({
      where: { company: { tenantId } },
      select: {
        id: true,
        name: true,
        role: true,
        companyId: true,
        company: { select: { name: true } },
      },
    });

    const agentIds = agents.map((a) => a.id);

    // Aggregate run steps by agent
    const stepGroups = await prisma.runStep.groupBy({
      by: ["agentId", "status"],
      where: {
        agentId: { in: agentIds },
        createdAt: { gte: periodStart },
      },
      _count: { id: true },
      _sum: { costUsd: true },
    });

    // Average duration per agent
    const stepDurations = await prisma.runStep.findMany({
      where: {
        agentId: { in: agentIds },
        createdAt: { gte: periodStart },
        startedAt: { not: null },
        completedAt: { not: null },
      },
      select: {
        agentId: true,
        startedAt: true,
        completedAt: true,
        costUsd: true,
      },
    });

    // Tool call distribution per agent
    const toolCallsByAgent = await prisma.toolCall.groupBy({
      by: ["toolName"],
      where: {
        runStep: {
          agentId: { in: agentIds },
          createdAt: { gte: periodStart },
        },
      },
      _count: { id: true },
    });

    // Tool calls count per agent
    const toolCallCountsByAgent = await prisma.$queryRaw<Array<{ agentId: string; count: bigint }>>`
      SELECT rs."agentId", COUNT(tc.id) as count
      FROM "ToolCall" tc
      JOIN "RunStep" rs ON tc."runStepId" = rs.id
      WHERE rs."agentId" = ANY(${agentIds})
        AND rs."createdAt" >= ${periodStart}
      GROUP BY rs."agentId"
    `;

    // Build per-agent stats map
    const statsMap: Record<string, {
      totalRuns: number;
      completedRuns: number;
      failedRuns: number;
      successRate: number;
      totalCostUsd: number;
      avgCostPerRun: number;
      avgDurationMs: number;
      totalToolCalls: number;
    }> = {};

    for (const agent of agents) {
      const completed = stepGroups.find((g) => g.agentId === agent.id && g.status === "COMPLETED")?._count.id ?? 0;
      const failed = stepGroups.find((g) => g.agentId === agent.id && g.status === "FAILED")?._count.id ?? 0;
      const total = completed + failed;

      const costSum = stepGroups
        .filter((g) => g.agentId === agent.id)
        .reduce((sum, g) => sum + Number(g._sum.costUsd ?? 0), 0);

      const agentDurations = stepDurations.filter((s) => s.agentId === agent.id);
      const avgDuration = agentDurations.length > 0
        ? agentDurations.reduce((sum, s) => {
          const ms = s.completedAt && s.startedAt
            ? s.completedAt.getTime() - s.startedAt.getTime()
            : 0;
          return sum + ms;
        }, 0) / agentDurations.length
        : 0;

      const toolCallEntry = toolCallCountsByAgent.find((t) => t.agentId === agent.id);
      const toolCalls = Number(toolCallEntry?.count ?? 0);

      statsMap[agent.id] = {
        totalRuns: total,
        completedRuns: completed,
        failedRuns: failed,
        successRate: total > 0 ? completed / total : 0,
        totalCostUsd: costSum,
        avgCostPerRun: total > 0 ? costSum / total : 0,
        avgDurationMs: avgDuration,
        totalToolCalls: toolCalls,
      };
    }

    const result = agents.map((agent) => ({
      agentId: agent.id,
      agentName: agent.name,
      role: agent.role,
      companyId: agent.companyId,
      companyName: agent.company.name,
      period: { start: periodStart.toISOString(), end: now.toISOString() },
      ...statsMap[agent.id],
    }));

    // Sort by total runs desc
    result.sort((a, b) => b.totalRuns - a.totalRuns);

    res.json({
      agents: result,
      toolDistribution: toolCallsByAgent.map((t) => ({
        toolName: t.toolName,
        count: t._count.id,
      })).sort((a, b) => b.count - a.count),
      period: { start: periodStart.toISOString(), end: now.toISOString() },
    });
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
