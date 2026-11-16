/**
 * BRA-P1-04-N2 — zamanlanmış (cron tick ile açılan, trigger="scheduled") koşuda adım-düzeyi onay
 * kapısı. Kapı koşunun tetikleyicisine bakmaz (executeStep tek çekirdek nokta); bu dosya bunu
 * regresyon olarak sabitler: kullanıcı yokken adım WAITING_APPROVAL'da bekler, tekrar eden tick /
 * yeniden kuyruklama adımı onaysız çalıştırmaz, onayla devam eder, red/timeout'ta durur ve loglanır,
 * kiracı/koşu izolasyonu korunur. Sıfır ağ: prisma bellekte, exact-action tüketimi gerçek koddur.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type Row = Record<string, any>;
const h = vi.hoisted(() => ({
  approvals: [] as Row[],
  runs: {} as Record<string, { tenantId: string; status: string }>,
  seq: 0,
  runStepCreate: vi.fn(),
  runStepUpdate: vi.fn(),
  runAgentLoop: vi.fn(),
  activity: [] as Row[],
}));

function match(row: Row, where: Row): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v && typeof v === "object" && "lt" in (v as Row)) return row[k] < (v as Row).lt;
    return row[k] === v;
  });
}

vi.mock("../../../lib/db", () => ({
  prisma: {
    run: {
      findUnique: async ({ where }: any) => {
        const r = h.runs[where.id];
        if (!r) return null;
        return {
          id: where.id, budgetUsd: 1, input: {}, status: r.status, trigger: "scheduled",
          pipeline: { company: { id: "co-1", name: "c", tenantId: r.tenantId, agents: [
            { id: "ag", name: "Op", role: "operator", systemPrompt: "s", tools: [], model: "m", maxTokens: 10, autonomy: "AUTONOMOUS" },
          ] } },
        };
      },
    },
    runStep: { create: (...a: unknown[]) => h.runStepCreate(...a), update: (...a: unknown[]) => h.runStepUpdate(...a) },
    handoffLedger: { findFirst: async () => null },
    activityLog: { create: async ({ data }: any) => { h.activity.push(data); return {}; } },
    approval: {
      findMany: async ({ where }: any) => h.approvals.filter((r) => match(r, { consumedAt: null, ...where })).map((r) => ({
        ...r,
        run: { pipeline: { company: { tenantId: h.runs[r.runId].tenantId } } },
      })),
      updateMany: async ({ where, data }: any) => {
        const rows = h.approvals.filter((r) => match(r, where));
        rows.forEach((r) => Object.assign(r, data));
        return { count: rows.length };
      },
      findFirst: async ({ where }: any) => h.approvals.find((r) => match(r, where)) ?? null,
      create: async ({ data }: any) => { const r = { id: `ap-${++h.seq}`, consumedAt: null, decidedAt: null, createdAt: new Date(), ...data }; h.approvals.push(r); return r; },
      deleteMany: async ({ where }: any) => { const n = h.approvals.length; h.approvals = h.approvals.filter((r) => !match(r, where)); return { count: n - h.approvals.length }; },
    },
  },
}));
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
vi.mock("../../run/transition", () => ({
  transitionRun: async (_p: unknown, runId: string, to: string, opts: any) => {
    const r = h.runs[runId];
    if (!r || (opts?.tenantId && r.tenantId !== opts.tenantId)) return { ok: false, reason: "not_found" };
    if (opts?.onlyIfStatus && !opts.onlyIfStatus.includes(r.status)) return { ok: false, reason: "status_mismatch" };
    r.status = to === "NEEDS_APPROVAL" ? "WAITING_APPROVAL" : to;
    return { ok: true };
  },
}));
vi.mock("../../../lib/tenant-context", () => ({ runWithoutTenant: (_n: string, fn: () => unknown) => fn() }));
vi.mock("../../../lib/telemetry", () => ({
  withSpan: async (_n: string, fn: any) => fn({ end: vi.fn(), setAttribute: vi.fn() }),
  toolCallCounter: { add: vi.fn() },
  stepDurationHistogram: { record: vi.fn() },
}));

import { executeStep, type StepDef } from "../executor";
import { runApprovalExpiry } from "../../approval/expiry-cron";

const GATED: StepDef = { name: "E-posta gönder (onay gerekli)", agentRole: "operator", order: 1, config: { planned: true, tool: "send", risk: "high", needsApproval: true } };

const pending = (runId: string) => h.approvals.filter((r) => r.runId === runId && r.status === "PENDING");
function approve(runId: string) {
  const row = pending(runId).at(-1)!;
  row.status = "APPROVED";
  row.decidedAt = new Date();
  return row;
}
const actions = () => h.activity.map((a) => a.action);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("STEP_APPROVAL_GATE", "true");
  h.approvals = []; h.seq = 0; h.activity = [];
  h.runs = { "run-sched-1": { tenantId: "t-1", status: "RUNNING" }, "run-sched-2": { tenantId: "t-1", status: "RUNNING" }, "run-other": { tenantId: "t-2", status: "RUNNING" } };
  h.runStepCreate.mockResolvedValue({ id: "rs-1", startedAt: new Date() });
  h.runStepUpdate.mockResolvedValue({});
  h.runAgentLoop.mockResolvedValue({ finalContent: "ok", turns: [], totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: 0, totalToolCalls: 0 });
});
afterEach(() => vi.unstubAllEnvs());

describe("zamanlanmış koşu × adım onay kapısı", () => {
  it("kullanıcı yokken adım çalışmaz: WAITING_APPROVAL, tek PENDING onay, activity_log approval.requested (kiracı kapsamlı)", async () => {
    const r = await executeStep("run-sched-1", GATED, 1, {});
    expect(r.status).toBe("INTERRUPTED");
    expect(h.runAgentLoop).not.toHaveBeenCalled();
    expect(h.runStepCreate).not.toHaveBeenCalled();
    expect(h.runs["run-sched-1"].status).toBe("WAITING_APPROVAL");
    expect(pending("run-sched-1")).toHaveLength(1);
    const req = h.activity.find((a) => a.action === "approval.requested");
    expect(req?.tenantId).toBe("t-1");
    expect(req?.details).toMatchObject({ runId: "run-sched-1", gate: "step" });
  });

  it("tick/kuyruk tekrarı (aynı koşu yeniden işlenir) adımı onaysız çalıştırmaz ve ikinci onay satırı açmaz", async () => {
    await executeStep("run-sched-1", GATED, 1, {});
    for (let i = 0; i < 3; i++) {
      h.runs["run-sched-1"].status = "RUNNING"; // yeniden kuyruğa alma koşuyu RUNNING'e çeker
      const again = await executeStep("run-sched-1", GATED, 1, {});
      expect(again.status).toBe("INTERRUPTED");
    }
    expect(h.runAgentLoop).not.toHaveBeenCalled();
    expect(h.approvals).toHaveLength(1);
    expect(actions().filter((a) => a === "approval.requested")).toHaveLength(1);
  });

  it("onay verilince adım tam bir kez çalışır ve approval.consumed loglanır; tekrar onay ister", async () => {
    await executeStep("run-sched-1", GATED, 1, {});
    approve("run-sched-1");
    h.runs["run-sched-1"].status = "RUNNING";
    expect((await executeStep("run-sched-1", GATED, 1, {})).status).toBe("COMPLETED");
    expect(h.runAgentLoop).toHaveBeenCalledTimes(1);
    expect(h.activity.find((a) => a.action === "approval.consumed")?.tenantId).toBe("t-1");

    h.runs["run-sched-1"].status = "RUNNING";
    expect((await executeStep("run-sched-1", GATED, 1, {})).status).toBe("INTERRUPTED");
    expect(h.runAgentLoop).toHaveBeenCalledTimes(1);
  });

  it("red: adım çalışmaz (sonraki tick'lerde de)", async () => {
    await executeStep("run-sched-1", GATED, 1, {});
    h.approvals[0].status = "REJECTED";
    for (let i = 0; i < 2; i++) {
      h.runs["run-sched-1"].status = "RUNNING";
      expect((await executeStep("run-sched-1", GATED, 1, {})).status).toBe("INTERRUPTED");
    }
    expect(h.runAgentLoop).not.toHaveBeenCalled();
  });

  it("timeout: süre dolan bekleyen onay cron'la REJECTED, koşu CANCELLED, approval.expired loglanır; adım çalışmaz", async () => {
    await executeStep("run-sched-1", GATED, 1, {});
    h.approvals[0].createdAt = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await runApprovalExpiry();
    expect(h.approvals[0].status).toBe("REJECTED");
    expect(h.runs["run-sched-1"].status).toBe("CANCELLED");
    const exp = h.activity.find((a) => a.action === "approval.expired");
    expect(exp?.tenantId).toBe("t-1");
    expect(exp?.details).toMatchObject({ runId: "run-sched-1", runCancelled: true });
    expect(h.runAgentLoop).not.toHaveBeenCalled();
  });

  it("süresi geçmiş (expiresAt) onay, cron çalışmadan da adımı açmaz", async () => {
    await executeStep("run-sched-1", GATED, 1, {});
    const a = approve("run-sched-1");
    a.expiresAt = new Date(Date.now() - 1000);
    h.runs["run-sched-1"].status = "RUNNING";
    expect((await executeStep("run-sched-1", GATED, 1, {})).status).toBe("INTERRUPTED");
    expect(h.runAgentLoop).not.toHaveBeenCalled();
  });

  it("sonraki tick'in YENİ koşusu önceki koşunun onayını kullanamaz: kendi onayını ister, öncekine dokunmaz", async () => {
    await executeStep("run-sched-1", GATED, 1, {});
    const first = approve("run-sched-1"); // run-1 onaylı ama henüz tüketilmedi
    const second = await executeStep("run-sched-2", GATED, 1, {});
    expect(second.status).toBe("INTERRUPTED");
    expect(h.runAgentLoop).not.toHaveBeenCalled();
    expect(first.consumedAt).toBeNull();
    expect(pending("run-sched-2")).toHaveLength(1);
    expect(h.runs["run-sched-2"].status).toBe("WAITING_APPROVAL");
  });

  it("kiracı izolasyonu: başka kiracının onayı (satır tenantId'si farklı) zamanlanmış koşuyu açmaz; onay satırı koşunun kiracısını taşır", async () => {
    await executeStep("run-sched-1", GATED, 1, {});
    expect(h.approvals[0].tenantId).toBe("t-1");
    const a = approve("run-sched-1");
    a.tenantId = "t-2";
    h.runs["run-sched-1"].status = "RUNNING";
    expect((await executeStep("run-sched-1", GATED, 1, {})).status).toBe("INTERRUPTED");
    expect(h.runAgentLoop).not.toHaveBeenCalled();

    // başka kiracının zamanlanmış koşusu bağımsız kendi onayını açar
    await executeStep("run-other", GATED, 1, {});
    expect(h.approvals.filter((r) => r.runId === "run-other").every((r) => r.tenantId === "t-2")).toBe(true);
  });
});
