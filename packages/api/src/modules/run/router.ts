import { Router } from "express";
import { authMiddleware } from "../../middleware/auth";
import { prisma } from "../../lib/db";
import { AppError } from "../../middleware/error";
import { enqueueRun } from "../pipeline/runner";

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
//
// Resume must do two things: flip status back to RUNNING AND re-enqueue
// the BullMQ job. Without the re-enqueue the run sits in RUNNING forever
// because the worker that exited on PAUSED never picks it back up. Note
// that the runner currently restarts from step group 0 on a new job
// pickup — fully step-cursor-aware resumption is on the roadmap. The
// trade-off (replay a few steps vs. permanent stuck-RUNNING) is
// preferable, and the runner's per-step idempotency keys avoid duplicate
// side effects on most replayable steps.
runRouter.post("/:id/resume", async (req, res, next) => {
  try {
    const run = await prisma.run.findUnique({
      where: { id: req.params.id },
      include: { pipeline: { include: { company: true } } },
    });
    if (!run || run.pipeline.company.tenantId !== req.auth!.tenantId) {
      throw new AppError(404, "Run not found");
    }
    if (run.status !== "PAUSED" && run.status !== "WAITING_APPROVAL") {
      throw new AppError(400, "Run is not paused or waiting on approval");
    }

    await prisma.run.update({
      where: { id: run.id },
      data: { status: "RUNNING" },
    });

    await enqueueRun(run.id);

    await prisma.activityLog.create({
      data: {
        tenantId: req.auth!.tenantId,
        actor: req.auth!.userId,
        action: "run.resume",
        resource: "run",
        resourceId: run.id,
      },
    });

    res.json({ success: true, status: "RUNNING" });
  } catch (err) { next(err); }
});

// GET /api/v1/runs/:id/stream — SSE stream for real-time run status
runRouter.get("/:id/stream", authMiddleware, async (req, res, next) => {
  try {
    const runId = req.params.id as string;
    const run = await prisma.run.findFirst({
      where: { id: runId, pipeline: { company: { tenantId: req.auth!.tenantId } } },
    });
    if (!run) return res.status(404).json({ error: "Run not found" });

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    // Flush headers immediately so the browser opens the EventSource
    // connection rather than waiting for the first chunk to arrive.
    if (typeof (res as any).flushHeaders === "function") {
      (res as any).flushHeaders();
    }

    const sendStatus = async () => {
      const current = await prisma.run.findUnique({
        where: { id: runId },
        include: { steps: { orderBy: { createdAt: "asc" } } },
      });
      if (!current) return false;

      res.write(`data: ${JSON.stringify({
        status: current.status,
        costUsd: current.costUsd,
        steps: current.steps.map((s: any) => ({
          name: s.name,
          status: s.status,
          reasoning: s.reasoning,
          costUsd: s.costUsd,
        })),
      })}\n\n`);

      return current.status === "RUNNING" || current.status === "PENDING" || current.status === "PAUSED";
    };

    // Send initial status
    const shouldContinue = await sendStatus();
    if (!shouldContinue) {
      res.write("event: done\ndata: {}\n\n");
      res.end();
      return;
    }

    // Poll every 3 seconds
    const interval = setInterval(async () => {
      try {
        const cont = await sendStatus();
        if (!cont) {
          res.write("event: done\ndata: {}\n\n");
          clearInterval(interval);
          clearInterval(heartbeat);
          res.end();
        }
      } catch {
        clearInterval(interval);
        clearInterval(heartbeat);
        res.end();
      }
    }, 3000);

    // SSE heartbeat — nginx + many CDNs idle-timeout connections that go
    // silent for 60s. A comment line every 25s keeps the socket alive
    // without delivering content (lines starting with ":" are comments
    // per the EventSource spec, ignored by the client).
    const heartbeat = setInterval(() => {
      try {
        res.write(`: keepalive ${Date.now()}\n\n`);
      } catch {
        clearInterval(heartbeat);
      }
    }, 25_000);

    req.on("close", () => {
      clearInterval(interval);
      clearInterval(heartbeat);
    });
  } catch (err) {
    next(err);
  }
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

// POST /api/v1/run-steps/:id/rerun — re-execute a failed/rolled-back step
runRouter.post("/steps/:id/rerun", async (req, res, next) => {
  try {
    const step = await prisma.runStep.findUnique({
      where: { id: req.params.id },
      include: { run: { include: { pipeline: { include: { company: true } } } } },
    });
    if (!step || step.run.pipeline.company.tenantId !== req.auth!.tenantId) {
      throw new AppError(404, "Run step not found");
    }
    if (step.status !== "FAILED" && step.status !== "ROLLED_BACK") {
      throw new AppError(400, "Only FAILED or ROLLED_BACK steps can be rerun");
    }

    // Reset step status to RUNNING
    await prisma.runStep.update({
      where: { id: step.id },
      data: {
        status: "RUNNING",
        error: null,
        startedAt: new Date(),
        completedAt: null,
      },
    });

    // Import and execute the step
    const { executeStep } = await import("../pipeline/executor");
    const stepDef = {
      name: step.name,
      agentRole: step.name, // Will be resolved from pipeline steps
      order: step.stepIndex,
    };

    // Get the pipeline step definition for agentRole
    const pipeline = step.run.pipeline;
    const pipelineSteps = pipeline.steps as Array<{ name: string; agentRole: string; order: number }>;
    const matchingStep = pipelineSteps.find((s) => s.name === step.name || s.order === step.stepIndex);
    if (matchingStep) {
      stepDef.agentRole = matchingStep.agentRole;
    }

    const result = await executeStep(
      step.runId,
      stepDef,
      step.stepIndex,
      step.input,
    );

    await prisma.activityLog.create({
      data: {
        tenantId: req.auth!.tenantId,
        actor: req.auth!.userId,
        action: "run_step.rerun",
        resource: "run_step",
        resourceId: step.id,
        details: { runId: step.runId, result: result.status },
      },
    });

    res.json(result);
  } catch (err) { next(err); }
});
