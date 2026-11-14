/**
 * BRA-P1-04a — TZ / DST contract for registerSchedule.
 *
 *  - `tz` passed to BullMQ upsertJobScheduler is env.SCHEDULER_TZ verbatim
 *    (Europe/Istanbul included).
 *  - Invalid cron is skipped (no upsert); invalid tz is NOT pre-validated by
 *    the app — whatever BullMQ rejects with propagates to the caller.
 *  - DST is delegated to BullMQ (cron-parser): registerSchedule is
 *    date-independent and does no DST math. REAL DST behaviour is exercised
 *    directly against cron-parser (the library BullMQ uses).
 */
import { createRequire } from "node:module";
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
import { logger } from "../../../lib/logger";

// cron-parser is BullMQ's own (transitive) dependency, not ours. Resolve it
// through bullmq so no new dependency / lockfile change is needed.
const bullmqRequire = createRequire(createRequire(import.meta.url).resolve("bullmq"));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const cronParser: any = bullmqRequire("cron-parser");
const nextFires = (pattern: string, tz: string, from: string, n: number): string[] => {
  const it = cronParser.parseExpression(pattern, { currentDate: new Date(from), tz });
  return Array.from({ length: n }, () => it.next().toDate().toISOString());
};

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
  it.each(["not a cron", "99 * * * *", "* * *"])(
    "skips invalid cron %j without calling BullMQ and warns",
    async (schedule) => {
      await registerSchedule({ id: "pipe-bad", schedule });
      expect(scheduleQueueMock.upsertJobScheduler).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledTimes(1);
    },
  );

  it("skips an empty schedule string (short-circuits on !schedule, before cron.validate)", async () => {
    await registerSchedule({ id: "pipe-empty", schedule: "" });
    expect(scheduleQueueMock.upsertJobScheduler).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  // NOTE: this proves only that registerSchedule does not swallow/pre-validate
  // tz errors (error propagation with a MOCKED rejection). It is NOT evidence
  // of BullMQ's real rejection; see the cron-parser test below for that.
  it("invalid tz: app does not pre-validate; a (mocked) BullMQ rejection propagates", async () => {
    envMock.SCHEDULER_TZ = "Mars/Olympus_Mons";
    scheduleQueueMock.upsertJobScheduler.mockRejectedValueOnce(new Error("Invalid time zone"));

    await expect(registerSchedule({ id: "pipe-badtz", schedule: "0 9 * * *" })).rejects.toThrow(
      "Invalid time zone",
    );
    expect(scheduleQueueMock.upsertJobScheduler.mock.calls[0]![1]).toEqual({
      pattern: "0 9 * * *",
      tz: "Mars/Olympus_Mons",
    });
  });

  it("cron-parser (BullMQ's engine) really rejects an unknown tz", () => {
    expect(() => nextFires("0 9 * * *", "Mars/Olympus_Mons", "2026-03-01T00:00:00Z", 1)).toThrow();
  });
});

describe("registerSchedule — date-independent tz pass-through", () => {
  it.each(["2026-03-08T00:00:00Z", "2026-11-01T00:00:00Z", "2026-07-01T12:00:00Z"])(
    "at %s the repeat options are identical: only {pattern, tz}, no app-side DST math",
    async (iso) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(iso));
      envMock.SCHEDULER_TZ = "America/New_York";
      await registerSchedule({ id: "pipe-dst", schedule: "30 2 * * *" });
      expect(scheduleQueueMock.upsertJobScheduler.mock.calls[0]![1]).toEqual({
        pattern: "30 2 * * *",
        tz: "America/New_York",
      });
    },
  );
});

describe("DST handled by cron-parser (BullMQ's engine), not by the app", () => {
  it("America/New_York spring-forward 2026-03-08: nonexistent 02:30 local still fires once (as 03:30 EDT)", () => {
    const fires = nextFires("30 2 * * *", "America/New_York", "2026-03-07T12:00:00Z", 3);
    expect(fires).toEqual([
      "2026-03-08T07:30:00.000Z", // observed cron-parser behaviour: 02:30 EST-equivalent instant = 03:30 EDT
      "2026-03-09T06:30:00.000Z", // 02:30 EDT (-04)
      "2026-03-10T06:30:00.000Z",
    ]);
  });

  it("America/New_York offset changes across the boundary for '0 9 * * *'", () => {
    const fires = nextFires("0 9 * * *", "America/New_York", "2026-03-07T00:00:00Z", 3);
    expect(fires).toEqual([
      "2026-03-07T14:00:00.000Z", // 09:00 EST (-05)
      "2026-03-08T13:00:00.000Z", // 09:00 EDT (-04)
      "2026-03-09T13:00:00.000Z",
    ]);
  });

  it("America/New_York fall-back 2026-11-01: wall-clock '0 9 * * *' shifts from EDT to EST", () => {
    const fires = nextFires("0 9 * * *", "America/New_York", "2026-10-31T00:00:00Z", 3);
    expect(fires).toEqual([
      "2026-10-31T13:00:00.000Z", // EDT (-04)
      "2026-11-01T14:00:00.000Z", // EST (-05)
      "2026-11-02T14:00:00.000Z",
    ]);
  });

  it("Europe/Istanbul has no DST: fixed +03 all year", () => {
    const summer = nextFires("0 9 * * *", "Europe/Istanbul", "2026-07-01T00:00:00Z", 1);
    const winter = nextFires("0 9 * * *", "Europe/Istanbul", "2026-01-15T00:00:00Z", 1);
    expect(summer).toEqual(["2026-07-01T06:00:00.000Z"]);
    expect(winter).toEqual(["2026-01-15T06:00:00.000Z"]);
    const across = nextFires("0 9 * * *", "Europe/Istanbul", "2026-03-07T00:00:00Z", 3);
    expect(across.every((f) => f.endsWith("T06:00:00.000Z"))).toBe(true);
  });
});
