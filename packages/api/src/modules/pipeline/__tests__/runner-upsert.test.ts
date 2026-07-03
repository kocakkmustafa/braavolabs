/**
 * E4/T1 — registerSchedule / removeSchedule map correctly onto the BullMQ
 * JobScheduler API.
 *
 * Guards the contract that:
 *  - registerSchedule calls upsertJobScheduler with (pipeline.id, {pattern,tz},
 *    {name, data}) so the scheduler is keyed by pipeline.id (idempotent, G2),
 *  - an invalid cron pattern is logged-and-skipped (no upsert),
 *  - removeSchedule calls removeJobScheduler with pipeline.id.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// registerSchedule / removeSchedule target the DEDICATED scheduleQueue (E4),
// NOT runQueue. Both are mocked; the assertions below verify the scheduler
// API is called on scheduleQueue and that runQueue is left untouched (so a
// regression that re-points schedulers at runQueue is caught).
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

vi.mock("../../../lib/db", () => ({ prisma: {} }));

vi.mock("../../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../../config/env", () => ({ env: { SCHEDULER_TZ: "UTC" } }));

import { registerSchedule, removeSchedule, SCHEDULED_TICK_JOB } from "../runner";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("registerSchedule", () => {
  it("upserts a JobScheduler keyed by pipeline.id with pattern + tz", async () => {
    await registerSchedule({ id: "pipe-1", schedule: "0 9 * * *" });

    expect(scheduleQueueMock.upsertJobScheduler).toHaveBeenCalledTimes(1);
    const [id, repeat, template] = scheduleQueueMock.upsertJobScheduler.mock.calls[0]!;
    expect(id).toBe("pipe-1");
    expect(repeat).toEqual({ pattern: "0 9 * * *", tz: "UTC" });
    expect(template.name).toBe(SCHEDULED_TICK_JOB);
    expect(template.data).toEqual({ pipelineId: "pipe-1" });
  });

  it("targets the DEDICATED schedule queue, never the run queue (anti-collision)", async () => {
    await registerSchedule({ id: "pipe-1", schedule: "0 9 * * *" });
    // The whole point of the fix: schedulers must NOT be produced onto the
    // pipeline-runs queue (where the execute-run worker would race them).
    expect(runQueueMock.upsertJobScheduler).not.toHaveBeenCalled();
  });

  it("re-registering the same pipeline uses the same scheduler id (idempotent)", async () => {
    await registerSchedule({ id: "pipe-1", schedule: "0 9 * * *" });
    await registerSchedule({ id: "pipe-1", schedule: "*/5 * * * *" });

    const ids = scheduleQueueMock.upsertJobScheduler.mock.calls.map((c) => c[0]);
    expect(ids).toEqual(["pipe-1", "pipe-1"]);
    // Second call carries the new pattern.
    expect(scheduleQueueMock.upsertJobScheduler.mock.calls[1]![1]).toEqual({
      pattern: "*/5 * * * *",
      tz: "UTC",
    });
  });

  it("does NOT upsert when the schedule is null", async () => {
    await registerSchedule({ id: "pipe-1", schedule: null });
    expect(scheduleQueueMock.upsertJobScheduler).not.toHaveBeenCalled();
  });

  it("does NOT upsert when the cron pattern is invalid", async () => {
    await registerSchedule({ id: "pipe-1", schedule: "not a cron" });
    expect(scheduleQueueMock.upsertJobScheduler).not.toHaveBeenCalled();
  });
});

describe("removeSchedule", () => {
  it("removes the JobScheduler by pipeline.id from the schedule queue", async () => {
    scheduleQueueMock.removeJobScheduler.mockResolvedValue(true);
    await removeSchedule("pipe-9");
    expect(scheduleQueueMock.removeJobScheduler).toHaveBeenCalledWith("pipe-9");
    expect(runQueueMock.removeJobScheduler).not.toHaveBeenCalled();
  });

  it("tolerates a missing scheduler (removeJobScheduler → false)", async () => {
    scheduleQueueMock.removeJobScheduler.mockResolvedValue(false);
    await expect(removeSchedule("pipe-absent")).resolves.toBeUndefined();
  });
});
