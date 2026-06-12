import type { Job } from "bullmq";
import * as cron from "node-cron";
import { prisma } from "../../lib/db";
import { logger } from "../../lib/logger";
import { runQueue, createWorker } from "../../lib/queue";
import { executeStep, checkGovernance, planResume, type StepDef, type StepExecutionResult } from "./executor";
import { publishRunEvent } from "../../lib/runEvents";
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
  // Snapshot of the run's tenant at enqueue time. Verified against the
  // DB on dequeue so a runId from tenant A cannot be processed under
  // tenant B's context. Optional only for backward compatibility with
  // in-flight jobs queued before this field was introduced — those
  // skip the assertion and rely on the existing per-row tenant scope.
  tenantId?: string;
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
  const { runId, tenantId: enqueuedTenantId } = job.data;
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

  // Defence-in-depth: if the enqueuer captured a tenantId (every code
  // path after the SEC-024 fix does), refuse to run when it disagrees
  // with the DB's view. A mismatch means either a stale job from
  // before a tenant transfer or a leaked Redis connection that
  // injected someone else's runId. Either way, refusing is the right
  // call — the run will be picked up again on retry only if the new
  // job carries the correct tenantId.
  if (enqueuedTenantId && enqueuedTenantId !== tenantId) {
    logger.error(
      { runId, enqueuedTenantId, dbTenantId: tenantId, jobId: job.id },
      "Pipeline runner: tenant mismatch — refusing to execute run",
    );
    return;
  }

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

  await publishRunEvent(runId, {
    type: "RUN_STARTED",
    pipelineId: run.pipelineId,
    pipelineName: run.pipeline.name,
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

  // Hierarchical pipelines have no flat `steps` array — the manager
  // agent synthesises steps at runtime via the delegate tool. Hand
  // off to the hierarchical executor and bail out here. The
  // sequential path below is unchanged for SEQUENTIAL pipelines so
  // every existing customer keeps the exact same behaviour.
  if (run.pipeline.pipelineType === "HIERARCHICAL") {
    const { processHierarchicalRun } = await import("./hierarchical-runner");
    await processHierarchicalRun({
      runId,
      tenantId,
      pipeline: run.pipeline,
      input: run.input,
    });
    return;
  }

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
  // First failed step's reason — surfaces on run.error so the API and UI
  // show *why* a run failed without forcing callers to fetch run_steps.
  let failureReason: string | null = null;

  // Shared memory map — agents can write outputs for subsequent agents to read
  const sharedMemory = new Map<string, unknown>();

  // ── Resume idempotency ───────────────────────────────────────────────
  // A run that paused on ask_user (WAITING_APPROVAL) is re-enqueued from the
  // top. Without this, every already-COMPLETED step would re-execute on
  // resume — re-spending, re-sending, re-charging. So: load prior COMPLETED
  // steps, seed cost from them, and below SKIP + restore them (feeding their
  // persisted output into previousOutput / sharedMemory) instead of re-running.
  // Only the not-yet-completed step (the one that paused) actually re-runs.
  const priorCompleted = await prisma.runStep.findMany({
    where: { runId, status: "COMPLETED" },
    select: { id: true, stepIndex: true, output: true, costUsd: true },
  });
  const priorByIndex = new Map<number, { id: string; output: unknown; costUsd: number }>();
  for (const ps of priorCompleted) {
    priorByIndex.set(ps.stepIndex, { id: ps.id, output: ps.output, costUsd: Number(ps.costUsd ?? 0) });
  }
  if (priorByIndex.size > 0) {
    totalCost = planResume(priorCompleted.map((ps) => ({ stepIndex: ps.stepIndex, costUsd: Number(ps.costUsd ?? 0) }))).seededCost;
    logger.info({ runId, restoredSteps: priorByIndex.size, seededCost: totalCost }, "Resume: restoring completed steps (idempotent skip — no re-execution)");
  }
  // Synthetic COMPLETED result for a restored step (no re-run; its cost is
  // already in the seed above, so costUsd: 0 to avoid double-counting).
  const restoredResult = (stepDef: StepDef, prior: { id: string; output: unknown }): StepExecutionResult => ({
    stepId: prior.id,
    status: "COMPLETED",
    reasoning: "(resumed — step already completed before the pause)",
    output: prior.output,
    costUsd: 0,
    toolCallIds: [],
    memoryKey: stepDef.writeMemoryKey,
  });

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
      await publishRunEvent(runId, { type: "RUN_FAILED", error: `Run timed out after ${Math.round(elapsed / 1000)}s.`, costUsd: totalCost });
      runFailedCounter.add(1, { runId });
      return;
    }

    // Check if run was cancelled/paused externally
    const currentRun = await prisma.run.findUnique({
      where: { id: runId },
      select: { status: true },
    });
    if (
      currentRun?.status === "CANCELLED" ||
      currentRun?.status === "PAUSED" ||
      currentRun?.status === "WAITING_APPROVAL"
    ) {
      // WAITING_APPROVAL is set by tool-executor.ts when it spawns an
      // Approval row — exiting here lets the BullMQ job complete cleanly
      // and waits for /approvals/:id/decide to call enqueueRun() again.
      logger.info({ runId, status: currentRun.status }, "Run stopped externally");
      await publishRunEvent(runId, { type: "RUN_STATUS", status: currentRun.status, reason: "stopped externally" });
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

      await publishRunEvent(runId, { type: "RUN_FAILED", error: governance.reason ?? "Governance stop", costUsd: totalCost });
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
        stepsAtOrder.map((stepDef, idx) => {
          const prior = priorByIndex.get(globalStepIndex + idx);
          // Resume: a step already COMPLETED before the pause is restored, not re-run.
          return prior
            ? Promise.resolve(restoredResult(stepDef, prior))
            : executeStep(runId, stepDef, globalStepIndex + idx, previousOutput, sharedMemory);
        }),
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
          // Capture first parallel failure as the run-level reason. Multiple
          // parallel failures are logged individually but only the first
          // surfaces on run.error to keep the field readable.
          if (!failureReason) {
            failureReason = pr.reason instanceof Error
              ? `Parallel step "${stepDef.name}" threw: ${pr.reason.message}`
              : `Parallel step "${stepDef.name}" threw unexpectedly.`;
          }
          continue;
        }

        const result = pr.value;
        totalCost += result.costUsd;

        if (result.status === "FAILED") {
          stepFailed = true;
          if (!failureReason) {
            failureReason = result.reasoning ?? `Parallel step "${stepDef.name}" failed.`;
          }
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

      // Resume: skip + restore an already-COMPLETED step instead of re-running it.
      const priorSeq = priorByIndex.get(globalStepIndex);
      const result = priorSeq
        ? restoredResult(stepDef, priorSeq)
        : await executeStep(runId, stepDef, globalStepIndex, previousOutput, sharedMemory);
      globalStepIndex += 1;
      totalCost += result.costUsd;

      await prisma.run.update({ where: { id: runId }, data: { costUsd: totalCost } });

      if (result.status === "FAILED") {
        failed = true;
        // Capture the failed step's reason so the run-level error field reflects
        // why the run died — without this users see {status:"FAILED", error:null}
        // and have no way to tell whether it was BYOK missing, governance stop,
        // or an upstream Anthropic 429. Run.error is the single field most UI
        // surfaces show by default.
        failureReason = result.reasoning ?? `Step "${stepDef.name}" failed.`;
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
      // Surface the first failed step's reasoning at run-level. Without this,
      // callers see {status:"FAILED", error:null} and must fetch run_steps to
      // learn the cause. Truncate at 500 chars — reset emails / governance
      // stop messages tend to fit; full step output stays in run_steps.error.
      error: failed ? (failureReason ?? "Run failed for an unspecified reason.").slice(0, 500) : null,
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
  if (failed) {
    await publishRunEvent(runId, { type: "RUN_FAILED", error: (failureReason ?? "Run failed for an unspecified reason.").slice(0, 500), costUsd: totalCost });
  } else {
    await publishRunEvent(runId, { type: "RUN_COMPLETED", costUsd: totalCost, durationMs: runDuration });
  }
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
 *
 * attempts=2 — single retry with 30s backoff covers transient Anthropic
 * 529 / 503 / network blips. The agent loop already retries the LLM
 * request internally; this outer retry only re-fires if the worker
 * itself crashed mid-run (rare but expensive for the user when it
 * happens). Set removeOnFail.count high enough that operators have
 * something to inspect when investigating real failures.
 */
export async function enqueueRun(runId: string): Promise<string> {
  // Capture tenantId at enqueue time so the worker can assert it back
  // out of the job payload before doing any DB work — defence-in-depth
  // against a leaked Redis connection or a future code path that
  // accidentally lifts a runId from one tenant into another tenant's
  // request context. See processRun() for the verification step.
  const run = await prisma.run.findUnique({
    where: { id: runId },
    select: { pipeline: { select: { company: { select: { tenantId: true } } } } },
  });
  const tenantId = run?.pipeline?.company?.tenantId;
  if (!tenantId) {
    throw new Error(`enqueueRun: run ${runId} not found or has no tenant`);
  }

  const job = await runQueue.add(
    "execute-run",
    { runId, tenantId },
    {
      attempts: 2,
      backoff: { type: "exponential", delay: 30_000 },
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 200 },
    },
  );
  logger.info({ runId, jobId: job.id }, "Run enqueued");
  return job.id!;
}

/**
 * Initialize the pipeline runner worker.
 * Call this on server startup.
 *
 * lockDuration / stalledInterval / maxStalledCount come from the
 * createWorker DEFAULT_WORKER_OPTS in lib/queue.ts — pipeline runs hit
 * Claude with potentially long tool-use loops, and the BullMQ default
 * 30s lock would expire mid-run and trigger re-pickup mid-execution
 * (double-billing the tenant + duplicate side effects).
 */
export function initPipelineRunner(): void {
  createWorker<RunJobData>("pipeline-runs", processRun);
  logger.info("Pipeline runner worker initialized");
}

const scheduledJobs = new Map<string, cron.ScheduledTask>();

export async function initScheduledPipelines(): Promise<void> {
  const pipelines = await prisma.pipeline.findMany({
    // Only ACTIVE companies get their crons registered — a paused or
    // archived workspace shouldn't keep burning scheduled runs.
    where: {
      enabled: true,
      trigger: "SCHEDULED",
      schedule: { not: null },
      company: { status: "ACTIVE" },
    },
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
        // Re-check company status at fire time — the registration-time
        // filter goes stale the moment a user pauses or archives the
        // workspace, and crons live until the next process restart.
        const company = await prisma.company.findUnique({
          where: { id: pipeline.companyId },
          select: { status: true, tenantId: true },
        });
        if (!company || company.status !== "ACTIVE") {
          logger.info(
            { pipelineId: pipeline.id, companyStatus: company?.status ?? "missing" },
            "Scheduled run skipped — company not active",
          );
          return;
        }
        // Atomic quota claim before enqueue (ISS-010). Skip the tick if the
        // tenant is over limit — scheduled runs shouldn't quietly burn the
        // entire monthly quota in a single hour because the cron fires before
        // the user notices the quota is exhausted.
        const claim = await claimQuota(company.tenantId, "runs");
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
