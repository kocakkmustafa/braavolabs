/**
 * E4/T2 — processScheduledTick fire-time behavior + idempotency.
 *
 * Covers the fire-time re-checks the old inline node-cron callback lacked (G3)
 * and the double-billing guard (A2): claimQuota has no rollback, so the tick
 * must run at most one claim per fire and must never be internally retried.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const prismaMock = vi.hoisted(() => ({
  pipeline: { findUnique: vi.fn(), update: vi.fn() },
  // run.findUnique is used by enqueueRun to snapshot the run's tenantId.
  run: { create: vi.fn(), findUnique: vi.fn() },
}));
vi.mock("../../../lib/db", () => ({ prisma: prismaMock }));

const claimQuotaMock = vi.hoisted(() => vi.fn());
const incrementMeterMock = vi.hoisted(() => vi.fn());
const checkQuotaMock = vi.hoisted(() => vi.fn());
vi.mock("../../billing/metering", () => ({
  claimQuota: claimQuotaMock,
  incrementMeter: incrementMeterMock,
  checkQuota: checkQuotaMock,
}));

const enqueueRunMock = vi.hoisted(() => vi.fn());
// enqueueRun lives in the same module under test, so we can't vi.mock it.
// Instead we mock runQueue.add (what enqueueRun ultimately calls) and stub the
// tenant lookup enqueueRun performs.
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
  createWorker: vi.fn(),
}));

vi.mock("../../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../../config/env", () => ({ env: { SCHEDULER_TZ: "UTC" } }));

import { processScheduledTick } from "../runner";

function makeJob(pipelineId = "pipe-1") {
  return { name: "scheduled-run", data: { pipelineId } } as any;
}

const activePipeline = {
  id: "pipe-1",
  enabled: true,
  trigger: "SCHEDULED",
  schedule: "0 9 * * *",
  companyId: "co-1",
  company: { status: "ACTIVE", tenantId: "tenant-1" },
};

beforeEach(() => {
  vi.clearAllMocks();
  runQueueMock.add.mockResolvedValue({ id: "job-1" });
  prismaMock.pipeline.update.mockResolvedValue({});
  // enqueueRun's tenant snapshot lookup.
  prismaMock.run.findUnique.mockResolvedValue({
    pipeline: { company: { tenantId: "tenant-1" } },
  });
});

describe("processScheduledTick — fire-time guards (G3)", () => {
  it("disabled pipeline → no run created", async () => {
    prismaMock.pipeline.findUnique.mockResolvedValue({ ...activePipeline, enabled: false });
    await processScheduledTick(makeJob());
    expect(claimQuotaMock).not.toHaveBeenCalled();
    expect(prismaMock.run.create).not.toHaveBeenCalled();
  });

  it("trigger no longer SCHEDULED → no run created", async () => {
    prismaMock.pipeline.findUnique.mockResolvedValue({ ...activePipeline, trigger: "MANUAL" });
    await processScheduledTick(makeJob());
    expect(prismaMock.run.create).not.toHaveBeenCalled();
  });

  it("schedule cleared → no run created", async () => {
    prismaMock.pipeline.findUnique.mockResolvedValue({ ...activePipeline, schedule: null });
    await processScheduledTick(makeJob());
    expect(prismaMock.run.create).not.toHaveBeenCalled();
  });

  it("deleted pipeline (null) → no run, no FK error path", async () => {
    prismaMock.pipeline.findUnique.mockResolvedValue(null);
    await processScheduledTick(makeJob());
    expect(prismaMock.run.create).not.toHaveBeenCalled();
  });

  it("company not ACTIVE → skip before claiming quota", async () => {
    prismaMock.pipeline.findUnique.mockResolvedValue({
      ...activePipeline,
      company: { status: "PAUSED", tenantId: "tenant-1" },
    });
    await processScheduledTick(makeJob());
    expect(claimQuotaMock).not.toHaveBeenCalled();
    expect(prismaMock.run.create).not.toHaveBeenCalled();
  });

  it("quota exhausted → no run created", async () => {
    prismaMock.pipeline.findUnique.mockResolvedValue(activePipeline);
    claimQuotaMock.mockResolvedValue({ claimed: false, value: 100, limit: 100 });
    await processScheduledTick(makeJob());
    expect(prismaMock.run.create).not.toHaveBeenCalled();
  });
});

describe("processScheduledTick — happy path", () => {
  it("creates exactly one run, enqueues it, and stamps lastRunAt", async () => {
    prismaMock.pipeline.findUnique.mockResolvedValue(activePipeline);
    claimQuotaMock.mockResolvedValue({ claimed: true, value: 1, limit: 100 });
    prismaMock.run.create.mockResolvedValue({ id: "run-1" });

    await processScheduledTick(makeJob());

    expect(claimQuotaMock).toHaveBeenCalledTimes(1);
    expect(prismaMock.run.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.run.create.mock.calls[0]![0].data).toMatchObject({
      pipelineId: "pipe-1",
      trigger: "scheduled",
      status: "PENDING",
    });
    // enqueueRun → runQueue.add fired for run-1
    expect(runQueueMock.add).toHaveBeenCalledTimes(1);
    // lastRunAt stamped
    expect(prismaMock.pipeline.update).toHaveBeenCalledTimes(1);
    expect(prismaMock.pipeline.update.mock.calls[0]![0]).toMatchObject({
      where: { id: "pipe-1" },
      data: expect.objectContaining({ lastRunAt: expect.any(Date) }),
    });
  });
});

describe("processScheduledTick — idempotency / no double-claim (A2)", () => {
  it("claimQuota succeeds then run.create throws → exactly ONE claim, error propagates (no in-fn retry)", async () => {
    prismaMock.pipeline.findUnique.mockResolvedValue(activePipeline);
    claimQuotaMock.mockResolvedValue({ claimed: true, value: 1, limit: 100 });
    prismaMock.run.create.mockRejectedValue(new Error("db down"));

    await expect(processScheduledTick(makeJob())).rejects.toThrow("db down");

    // The critical assertion: quota was claimed exactly once. Because the tick
    // never retries internally (and the worker is registered attempts:1), a
    // post-claim failure cannot double-bill the tenant.
    expect(claimQuotaMock).toHaveBeenCalledTimes(1);
  });
});
