/**
 * BRA-P0-03d — adım-düzeyi onay kapısı. Sıfır ağ: prisma, ajan döngüsü, durum makinesi mock'lanır;
 * Approval tablosu bellekte (exact-action tüketimi gerçek koddur).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type Row = Record<string, any>;
const h = vi.hoisted(() => ({
  approvals: [] as Row[],
  seq: 0,
  runStatus: "RUNNING",
  runStepCreate: vi.fn(),
  runStepUpdate: vi.fn(),
  runAgentLoop: vi.fn(),
  transition: vi.fn(),
  activityCreate: vi.fn(),
}));

function match(row: Row, where: Row): boolean {
  return Object.entries(where).every(([k, v]) => row[k] === v);
}

vi.mock("../../../lib/db", () => ({
  prisma: {
    run: {
      findUnique: async () => ({
        id: "run-1", budgetUsd: 1, input: {}, status: h.runStatus,
        pipeline: { company: { id: "co-1", name: "c", tenantId: "t-1", agents: [
          { id: "ag", name: "Op", role: "operator", systemPrompt: "s", tools: [], model: "m", maxTokens: 10, autonomy: "AUTONOMOUS" },
        ] } },
      }),
    },
    runStep: { create: (...a: unknown[]) => h.runStepCreate(...a), update: (...a: unknown[]) => h.runStepUpdate(...a) },
    handoffLedger: { findFirst: async () => null },
    activityLog: { create: (...a: unknown[]) => h.activityCreate(...a) },
    approval: {
      findMany: async ({ where }: any) => h.approvals.filter((r) => match(r, { runId: where.runId, tenantId: where.tenantId, actionHash: where.actionHash, status: where.status, consumedAt: null })),
      updateMany: async ({ where, data }: any) => {
        const rows = h.approvals.filter((r) => match(r, where));
        rows.forEach((r) => Object.assign(r, data));
        return { count: rows.length };
      },
      findFirst: async ({ where }: any) => h.approvals.find((r) => match(r, where)) ?? null,
      create: async ({ data }: any) => { const r = { id: `ap-${++h.seq}`, consumedAt: null, decidedAt: null, ...data }; h.approvals.push(r); return r; },
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
vi.mock("../../run/transition", () => ({ transitionRun: (...a: unknown[]) => h.transition(...a) }));
vi.mock("../../../lib/telemetry", () => ({
  withSpan: async (_n: string, fn: any) => fn({ end: vi.fn(), setAttribute: vi.fn() }),
  toolCallCounter: { add: vi.fn() },
  stepDurationHistogram: { record: vi.fn() },
}));

import { executeStep, type StepDef } from "../executor";
import { pipelineHasGatedSteps, requireStepApproval, stepRequiresApproval } from "../step-approval";

const GATED: StepDef = { name: "E-posta gönder (onay gerekli)", agentRole: "operator", order: 1, config: { planned: true, tool: "send", risk: "high", needsApproval: true } };
const PLAIN: StepDef = { name: "Taslak", agentRole: "operator", order: 0, config: { planned: true, tool: "draft", risk: "low", needsApproval: false } };

/** Operatörün onayı: bekleyen satırı APPROVED yapar (decide ucunun etkisi). */
function approveLatest() {
  const row = h.approvals.filter((r) => r.status === "PENDING").at(-1)!;
  row.status = "APPROVED";
  row.decidedAt = new Date();
  return row;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.approvals = []; h.seq = 0; h.runStatus = "RUNNING";
  h.runStepCreate.mockResolvedValue({ id: "rs-1", startedAt: new Date() });
  h.runStepUpdate.mockResolvedValue({});
  h.transition.mockImplementation(async () => { h.runStatus = "WAITING_APPROVAL"; return { ok: true }; });
  h.activityCreate.mockResolvedValue({});
  h.runAgentLoop.mockResolvedValue({ finalContent: "ok", turns: [], totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: 0, totalToolCalls: 0 });
});
afterEach(() => vi.unstubAllEnvs());

describe("STEP_APPROVAL_GATE kapalı (varsayılan): davranış birebir eski", () => {
  it("yüksek riskli adım da eskisi gibi çalışır; onay satırı/geçiş yok", async () => {
    const r = await executeStep("run-1", GATED, 1, {});
    expect(r.status).toBe("COMPLETED");
    expect(h.runAgentLoop).toHaveBeenCalledTimes(1);
    expect(h.approvals).toHaveLength(0);
    expect(h.transition).not.toHaveBeenCalled();
  });
  it("yalnız literal 'true' açar", async () => {
    vi.stubEnv("STEP_APPROVAL_GATE", "1");
    expect((await executeStep("run-1", GATED, 1, {})).status).toBe("COMPLETED");
    expect(h.approvals).toHaveLength(0);
  });
});

describe("STEP_APPROVAL_GATE açık", () => {
  beforeEach(() => vi.stubEnv("STEP_APPROVAL_GATE", "true"));

  it("onaysız yüksek riskli adım ÇALIŞMAZ (AUTONOMOUS ajan dahil; araç çağrısı sayacı 0)", async () => {
    const r = await executeStep("run-1", GATED, 1, {});
    expect(r.status).toBe("INTERRUPTED");
    expect(h.runAgentLoop).not.toHaveBeenCalled();
    expect(h.runStepCreate).not.toHaveBeenCalled();
    expect(h.transition.mock.calls[0][2]).toBe("NEEDS_APPROVAL");
    expect(h.approvals).toHaveLength(1);
    const a = h.approvals[0];
    expect(a).toMatchObject({ runId: "run-1", tenantId: "t-1", status: "PENDING", metadata: expect.objectContaining({ gate: "step", stepIndex: 1 }) });
    expect(a.nonce && a.actionHash && a.expiresAt).toBeTruthy();
  });

  it("yüksek riskli olmayan adım kapıdan etkilenmez", async () => {
    expect((await executeStep("run-1", PLAIN, 0, {})).status).toBe("COMPLETED");
    expect(h.approvals).toHaveLength(0);
  });

  it("onay sonrası adım TEK kez çalışır; aynı onay ikinci kez geçmez (replay/retry yeni onay ister)", async () => {
    await executeStep("run-1", GATED, 1, {});
    const grant = approveLatest();
    const ok = await executeStep("run-1", GATED, 1, {});
    expect(ok.status).toBe("COMPLETED");
    expect(h.runAgentLoop).toHaveBeenCalledTimes(1);
    expect(grant.consumedAt).toBeInstanceOf(Date);

    h.runStatus = "RUNNING";
    const replay = await executeStep("run-1", GATED, 1, {}); // retry / resume sonrası yeniden çalıştırma
    expect(replay.status).toBe("INTERRUPTED");
    expect(h.runAgentLoop).toHaveBeenCalledTimes(1);
    expect(h.approvals.filter((r) => r.status === "PENDING")).toHaveLength(1);
  });

  it("red sonrası adım çalışmaz", async () => {
    await executeStep("run-1", GATED, 1, {});
    h.approvals[0].status = "REJECTED";
    h.runStatus = "RUNNING";
    const r = await executeStep("run-1", GATED, 1, {});
    expect(r.status).toBe("INTERRUPTED");
    expect(h.runAgentLoop).not.toHaveBeenCalled();
  });

  it("başka kiracının onayı geçmez", async () => {
    await executeStep("run-1", GATED, 1, {});
    const a = approveLatest();
    a.tenantId = "t-2";
    h.runStatus = "RUNNING";
    expect((await executeStep("run-1", GATED, 1, {})).status).toBe("INTERRUPTED");
    expect(h.runAgentLoop).not.toHaveBeenCalled();
  });

  it("başka adımın (farklı indeks/ad) onayı bu adımı açmaz", async () => {
    await executeStep("run-1", GATED, 1, {});
    approveLatest();
    h.runStatus = "RUNNING";
    const other = await executeStep("run-1", { ...GATED, name: "Başka adım" }, 2, {});
    expect(other.status).toBe("INTERRUPTED");
    expect(h.runAgentLoop).not.toHaveBeenCalled();
  });

  it("süresi dolmuş onay geçmez", async () => {
    await executeStep("run-1", GATED, 1, {});
    const a = approveLatest();
    a.expiresAt = new Date(Date.now() - 1000);
    h.runStatus = "RUNNING";
    expect((await executeStep("run-1", GATED, 1, {})).status).toBe("INTERRUPTED");
    expect(h.runAgentLoop).not.toHaveBeenCalled();
  });

  it("yeniden kuyruğa alma bekleyen onayı çoğaltmaz", async () => {
    await executeStep("run-1", GATED, 1, {});
    h.runStatus = "RUNNING";
    await executeStep("run-1", GATED, 1, {});
    expect(h.approvals).toHaveLength(1);
  });

  it("koşu WAITING_APPROVAL'a geçirilemezse adım çalışmaz, onay geri çekilir (FAILED)", async () => {
    h.transition.mockResolvedValue({ ok: false, reason: "illegal_transition" });
    h.runStatus = "COMPLETED";
    const r = await executeStep("run-1", GATED, 1, {});
    expect(r.status).toBe("FAILED");
    expect(h.runAgentLoop).not.toHaveBeenCalled();
    expect(h.approvals).toHaveLength(0);
  });

  it("paralel kardeş koşuyu zaten bekletiyorsa ikinci kapı da bekler (çalışmaz)", async () => {
    h.transition
      .mockImplementationOnce(async () => { h.runStatus = "WAITING_APPROVAL"; return { ok: true }; })
      .mockResolvedValue({ ok: false, reason: "noop" });
    const [a, b] = await Promise.all([
      executeStep("run-1", GATED, 1, {}),
      executeStep("run-1", { ...GATED, name: "İkinci" }, 2, {}),
    ]);
    expect([a.status, b.status]).toEqual(["INTERRUPTED", "INTERRUPTED"]);
    expect(h.approvals).toHaveLength(2);
    expect(h.runAgentLoop).not.toHaveBeenCalled();
  });

  it("fail-closed ayrıştırma: truthy-benzeri / belirsiz tipler gated; yalnız açık 'hayır' gated değil", () => {
    for (const v of [true, 1, "true", "TRUE", " True ", "1", "yes", "YES", 2, {}, [], "evet"]) {
      expect(stepRequiresApproval({ needsApproval: v }), String(JSON.stringify(v))).toBe(true);
    }
    for (const v of [undefined, null, false, 0, "false", "FALSE", ""]) {
      expect(stepRequiresApproval({ needsApproval: v }), String(JSON.stringify(v))).toBe(false);
    }
    for (const r of ["high", "HIGH", "High", " high ", 3, true, {}]) {
      expect(stepRequiresApproval({ risk: r }), String(JSON.stringify(r))).toBe(true);
    }
    for (const r of ["low", "medium", undefined, null]) expect(stepRequiresApproval({ risk: r })).toBe(false);
    expect(stepRequiresApproval(undefined)).toBe(false);
    expect(stepRequiresApproval({})).toBe(false);
    expect(stepRequiresApproval("garip")).toBe(true);
    expect(stepRequiresApproval([1])).toBe(true);
    expect(pipelineHasGatedSteps([PLAIN, GATED])).toBe(true);
    expect(pipelineHasGatedSteps([PLAIN])).toBe(false);
    expect(pipelineHasGatedSteps([{ config: { needsApproval: "TRUE" } }])).toBe(true);
  });

  it("'TRUE' / 'High' yazımlı adım kapıdan geçemez (çalışmaz)", async () => {
    const r1 = await executeStep("run-1", { ...PLAIN, config: { needsApproval: "TRUE" } }, 0, {});
    const r2 = await executeStep("run-1", { ...PLAIN, name: "b", config: { risk: "High" } }, 1, {});
    expect([r1.status, r2.status]).toEqual(["INTERRUPTED", "INTERRUPTED"]);
    expect(h.runAgentLoop).not.toHaveBeenCalled();
  });

  it("TOCTOU: onaydan sonra config ya da agentRole değişirse onay geçmez", async () => {
    await executeStep("run-1", GATED, 1, {});
    approveLatest();
    h.runStatus = "RUNNING";
    const edited = await executeStep("run-1", { ...GATED, config: { ...GATED.config, extra: "yeni" } }, 1, {});
    expect(edited.status).toBe("INTERRUPTED");
    expect(h.runAgentLoop).not.toHaveBeenCalled();
    h.runStatus = "RUNNING";
    h.approvals.forEach((r) => { if (r.status === "PENDING") r.status = "REJECTED"; });
    const other = await executeStep("run-1", { ...GATED, agentRole: "operator2" }, 1, {});
    expect(other.status === "INTERRUPTED" || other.status === "FAILED").toBe(true);
    expect(h.runAgentLoop).not.toHaveBeenCalled();
    // değişmemiş adım hâlâ orijinal onayla geçer
    h.runStatus = "RUNNING";
    expect((await executeStep("run-1", GATED, 1, {})).status).toBe("COMPLETED");
  });

  it("anahtar sırası farkı config özetini değiştirmez (normalize)", async () => {
    const a = { ...GATED, config: { planned: true, tool: "send", risk: "high", needsApproval: true } };
    const b = { ...GATED, config: { needsApproval: true, risk: "high", tool: "send", planned: true } };
    await executeStep("run-1", a, 1, {});
    approveLatest();
    h.runStatus = "RUNNING";
    expect((await executeStep("run-1", b, 1, {})).status).toBe("COMPLETED");
  });

  it("kapıya geçiş yalnız RUNNING koşudan (onlyIfStatus) — /stop,/pause ezilmez", async () => {
    await executeStep("run-1", GATED, 1, {});
    expect(h.transition.mock.calls[0][3]).toMatchObject({ onlyIfStatus: ["RUNNING"], tenantId: "t-1" });
  });

  it("requireStepApproval doğrudan: kapalı adım proceed", async () => {
    expect(await requireStepApproval({ tenantId: "t-1", runId: "run-1", stepIndex: 0, stepName: "x", agentRole: "operator", config: {} })).toEqual({ proceed: true, gated: false });
  });
});
