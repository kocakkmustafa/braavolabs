/**
 * BRA-P0-03d — runner seviyesi: kapı bekleyen adım (`executeStep` → INTERRUPTED) koşuyu finalize
 * ETMEZ (sıralı + paralel); adım `config`i (needsApproval/risk) executeStep'e BOZULMADAN geçer
 * (resume/continue/retry yeniden kuyruğa alma aynı processRun yolunu kullanır). executeStep mock'ludur;
 * kapının kendisi step-approval.test.ts'te.
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
  steps: [] as any[],
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
          steps: h.steps,
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


const GATED_CFG = { planned: true, risk: "high", needsApproval: true };
const waiting = { stepId: "", status: "INTERRUPTED", reasoning: "Step is waiting for approval", output: null, costUsd: 0, toolCallIds: [] };

beforeEach(() => {
  h.events.length = 0;
  h.activity.length = 0;
  h.updateManyCalls.length = 0;
  h.raceBeforeFinal = null;
  h.executeStep.mockReset().mockResolvedValue(okStep);
  h.checkGovernance.mockReset().mockResolvedValue({ allowed: true });
  initPipelineRunner();
});

describe("runner × adım-düzeyi onay kapısı", () => {
  it("sıralı: kapı bekletirse koşu COMPLETED/FAILED yapılmaz, RUN_COMPLETED yok", async () => {
    h.steps = [{ name: "s1", order: 0, agentRole: "op", config: GATED_CFG }];
    setRow({});
    h.executeStep.mockResolvedValue(waiting);
    await run();
    expect(h.row.status).toBe("RUNNING");
    expect(h.events).not.toContain("RUN_COMPLETED");
    expect(h.events).not.toContain("RUN_FAILED");
    expect(h.activity).not.toContain("run.completed");
  });

  it("paralel: kardeş adım bekletirse (interrupted) finalize edilmez; diğer adım tamamlanmış sayılır", async () => {
    h.steps = [
      { name: "a", order: 0, agentRole: "op", config: GATED_CFG },
      { name: "b", order: 0, agentRole: "op", config: {} },
    ];
    setRow({});
    h.executeStep.mockResolvedValueOnce(waiting).mockResolvedValueOnce(okStep);
    await run();
    expect(h.executeStep).toHaveBeenCalledTimes(2);
    expect(h.row.status).not.toBe("COMPLETED");
    expect(h.row.status).not.toBe("FAILED");
    expect(h.events).not.toContain("RUN_COMPLETED");
  });

  it("yeniden kuyruğa alınan koşu (resume/continue/retry yolu) adım config'ini executeStep'e aynen geçirir", async () => {
    h.steps = [{ name: "s1", order: 0, agentRole: "op", config: GATED_CFG }];
    setRow({ status: "RUNNING" });
    await run({ attemptsMade: 1 });
    expect(h.executeStep).toHaveBeenCalledTimes(1);
    expect(h.executeStep.mock.calls[0][1].config).toEqual(GATED_CFG);
  });
});
