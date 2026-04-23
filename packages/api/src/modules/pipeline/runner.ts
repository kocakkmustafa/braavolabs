import type { Job } from "bullmq";
import * as cron from "node-cron";
import { prisma } from "../../lib/db";
import { logger } from "../../lib/logger";
import { runQueue, createWorker } from "../../lib/queue";
import { executeStep, checkGovernance, type StepDef } from "./executor";
import { incrementMeter, checkQuota, claimQuota } from "../billing/metering";
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
 * Hard wall-clock limit for a single pipeline run. Prevents a wedged Claude
 * call (slow API, infinite tool loop) from holding a BullMQ worker slot
 * forever. 15 minutes is well above the p99 of healthy runs but short enough
 * that one stuck job doesn't drain a free-plan tenant's monthly quota.
 */
const MAX_RUN_DURATION_MS = 15 * 60 * 1000;

/**
 * Reject pipelines whose step count exceeds this. A pipeline with more than
 * 50 steps is almost always a configuration mistake or a malicious payload
 * (the natural-language builder caps at 8) and would burn budget without
 * delivering value.
 */
const MAX_STEPS_PER_RUN = 50;

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

  const tenantId = run.pipeline.company.tenantId;

  // NOTE: Run quota is now claimed atomically at the enqueue site (POST
  // /pipelines/:id/run, webhook trigger, scheduled cron) via claimQuota().
  // The runner used to check + increment here, but doing both at enqueue
  // and again at execution time double-counted the run AND introduced a
  // false-negative (the runner's read would see the already-incremented
  // value and fail the run). See ISS-010.

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

  // Sort steps and group by order for parallel execution
  const allSteps = (run.pipeline.steps as unknown as StepDef[]).sort((a, b) => a.order - b.order);

  // ── Step count guard (ISS-009) ─────────────────────────────────────────────
  // Reject pathologically large pipelines before doing any work. The natural
  // language builder caps generated pipelines at 8 steps; a hand-built one
  // can reasonably go higher but 50 is the upper bound of "this is still a
  // workflow, not an abuse pattern."
  if (allSteps.length > MAX_STEPS_PER_RUN) {
    logger.warn(
      { runId, stepCount: allSteps.length, max: MAX_STEPS_PER_RUN },
      "Run rejected — step count exceeds maximum",
    );
    await prisma.run.update({
      where: { id: runId },
      data: {
        status: "FAILED",
        error: `Pipeline has ${allSteps.length} steps; maximum is ${MAX_STEPS_PER_RUN}.`,
        completedAt: new Date(),
      },
    });
    await prisma.activityLog.create({
      data: {
        tenantId,
        actor: "system",
        action: "run.rejected_step_count",
        resource: "run",
        resourceId: runId,
        details: { stepCount: allSteps.length, max: MAX_STEPS_PER_RUN },
      },
    });
    runFailedCounter.add(1, { runId });
    return;
  }

  // Group steps by order index — same order = run in parallel
  const stepGroups = new Map<number, StepDef[]>();
  for (const step of allSteps) {
    const group = stepGroups.get(step.order) ?? [];
    group.push(step);
    stepGroups.set(step.order, group);
  }

  const sortedOrders = Array.from(stepGroups.keys()).sort((a, b) => a - b);

  let totalCost = 0;
  let previousOutput: unknown = run.input;
  let failed = false;

  // Shared memory map — agents can write outputs for subsequent agents to read
  const sharedMemory = new Map<string, unknown>();

  let globalStepIndex = 0;

  for (const orderIndex of sortedOrders) {
    const stepsAtOrder = stepGroups.get(orderIndex)!;

    // ── Wall-clock timeout check (ISS-009) ───────────────────────────────
    // Soft cap: bail before launching the next step group if we're already
    // past the budget. Prevents a slow Claude call inside an in-flight step
    // from being followed by another in-flight step that pushes the run far
    // beyond the limit.
    const elapsed = Date.now() - runStartTime;
    if (elapsed > MAX_RUN_DURATION_MS) {
      logger.warn(
        { runId, elapsedMs: elapsed, limitMs: MAX_RUN_DURATION_MS },
        "Run timed out — wall-clock limit exceeded",
      );
      await prisma.run.update({
        where: { id: runId },
        data: {
          status: "FAILED",
          error: `Run timed out after ${Math.round(elapsed / 1000)}s (limit: ${Math.round(MAX_RUN_DURATION_MS / 1000)}s).`,
          costUsd: totalCost,
          completedAt: new Date(),
        },
      });
      await prisma.activityLog.create({
        data: {
          tenantId,
          actor: "system",
          action: "run.timeout",
          resource: "run",
          resourceId: runId,
          details: { elapsedMs: elapsed, limitMs: MAX_RUN_DURATION_MS, costUsd: totalCost },
        },
      });
      runFailedCounter.add(1, { runId });
      return;
    }

    // Check if run was cancelled/paused externally
    const currentRun = await prisma.run.findUnique({
      where: { id: runId },
      select: { status: true },
    });
    if (currentRun?.status === "CANCELLED" || currentRun?.status === "PAUSED") {
      logger.info({ runId, status: currentRun.status }, "Run stopped externally");
      return;
    }

    // Check governance rules before each order group
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

    const isParallel = stepsAtOrder.length > 1;

    if (isParallel) {
      // ── Parallel execution ──────────────────────────────────────────────────
      logger.info(
        { runId, order: orderIndex, count: stepsAtOrder.length },
        `Executing ${stepsAtOrder.length} parallel steps at order ${orderIndex}`,
      );

      const parallelResults = await Promise.allSettled(
        stepsAtOrder.map((stepDef, idx) =>
          executeStep(runId, stepDef, globalStepIndex + idx, previousOutput, sharedMemory)
        ),
      );

      globalStepIndex += stepsAtOrder.length;

      // Collect parallel outputs — merge into an array for next sequential step
      const parallelOutputs: unknown[] = [];
      let stepFailed = false;

      for (let j = 0; j < parallelResults.length; j++) {
        const pr = parallelResults[j];
        const stepDef = stepsAtOrder[j];

        if (pr.status === "rejected") {
          logger.error({ runId, step: stepDef.name, err: pr.reason }, "Parallel step threw unexpectedly");
          stepFailed = true;
          continue;
        }

        const result = pr.value;
        totalCost += result.costUsd;

        if (result.status === "FAILED") {
          stepFailed = true;
          logger.error({ runId, step: stepDef.name, reason: result.reasoning }, "Parallel step failed");
        } else {
          parallelOutputs.push(result.output);

          // Write to shared memory if key specified
          if (result.memoryKey) {
            sharedMemory.set(result.memoryKey, result.output);
          }
        }

        // Track tool calls
        if (result.toolCallIds.length > 0) {
          await incrementMeter(tenantId, "tool_calls", result.toolCallIds.length);
        }

        await prisma.activityLog.create({
          data: {
            tenantId,
            actor: "system",
            action: "run_step.complete",
            resource: "run_step",
            resourceId: result.stepId,
            details: { runId, step: stepDef.name, costUsd: result.costUsd, parallel: true },
          },
        });
      }

      await prisma.run.update({ where: { id: runId }, data: { costUsd: totalCost } });

      if (stepFailed) {
        failed = true;
        break;
      }

      // Pass merged parallel outputs to next step
      previousOutput = parallelOutputs.length === 1 ? parallelOutputs[0] : parallelOutputs;

    } else {
      // ── Sequential execution (single step at this order) ────────────────────
      const stepDef = stepsAtOrder[0];

      logger.info(
        { runId, step: stepDef.name, order: orderIndex },
        `Executing step ${globalStepIndex + 1}/${allSteps.length}`,
      );

      const result = await executeStep(runId, stepDef, globalStepIndex, previousOutput, sharedMemory);
      globalStepIndex += 1;
      totalCost += result.costUsd;

      await prisma.run.update({ where: { id: runId }, data: { costUsd: totalCost } });

      if (result.status === "FAILED") {
        failed = true;
        logger.error({ runId, step: stepDef.name, reason: result.reasoning }, "Step failed");
        break;
      }

      // Write to shared memory if key specified
      if (result.memoryKey) {
        sharedMemory.set(result.memoryKey, result.output);
      }

      previousOutput = result.output;

      if (result.toolCallIds.length > 0) {
        await incrementMeter(tenantId, "tool_calls", result.toolCallIds.length);
      }

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
      details: { totalCost, stepCount: allSteps.length },
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

const scheduledJobs = new Map<string, cron.ScheduledTask>();

export async function initScheduledPipelines(): Promise<void> {
  const pipelines = await prisma.pipeline.findMany({
    where: { enabled: true, trigger: "SCHEDULED", schedule: { not: null } },
    include: { company: true },
  });

  for (const pipeline of pipelines) {
    if (!pipeline.schedule || !cron.validate(pipeline.schedule)) {
      logger.warn({ pipelineId: pipeline.id, schedule: pipeline.schedule }, "Invalid cron schedule");
      continue;
    }

    const job = cron.schedule(pipeline.schedule, async () => {
      logger.info({ pipelineId: pipeline.id, name: pipeline.name }, "Scheduled pipeline triggered");
      try {
        // Atomic quota claim before enqueue (ISS-010). Skip the tick if the
        // tenant is over limit — scheduled runs shouldn't quietly burn the
        // entire monthly quota in a single hour because the cron fires before
        // the user notices the quota is exhausted.
        const claim = await claimQuota(pipeline.company.tenantId, "runs");
        if (!claim.claimed) {
          logger.warn(
            { pipelineId: pipeline.id, tenantId: pipeline.company.tenantId, value: claim.value, limit: claim.limit },
            "Scheduled run skipped — quota exhausted",
          );
          return;
        }
        const run = await prisma.run.create({
          data: {
            pipelineId: pipeline.id,
            trigger: "scheduled",
            status: "PENDING",
            input: {},
          },
        });
        await enqueueRun(run.id);
      } catch (err) {
        logger.error({ pipelineId: pipeline.id, err }, "Failed to trigger scheduled pipeline");
      }
    });

    scheduledJobs.set(pipeline.id, job);
    logger.info({ pipelineId: pipeline.id, schedule: pipeline.schedule, name: pipeline.name }, "Scheduled pipeline cron registered");
  }

  logger.info({ count: scheduledJobs.size }, "Scheduled pipelines initialized");
}

export function stopScheduledPipelines(): void {
  for (const [id, job] of scheduledJobs) {
    job.stop();
  }
  scheduledJobs.clear();
}
