/**
 * BRA-P0-03b — plan kartı onayıyla iş başlatma. Sıfır ağ: prisma, kuyruk, kota mock'lanır.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Router } from "express";

vi.mock("../../../lib/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const m = vi.hoisted(() => ({
  companyFindFirst: vi.fn(),
  companyFindMany: vi.fn(),
  agentFindFirst: vi.fn(),
  pipelineCreate: vi.fn(),
  releaseQuota: vi.fn(),
  runFindFirst: vi.fn(),
  runCreate: vi.fn(),
  runUpdate: vi.fn(),
  approvalCreate: vi.fn(),
  activityCreate: vi.fn(),
  claimQuota: vi.fn(),
  enqueueRun: vi.fn(),
}));
vi.mock("../../../lib/db", () => ({
  prisma: {
    company: { findFirst: (...a: unknown[]) => m.companyFindFirst(...a), findMany: (...a: unknown[]) => m.companyFindMany(...a) },
    agent: { findFirst: (...a: unknown[]) => m.agentFindFirst(...a) },
    run: { findFirst: (...a: unknown[]) => m.runFindFirst(...a), update: (...a: unknown[]) => m.runUpdate(...a) },
    approval: { create: (...a: unknown[]) => m.approvalCreate(...a) },
    activityLog: { create: (...a: unknown[]) => m.activityCreate(...a) },
  },
  tenantTx: (fn: (tx: unknown) => unknown) =>
    fn({ pipeline: { create: (...a: unknown[]) => m.pipelineCreate(...a) }, run: { create: (...a: unknown[]) => m.runCreate(...a) } }),
}));
vi.mock("../../../middleware/rateLimit", () => ({
  rateLimit: (opts: unknown) => {
    const f: any = (_q: unknown, _s: unknown, next: () => void) => next();
    f.__rl = opts;
    return f;
  },
}));
vi.mock("../../../config/env", () => ({ env: { CLAUDE_MODEL: "claude-sonnet-4-5", JWT_SECRET: "x".repeat(40) } }));
const cfg = vi.hoisted(() => vi.fn());
vi.mock("../../../services/ai-client", () => ({ getTenantAIConfig: (...a: unknown[]) => cfg(...a), chatCompletion: vi.fn() }));
vi.mock("../../../services/provider-chain", () => ({ resolveTenantCompletionLink: vi.fn() }));
vi.mock("../../billing/metering", () => ({
  claimQuota: (...a: unknown[]) => m.claimQuota(...a),
  releaseQuota: (...a: unknown[]) => m.releaseQuota(...a),
}));
vi.mock("../../pipeline/runner", () => ({ enqueueRun: (...a: unknown[]) => m.enqueueRun(...a) }));
vi.mock("../../../lib/modelPricing", () => ({
  estimatePipelineCostUsd: (n: number, provider: string, model: string) => ({
    stepCount: n, provider, model,
    lowUsd: model === "mystery" ? 0 : 0.01 * n,
    highUsd: model === "mystery" ? 0 : 0.05 * n,
    perStepUsd: 0.03, unknownModel: model === "mystery", isFree: false,
  }),
}));

import { jobsRouter } from "../router";
import { computePlanHash } from "../plan-hash";
import { DEFAULT_MAX_TOKENS, DEFAULT_MAX_USD } from "../start";
import { detectHighRisk } from "../plan";

function handler(path: string) {
  const layer = (jobsRouter as Router as any).stack.find((l: any) => l.route?.path === path && l.route.methods.post);
  const stack = layer.route.stack;
  return { fn: stack[stack.length - 1].handle as (q: any, s: any, n: any) => Promise<void>, limiter: stack[0].handle };
}
function mockRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  return res;
}
async function call(path: string, body: unknown, tenantId = "tenant-1") {
  const res = mockRes();
  let nextErr: any;
  await handler(path).fn({ auth: { tenantId, userId: "u-1", role: "admin" }, body, params: {}, query: {} }, res, (e?: any) => { nextErr = e; });
  return { res, nextErr };
}
async function planHashFor(message: string, tenantId = "tenant-1", workspaceId?: string) {
  const { res } = await call("/plan", { message, ...(workspaceId ? { workspaceId } : {}) }, tenantId);
  return res.body.planHash as string;
}

const MSG = "Müşteri raporunu hazırla";
const RISKY = "Müşterilere kampanya e-postası gönder";
const FAMILIES: Record<string, string> = {
  send: "Müşterilere kampanya e-postası gönder",
  publish: "Blog yazısını yayınla",
  delete: "Eski müşteri kayıtlarını sil",
  pay: "Tedarikçi faturasını öde",
  deploy: "Uygulamayı production'a deploy et",
  merge: "Pull request'i merge et",
  grant: "Stajyere panel erişim ver",
};
const KEY = "idem-key-0001";

beforeEach(() => {
  vi.clearAllMocks();
  cfg.mockResolvedValue({ provider: "ANTHROPIC", model: "claude-sonnet-4-5" });
  m.companyFindFirst.mockResolvedValue({ id: "ws-1", status: "ACTIVE" });
  m.companyFindMany.mockResolvedValue([{ id: "ws-1", status: "ACTIVE" }]);
  m.agentFindFirst.mockResolvedValue({ role: "operator" });
  m.runFindFirst.mockResolvedValue(null);
  m.pipelineCreate.mockResolvedValue({ id: "pl-1" });
  m.runCreate.mockResolvedValue({ id: "run-1", status: "PENDING" });
  m.claimQuota.mockResolvedValue({ claimed: true, value: 1, limit: 10 });
  m.enqueueRun.mockResolvedValue("job-1");
  m.activityCreate.mockResolvedValue({});
  m.releaseQuota.mockResolvedValue(undefined);
  m.runUpdate.mockResolvedValue({});
});

describe("planHash", () => {
  it("aynı girdi aynı hash; farklı mesaj/tenant/workspace farklı", async () => {
    const a = await planHashFor(MSG);
    expect(a).toMatch(/^v1:[0-9a-f]{64}$/);
    expect(await planHashFor(MSG)).toBe(a);
    expect(await planHashFor("Başka bir rapor hazırla")).not.toBe(a);
    expect(await planHashFor(MSG, "tenant-2")).not.toBe(a);
    expect(await planHashFor(MSG, "tenant-1", "ws-1")).not.toBe(a);
  });
  it("planHash plan yanıtındaki karttan hesaplanır ve kart anahtar kümesi korunur", async () => {
    const { res } = await call("/plan", { message: MSG });
    expect(Object.keys(res.body).sort()).toEqual(["card", "intent", "planHash"]);
    expect(res.body.planHash).toBe(computePlanHash({ tenantId: "tenant-1", workspaceId: null, message: MSG, card: res.body.card }));
  });
});

describe("POST /jobs/start", () => {
  it("rate limit anahtarı rl:jobs:start", () => {
    expect((handler("/start").limiter as any)?.__rl?.keyPrefix).toBe("rl:jobs:start");
  });

  it("geçerli hash: 201 { runId, pipelineId, state }, kuyruğa alınır, ham satır yok", async () => {
    const planHash = await planHashFor(MSG);
    const { res, nextErr } = await call("/start", { message: MSG, planHash, idempotencyKey: KEY });
    expect(nextErr).toBeUndefined();
    expect(res.statusCode).toBe(201);
    expect(Object.keys(res.body).sort()).toEqual(["pipelineId", "runId", "state"]);
    expect(res.body).toEqual({ runId: "run-1", pipelineId: "pl-1", state: "PENDING" });
    expect(m.enqueueRun).toHaveBeenCalledWith("run-1");
    const runData = m.runCreate.mock.calls[0]![0].data;
    expect(runData).toMatchObject({ tenantId: "tenant-1", workspaceId: "ws-1", idempotencyKey: KEY, status: "PENDING" });
    expect(m.pipelineCreate.mock.calls[0]![0].data.companyId).toBe("ws-1");
  });

  it("hash uyuşmazlığı: 409 plan_changed, hiçbir şey yazılmaz", async () => {
    const planHash = await planHashFor(MSG);
    const { res } = await call("/start", { message: "Başka bir rapor hazırla", planHash, idempotencyKey: KEY });
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: "plan_changed" });
    expect(m.pipelineCreate).not.toHaveBeenCalled();
    expect(m.runCreate).not.toHaveBeenCalled();
    expect(m.enqueueRun).not.toHaveBeenCalled();
  });

  it("başka tenant'ın hash'i geçmez", async () => {
    const planHash = await planHashFor(MSG, "tenant-2");
    const { res } = await call("/start", { message: MSG, planHash, idempotencyKey: KEY });
    expect(res.statusCode).toBe(409);
  });

  it("idempotency: aynı anahtar aynı runId, ikinci koşu/kuyruk/kota yok", async () => {
    const planHash = await planHashFor(MSG);
    m.runFindFirst.mockResolvedValue({ id: "run-1", pipelineId: "pl-1", status: "PENDING", input: { planHash } });
    const { res } = await call("/start", { message: MSG, planHash, idempotencyKey: KEY });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ runId: "run-1", pipelineId: "pl-1", state: "PENDING" });
    expect(m.runFindFirst.mock.calls[0]![0].where).toEqual({ tenantId: "tenant-1", idempotencyKey: KEY });
    expect(m.runCreate).not.toHaveBeenCalled();
    expect(m.pipelineCreate).not.toHaveBeenCalled();
    expect(m.enqueueRun).not.toHaveBeenCalled();
    expect(m.claimQuota).not.toHaveBeenCalled();
  });

  it("idempotency yarışı (P2002): kota iade edilir, kazananın runId'si döner", async () => {
    const planHash = await planHashFor(MSG);
    m.runFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "run-9", pipelineId: "pl-9", status: "PENDING", input: { planHash } });
    m.runCreate.mockRejectedValue(Object.assign(new Error("dup"), { code: "P2002" }));
    const { res } = await call("/start", { message: MSG, planHash, idempotencyKey: KEY });
    // tx callback fırlatınca hata tenantTx dışına çıkar; iç yakalama yok, tx içinde ek sorgu yok.
    expect(m.runCreate).toHaveBeenCalledTimes(1);
    expect(m.pipelineCreate).toHaveBeenCalledTimes(1);
    expect(m.runFindFirst).toHaveBeenCalledTimes(2); // replay kontrolü + dış catch (tx dışı)
    expect(res.body).toEqual({ runId: "run-9", pipelineId: "pl-9", state: "PENDING" });
    expect(m.releaseQuota).toHaveBeenCalledWith("tenant-1", "runs");
    expect(m.enqueueRun).not.toHaveBeenCalled();
  });

  it("aynı anahtar farklı planla: 409", async () => {
    const planHash = await planHashFor(MSG);
    m.runFindFirst.mockResolvedValue({ id: "run-1", pipelineId: "pl-1", status: "PENDING", input: { planHash: "v1:baska" } });
    const { nextErr } = await call("/start", { message: MSG, planHash, idempotencyKey: KEY });
    expect(nextErr.statusCode).toBe(409);
  });

  it("yüksek riskli kart (her fiil ailesi): 422, kota/pipeline/run/onay oluşmaz", async () => {
    expect(new Set(Object.values(FAMILIES).flatMap((t) => detectHighRisk(t).map((x) => x.id)))).toEqual(
      new Set(["send", "publish", "delete", "pay", "deploy", "merge", "grant"]),
    );
    for (const text of Object.values(FAMILIES)) {
      const { res: planRes } = await call("/plan", { message: text });
      expect(planRes.body.card.risk).toBe("high");
      expect(planRes.body.card.warnings.some((w: string) => w.includes("otomatik başlatma şimdilik kapalı"))).toBe(true);
      const { res } = await call("/start", { message: text, planHash: planRes.body.planHash, idempotencyKey: KEY });
      expect(res.statusCode).toBe(422);
      expect(res.body.error).toBe("high_risk_start_unsupported");
    }
    expect(m.claimQuota).not.toHaveBeenCalled();
    expect(m.pipelineCreate).not.toHaveBeenCalled();
    expect(m.runCreate).not.toHaveBeenCalled();
    expect(m.approvalCreate).not.toHaveBeenCalled();
    expect(m.enqueueRun).not.toHaveBeenCalled();
  });

  it("yüksek riskli kartta yanlış hash önce 409 (422 hash doğrulamasından sonra)", async () => {
    const { res } = await call("/start", { message: RISKY, planHash: "v1:yanlis", idempotencyKey: KEY });
    expect(res.statusCode).toBe(409);
  });

  it("fiyatsız modelde güvenli USD tavanı zorunlu", async () => {
    cfg.mockResolvedValue({ provider: "ANTHROPIC", model: "mystery" });
    const { res: p } = await call("/plan", { message: MSG });
    expect(p.body.card.budget.maxUsd).toBeUndefined();
    await call("/start", { message: MSG, planHash: p.body.planHash, idempotencyKey: KEY });
    const jb = m.runCreate.mock.calls[0]![0].data.jobBudget;
    expect(jb.maxUsd).toBe(DEFAULT_MAX_USD);
    expect(jb.maxTokens).toBe(DEFAULT_MAX_TOKENS);
    expect(jb.maxSteps).toBeGreaterThan(0);
    expect(jb.timeoutMs).toBeGreaterThan(0);
  });

  it("fiyatlı modelde kart tavanı korunur", async () => {
    const { res: p } = await call("/plan", { message: MSG });
    await call("/start", { message: MSG, planHash: p.body.planHash, idempotencyKey: KEY });
    expect(m.runCreate.mock.calls[0]![0].data.jobBudget.maxUsd).toBe(p.body.card.budget.maxUsd);
  });

  it("geçersiz gövde 400 (kısa anahtar, eksik hash, fazla alan)", async () => {
    for (const body of [
      { message: MSG, planHash: "v1:x", idempotencyKey: "short" },
      { message: MSG, idempotencyKey: KEY },
      { message: MSG, planHash: "v1:x", idempotencyKey: KEY, extra: 1 },
    ]) {
      const { nextErr } = await call("/start", body);
      expect(nextErr?.name).toBe("ZodError");
    }
    expect(m.runCreate).not.toHaveBeenCalled();
  });

  it("başka kiracı workspace: 404", async () => {
    m.companyFindFirst.mockResolvedValue(null);
    const { nextErr } = await call("/start", { message: MSG, workspaceId: "ws-x", planHash: "v1:x", idempotencyKey: KEY });
    expect(nextErr.statusCode).toBe(404);
    expect(m.companyFindFirst.mock.calls[0]![0].where).toEqual({ id: "ws-x", tenantId: "tenant-1" });
  });

  it("workspaceId yok ve birden çok şirket: 400", async () => {
    m.companyFindMany.mockResolvedValue([{ id: "a" }, { id: "b" }]);
    const { nextErr } = await call("/start", { message: MSG, planHash: "v1:x", idempotencyKey: KEY });
    expect(nextErr.statusCode).toBe(400);
  });

  it("kota dolu: 429, koşu yok", async () => {
    const planHash = await planHashFor(MSG);
    m.claimQuota.mockResolvedValue({ claimed: false, value: 10, limit: 10 });
    const { nextErr } = await call("/start", { message: MSG, planHash, idempotencyKey: KEY });
    expect(nextErr.statusCode).toBe(429);
    expect(m.runCreate).not.toHaveBeenCalled();
  });

  it("enqueue hatası: koşu FAILED işaretlenir", async () => {
    const planHash = await planHashFor(MSG);
    m.enqueueRun.mockRejectedValue(new Error("redis"));
    const { nextErr } = await call("/start", { message: MSG, planHash, idempotencyKey: KEY });
    expect(nextErr).toBeInstanceOf(Error);
    expect(m.runUpdate).toHaveBeenCalledWith({ where: { id: "run-1" }, data: { status: "FAILED", error: "enqueue_failed" } });
    expect(m.releaseQuota).toHaveBeenCalledWith("tenant-1", "runs");
  });

  it("workspace PAUSED/ARCHIVED: 409, kota yok", async () => {
    const planHash = await planHashFor(MSG, "tenant-1", "ws-1");
    for (const status of ["PAUSED", "ARCHIVED"]) {
      m.companyFindFirst.mockResolvedValue({ id: "ws-1", status });
      const { nextErr } = await call("/start", { message: MSG, workspaceId: "ws-1", planHash, idempotencyKey: KEY });
      expect(nextErr.statusCode).toBe(409);
    }
    expect(m.claimQuota).not.toHaveBeenCalled();
  });

  it("ajansız workspace: 422, kota yok", async () => {
    const planHash = await planHashFor(MSG);
    m.agentFindFirst.mockResolvedValue(null);
    const { nextErr } = await call("/start", { message: MSG, planHash, idempotencyKey: KEY });
    expect(nextErr.statusCode).toBe(422);
    expect(m.claimQuota).not.toHaveBeenCalled();
  });

  it("iş olmayan mesaj: 422", async () => {
    const { nextErr } = await call("/start", { message: "Merhaba nasılsın?", planHash: "v1:x", idempotencyKey: KEY });
    expect(nextErr.statusCode).toBe(422);
  });

  it("claimQuota tenantId ile çağrılır; pipeline/run verisi tenant'a bağlı", async () => {
    const planHash = await planHashFor(MSG);
    await call("/start", { message: MSG, planHash, idempotencyKey: KEY });
    expect(m.claimQuota).toHaveBeenCalledWith("tenant-1", "runs");
    expect(m.pipelineCreate.mock.calls[0]![0].data.companyId).toBe("ws-1");
    expect(m.runCreate.mock.calls[0]![0].data.tenantId).toBe("tenant-1");
    expect(m.agentFindFirst.mock.calls[0]![0].where).toEqual({ companyId: "ws-1" });
  });

  it("title/warnings değişince hash aynı kalır; goal/steps değişince değişir", async () => {
    const { res } = await call("/plan", { message: MSG });
    const base = { tenantId: "tenant-1", workspaceId: null, message: MSG };
    const h = computePlanHash({ ...base, card: res.body.card });
    expect(computePlanHash({ ...base, card: { ...res.body.card, title: "Başka başlık", warnings: ["x"] } })).toBe(h);
    expect(computePlanHash({ ...base, card: { ...res.body.card, goal: "Başka amaç" } })).not.toBe(h);
    expect(computePlanHash({ ...base, card: { ...res.body.card, steps: res.body.card.steps.slice(1) } })).not.toBe(h);
  });

  it("kısa/uzun planHash istisna fırlatmaz: 409 plan_changed; 200+ karakter 400", async () => {
    for (const planHash of ["v1:a", "v1:" + "a".repeat(150)]) {
      const { res, nextErr } = await call("/start", { message: MSG, planHash, idempotencyKey: KEY });
      expect(nextErr).toBeUndefined();
      expect(res.statusCode).toBe(409);
    }
    const { nextErr } = await call("/start", { message: MSG, planHash: "a".repeat(201), idempotencyKey: KEY });
    expect(nextErr?.name).toBe("ZodError");
  });

  it("createPlannedRun hatası: kota iade edilir, kuyruk yok", async () => {
    const planHash = await planHashFor(MSG);
    m.runCreate.mockRejectedValue(new Error("db"));
    const { nextErr } = await call("/start", { message: MSG, planHash, idempotencyKey: KEY });
    expect(nextErr).toBeInstanceOf(Error);
    expect(m.releaseQuota).toHaveBeenCalledWith("tenant-1", "runs");
    expect(m.enqueueRun).not.toHaveBeenCalled();
  });

  it("FAILED koşu replay'i: 200 ve state FAILED açıkça yansır, yeniden kuyruk yok", async () => {
    const planHash = await planHashFor(MSG);
    m.runFindFirst.mockResolvedValue({ id: "run-1", pipelineId: "pl-1", status: "FAILED", input: { planHash } });
    const { res } = await call("/start", { message: MSG, planHash, idempotencyKey: KEY });
    expect(res.body).toEqual({ runId: "run-1", pipelineId: "pl-1", state: "FAILED" });
    expect(m.enqueueRun).not.toHaveBeenCalled();
  });

  it("activityLog fırlatsa bile koşu kuyruğa alınır ve 201 döner", async () => {
    const planHash = await planHashFor(MSG);
    m.activityCreate.mockRejectedValue(new Error("log db"));
    const { res, nextErr } = await call("/start", { message: MSG, planHash, idempotencyKey: KEY });
    expect(nextErr).toBeUndefined();
    expect(res.statusCode).toBe(201);
    expect(m.enqueueRun).toHaveBeenCalledWith("run-1");
    expect(m.releaseQuota).not.toHaveBeenCalled();
  });

  it("enqueue activityLog'dan ÖNCE çağrılır", async () => {
    const planHash = await planHashFor(MSG);
    const order: string[] = [];
    m.enqueueRun.mockImplementation(async () => { order.push("enqueue"); return "j"; });
    m.activityCreate.mockImplementation(async (a: any) => { if (a.data.action === "job.started") order.push("log"); return {}; });
    await call("/start", { message: MSG, planHash, idempotencyKey: KEY });
    expect(order).toEqual(["enqueue", "log"]);
  });
});

describe("POST /jobs/start — STEP_APPROVAL_GATE (BRA-P0-03d)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("kapı kapalı (varsayılan): yüksek riskli kart 422 high_risk_start_unsupported", async () => {
    const { res: p } = await call("/plan", { message: RISKY });
    const { res } = await call("/start", { message: RISKY, planHash: p.body.planHash, idempotencyKey: KEY });
    expect(res.statusCode).toBe(422);
    expect(res.body.error).toBe("high_risk_start_unsupported");
    expect(m.runCreate).not.toHaveBeenCalled();
  });

  it("kapı açık: yüksek riskli kart kabul edilir; adımlar needsApproval/risk ile yazılır, onay satırını yürütücü açar", async () => {
    vi.stubEnv("STEP_APPROVAL_GATE", "true");
    for (const text of Object.values(FAMILIES)) {
      vi.clearAllMocks();
      m.companyFindFirst.mockResolvedValue({ id: "ws-1", status: "ACTIVE" });
      m.companyFindMany.mockResolvedValue([{ id: "ws-1", status: "ACTIVE" }]);
      m.agentFindFirst.mockResolvedValue({ role: "operator" });
      m.runFindFirst.mockResolvedValue(null);
      m.pipelineCreate.mockResolvedValue({ id: "pl-1" });
      m.runCreate.mockResolvedValue({ id: "run-1", status: "PENDING" });
      m.claimQuota.mockResolvedValue({ claimed: true, value: 1, limit: 10 });
      m.enqueueRun.mockResolvedValue("job-1");
      m.activityCreate.mockResolvedValue({});
      const { res: p } = await call("/plan", { message: text });
      const { res } = await call("/start", { message: text, planHash: p.body.planHash, idempotencyKey: KEY });
      expect(res.statusCode).toBe(201);
      const steps = m.pipelineCreate.mock.calls[0]![0].data.steps as Array<{ config: Record<string, unknown> }>;
      expect(steps.some((s) => s.config.needsApproval === true && s.config.risk === "high")).toBe(true);
      expect(m.approvalCreate).not.toHaveBeenCalled();
      expect(m.enqueueRun).toHaveBeenCalledWith("run-1");
    }
  });

  it("kapı açık: yanlış hash yine 409 (planHash/idempotency mantığı değişmez)", async () => {
    vi.stubEnv("STEP_APPROVAL_GATE", "true");
    const { res } = await call("/start", { message: RISKY, planHash: "v1:yanlis", idempotencyKey: KEY });
    expect(res.statusCode).toBe(409);
  });
});
