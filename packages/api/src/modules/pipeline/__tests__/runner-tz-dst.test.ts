/**
 * BRA-P1-04a — TZ / DST contract for registerSchedule.
 *
 *  - `tz` passed to BullMQ upsertJobScheduler is env.SCHEDULER_TZ verbatim
 *    (Europe/Istanbul included).
 *  - Invalid cron is skipped (no upsert); invalid tz is NOT pre-validated by
 *    the app — BullMQ's rejection propagates to the caller.
 *  - DST transitions are delegated to BullMQ (cron-parser): the app does no
 *    DST arithmetic. Same pattern + tz option is passed through unchanged
 *    regardless of the date (spring-forward / fall-back), and no offset or
 *    UTC conversion is applied.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const scheduleQueueMock = vi.hoisted(() => ({
  upsertJobScheduler: vi.fn(),
  removeJobScheduler: vi.fn(),
}));
const envMock = vi.hoisted(() => ({ SCHEDULER_TZ: "UTC" }));

vi.mock("../../../lib/queue", () => ({
  runQueue: { upsertJobScheduler: vi.fn(), removeJobScheduler: vi.fn(), add: vi.fn() },
  scheduleQueue: scheduleQueueMock,
  createWorker: vi.fn(),
}));
vi.mock("../../../lib/db", () => ({ prisma: {} }));
vi.mock("../../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../../config/env", () => ({ env: envMock }));

import { registerSchedule } from "../runner";

beforeEach(() => {
  vi.clearAllMocks();
  envMock.SCHEDULER_TZ = "UTC";
});
afterEach(() => {
  vi.useRealTimers();
});

describe("registerSchedule — tz option", () => {
  it("passes Europe/Istanbul through to upsertJobScheduler", async () => {
    envMock.SCHEDULER_TZ = "Europe/Istanbul";
    await registerSchedule({ id: "pipe-tr", schedule: "30 8 * * 1-5" });

    expect(scheduleQueueMock.upsertJobScheduler).toHaveBeenCalledTimes(1);
    const [id, repeat] = scheduleQueueMock.upsertJobScheduler.mock.calls[0]!;
    expect(id).toBe("pipe-tr");
    expect(repeat).toEqual({ pattern: "30 8 * * 1-5", tz: "Europe/Istanbul" });
  });

  it("defaults to UTC when SCHEDULER_TZ is UTC", async () => {
    await registerSchedule({ id: "pipe-utc", schedule: "0 0 * * *" });
    expect(scheduleQueueMock.upsertJobScheduler.mock.calls[0]![1]).toEqual({
      pattern: "0 0 * * *",
      tz: "UTC",
    });
  });
});

describe("registerSchedule — invalid input", () => {
  it.each(["not a cron", "99 * * * *", "* * *", ""])(
    "rejects invalid cron %j without calling BullMQ",
    async (schedule) => {
      await registerSchedule({ id: "pipe-bad", schedule });
      expect(scheduleQueueMock.upsertJobScheduler).not.toHaveBeenCalled();
    },
  );

  it("invalid tz is not pre-validated; BullMQ's rejection propagates", async () => {
    envMock.SCHEDULER_TZ = "Mars/Olympus_Mons";
    scheduleQueueMock.upsertJobScheduler.mockRejectedValueOnce(new Error("Invalid time zone"));

    await expect(registerSchedule({ id: "pipe-badtz", schedule: "0 9 * * *" })).rejects.toThrow(
      "Invalid time zone",
    );
    expect(scheduleQueueMock.upsertJobScheduler).toHaveBeenCalledTimes(1);
    expect(scheduleQueueMock.upsertJobScheduler.mock.calls[0]![1]).toEqual({
      pattern: "0 9 * * *",
      tz: "Mars/Olympus_Mons",
    });
  });
});

describe("registerSchedule — DST is left to BullMQ", () => {
  // 2026 Europe/Berlin-style transitions; Istanbul has no DST (fixed +03),
  // but the app must behave identically for any IANA zone.
  const dates = [
    ["spring-forward", "2026-03-29T00:30:00Z"],
    ["fall-back", "2026-10-25T00:30:00Z"],
    ["ordinary day", "2026-07-01T12:00:00Z"],
  ] as const;

  it.each(dates)(
    "%s: option is passed unchanged, no app-side DST/offset math",
    async (_label, iso) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(iso));
      envMock.SCHEDULER_TZ = "Europe/Berlin";

      // 02:30 local does not exist on spring-forward and occurs twice on fall-back.
      await registerSchedule({ id: "pipe-dst", schedule: "30 2 * * *" });

      const [, repeat] = scheduleQueueMock.upsertJobScheduler.mock.calls[0]!;
      expect(repeat).toEqual({ pattern: "30 2 * * *", tz: "Europe/Berlin" });
      // Only pattern + tz are handed over: no startDate/offset/utc rewrite.
      expect(Object.keys(repeat).sort()).toEqual(["pattern", "tz"]);
    },
  );

  it("re-registering across a DST boundary yields identical repeat options", async () => {
    vi.useFakeTimers();
    envMock.SCHEDULER_TZ = "Europe/Berlin";

    vi.setSystemTime(new Date("2026-03-28T12:00:00Z"));
    await registerSchedule({ id: "pipe-dst", schedule: "30 2 * * *" });
    vi.setSystemTime(new Date("2026-03-30T12:00:00Z"));
    await registerSchedule({ id: "pipe-dst", schedule: "30 2 * * *" });

    const [a, b] = scheduleQueueMock.upsertJobScheduler.mock.calls;
    expect(a![1]).toEqual(b![1]);
  });
});
