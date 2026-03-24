import { Queue, Worker, type Job } from "bullmq";
import { redis } from "./redis";
import { logger } from "./logger";

// Cast to any to avoid ioredis version mismatch between bullmq's peer dep and direct dep
const connection = redis as any;

// Pipeline run queue
export const runQueue = new Queue("pipeline-runs", { connection });

// Outreach queue
export const outreachQueue = new Queue("outreach", { connection });

// Memory consolidation queue
export const memoryQueue = new Queue("memory-consolidation", { connection });

/**
 * Create a typed worker for a queue.
 */
export function createWorker<T>(
  queueName: string,
  processor: (job: Job<T>) => Promise<void>,
) {
  const worker = new Worker<T>(queueName, processor, { connection: connection as any });

  worker.on("completed", (job) => {
    logger.info({ jobId: job.id, queue: queueName }, "Job completed");
  });

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, queue: queueName, error: err.message }, "Job failed");
  });

  return worker;
}
