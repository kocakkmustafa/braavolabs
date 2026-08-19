import { Queue, Worker, type Job, type WorkerOptions } from "bullmq";
import { redis } from "./redis";
import { logger } from "./logger";
import { runWithoutTenant } from "./tenant-context";

// Cast to any to avoid ioredis version mismatch between bullmq's peer dep and direct dep
const connection = redis as any;

// Pipeline run queue — see modules/pipeline/runner.ts for retry/backoff
// configuration on enqueue. The Queue object itself only governs how jobs
// are serialised to Redis; per-job opts live at enqueueRun time.
export const runQueue = new Queue("pipeline-runs", { connection });

// Pipeline schedule queue (E4) — DEDICATED queue for BullMQ JobScheduler
// repeat state. It MUST be separate from runQueue: BullMQ delivers a job to
// exactly one worker per queue regardless of job.name, so two workers on the
// same queue race for every job. If the scheduled-tick worker and the
// execute-run worker shared "pipeline-runs", the tick worker could grab an
// execute-run job (and no-op ACK it → the pipeline never runs) and the
// execute-run worker could grab a scheduled-tick job (→ runId=undefined). By
// giving schedulers their own queue, each queue has exactly ONE worker and the
// two job types can never cross-consume. The scheduled tick still funnels the
// actual pipeline run back onto runQueue via enqueueRun("execute-run").
export const scheduleQueue = new Queue("pipeline-schedules", { connection });

// NOTE (E4/T4): a "memory-consolidation" Queue used to be declared here but
// had no producer and no worker — memory consolidation actually runs on a
// plain setInterval (modules/memory/consolidation-cron.ts). The dead export
// was removed to avoid implying a BullMQ path that doesn't exist. Redis
// key-prefixing was evaluated and intentionally NOT added: prod runs a
// dedicated password-auth aicos-redis (compose.prod.yaml) and the only other
// workspace project (Burun Farkı) is Vercel-hosted with no shared Redis, so
// getJobSchedulers() cannot enumerate a foreign app's schedulers.

/**
 * Default worker options applied to every queue we manage. Long-running
 * LLM steps need a generous lockDuration so the job isn't re-picked up
 * mid-run; matching stalledInterval keeps stall detection coarse enough
 * that a slow heartbeat doesn't trigger a false re-queue.
 */
const DEFAULT_WORKER_OPTS: Partial<WorkerOptions> = {
  lockDuration: 600_000, // 10 min — covers max run wall-clock + margin
  stalledInterval: 60_000,
  maxStalledCount: 1,
};

/**
 * Create a typed worker for a queue. Caller may override the defaults
 * (e.g. concurrency) via opts; redis connection is always wired here.
 */
export function createWorker<T>(
  queueName: string,
  processor: (job: Job<T>) => Promise<void>,
  opts: Partial<WorkerOptions> = {},
) {
  // BR-P0-004: a worker has no request and therefore no tenant context. Mark
  // that explicitly HERE, at the factory, rather than in each worker body —
  // a worker added later then inherits the marker instead of silently becoming
  // an unmarked path (which the fail-closed DB rule rejects at runtime, in
  // production, on a queue nobody is watching). Behavior is unchanged today:
  // currentTenantId() stays undefined inside the processor, exactly as before.
  // Forward EVERY argument: BullMQ calls the processor as
  // `processFn(job, token, signal)`. Swallowing token/signal would silently
  // disable Worker.RateLimitError, `job.moveToDelayed(ts, token)` and
  // abort-on-lock-loss for anything created through this factory.
  const scopedProcessor = (job: Job<T>, ...rest: unknown[]) =>
    runWithoutTenant(`worker:${queueName}`, () =>
      (processor as (...a: unknown[]) => Promise<void>)(job, ...rest),
    );

  const worker = new Worker<T>(queueName, scopedProcessor, {
    ...DEFAULT_WORKER_OPTS,
    ...opts,
    // connection is enforced — callers cannot pass a different redis
    // and accidentally split jobs across two backing stores.
    connection: connection as any,
  });

  worker.on("completed", (job) => {
    logger.info({ jobId: job.id, queue: queueName }, "Job completed");
  });

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, queue: queueName, error: err.message }, "Job failed");
  });

  return worker;
}
