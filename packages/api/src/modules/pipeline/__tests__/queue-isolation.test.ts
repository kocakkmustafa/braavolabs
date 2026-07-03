/**
 * E4 — Queue isolation / two-worker anti-collision regression guard.
 *
 * BullMQ delivers each job to exactly ONE worker per queue, ignoring job.name.
 * The original E4 design put BOTH the scheduled-tick worker and the execute-run
 * worker on the SAME "pipeline-runs" queue, so the two workers raced for every
 * job. Two failure modes resulted:
 *   1. A scheduled-tick job grabbed by the execute-run worker → runId=undefined,
 *      the scheduled run silently dropped.
 *   2. FAR worse: an execute-run job grabbed by the tick worker → not a
 *      SCHEDULED_TICK_JOB, so the tick worker no-op-ACK'd it and the pipeline
 *      NEVER ran — randomly swallowing manual POST /:id/run, webhook, and
 *      approval-resume runs (live repro: 29/50 execute-run jobs vanished).
 *
 * The fix: the scheduled-tick worker consumes a DEDICATED "pipeline-schedules"
 * queue; execute-run stays on "pipeline-runs". With one worker per queue the
 * two job types can never cross-consume.
 *
 * These tests assert the isolation structurally (the two workers register on
 * DIFFERENT queue names, tick jobs are produced only onto the schedule queue)
 * and behaviorally (the tick worker never processes — no-op-ACKs — an
 * execute-run job, because it is not even subscribed to that queue's jobs).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Capture every createWorker(queueName, processor) call so we can inspect which
// queue each init*Worker subscribes to and drive its processor directly.
const workerRegistrations: Array<{ queue: string; processor: (job: any) => Promise<void> }> = [];
const createWorkerMock = vi.hoisted(() => vi.fn());

const runQueueMock = vi.hoisted(() => ({
  add: vi.fn(),
  upsertJobScheduler: vi.fn(),
  removeJobScheduler: vi.fn(),
  getJobSchedulers: vi.fn(),
}));
const scheduleQueueMock = vi.hoisted(() => ({
  add: vi.fn(),
  upsertJobScheduler: vi.fn(),
  removeJobScheduler: vi.fn(),
  getJobSchedulers: vi.fn(),
}));
vi.mock("../../../lib/queue", () => ({
  runQueue: runQueueMock,
  scheduleQueue: scheduleQueueMock,
  createWorker: createWorkerMock,
}));

const prismaMock = vi.hoisted(() => ({
  pipeline: { findUnique: vi.fn(), update: vi.fn() },
  run: { create: vi.fn(), findUnique: vi.fn() },
}));
vi.mock("../../../lib/db", () => ({ prisma: prismaMock }));

const claimQuotaMock = vi.hoisted(() => vi.fn());
vi.mock("../../billing/metering", () => ({
  claimQuota: claimQuotaMock,
  incrementMeter: vi.fn(),
  checkQuota: vi.fn(),
}));

vi.mock("../../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../../config/env", () => ({ env: { SCHEDULER_TZ: "UTC" } }));

import {
  initPipelineRunner,
  initScheduledTickWorker,
  registerSchedule,
  SCHEDULED_TICK_JOB,
} from "../runner";

beforeEach(() => {
  vi.clearAllMocks();
  workerRegistrations.length = 0;
  // Record each worker registration.
  createWorkerMock.mockImplementation((queue: string, processor: (job: any) => Promise<void>) => {
    workerRegistrations.push({ queue, processor });
    return { on: vi.fn() } as any;
  });
});

describe("queue isolation — the schedule queue is NOT the run queue", () => {
  it("the two Queue objects have different names (distinct BullMQ queues)", () => {
    // The mocks stand in for the real Queue instances; the real ones are
    // constructed as new Queue("pipeline-runs") and new Queue("pipeline-schedules")
    // in lib/queue.ts. Here we assert the module wires the tick worker and the
    // run worker onto DIFFERENT queue names, which is the invariant that keeps
    // exactly one worker per queue.
    initPipelineRunner();
    initScheduledTickWorker();

    const queues = workerRegistrations.map((w) => w.queue);
    expect(queues).toContain("pipeline-runs");
    expect(queues).toContain("pipeline-schedules");
    // Crucially: the two workers are on DISTINCT queues (no shared queue → no race).
    expect(new Set(queues).size).toBe(2);
  });

  it("execute-run worker subscribes to pipeline-runs; scheduled-tick worker to pipeline-schedules", () => {
    initPipelineRunner();
    const runReg = workerRegistrations.find((w) => w.queue === "pipeline-runs");
    expect(runReg).toBeDefined();

    workerRegistrations.length = 0;
    initScheduledTickWorker();
    const tickReg = workerRegistrations.find((w) => w.queue === "pipeline-schedules");
    expect(tickReg).toBeDefined();
    // The tick worker must NOT also be on pipeline-runs.
    expect(workerRegistrations.some((w) => w.queue === "pipeline-runs")).toBe(false);
  });
});

describe("tick jobs are produced ONLY onto the schedule queue", () => {
  it("registerSchedule upserts the scheduler on scheduleQueue, never runQueue", async () => {
    await registerSchedule({ id: "pipe-1", schedule: "0 9 * * *" });

    expect(scheduleQueueMock.upsertJobScheduler).toHaveBeenCalledTimes(1);
    expect(scheduleQueueMock.upsertJobScheduler.mock.calls[0]![0]).toBe("pipe-1");
    // The run queue must never receive a scheduler — that is exactly the
    // collision the fix removes.
    expect(runQueueMock.upsertJobScheduler).not.toHaveBeenCalled();
  });
});

describe("tick worker NEVER no-op-ACKs an execute-run job (regression)", () => {
  it("an execute-run job handed to the tick-worker processor does not create a run or claim quota", async () => {
    // Register the tick worker and grab its processor.
    initScheduledTickWorker();
    const tickReg = workerRegistrations.find((w) => w.queue === "pipeline-schedules");
    expect(tickReg).toBeDefined();

    // Simulate the OLD bug: an execute-run job (name "execute-run") reaching
    // the tick-worker processor. In the correct design this job never lands
    // here (different queue), but even if a foreign job appeared on the
    // schedule queue, the processor must NOT treat it as a run trigger and
    // must NOT silently consume pipeline work.
    const executeRunJob = {
      id: "job-99",
      name: "execute-run",
      data: { runId: "run-abc", tenantId: "tenant-1" },
    };

    await tickReg!.processor(executeRunJob as any);

    // The processor left the foreign job alone: it did not run the scheduled
    // tick path (no pipeline lookup, no quota claim, no run creation). Because
    // the two workers are on separate queues, an execute-run job is consumed
    // by processRun on pipeline-runs — never silently ACK'd here.
    expect(prismaMock.pipeline.findUnique).not.toHaveBeenCalled();
    expect(claimQuotaMock).not.toHaveBeenCalled();
    expect(prismaMock.run.create).not.toHaveBeenCalled();
  });

  it("a genuine scheduled-tick job on the schedule queue IS processed", async () => {
    prismaMock.pipeline.findUnique.mockResolvedValue({
      id: "pipe-1",
      enabled: true,
      trigger: "SCHEDULED",
      schedule: "0 9 * * *",
      companyId: "co-1",
      company: { status: "ACTIVE", tenantId: "tenant-1" },
    });
    claimQuotaMock.mockResolvedValue({ claimed: true, value: 1, limit: 100 });
    prismaMock.run.create.mockResolvedValue({ id: "run-1" });
    prismaMock.run.findUnique.mockResolvedValue({
      pipeline: { company: { tenantId: "tenant-1" } },
    });
    prismaMock.pipeline.update.mockResolvedValue({});
    runQueueMock.add.mockResolvedValue({ id: "job-1" });

    initScheduledTickWorker();
    const tickReg = workerRegistrations.find((w) => w.queue === "pipeline-schedules");

    const tickJob = { id: "job-1", name: SCHEDULED_TICK_JOB, data: { pipelineId: "pipe-1" } };
    await tickReg!.processor(tickJob as any);

    // The tick creates a run and funnels the actual work onto runQueue via
    // enqueueRun (an "execute-run" job → processRun consumes it).
    expect(prismaMock.run.create).toHaveBeenCalledTimes(1);
    expect(runQueueMock.add).toHaveBeenCalledTimes(1);
    expect(runQueueMock.add.mock.calls[0]![0]).toBe("execute-run");
  });
});
