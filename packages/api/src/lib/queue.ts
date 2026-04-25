import { Queue, Worker, type Job, type WorkerOptions } from "bullmq";
import { redis } from "./redis";
import { logger } from "./logger";

// Cast to any to avoid ioredis version mismatch between bullmq's peer dep and direct dep
const connection = redis as any;

// Pipeline run queue — see modules/pipeline/runner.ts for retry/backoff
// configuration on enqueue. The Queue object itself only governs how jobs
// are serialised to Redis; per-job opts live at enqueueRun time.
export const runQueue = new Queue("pipeline-runs", { connection });

// Memory consolidation queue
export const memoryQueue = new Queue("memory-consolidation", { connection });

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
  const worker = new Worker<T>(queueName, processor, {
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
