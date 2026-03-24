import { Router } from "express";
import { authMiddleware } from "../../middleware/auth";
import { prisma } from "../../lib/db";
import { AppError } from "../../middleware/error";

export const runRouter = Router();
runRouter.use(authMiddleware);

// GET /api/v1/runs/:id — run detail with steps and tool calls
runRouter.get("/:id", async (req, res, next) => {
  try {
    const run = await prisma.run.findUnique({
      where: { id: req.params.id },
      include: {
        steps: {
          include: { toolCalls: true },
          orderBy: { stepIndex: "asc" },
        },
        pipeline: { include: { company: true } },
        approvals: true,
      },
    });
    if (!run || run.pipeline.company.tenantId !== req.auth!.tenantId) {
      throw new AppError(404, "Run not found");
    }
    res.json(run);
  } catch (err) { next(err); }
});

// POST /api/v1/runs/:id/stop
runRouter.post("/:id/stop", async (req, res, next) => {
  try {
    const run = await prisma.run.findUnique({
      where: { id: req.params.id },
      include: { pipeline: { include: { company: true } } },
    });
    if (!run || run.pipeline.company.tenantId !== req.auth!.tenantId) {
      throw new AppError(404, "Run not found");
    }
    if (run.status !== "RUNNING" && run.status !== "PAUSED" && run.status !== "WAITING_APPROVAL") {
      throw new AppError(400, "Run is not in a stoppable state");
    }

    await prisma.run.update({
      where: { id: run.id },
      data: { status: "CANCELLED", completedAt: new Date() },
    });

    await prisma.activityLog.create({
      data: {
        tenantId: req.auth!.tenantId,
        actor: req.auth!.userId,
        action: "run.stop",
        resource: "run",
        resourceId: run.id,
      },
    });

    res.json({ success: true, status: "CANCELLED" });
  } catch (err) { next(err); }
});

// POST /api/v1/runs/:id/pause
runRouter.post("/:id/pause", async (req, res, next) => {
  try {
    const run = await prisma.run.findUnique({
      where: { id: req.params.id },
      include: { pipeline: { include: { company: true } } },
    });
    if (!run || run.pipeline.company.tenantId !== req.auth!.tenantId) {
      throw new AppError(404, "Run not found");
    }

    await prisma.run.update({
      where: { id: run.id },
      data: { status: "PAUSED" },
    });

    res.json({ success: true, status: "PAUSED" });
  } catch (err) { next(err); }
});

// POST /api/v1/runs/:id/resume
runRouter.post("/:id/resume", async (req, res, next) => {
  try {
    const run = await prisma.run.findUnique({
      where: { id: req.params.id },
      include: { pipeline: { include: { company: true } } },
    });
    if (!run || run.pipeline.company.tenantId !== req.auth!.tenantId) {
      throw new AppError(404, "Run not found");
    }

    await prisma.run.update({
      where: { id: run.id },
      data: { status: "RUNNING" },
    });

    res.json({ success: true, status: "RUNNING" });
  } catch (err) { next(err); }
});

// POST /api/v1/run-steps/:id/rollback
runRouter.post("/steps/:id/rollback", async (req, res, next) => {
  try {
    const step = await prisma.runStep.findUnique({
      where: { id: req.params.id },
      include: { run: { include: { pipeline: { include: { company: true } } } } },
    });
    if (!step || step.run.pipeline.company.tenantId !== req.auth!.tenantId) {
      throw new AppError(404, "Run step not found");
    }

    await prisma.runStep.update({
      where: { id: step.id },
      data: { status: "ROLLED_BACK" },
    });

    await prisma.activityLog.create({
      data: {
        tenantId: req.auth!.tenantId,
        actor: req.auth!.userId,
        action: "run_step.rollback",
        resource: "run_step",
        resourceId: step.id,
        details: { runId: step.runId },
      },
    });

    res.json({ success: true, status: "ROLLED_BACK" });
  } catch (err) { next(err); }
});
