import { Router } from "express";
import { authMiddleware } from "../../middleware/auth";
import { prisma } from "../../lib/db";
import { AppError } from "../../middleware/error";
import { z } from "zod";

export const pipelineRouter = Router();
pipelineRouter.use(authMiddleware);

const createSchema = z.object({
  companyId: z.string(),
  name: z.string().min(1),
  description: z.string().optional(),
  trigger: z.enum(["MANUAL", "SCHEDULED", "WEBHOOK", "EVENT"]).default("MANUAL"),
  schedule: z.string().optional(),
  steps: z.array(z.object({
    name: z.string(),
    agentRole: z.string(),
    order: z.number(),
    config: z.record(z.unknown()).optional(),
  })),
});

// GET /api/v1/pipelines?companyId=xxx
pipelineRouter.get("/", async (req, res, next) => {
  try {
    const { companyId } = req.query;
    // Verify company belongs to tenant
    const company = await prisma.company.findFirst({
      where: { id: companyId as string, tenantId: req.auth!.tenantId },
    });
    if (!company) throw new AppError(404, "Company not found");

    const pipelines = await prisma.pipeline.findMany({
      where: { companyId: company.id },
      orderBy: { createdAt: "desc" },
    });
    res.json(pipelines);
  } catch (err) { next(err); }
});

// POST /api/v1/pipelines
pipelineRouter.post("/", async (req, res, next) => {
  try {
    const data = createSchema.parse(req.body);
    // Verify company belongs to tenant
    const company = await prisma.company.findFirst({
      where: { id: data.companyId, tenantId: req.auth!.tenantId },
    });
    if (!company) throw new AppError(404, "Company not found");

    const pipeline = await prisma.pipeline.create({ data });

    await prisma.activityLog.create({
      data: {
        tenantId: req.auth!.tenantId,
        actor: req.auth!.userId,
        action: "pipeline.create",
        resource: "pipeline",
        resourceId: pipeline.id,
      },
    });

    res.status(201).json(pipeline);
  } catch (err) { next(err); }
});

// POST /api/v1/pipelines/:id/run — trigger a pipeline run
pipelineRouter.post("/:id/run", async (req, res, next) => {
  try {
    const pipeline = await prisma.pipeline.findUnique({
      where: { id: req.params.id },
      include: { company: true },
    });
    if (!pipeline || pipeline.company.tenantId !== req.auth!.tenantId) {
      throw new AppError(404, "Pipeline not found");
    }

    const run = await prisma.run.create({
      data: {
        pipelineId: pipeline.id,
        status: "PENDING",
        trigger: "manual",
        input: req.body.input ?? {},
      },
    });

    await prisma.activityLog.create({
      data: {
        tenantId: req.auth!.tenantId,
        actor: req.auth!.userId,
        action: "run.start",
        resource: "run",
        resourceId: run.id,
        details: { pipelineId: pipeline.id },
      },
    });

    // TODO: Faz 1 — enqueue run to BullMQ for processing
    // await runQueue.add("execute-run", { runId: run.id });

    res.status(201).json(run);
  } catch (err) { next(err); }
});
