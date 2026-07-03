/**
 * E4/T2 — initScheduledPipelines reconciles Redis schedulers against the DB on
 * boot: register every desired pipeline, remove every orphan scheduler (a
 * scheduler in Redis whose pipeline is gone/disabled/not-scheduled), so a
 * deleted pipeline's scheduler doesn't re-appear after a restart (G1/SCHED-04).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const prismaMock = vi.hoisted(() => ({
  pipeline: { findMany: vi.fn() },
}));
vi.mock("../../../lib/db", () => ({ prisma: prismaMock }));

// Reconcile now operates on the dedicated scheduleQueue (E4). runQueue is also
// mocked so we can assert reconciliation never touches it.
const scheduleQueueMock = vi.hoisted(() => ({
  upsertJobScheduler: vi.fn(),
  removeJobScheduler: vi.fn(),
  getJobSchedulers: vi.fn(),
  add: vi.fn(),
}));
const runQueueMock = vi.hoisted(() => ({
  upsertJobScheduler: vi.fn(),
  removeJobScheduler: vi.fn(),
  getJobSchedulers: vi.fn(),
  add: vi.fn(),
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

import { initScheduledPipelines } from "../runner";

beforeEach(() => {
  vi.clearAllMocks();
  scheduleQueueMock.removeJobScheduler.mockResolvedValue(true);
});

describe("initScheduledPipelines — boot reconcile", () => {
  it("registers desired pipelines and removes orphan schedulers", async () => {
    // DB has one enabled SCHEDULED pipeline: A.
    prismaMock.pipeline.findMany.mockResolvedValue([{ id: "A", schedule: "0 9 * * *" }]);
    // Redis currently has schedulers for A (stale, will be refreshed) and a
    // deleted pipeline C (orphan → must be removed).
    scheduleQueueMock.getJobSchedulers.mockResolvedValue([
      { key: "A", next: 123 },
      { key: "C", next: 456 },
    ]);

    await initScheduledPipelines();

    // A is (re)registered.
    const registered = scheduleQueueMock.upsertJobScheduler.mock.calls.map((c) => c[0]);
    expect(registered).toEqual(["A"]);

    // C (orphan) is removed; A (desired) is NOT removed.
    const removed = scheduleQueueMock.removeJobScheduler.mock.calls.map((c) => c[0]);
    expect(removed).toEqual(["C"]);
    expect(removed).not.toContain("A");

    // Reconciliation happens entirely on the schedule queue — the run queue's
    // scheduler API is never touched (regression guard for the queue split).
    expect(runQueueMock.getJobSchedulers).not.toHaveBeenCalled();
    expect(runQueueMock.upsertJobScheduler).not.toHaveBeenCalled();
    expect(runQueueMock.removeJobScheduler).not.toHaveBeenCalled();
  });

  it("with no desired pipelines, removes every existing scheduler", async () => {
    prismaMock.pipeline.findMany.mockResolvedValue([]);
    scheduleQueueMock.getJobSchedulers.mockResolvedValue([{ key: "X" }, { key: "Y" }]);

    await initScheduledPipelines();

    expect(scheduleQueueMock.upsertJobScheduler).not.toHaveBeenCalled();
    expect(scheduleQueueMock.removeJobScheduler.mock.calls.map((c) => c[0]).sort()).toEqual(["X", "Y"]);
  });

  it("with no existing schedulers, only registers (no removals)", async () => {
    prismaMock.pipeline.findMany.mockResolvedValue([{ id: "A", schedule: "0 9 * * *" }]);
    scheduleQueueMock.getJobSchedulers.mockResolvedValue([]);

    await initScheduledPipelines();

    expect(scheduleQueueMock.upsertJobScheduler.mock.calls.map((c) => c[0])).toEqual(["A"]);
    expect(scheduleQueueMock.removeJobScheduler).not.toHaveBeenCalled();
  });
});
