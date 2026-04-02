/**
 * A/B Test Router — Agent prompt/config variant testing
 *
 * Lets users create variants of agent prompts/configs and track
 * which performs better via recorded metrics.
 */

import { Router } from "express";
import { authMiddleware } from "../../middleware/auth";
import { prisma } from "../../lib/db";
import { AppError } from "../../middleware/error";
import { z } from "zod";

export const abTestRouter = Router();
abTestRouter.use(authMiddleware);

// ─── Validation schemas ────────────────────────────────

const variantSchema = z.object({
  name: z.string().min(1).max(100),
  config: z.record(z.any()),
  weight: z.number().int().min(1).max(100).optional().default(50),
});

const createSchema = z.object({
  companyId: z.string().min(1),
  agentId: z.string().min(1),
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  variants: z.array(variantSchema).min(2).max(10),
});

const recordMetricSchema = z.object({
  variantId: z.string().min(1),
  runId: z.string().optional(),
  metric: z.string().min(1).max(100),
  value: z.number(),
  metadata: z.record(z.any()).optional(),
});

const completeSchema = z.object({
  winnerVariantId: z.string().optional(),
});

// ─── Helper: verify test belongs to tenant ─────────────

async function findTestForTenant(testId: string, tenantId: string) {
  const test = await prisma.abTest.findUnique({
    where: { id: testId },
    include: {
      company: { select: { name: true, tenantId: true } },
      agent: { select: { name: true } },
      variants: {
        include: { metrics: true },
      },
    },
  });

  if (!test || test.company.tenantId !== tenantId) {
    throw new AppError(404, "A/B test not found");
  }

  return test;
}

// ─── GET /ab-tests — list A/B tests ───────────────────

abTestRouter.get("/", async (req, res, next) => {
  try {
    const tenantId = req.auth!.tenantId;
    const { status, companyId } = req.query;

    const where: any = { tenantId };
    if (status) where.status = status as string;
    if (companyId) where.companyId = companyId as string;

    const tests = await prisma.abTest.findMany({
      where,
      include: {
        company: { select: { name: true } },
        agent: { select: { name: true } },
        variants: {
          include: {
            _count: { select: { metrics: true } },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    const summaries = tests.map((t) => ({
      id: t.id,
      name: t.name,
      status: t.status,
      agentName: t.agent.name,
      companyName: t.company.name,
      variantCount: t.variants.length,
      totalRuns: t.variants.reduce((sum, v) => sum + v._count.metrics, 0),
      startedAt: t.startedAt?.toISOString() ?? null,
      createdAt: t.createdAt.toISOString(),
    }));

    res.json(summaries);
  } catch (err) {
    next(err);
  }
});

// ─── POST /ab-tests — create A/B test ─────────────────

abTestRouter.post("/", async (req, res, next) => {
  try {
    const tenantId = req.auth!.tenantId;
    const body = createSchema.parse(req.body);

    // Verify company belongs to tenant
    const company = await prisma.company.findUnique({
      where: { id: body.companyId },
    });
    if (!company || company.tenantId !== tenantId) {
      throw new AppError(404, "Company not found");
    }

    // Verify agent belongs to company
    const agent = await prisma.agent.findUnique({
      where: { id: body.agentId },
    });
    if (!agent || agent.companyId !== body.companyId) {
      throw new AppError(404, "Agent not found in this company");
    }

    const test = await prisma.abTest.create({
      data: {
        tenantId,
        companyId: body.companyId,
        agentId: body.agentId,
        name: body.name,
        description: body.description,
        variants: {
          create: body.variants.map((v) => ({
            name: v.name,
            config: v.config,
            weight: v.weight,
          })),
        },
      },
      include: {
        variants: true,
        company: { select: { name: true } },
        agent: { select: { name: true } },
      },
    });

    await prisma.activityLog.create({
      data: {
        tenantId,
        actor: req.auth!.userId,
        action: "ab_test.create",
        resource: "ab_test",
        resourceId: test.id,
        details: {
          name: test.name,
          agentId: body.agentId,
          variantCount: body.variants.length,
        },
      },
    });

    res.status(201).json(test);
  } catch (err) {
    next(err);
  }
});

// ─── GET /ab-tests/:id — test detail with metrics ─────

abTestRouter.get("/:id", async (req, res, next) => {
  try {
    const test = await findTestForTenant(req.params.id, req.auth!.tenantId);

    // Aggregate metrics per variant
    const variantsWithAgg = test.variants.map((v) => {
      const metricMap = new Map<string, { sum: number; count: number }>();
      for (const m of v.metrics) {
        const existing = metricMap.get(m.metric) || { sum: 0, count: 0 };
        existing.sum += m.value;
        existing.count += 1;
        metricMap.set(m.metric, existing);
      }

      const metrics = Array.from(metricMap.entries()).map(([metric, agg]) => ({
        metric,
        avgValue: agg.count > 0 ? agg.sum / agg.count : 0,
        count: agg.count,
      }));

      return {
        id: v.id,
        name: v.name,
        weight: v.weight,
        config: v.config as Record<string, any>,
        metrics,
        isWinner: test.winnerVariantId === v.id,
      };
    });

    const detail = {
      id: test.id,
      name: test.name,
      description: test.description,
      status: test.status,
      agentName: test.agent.name,
      companyName: test.company.name,
      variantCount: test.variants.length,
      totalRuns: test.variants.reduce((sum, v) => sum + v.metrics.length, 0),
      startedAt: test.startedAt?.toISOString() ?? null,
      createdAt: test.createdAt.toISOString(),
      variants: variantsWithAgg,
    };

    res.json(detail);
  } catch (err) {
    next(err);
  }
});

// ─── PATCH /ab-tests/:id/start — start test ───────────

abTestRouter.patch("/:id/start", async (req, res, next) => {
  try {
    const test = await findTestForTenant(req.params.id, req.auth!.tenantId);

    if (test.status !== "DRAFT" && test.status !== "PAUSED") {
      throw new AppError(400, `Cannot start test in ${test.status} status`);
    }

    if (test.variants.length < 2) {
      throw new AppError(400, "Test needs at least 2 variants to start");
    }

    const updated = await prisma.abTest.update({
      where: { id: test.id },
      data: {
        status: "RUNNING",
        startedAt: test.startedAt ?? new Date(),
      },
    });

    await prisma.activityLog.create({
      data: {
        tenantId: req.auth!.tenantId,
        actor: req.auth!.userId,
        action: "ab_test.start",
        resource: "ab_test",
        resourceId: test.id,
        details: { previousStatus: test.status },
      },
    });

    res.json({ success: true, status: updated.status });
  } catch (err) {
    next(err);
  }
});

// ─── PATCH /ab-tests/:id/pause — pause test ───────────

abTestRouter.patch("/:id/pause", async (req, res, next) => {
  try {
    const test = await findTestForTenant(req.params.id, req.auth!.tenantId);

    if (test.status !== "RUNNING") {
      throw new AppError(400, "Only running tests can be paused");
    }

    await prisma.abTest.update({
      where: { id: test.id },
      data: { status: "PAUSED" },
    });

    await prisma.activityLog.create({
      data: {
        tenantId: req.auth!.tenantId,
        actor: req.auth!.userId,
        action: "ab_test.pause",
        resource: "ab_test",
        resourceId: test.id,
      },
    });

    res.json({ success: true, status: "PAUSED" });
  } catch (err) {
    next(err);
  }
});

// ─── PATCH /ab-tests/:id/complete — complete test ─────

abTestRouter.patch("/:id/complete", async (req, res, next) => {
  try {
    const test = await findTestForTenant(req.params.id, req.auth!.tenantId);
    const body = completeSchema.parse(req.body);

    if (test.status !== "RUNNING" && test.status !== "PAUSED") {
      throw new AppError(400, `Cannot complete test in ${test.status} status`);
    }

    // Validate winner variant belongs to this test
    if (body.winnerVariantId) {
      const variantIds = test.variants.map((v) => v.id);
      if (!variantIds.includes(body.winnerVariantId)) {
        throw new AppError(400, "Winner variant does not belong to this test");
      }
    }

    const updated = await prisma.abTest.update({
      where: { id: test.id },
      data: {
        status: "COMPLETED",
        winnerVariantId: body.winnerVariantId ?? null,
        endedAt: new Date(),
      },
    });

    await prisma.activityLog.create({
      data: {
        tenantId: req.auth!.tenantId,
        actor: req.auth!.userId,
        action: "ab_test.complete",
        resource: "ab_test",
        resourceId: test.id,
        details: { winnerVariantId: body.winnerVariantId ?? null },
      },
    });

    res.json({ success: true, status: updated.status, winnerVariantId: updated.winnerVariantId });
  } catch (err) {
    next(err);
  }
});

// ─── DELETE /ab-tests/:id — delete test (DRAFT only) ──

abTestRouter.delete("/:id", async (req, res, next) => {
  try {
    const test = await findTestForTenant(req.params.id, req.auth!.tenantId);

    if (test.status !== "DRAFT") {
      throw new AppError(400, "Only draft tests can be deleted");
    }

    await prisma.abTest.delete({ where: { id: test.id } });

    await prisma.activityLog.create({
      data: {
        tenantId: req.auth!.tenantId,
        actor: req.auth!.userId,
        action: "ab_test.delete",
        resource: "ab_test",
        resourceId: test.id,
        details: { name: test.name },
      },
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ─── POST /ab-tests/:id/metrics — record a metric ─────

abTestRouter.post("/:id/metrics", async (req, res, next) => {
  try {
    const test = await findTestForTenant(req.params.id, req.auth!.tenantId);
    const body = recordMetricSchema.parse(req.body);

    if (test.status !== "RUNNING") {
      throw new AppError(400, "Can only record metrics for running tests");
    }

    // Validate variant belongs to this test
    const variantIds = test.variants.map((v) => v.id);
    if (!variantIds.includes(body.variantId)) {
      throw new AppError(400, "Variant does not belong to this test");
    }

    const metric = await prisma.abTestMetric.create({
      data: {
        variantId: body.variantId,
        runId: body.runId,
        metric: body.metric,
        value: body.value,
        metadata: body.metadata ?? undefined,
      },
    });

    await prisma.activityLog.create({
      data: {
        tenantId: req.auth!.tenantId,
        actor: req.auth!.userId,
        action: "ab_test.record_metric",
        resource: "ab_test_metric",
        resourceId: metric.id,
        details: {
          testId: test.id,
          variantId: body.variantId,
          metric: body.metric,
          value: body.value,
        },
      },
    });

    res.status(201).json(metric);
  } catch (err) {
    next(err);
  }
});

// ─── GET /ab-tests/:id/results — aggregated results ───

abTestRouter.get("/:id/results", async (req, res, next) => {
  try {
    const test = await findTestForTenant(req.params.id, req.auth!.tenantId);

    const variantResults = test.variants.map((v) => {
      // Group metrics by name
      const metricMap = new Map<string, number[]>();
      for (const m of v.metrics) {
        const arr = metricMap.get(m.metric) || [];
        arr.push(m.value);
        metricMap.set(m.metric, arr);
      }

      const aggregatedMetrics: Record<string, {
        avg: number;
        min: number;
        max: number;
        stdDev: number;
        count: number;
        sum: number;
      }> = {};

      for (const [metricName, values] of metricMap.entries()) {
        const count = values.length;
        const sum = values.reduce((a, b) => a + b, 0);
        const avg = sum / count;
        const min = Math.min(...values);
        const max = Math.max(...values);
        const variance = count > 1
          ? values.reduce((acc, val) => acc + (val - avg) ** 2, 0) / (count - 1)
          : 0;
        const stdDev = Math.sqrt(variance);

        aggregatedMetrics[metricName] = {
          avg: Math.round(avg * 10000) / 10000,
          min: Math.round(min * 10000) / 10000,
          max: Math.round(max * 10000) / 10000,
          stdDev: Math.round(stdDev * 10000) / 10000,
          count,
          sum: Math.round(sum * 10000) / 10000,
        };
      }

      return {
        variantId: v.id,
        variantName: v.name,
        weight: v.weight,
        isWinner: test.winnerVariantId === v.id,
        totalMetricRecords: v.metrics.length,
        metrics: aggregatedMetrics,
      };
    });

    // Compute comparative analysis for shared metrics
    const allMetricNames = new Set<string>();
    for (const vr of variantResults) {
      for (const name of Object.keys(vr.metrics)) {
        allMetricNames.add(name);
      }
    }

    const comparison: Record<string, {
      bestVariant: string;
      bestAvg: number;
      worstVariant: string;
      worstAvg: number;
      improvement: string;
    }> = {};

    for (const metricName of allMetricNames) {
      let best = { id: "", name: "", avg: -Infinity };
      let worst = { id: "", name: "", avg: Infinity };

      for (const vr of variantResults) {
        const m = vr.metrics[metricName];
        if (!m) continue;
        if (m.avg > best.avg) {
          best = { id: vr.variantId, name: vr.variantName, avg: m.avg };
        }
        if (m.avg < worst.avg) {
          worst = { id: vr.variantId, name: vr.variantName, avg: m.avg };
        }
      }

      if (best.avg !== -Infinity && worst.avg !== Infinity && worst.avg !== 0) {
        const pctImprovement = ((best.avg - worst.avg) / Math.abs(worst.avg)) * 100;
        comparison[metricName] = {
          bestVariant: best.name,
          bestAvg: best.avg,
          worstVariant: worst.name,
          worstAvg: worst.avg,
          improvement: `${Math.round(pctImprovement * 100) / 100}%`,
        };
      }
    }

    res.json({
      testId: test.id,
      testName: test.name,
      status: test.status,
      winnerVariantId: test.winnerVariantId,
      variants: variantResults,
      comparison,
    });
  } catch (err) {
    next(err);
  }
});
