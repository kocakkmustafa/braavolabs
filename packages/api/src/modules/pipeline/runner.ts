import type { Job } from "bullmq";
import * as cron from "node-cron";
import { prisma } from "../../lib/db";
import { logger } from "../../lib/logger";
import { env } from "../../config/env";
import { runQueue, scheduleQueue, createWorker } from "../../lib/queue";
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

  // Sort steps and group by order for parallel execution.
  // Defence-in-depth (E5/T2): coalesce a missing `order` to the array index so
  // a legacy/partial step list without explicit orders can't produce NaN
  // comparisons (unstable sort) or collapse every step into one parallel group.
  const allSteps = (run.pipeline.steps as unknown as StepDef[])
    .map((s, idx) => ({ ...s, order: s.order ?? idx }))
    .sort((a, b) => a.order - b.order);

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
      let interrupted = false;

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

        // E3/T2 (§2.3a-2): a turn-boundary interrupt is neither a completion
        // nor a failure — the step is back at PENDING, the run stays
        // PAUSED/CANCELLED for a takeover. Skip the completion bookkeeping.
        if (result.status === "INTERRUPTED") {
          interrupted = true;
          continue;
        }

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

      // E3/T2 (§2.3a-2): exit exactly like the order-group boundary check —
      // WITHOUT the finalize block below, which would overwrite the paused
      // run with COMPLETED/FAILED (the last-order-group case never reaches
      // another boundary check). The run keeps whatever status the interrupt
      // requester set (PAUSED/CANCELLED).
      if (interrupted) {
        const current = await prisma.run.findUnique({ where: { id: runId }, select: { status: true } });
        logger.info(
          { runId, order: orderIndex, status: current?.status },
          "Run interrupted at a turn boundary (pause/handoff) — exiting without finalize",
        );
        await publishRunEvent(runId, {
          type: "RUN_STATUS",
          status: current?.status ?? "PAUSED",
          reason: "interrupted at a turn boundary (pause/handoff)",
        });
        return;
      }

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

      // E3/T2 (§2.3a-2): turn-boundary interrupt — the step is back at
      // PENDING, the run stays PAUSED/CANCELLED. Exit like the order-group
      // boundary check does, and crucially BEFORE the finalize block (a
      // last-group interrupt would otherwise flip the paused run to
      // COMPLETED and fire RUN_COMPLETED).
      if (result.status === "INTERRUPTED") {
        const current = await prisma.run.findUnique({ where: { id: runId }, select: { status: true } });
        logger.info(
          { runId, step: stepDef.name, status: current?.status },
          "Run interrupted at a turn boundary (pause/handoff) — exiting without finalize",
        );
        await publishRunEvent(runId, {
          type: "RUN_STATUS",
          status: current?.status ?? "PAUSED",
          reason: "interrupted at a turn boundary (pause/handoff)",
        });
        return;
      }

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
  // Eşzamanlılık 3 (ölçüm 2026-08-12): yerel Ollama'ya 3 paralel istek, seri
  // koşuya göre istek başına 111,8 sn → 43,7 sn. Tek model örneği bellekte
  // kaldığı için RAM artmıyor; Ollama istekleri kendi içinde toplu işliyor.
  // 3'ün üstü kazanç getirmedi (2 ve 3 duvar saati neredeyse aynı: 132/131 sn).
  createWorker<RunJobData>("pipeline-runs", processRun, { concurrency: 3 });
  logger.info("Pipeline runner worker initialized");
}

// ─── Scheduled pipelines — BullMQ JobScheduler (E4) ───────────────────────
//
// Replaces the previous in-process node-cron Map. The old design registered
// crons ONLY at boot (initScheduledPipelines) and dropped them on SIGTERM, so
// runtime create/patch/delete never took effect until a restart (G1) and a
// process bounce could silently drop a fire (G4). BullMQ JobScheduler holds
// the repeat state in Redis, so:
//   - register/remove happen at request time from the router (G1 closed),
//   - the schedule survives a process restart (G4 closed),
//   - a fixed jobSchedulerId=pipeline.id makes re-registration idempotent, so
//     even two API processes sharing one Redis produce ONE scheduler (G2).
//
// CRITICAL durability contract: SIGTERM must NOT touch the schedulers.
// removeJobScheduler is called ONLY on pipeline delete/disable, never on
// shutdown — see stopScheduledPipelines() below.

/** Name given to every scheduled-tick job produced by a JobScheduler. */
export const SCHEDULED_TICK_JOB = "scheduled-run";

interface ScheduledTickData {
  pipelineId: string;
}

/**
 * Register (or update) the BullMQ repeat schedule for a SCHEDULED pipeline.
 *
 * Idempotent by construction: jobSchedulerId = pipeline.id. Calling this again
 * with a changed pattern updates the existing scheduler in place; it never
 * spawns a second one. Invalid cron patterns are logged and skipped (no
 * scheduler created) so a bad PATCH can't wedge the queue.
 *
 * The firing timezone is pinned to env.SCHEDULER_TZ (default "UTC") so the
 * wall-clock firing time is deterministic and matches the old node-cron
 * behavior on the (TZ-unpinned → UTC) prod container.
 */
export async function registerSchedule(pipeline: {
  id: string;
  schedule: string | null;
}): Promise<void> {
  if (!pipeline.schedule || !cron.validate(pipeline.schedule)) {
    logger.warn(
      { pipelineId: pipeline.id, schedule: pipeline.schedule },
      "registerSchedule skipped — invalid cron pattern",
    );
    return;
  }

  // Target the DEDICATED schedule queue — NOT runQueue. See scheduleQueue's
  // doc in lib/queue.ts: keeping schedulers off the run queue is what prevents
  // the two workers from racing (and the execute-run regression where a tick
  // worker no-op-ACKs a real run job).
  await scheduleQueue.upsertJobScheduler(
    pipeline.id,
    { pattern: pipeline.schedule, tz: env.SCHEDULER_TZ },
    {
      name: SCHEDULED_TICK_JOB,
      data: { pipelineId: pipeline.id } satisfies ScheduledTickData,
    },
  );
  logger.info(
    { pipelineId: pipeline.id, schedule: pipeline.schedule, tz: env.SCHEDULER_TZ },
    "Scheduled pipeline registered (BullMQ JobScheduler)",
  );
}

/**
 * Remove the BullMQ repeat schedule for a pipeline. Safe to call when no
 * scheduler exists (BullMQ returns false; we don't treat that as an error).
 * This is the ONLY place a scheduler is torn down — pipeline delete/disable.
 */
export async function removeSchedule(pipelineId: string): Promise<void> {
  const removed = await scheduleQueue.removeJobScheduler(pipelineId);
  logger.info({ pipelineId, removed }, "Scheduled pipeline scheduler removed");
}

/**
 * The tick body a scheduled JobScheduler enqueues on each fire. Exported so it
 * can be unit-tested directly (the old inline node-cron callback could not be).
 *
 * Fire-time re-checks (G3): the pipeline may have been disabled, re-scheduled,
 * or switched away from SCHEDULED trigger since the scheduler was registered,
 * and the company may have been paused. All are re-loaded from the DB here so a
 * stale scheduler that briefly outlives a mutation cannot produce a run.
 *
 * Idempotency (A2): this worker MUST be registered with attempts:1 (see
 * initScheduledTickWorker). claimQuota has no rollback, so a retry after a
 * post-claim throw would double-bill. We never retry the tick.
 */
export async function processScheduledTick(job: Job<ScheduledTickData>): Promise<void> {
  const { pipelineId } = job.data;

  const pipeline = await prisma.pipeline.findUnique({
    where: { id: pipelineId },
    select: {
      id: true,
      enabled: true,
      trigger: true,
      schedule: true,
      companyId: true,
      company: { select: { status: true, tenantId: true } },
    },
  });

  // G3 — pipeline gone / disabled / no longer SCHEDULED / schedule cleared.
  if (
    !pipeline ||
    !pipeline.enabled ||
    pipeline.trigger !== "SCHEDULED" ||
    !pipeline.schedule
  ) {
    logger.info(
      {
        pipelineId,
        exists: !!pipeline,
        enabled: pipeline?.enabled,
        trigger: pipeline?.trigger,
      },
      "Scheduled tick skipped — pipeline not an enabled SCHEDULED pipeline",
    );
    return;
  }

  // Re-check company status at fire time — a paused/archived workspace
  // shouldn't keep burning scheduled runs.
  if (!pipeline.company || pipeline.company.status !== "ACTIVE") {
    logger.info(
      { pipelineId, companyStatus: pipeline.company?.status ?? "missing" },
      "Scheduled run skipped — company not active",
    );
    return;
  }

  // Atomic quota claim before enqueue (ISS-010). Skip the tick if the tenant
  // is over limit — scheduled runs shouldn't quietly burn the entire monthly
  // quota because the cron keeps firing after the quota is exhausted.
  const claim = await claimQuota(pipeline.company.tenantId, "runs");
  if (!claim.claimed) {
    logger.warn(
      { pipelineId, tenantId: pipeline.company.tenantId, value: claim.value, limit: claim.limit },
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

  // Persist last fire time for the dashboard (T5). Best-effort: a failure to
  // stamp lastRunAt must not fail the tick (the run is already enqueued).
  await prisma.pipeline
    .update({ where: { id: pipeline.id }, data: { lastRunAt: new Date() } })
    .catch((err) => logger.warn({ pipelineId, err }, "Failed to stamp lastRunAt"));

  logger.info({ pipelineId, runId: run.id }, "Scheduled pipeline run enqueued");
}

/**
 * Start the worker that consumes scheduled-tick jobs.
 *
 * Runs on the DEDICATED "pipeline-schedules" queue — NOT the "pipeline-runs"
 * queue that initPipelineRunner's execute-run worker consumes. This isolation
 * is load-bearing: BullMQ delivers each job to exactly one worker per queue
 * regardless of job.name, so if this worker shared "pipeline-runs" with the
 * execute-run worker they would race for every job. That race caused two
 * failures: (1) a scheduled-tick job grabbed by the execute-run worker →
 * runId=undefined and the scheduled run is dropped; (2) FAR worse, an
 * execute-run job grabbed by this tick worker → it isn't a SCHEDULED_TICK_JOB,
 * so the job is ACK'd but the pipeline never runs, silently swallowing manual
 * POST /:id/run, webhook, and approval-resume runs at random. Separate queues
 * mean each queue has one worker and the two job types can never cross-consume.
 *
 * The scheduled tick itself does NOT execute the pipeline — it creates a Run
 * and calls enqueueRun(), which puts an "execute-run" job on runQueue where
 * processRun (the sole "pipeline-runs" consumer) picks it up.
 *
 * attempts is NOT overridable per-job for scheduler-produced jobs the way
 * enqueueRun sets it, so we hard-cap retries at the worker's own default of 1.
 * See processScheduledTick doc (A2): claimQuota has no rollback, so a
 * post-claim throw must not be retried by BullMQ.
 */
export function initScheduledTickWorker(): void {
  createWorker<ScheduledTickData>("pipeline-schedules", async (job) => {
    // Defensive: the schedule queue only ever carries SCHEDULED_TICK_JOB jobs
    // (registerSchedule is the only producer). This guard is belt-and-braces
    // against a future producer accidentally targeting this queue — a foreign
    // job is left alone rather than mis-processed as a tick.
    if (job.name !== SCHEDULED_TICK_JOB) {
      logger.warn(
        { jobId: job.id, jobName: job.name },
        "Scheduled-tick worker received an unexpected job name on pipeline-schedules — ignoring",
      );
      return;
    }
    await processScheduledTick(job as Job<ScheduledTickData>);
  });
  logger.info("Scheduled-tick worker initialized (queue=pipeline-schedules)");
}

/**
 * Reconcile Redis schedulers against the DB on boot (replaces the old
 * boot-only registration). Registers every enabled SCHEDULED pipeline of an
 * ACTIVE company, and removes any orphan scheduler in Redis whose pipeline is
 * gone / disabled / no longer SCHEDULED (G1/SCHED-04 — a deleted pipeline must
 * not keep a live scheduler after a restart).
 */
export async function initScheduledPipelines(): Promise<void> {
  const pipelines = await prisma.pipeline.findMany({
    where: {
      enabled: true,
      trigger: "SCHEDULED",
      schedule: { not: null },
      company: { status: "ACTIVE" },
    },
    select: { id: true, schedule: true },
  });

  const desired = new Set(pipelines.map((p) => p.id));

  // Register/refresh all desired schedules.
  for (const pipeline of pipelines) {
    await registerSchedule(pipeline);
  }

  // Remove orphan schedulers: anything in Redis not in the desired set.
  // Enumerate the DEDICATED schedule queue (schedulers live there now, not on
  // runQueue).
  const existing = await scheduleQueue.getJobSchedulers(0, -1);
  let orphans = 0;
  for (const sched of existing) {
    const id = sched.key ?? sched.id;
    if (id && !desired.has(id)) {
      await removeSchedule(id);
      orphans++;
    }
  }

  logger.info(
    { registered: desired.size, orphansRemoved: orphans },
    "Scheduled pipelines reconciled (BullMQ JobScheduler)",
  );
}

/**
 * SIGTERM hook. Under BullMQ JobScheduler the repeat state lives in Redis, so
 * a graceful shutdown MUST NOT remove the schedulers — doing so would delete
 * every schedule on every deploy. This is intentionally a no-op; schedulers
 * are only torn down by pipeline delete/disable via removeSchedule().
 */
export function stopScheduledPipelines(): void {
  logger.info("stopScheduledPipelines — no-op (JobScheduler state is durable in Redis)");
}
