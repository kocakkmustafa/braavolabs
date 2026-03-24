import type { Job } from "bullmq";
import { prisma } from "../../lib/db";
import { logger } from "../../lib/logger";
import { runQueue, createWorker } from "../../lib/queue";
import { executeStep, checkGovernance } from "./executor";
import { incrementMeter, checkQuota } from "../billing/metering";
import {
  withSpan,
  runCounter,
  runCompletedCounter,
  runFailedCounter,
  runDurationHistogram,
  runCostHistogram,
  governanceStopCounter,
} from "../../lib/telemetry";

interface RunJobData {
  runId: string;
}

/**
 * Pipeline Runner — BullMQ worker that processes pipeline runs.
 *
 * Flow:
 * 1. Load run + pipeline + steps
 * 2. Execute each step sequentially
 * 3. Track cost, check governance at each step
 * 4. Handle approval gates for spend actions
 * 5. Update run status throughout
 */
async function processRun(job: Job<RunJobData>): Promise<void> {
  const { runId } = job.data;
  const runStartTime = Date.now();

  logger.info({ runId, jobId: job.id }, "Pipeline run started");
  runCounter.add(1, { runId });

  // Load run with pipeline and company
  const run = await prisma.run.findUnique({
    where: { id: runId },
    include: {
      pipeline: {
        include: {
          company: { include: { agents: true } },
        },
      },
    },
  });

  if (!run) {
    logger.error({ runId }, "Run not found");
    return;
  }

  // Check usage quota before starting
  const tenantId = run.pipeline.company.tenantId;
  const quota = await checkQuota(tenantId, "runs");
  if (!quota.allowed) {
    logger.warn({ runId, tenantId, remaining: quota.remaining }, "Run quota exceeded");
    await prisma.run.update({
      where: { id: runId },
      data: {
        status: "FAILED",
        error: `Monthly run limit reached (${quota.limit}). Upgrade your plan for more runs.`,
        completedAt: new Date(),
      },
    });
    await prisma.activityLog.create({
      data: {
        tenantId,
        actor: "system",
        action: "billing.quota_exceeded",
        resource: "run",
        resourceId: runId,
        details: { metric: "runs", limit: quota.limit },
      },
    });
    return;
  }

  // Increment run meter
  await incrementMeter(tenantId, "runs", 1);

  // Update status to RUNNING
  await prisma.run.update({
    where: { id: runId },
    data: { status: "RUNNING", startedAt: new Date() },
  });

  // Log activity
  await prisma.activityLog.create({
    data: {
      tenantId: run.pipeline.company.tenantId,
      actor: "system",
      action: "run.execute",
      resource: "run",
      resourceId: runId,
      details: { pipelineId: run.pipelineId, trigger: run.trigger },
    },
  });

  const steps = (run.pipeline.steps as any[]).sort(
    (a: any, b: any) => a.order - b.order,
  );

  let totalCost = 0;
  let previousOutput: unknown = run.input;
  let failed = false;

  for (let i = 0; i < steps.length; i++) {
    const stepDef = steps[i];

    // Check if run was cancelled/paused externally
    const currentRun = await prisma.run.findUnique({
      where: { id: runId },
      select: { status: true },
    });
    if (
      currentRun?.status === "CANCELLED" ||
      currentRun?.status === "PAUSED"
    ) {
      logger.info({ runId, status: currentRun.status }, "Run stopped externally");
      return;
    }

    // Check governance rules
    const governance = await checkGovernance(runId, totalCost);
    if (!governance.allowed) {
      governanceStopCounter.add(1, { reason: governance.reason ?? "unknown" });
      logger.warn({ runId, reason: governance.reason }, "Governance stop triggered");

      await prisma.run.update({
        where: { id: runId },
        data: {
          status: "FAILED",
          error: governance.reason,
          costUsd: totalCost,
          completedAt: new Date(),
        },
      });

      await prisma.activityLog.create({
        data: {
          tenantId: run.pipeline.company.tenantId,
          actor: "system",
          action: "run.governance_stop",
          resource: "run",
          resourceId: runId,
          details: { reason: governance.reason, costUsd: totalCost },
        },
      });

      return;
    }

    // Execute step
    logger.info(
      { runId, step: stepDef.name, index: i },
      `Executing step ${i + 1}/${steps.length}`,
    );

    const result = await executeStep(runId, stepDef, i, previousOutput);
    totalCost += result.costUsd;

    // Update run cost
    await prisma.run.update({
      where: { id: runId },
      data: { costUsd: totalCost },
    });

    if (result.status === "FAILED") {
      failed = true;
      logger.error(
        { runId, step: stepDef.name, reason: result.reasoning },
        "Step failed",
      );
      break;
    }

    // Pass output to next step
    previousOutput = result.output;

    // Track tool call usage
    if (result.toolCallIds.length > 0) {
      await incrementMeter(tenantId, "tool_calls", result.toolCallIds.length);
    }

    // Log step completion
    await prisma.activityLog.create({
      data: {
        tenantId,
        actor: "system",
        action: "run_step.complete",
        resource: "run_step",
        resourceId: result.stepId,
        details: {
          runId,
          step: stepDef.name,
          costUsd: result.costUsd,
          toolCalls: result.toolCallIds.length,
        },
      },
    });
  }

  // Finalize run
  await prisma.run.update({
    where: { id: runId },
    data: {
      status: failed ? "FAILED" : "COMPLETED",
      output: { lastStepOutput: previousOutput } as any,
      costUsd: totalCost,
      completedAt: new Date(),
    },
  });

  await prisma.activityLog.create({
    data: {
      tenantId: run.pipeline.company.tenantId,
      actor: "system",
      action: failed ? "run.failed" : "run.completed",
      resource: "run",
      resourceId: runId,
      details: { totalCost, stepCount: steps.length },
    },
  });

  // Record metrics
  const runDuration = Date.now() - runStartTime;
  runDurationHistogram.record(runDuration, { status: failed ? "FAILED" : "COMPLETED" });
  runCostHistogram.record(totalCost, { runId });
  if (failed) {
    runFailedCounter.add(1, { runId });
  } else {
    runCompletedCounter.add(1, { runId });
  }

  logger.info(
    { runId, status: failed ? "FAILED" : "COMPLETED", totalCost, durationMs: runDuration },
    "Pipeline run finished",
  );
}

/**
 * Enqueue a pipeline run for processing.
 */
export async function enqueueRun(runId: string): Promise<string> {
  const job = await runQueue.add(
    "execute-run",
    { runId },
    {
      attempts: 1, // No automatic retry — failed runs need investigation
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 100 },
    },
  );
  logger.info({ runId, jobId: job.id }, "Run enqueued");
  return job.id!;
}

/**
 * Initialize the pipeline runner worker.
 * Call this on server startup.
 */
export function initPipelineRunner(): void {
  createWorker<RunJobData>("pipeline-runs", processRun);
  logger.info("Pipeline runner worker initialized");
}
