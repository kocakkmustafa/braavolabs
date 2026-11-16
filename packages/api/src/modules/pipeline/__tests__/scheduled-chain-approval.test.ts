/**
 * BRA-P1-04-N2 — zincir kanıtı: processScheduledTick → run.create(trigger:"scheduled") → enqueueRun →
 * processRun (GERÇEK runner + GERÇEK executeStep + GERÇEK kapı) → gated adımda WAITING_APPROVAL'da durur,
 * onay satırı açılır, ajan döngüsü çalışmaz; processRun WAITING_APPROVAL koşuyu (artık bayat iş) tekrar
 * çalıştırmaz (runner.ts "refusing to execute"); tick tekrarı/ikinci tick bekleyen koşu varken koşu açmaz.
 * Sıfır ağ: prisma/kuyruk/redis bellekte.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type Row = Record<string, any>;
const h = vi.hoisted(() => ({
  processor: null as null | ((job: unknown) => Promise<void>),
  jobs: [] as Array<{ name: string; data: any }>,
  runs: {} as Record<string, Row>,
  approvals: [] as Row[],
  activity: [] as Row[],
  redisStore: new Map<string, string>(),
  seq: 0,
  runAgentLoop: vi.fn(),
  claimQuota: vi.fn(),
  steps: [] as any[],
}));

function match(row: Row, where: Row): boolean {
  // Minimal Prisma-where subset: equality, OR, { in }, { gte } (BRA-P2-06 overlap guard).
  return Object.entries(where).every(([k, v]) => {
    if (k === "OR") return (v as Row[]).some((w) => match(row, w));
    if (v && typeof v === "object" && !(v instanceof Date)) {
      if ("in" in v) return (v as any).in.includes(row[k]);
      if ("gte" in v) return row[k] instanceof Date && row[k] >= (v as any).gte;
    }
    return row[k] === v;
  });
}

vi.mock("../../../lib/queue", () => ({
  runQueue: { add: async (name: string, data: any) => { h.jobs.push({ name, data }); return { id: `job-${h.jobs.length}` }; } },
  scheduleQueue: { add: vi.fn() },
  createWorker: (_q: string, p: (job: unknown) => Promise<void>) => { h.processor = p; },
}));
vi.mock("../../../lib/redis", () => ({
  redis: { set: async (k: string) => { if (h.redisStore.has(k)) return null; h.redisStore.set(k, "1"); return "OK"; } },
}));
vi.mock("../../../config/env", () => ({ env: { SCHEDULER_TZ: "UTC" } }));
vi.mock("../../billing/metering", () => ({ incrementMeter: vi.fn(), checkQuota: vi.fn(), claimQuota: (...a: unknown[]) => h.claimQuota(...a) }));

const pipelineRow = () => ({
  id: "pipe-1", enabled: true, trigger: "SCHEDULED", schedule: "0 9 * * *", companyId: "co-1",
  company: { status: "ACTIVE", tenantId: "t-1" },
});

vi.mock("../../../lib/db", () => ({
  prisma: {
    pipeline: { findUnique: async () => pipelineRow(), update: async () => ({}) },
    run: {
      create: async ({ data }: any) => {
        const r = { id: `run-${++h.seq}`, costUsd: 0, state: null, retryCount: 0, jobBudget: null, input: {}, updatedAt: new Date(), ...data };
        h.runs[r.id] = r;
        return r;
      },
      findUnique: async ({ where, select }: any) => {
        const r = h.runs[where.id];
        if (!r) return null;
        if (select?.status && !select.pipeline) return { status: r.status };
        return {
          ...r,
          budgetUsd: 1,
          pipeline: {
            name: "P", pipelineType: "SEQUENTIAL", steps: h.steps,
            company: { id: "co-1", name: "c", tenantId: r.tenantId, agents: [
              { id: "ag", name: "Op", role: "operator", systemPrompt: "s", tools: [], model: "m", maxTokens: 10, autonomy: "AUTONOMOUS" },
            ] },
          },
        };
      },
      findFirst: async ({ where }: any) => Object.values(h.runs).find((r) => match(r, where)) ?? null,
      update: async () => ({}),
      updateMany: async () => ({ count: 1 }),
    },
    runStep: { findMany: async () => [], create: async () => ({ id: "rs-1", startedAt: new Date() }), update: async () => ({}) },
    handoffLedger: { findFirst: async () => null },
    activityLog: { create: async ({ data }: any) => { h.activity.push(data); return {}; } },
    approval: {
      findMany: async ({ where }: any) => h.approvals.filter((r) => match(r, { consumedAt: null, ...where })),
      updateMany: async ({ where, data }: any) => {
        const rows = h.approvals.filter((r) => match(r, where));
        rows.forEach((r) => Object.assign(r, data));
        return { count: rows.length };
      },
      findFirst: async ({ where }: any) => h.approvals.find((r) => match(r, where)) ?? null,
      create: async ({ data }: any) => { const r = { id: `ap-${++h.seq}`, consumedAt: null, decidedAt: null, ...data }; h.approvals.push(r); return r; },
      deleteMany: async () => ({ count: 0 }),
    },
  },
}));
vi.mock("../../run/transition", () => ({
  isJobStateDualWriteEnabled: () => false,
  transitionRun: async (_p: unknown, runId: string, to: string, opts: any) => {
    const r = h.runs[runId];
    if (!r || (opts?.tenantId && r.tenantId !== opts.tenantId)) return { ok: false, reason: "not_found" };
    if (opts?.onlyIfStatus && !opts.onlyIfStatus.includes(r.status)) return { ok: false, reason: "status_mismatch" };
    r.status = to === "NEEDS_APPROVAL" ? "WAITING_APPROVAL" : to;
    return { ok: true };
  },
}));
vi.mock("../../run/heartbeat", () => ({ beatRun: vi.fn(), forgetBeat: vi.fn() }));
vi.mock("../../../lib/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../../../lib/runEvents", () => ({ publishRunEvent: vi.fn() }));
vi.mock("../../agent/claude", () => ({
  runAgentLoop: (...a: unknown[]) => h.runAgentLoop(...a),
  HandoffInterrupt: class HandoffInterrupt extends Error {},
  buildHandoffResumeNote: vi.fn(),
}));
vi.mock("../../../services/provider-chain", () => ({ isHandoffTriggerEligible: () => false }));
vi.mock("../../../services/takeover-config", () => ({ resolveTakeoverConfig: vi.fn() }));
vi.mock("../../run/handoff.trigger", () => ({ maybeOpenAutoHandoff: vi.fn() }));
vi.mock("../../../services/push", () => ({ notifyTenantUsers: async () => undefined }));
vi.mock("../../../lib/tenant-context", () => ({ runWithoutTenant: (_n: string, fn: () => unknown) => fn() }));
vi.mock("../../../lib/telemetry", () => {
  const c = { add: vi.fn(), record: vi.fn() };
  return {
    withSpan: async (_n: string, fn: any) => fn({ end: vi.fn(), setAttribute: vi.fn() }),
    toolCallCounter: c, stepDurationHistogram: c,
    runCounter: c, runCompletedCounter: c, runFailedCounter: c, runDurationHistogram: c, runCostHistogram: c, governanceStopCounter: c,
  };
});
vi.mock("../executor", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../executor")>()),
  checkGovernance: async () => ({ allowed: true }),
}));

import { initPipelineRunner, processScheduledTick } from "../runner";

const GATED = { name: "E-posta gönder (onay gerekli)", agentRole: "operator", order: 0, config: { planned: true, tool: "send", risk: "high", needsApproval: true } };
const tick = (ts: number) => ({ name: "scheduled-run", data: { pipelineId: "pipe-1" }, timestamp: ts, opts: { delay: 60_000 } }) as any;
const drain = async () => {
  const j = h.jobs.shift()!;
  await h.processor!({ id: "j", name: j.name, data: j.data });
};
const skipReasons = () => h.activity.filter((a) => a.action === "pipeline.schedule.skip").map((a) => a.details.reason);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("STEP_APPROVAL_GATE", "true");
  h.jobs = []; h.runs = {}; h.approvals = []; h.activity = []; h.redisStore = new Map(); h.seq = 0;
  h.steps = [GATED];
  h.claimQuota.mockResolvedValue({ claimed: true, value: 1, limit: 100 });
  h.runAgentLoop.mockResolvedValue({ finalContent: "ok", turns: [], totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: 0, totalToolCalls: 0 });
  initPipelineRunner();
});
afterEach(() => vi.unstubAllEnvs());

describe("tick → run → processRun zinciri × adım onay kapısı", () => {
  it("tick scheduled koşu açar; processRun gated adımda WAITING_APPROVAL'da durur, onay satırı açılır, ajan çalışmaz, koşu finalize olmaz", async () => {
    await processScheduledTick(tick(1_000_000));
    const run = Object.values(h.runs)[0]!;
    expect(run).toMatchObject({ trigger: "scheduled", status: "PENDING", tenantId: "t-1" });
    expect(h.jobs).toHaveLength(1);

    await drain();

    expect(run.status).toBe("WAITING_APPROVAL");
    expect(h.runAgentLoop).not.toHaveBeenCalled();
    expect(h.approvals).toHaveLength(1);
    expect(h.approvals[0]).toMatchObject({ runId: run.id, tenantId: "t-1", status: "PENDING" });
    expect(h.activity.some((a) => a.action === "approval.requested" && a.tenantId === "t-1")).toBe(true);
    expect(h.activity.some((a) => a.action === "run.complete" || a.action === "run_step.complete")).toBe(false);
  });

  it("WAITING_APPROVAL koşu için bayat/yinelenen iş gelirse processRun onu tekrar çalıştırmaz (adım yok, yeni onay yok)", async () => {
    await processScheduledTick(tick(1_000_000));
    await drain();
    const run = Object.values(h.runs)[0]!;
    expect(run.status).toBe("WAITING_APPROVAL");

    for (let i = 0; i < 2; i++) await h.processor!({ id: `stale-${i}`, name: "execute-run", data: { runId: run.id, tenantId: "t-1" } });

    expect(run.status).toBe("WAITING_APPROVAL");
    expect(h.runAgentLoop).not.toHaveBeenCalled();
    expect(h.approvals).toHaveLength(1);
  });

  it("onay bekleyen koşu varken sonraki tick koşu açmaz ve kota yemez (waiting_approval skip); koşu çözülünce sonraki tick açar", async () => {
    await processScheduledTick(tick(1_000_000));
    await drain();
    const first = Object.values(h.runs)[0]!;
    expect(h.claimQuota).toHaveBeenCalledTimes(1);

    await processScheduledTick(tick(2_000_000));
    expect(Object.keys(h.runs)).toHaveLength(1);
    expect(h.jobs).toHaveLength(0);
    expect(h.claimQuota).toHaveBeenCalledTimes(1);
    expect(skipReasons()).toEqual(["waiting_approval"]);

    first.status = "CANCELLED"; // red / timeout
    await processScheduledTick(tick(3_000_000));
    expect(Object.keys(h.runs)).toHaveLength(2);
    expect(h.claimQuota).toHaveBeenCalledTimes(2);
  });
});
