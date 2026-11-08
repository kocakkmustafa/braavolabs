/**
 * BRA-P0-02c-4 — graph runner lifecycle writers go through `transitionRun`.
 * Drives the real `processRun` (via the captured BullMQ processor) against an
 * in-memory fake `runs` row so compare-and-set, the flag and the races are real.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  processor: null as null | ((job: unknown) => Promise<void>),
  row: {} as Record<string, any>,
  /** Simulates a concurrent write landing between the runner's read and its write. */
  raceBeforeFinal: null as null | { status: string; state: string },
  updateManyCalls: [] as any[],
  events: [] as any[],
  activity: [] as any[],
  executeStep: vi.fn(),
  checkGovernance: vi.fn(),
}));

vi.mock("../../../lib/queue", () => ({
  runQueue: { add: vi.fn() },
  scheduleQueue: { add: vi.fn() },
  createWorker: (_q: string, p: (job: unknown) => Promise<void>) => {
    h.processor = p;
  },
}));

function matches(where: Record<string, any>): boolean {
  for (const k of ["status", "state", "retryCount"]) {
    if (k in where && where[k] !== h.row[k]) return false;
  }
  return where.id === h.row.id;
}

vi.mock("../../../lib/db", () => {
  const run = {
    findUnique: vi.fn(async (args: any) => {
      if (args.select?.status) return { status: h.row.status };
      return {
        ...h.row,
        pipelineId: "pipe-1",
        trigger: "MANUAL",
        input: {},
        pipeline: {
          name: "P",
          pipelineType: "SEQUENTIAL",
          steps: [{ name: "s1", order: 0, agentId: "a1" }],
          company: { tenantId: "t1", agents: [] },
        },
      };
    }),
    findFirst: vi.fn(async (args: any) => {
      const sel = args.select ?? {};
      const out: Record<string, any> = {};
      for (const k of Object.keys(sel)) out[k] = h.row[k] ?? null;
      return out;
    }),
    updateMany: vi.fn(async (args: any) => {
      h.updateManyCalls.push(args);
      if (h.raceBeforeFinal && args.data.status === "COMPLETED") {
        h.row.status = h.raceBeforeFinal.status;
        h.row.state = h.raceBeforeFinal.state;
      }
      if (!matches(args.where)) return { count: 0 };
      for (const [k, v] of Object.entries(args.data)) {
        if (v && typeof v === "object" && "increment" in (v as any)) h.row[k] = (h.row[k] ?? 0) + (v as any).increment;
        else h.row[k] = v;
      }
      return { count: 1 };
    }),
    update: vi.fn(async () => ({})),
  };
  return {
    prisma: {
      run,
      runStep: { findMany: vi.fn(async () => []) },
      activityLog: { create: vi.fn(async (a: any) => h.activity.push(a.data.action)) },
    },
  };
});

vi.mock("../executor", () => ({
  executeStep: h.executeStep,
  checkGovernance: h.checkGovernance,
  planResume: () => ({ skip: new Set(), seededCost: 0 }),
}));
vi.mock("../../../lib/runEvents", () => ({ publishRunEvent: vi.fn(async (_id: string, e: any) => h.events.push(e.type)) }));
vi.mock("../../billing/metering", () => ({ incrementMeter: vi.fn(), checkQuota: vi.fn(), claimQuota: vi.fn() }));
vi.mock("../../../lib/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../../../config/env", () => ({ env: { SCHEDULER_TZ: "UTC" } }));
vi.mock("../../../lib/telemetry", () => {
  const c = { add: vi.fn(), record: vi.fn() };
  return {
    withSpan: vi.fn(),
    runCounter: c,
    runCompletedCounter: c,
    runFailedCounter: c,
    runDurationHistogram: c,
    runCostHistogram: c,
    governanceStopCounter: c,
  };
});

import { initPipelineRunner } from "../runner";

const job = (extra: Record<string, unknown> = {}) => ({ id: "j1", data: { runId: "run-1", tenantId: "t1" }, ...extra });
const okStep = { stepId: "st1", status: "COMPLETED", reasoning: "r", output: { x: 1 }, costUsd: 0.01, toolCallIds: [] };

function setRow(r: Record<string, any>) {
  h.row = { id: "run-1", status: "PENDING", state: null, retryCount: 0, jobBudget: null, ...r };
}
async function run(extra?: Record<string, unknown>) {
  await h.processor!(job(extra));
}
const namesState = () =>
  h.updateManyCalls.some((c) => "state" in c.data || "state" in c.where || "retryCount" in c.where || "retryCount" in c.data);

beforeEach(() => {
  h.events.length = 0;
  h.activity.length = 0;
  h.updateManyCalls.length = 0;
  h.raceBeforeFinal = null;
  h.executeStep.mockReset().mockResolvedValue(okStep);
  h.checkGovernance.mockReset().mockResolvedValue({ allowed: true });
  initPipelineRunner();
});
afterEach(() => {
  delete process.env.JOB_STATE_DUAL_WRITE;
});

describe("graph runner — flag OFF (legacy behaviour)", () => {
  it("writes RUNNING then COMPLETED through status-only CAS; never names state/retry_count", async () => {
    setRow({ status: "PENDING" });
    await run();
    expect(h.row.status).toBe("COMPLETED");
    expect(h.updateManyCalls[0].data.status).toBe("RUNNING");
    expect(h.updateManyCalls[0].data.startedAt).toBeInstanceOf(Date);
    expect(namesState()).toBe(false);
    expect(h.events).toEqual(["RUN_STARTED", "RUN_COMPLETED"]);
    expect(h.activity).toEqual(["run.execute", "run_step.complete", "run.completed"]);
  });

  it("failed step finalizes FAILED with the reason", async () => {
    setRow({});
    h.executeStep.mockResolvedValue({ ...okStep, status: "FAILED", reasoning: "boom" });
    await run();
    expect(h.row.status).toBe("FAILED");
    expect(h.row.error).toBe("boom");
    expect(h.events).toContain("RUN_FAILED");
  });

  it("final CAS lost (run flipped to CANCELLED between read and write): not overwritten, no side effects", async () => {
    setRow({});
    h.raceBeforeFinal = { status: "CANCELLED", state: "CANCELLED" };
    await run();
    expect(h.row.status).toBe("CANCELLED");
    expect(h.events).not.toContain("RUN_COMPLETED");
    expect(h.activity).not.toContain("run.completed");
  });

  it("redelivered job does NOT touch retry_count (flag off)", async () => {
    setRow({ status: "RUNNING" });
    await run({ attemptsMade: 1 });
    expect(h.row.retryCount).toBe(0);
    expect(namesState()).toBe(false);
  });
});

describe("graph runner — flag ON", () => {
  beforeEach(() => {
    process.env.JOB_STATE_DUAL_WRITE = "true";
  });

  it("READY→RUNNING→COMPLETED writes state with status in the same update", async () => {
    setRow({ status: "PENDING", state: "READY" });
    await run();
    expect(h.row).toMatchObject({ status: "COMPLETED", state: "COMPLETED" });
    expect(h.updateManyCalls[0].where).toMatchObject({ status: "PENDING", state: "READY" });
    expect(h.updateManyCalls[0].data).toMatchObject({ status: "RUNNING", state: "RUNNING" });
    expect(h.events).toEqual(["RUN_STARTED", "RUN_COMPLETED"]);
  });

  it("re-pickup of a RUNNING run still refreshes started_at (timeoutMs stays a per-leg bound)", async () => {
    setRow({ status: "RUNNING", state: "RUNNING", startedAt: new Date(0) });
    await run();
    expect(h.row.startedAt.getTime()).toBeGreaterThan(0);
    expect(h.row.state).toBe("COMPLETED");
  });

  it("RESUMING is advanced to RUNNING by the runner ((e))", async () => {
    setRow({ status: "RUNNING", state: "RESUMING" });
    await run();
    expect(h.updateManyCalls[0].where).toMatchObject({ state: "RESUMING" });
    expect(h.updateManyCalls[0].data).toMatchObject({ state: "RUNNING" });
    expect(h.row.state).toBe("COMPLETED");
  });

  it("PAUSED→COMPLETED race: operator paused mid-step; run stays PAUSED, no completion side effects", async () => {
    setRow({ status: "PENDING", state: "READY" });
    h.executeStep.mockImplementation(async () => {
      h.row.status = "PAUSED";
      h.row.state = "PAUSED";
      return okStep;
    });
    await run();
    expect(h.row).toMatchObject({ status: "PAUSED", state: "PAUSED" });
    expect(h.events).toEqual(["RUN_STARTED"]);
    expect(h.activity).not.toContain("run.completed");
  });

  it("CAS lost to a concurrent CANCELLED between read and write: re-read, run stays CANCELLED, clean exit", async () => {
    setRow({ status: "PENDING", state: "READY" });
    h.raceBeforeFinal = { status: "CANCELLED", state: "CANCELLED" };
    await run();
    expect(h.row).toMatchObject({ status: "CANCELLED", state: "CANCELLED" });
    expect(h.events).not.toContain("RUN_COMPLETED");
    expect(h.activity).not.toContain("run.completed");
  });

  it("a run cancelled before pickup is not started (no step, no events)", async () => {
    setRow({ status: "CANCELLED", state: "CANCELLED" });
    await run();
    expect(h.executeStep).not.toHaveBeenCalled();
    expect(h.events).toEqual([]);
    expect(h.activity).toEqual([]);
    expect(h.row.status).toBe("CANCELLED");
  });

  it("governance stop writes FAILED via transitionRun", async () => {
    setRow({ status: "PENDING", state: "READY" });
    h.checkGovernance.mockResolvedValue({ allowed: false, reason: "no money" });
    await run();
    expect(h.row).toMatchObject({ status: "FAILED", state: "FAILED", error: "no money" });
    expect(h.activity).toContain("run.governance_stop");
  });

  describe("crash recovery retry_count", () => {
    it("redelivered job on a crashed RUNNING run consumes one retry, resumes, completes", async () => {
      setRow({ status: "RUNNING", state: "RUNNING", retryCount: 0, jobBudget: { maxRetries: 2 } });
      await run({ attemptsMade: 1 });
      expect(h.row.retryCount).toBe(1);
      expect(h.row.state).toBe("COMPLETED");
      const rec = h.updateManyCalls[0];
      expect(rec.where).toMatchObject({ state: "RUNNING", retryCount: 0 });
      expect(rec.data).toMatchObject({ state: "RESUMING", status: "RUNNING", retryCount: { increment: 1 } });
    });

    it("retries exhausted: run FAILED, no step executed, no completion events", async () => {
      setRow({ status: "RUNNING", state: "RUNNING", retryCount: 2, jobBudget: { maxRetries: 2 } });
      await run({ attemptsMade: 1 });
      expect(h.row).toMatchObject({ status: "FAILED", state: "FAILED", retryCount: 2 });
      expect(h.executeStep).not.toHaveBeenCalled();
      expect(h.events).toEqual([]);
    });

    it("first delivery never consumes a retry", async () => {
      setRow({ status: "RUNNING", state: "RUNNING", retryCount: 0 });
      await run({ attemptsMade: 0, attemptsStarted: 1 });
      expect(h.row.retryCount).toBe(0);
    });

    it("lost retry CAS (two workers): loser exits without side effects", async () => {
      setRow({ status: "RUNNING", state: "RUNNING", retryCount: 0 });
      const db = (await import("../../../lib/db")).prisma as any;
      db.run.findFirst.mockImplementationOnce(async () => {
        const snap = { status: "RUNNING", state: "RUNNING", retryCount: 0 };
        h.row.retryCount = 1; // the other worker consumed it first
        return snap;
      });
      await run({ attemptsMade: 1 });
      expect(h.executeStep).not.toHaveBeenCalled();
      expect(h.events).toEqual([]);
      expect(h.row.retryCount).toBe(1);
    });
  });
});
