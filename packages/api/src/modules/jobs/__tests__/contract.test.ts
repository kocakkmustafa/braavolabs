/**
 * BRA-P1-08-N1 — mobil compose için sınırlı payload sözleşmesi (jobs/plan + jobs/start).
 * Sözleşme router'daki .strict() şemalarıdır; bu dosya onu sabitler: beyaz liste, uzunluk üst sınırı,
 * yetki alanı (tenant/company/bütçe/izin/onay atlama) reddi ve tenant/company'nin yalnız oturumdan gelmesi.
 * Sıfır ağ: prisma, kuyruk, kota mock'lanır.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Router } from "express";

vi.mock("../../../lib/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const m = vi.hoisted(() => ({
  companyFindFirst: vi.fn(),
  companyFindMany: vi.fn(),
  agentFindFirst: vi.fn(),
  runFindFirst: vi.fn(),
  runCreate: vi.fn(),
  pipelineCreate: vi.fn(),
  activityCreate: vi.fn(),
  claimQuota: vi.fn(),
  enqueueRun: vi.fn(),
}));
vi.mock("../../../lib/db", () => ({
  prisma: {
    company: { findFirst: (...a: unknown[]) => m.companyFindFirst(...a), findMany: (...a: unknown[]) => m.companyFindMany(...a) },
    agent: { findFirst: (...a: unknown[]) => m.agentFindFirst(...a) },
    run: { findFirst: (...a: unknown[]) => m.runFindFirst(...a), update: vi.fn(), updateMany: vi.fn() },
    approval: { create: vi.fn() },
    activityLog: { create: (...a: unknown[]) => m.activityCreate(...a) },
  },
  tenantTx: (fn: (tx: unknown) => unknown) =>
    fn({ pipeline: { create: (...a: unknown[]) => m.pipelineCreate(...a) }, run: { create: (...a: unknown[]) => m.runCreate(...a) } }),
}));
vi.mock("../../../middleware/rateLimit", () => ({
  rateLimit: () => (_q: unknown, _s: unknown, next: () => void) => next(),
}));
vi.mock("../../../config/env", () => ({ env: { CLAUDE_MODEL: "claude-sonnet-4-5", JWT_SECRET: "x".repeat(40) } }));
vi.mock("../../../services/ai-client", () => ({
  getTenantAIConfig: vi.fn().mockResolvedValue({ provider: "ANTHROPIC", model: "claude-sonnet-4-5" }),
  chatCompletion: vi.fn(),
}));
vi.mock("../../../services/provider-chain", () => ({ resolveTenantCompletionLink: vi.fn() }));
vi.mock("../../billing/metering", () => ({
  claimQuota: (...a: unknown[]) => m.claimQuota(...a),
  releaseQuota: vi.fn(),
}));
vi.mock("../../run/transition", async (orig) => ({
  ...(await orig<typeof import("../../run/transition")>()),
  tryWriteReceipt: vi.fn(),
}));
vi.mock("../../pipeline/runner", () => ({ enqueueRun: (...a: unknown[]) => m.enqueueRun(...a) }));
vi.mock("../../../lib/modelPricing", () => ({
  estimatePipelineCostUsd: (n: number, provider: string, model: string) => ({
    stepCount: n, provider, model, lowUsd: 0.01 * n, highUsd: 0.05 * n, perStepUsd: 0.03, unknownModel: false, isFree: false,
  }),
}));

import { jobsRouter } from "../router";
import { errorHandler } from "../../../middleware/error";

function handler(path: string) {
  const layer = (jobsRouter as Router as any).stack.find((l: any) => l.route?.path === path && l.route.methods.post);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle as (q: any, s: any, n: any) => Promise<void>;
}
// Gerçek errorHandler üzerinden: ZodError → HTTP 400.
async function call(path: string, body: unknown, auth: Record<string, unknown> = { tenantId: "tenant-1", userId: "u-1", role: "admin" }) {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  const req: any = { auth, body, params: {}, query: {}, headers: {} };
  await handler(path)(req, res, (e?: Error) => { if (e) errorHandler(e, req, res, () => undefined); });
  return res;
}

const MSG = "Müşteri raporunu hazırla";
const KEY = "idem-key-0001";

// Mobilin ASLA göndermemesi gereken yetkili alanlar.
const AUTHORITY_FIELDS: Record<string, unknown> = {
  tenantId: "tenant-evil",
  companyId: "ws-evil",
  userId: "u-evil",
  role: "owner",
  budget: { maxUsd: 9999, maxTokens: 99999999 },
  maxUsd: 9999,
  jobBudget: { maxUsd: 9999 },
  permissions: ["*"],
  approved: true,
  skipApproval: true,
  needsApproval: false,
  approvals: [],
  risk: "low",
  card: { risk: "low", steps: [] },
  isAdmin: true,
};

beforeEach(() => {
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
});

describe("jobs/plan payload sözleşmesi", () => {
  it("geçerli payload kabul: yalnız message, message+workspaceId", async () => {
    expect((await call("/plan", { message: MSG })).statusCode).toBe(200);
    expect((await call("/plan", { message: MSG, workspaceId: "ws-1" })).statusCode).toBe(200);
  });

  it.each(Object.entries(AUTHORITY_FIELDS))("yetki alanı %s → 400 (strict), hiçbir yan etki yok", async (key, value) => {
    const res = await call("/plan", { message: MSG, [key]: value });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe("Validation error");
    expect(m.companyFindFirst).not.toHaveBeenCalled();
    expect(m.activityCreate).not.toHaveBeenCalled();
  });

  it("bilinmeyen alan → 400", async () => {
    expect((await call("/plan", { message: MSG, foo: "bar" })).statusCode).toBe(400);
  });

  it("aşırı uzun alanlar → 400 (message 4001, workspaceId 201); sınırdakiler kabul", async () => {
    expect((await call("/plan", { message: "a".repeat(4001) })).statusCode).toBe(400);
    expect((await call("/plan", { message: MSG, workspaceId: "w".repeat(201) })).statusCode).toBe(400);
    expect((await call("/plan", { message: MSG, workspaceId: "w".repeat(200) })).statusCode).toBe(200);
  });

  it("message alt sınırı: boş ve yalnız-boşluk → 400; 4000 karakter kabul", async () => {
    expect((await call("/plan", { message: "" })).statusCode).toBe(400);
    expect((await call("/plan", { message: "   " })).statusCode).toBe(400);
    expect((await call("/plan", { message: "Rapor hazırla " + "a".repeat(3986) })).statusCode).toBe(200);
  });

  it("yanlış tip / dizi gövde → 400", async () => {
    for (const body of [{ message: 5 }, { message: [MSG] }, { message: MSG, workspaceId: 7 }, [MSG], "x", null]) {
      expect((await call("/plan", body)).statusCode).toBe(400);
    }
  });

  it("tenant oturumdan gelir: workspace sahipliği ve audit log oturum tenant'ıyla yazılır", async () => {
    await call("/plan", { message: MSG, workspaceId: "ws-1" }, { tenantId: "tenant-session", userId: "u-1", role: "member" });
    expect(m.companyFindFirst.mock.calls[0]![0].where).toEqual({ id: "ws-1", tenantId: "tenant-session" });
    expect(m.activityCreate.mock.calls[0]![0].data.tenantId).toBe("tenant-session");
  });
});

describe("jobs/start payload sözleşmesi", () => {
  afterEach(() => vi.unstubAllEnvs());
  async function validBody(auth?: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    const p = await call("/plan", { message: MSG, ...extra }, auth);
    return { message: MSG, ...extra, planHash: p.body.planHash as string, idempotencyKey: KEY };
  }
  const SESSION = { tenantId: "tenant-session", userId: "u-1", role: "member" };

  it("geçerli payload kabul (201); tenant/company yalnız oturumdan (workspaceId'siz dal)", async () => {
    const res = await call("/start", await validBody(SESSION), SESSION);
    expect(res.statusCode).toBe(201);
    expect(m.companyFindMany.mock.calls[0]![0].where).toEqual({ tenantId: "tenant-session" });
    expect(m.claimQuota).toHaveBeenCalledWith("tenant-session", "runs");
    expect(m.runFindFirst.mock.calls[0]![0].where).toEqual({ tenantId: "tenant-session", idempotencyKey: KEY });
    expect(m.runCreate.mock.calls[0]![0].data.tenantId).toBe("tenant-session");
    const started = m.activityCreate.mock.calls.map((c) => c[0].data).find((d) => d.action === "job.started");
    expect(started.tenantId).toBe("tenant-session");
    expect(started.resourceId).toBe("run-1");
  });

  it("workspaceId'li dal: sahiplik oturum tenant'ıyla aranır, koşu o şirkete yazılır", async () => {
    m.companyFindFirst.mockResolvedValue({ id: "ws-9", status: "ACTIVE" });
    const res = await call("/start", await validBody(SESSION, { workspaceId: "ws-9" }), SESSION);
    expect(res.statusCode).toBe(201);
    expect(m.companyFindFirst.mock.calls.at(-1)![0].where).toEqual({ id: "ws-9", tenantId: "tenant-session" });
    expect(m.companyFindMany).not.toHaveBeenCalled();
    expect(m.runCreate.mock.calls[0]![0].data.workspaceId).toBe("ws-9");
  });

  it("başka tenant'ın planHash'i → 409 plan_changed; kota/koşu/kuyruk yok", async () => {
    const other = await validBody({ tenantId: "tenant-other", userId: "u-2", role: "admin" });
    const res = await call("/start", other, SESSION);
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: "plan_changed" });
    expect(m.claimQuota).not.toHaveBeenCalled();
    expect(m.runCreate).not.toHaveBeenCalled();
    expect(m.enqueueRun).not.toHaveBeenCalled();
  });

  it.each(Object.entries(AUTHORITY_FIELDS))("yetki alanı %s → 400 (şema hatası); koşu/kota/kuyruk yok", async (key, value) => {
    const res = await call("/start", { ...(await validBody()), [key]: value });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe("Validation error");
    expect(m.claimQuota).not.toHaveBeenCalled();
    expect(m.runCreate).not.toHaveBeenCalled();
    expect(m.enqueueRun).not.toHaveBeenCalled();
  });

  it("aşırı uzun alanlar → 400 şema hatası (message, workspaceId, planHash 201, idempotencyKey 129)", async () => {
    const base = await validBody();
    for (const patch of [
      { message: "a".repeat(4001) },
      { workspaceId: "w".repeat(201) },
      { planHash: "h".repeat(201) },
      { idempotencyKey: "k".repeat(129) },
    ]) {
      const res = await call("/start", { ...base, ...patch });
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toBe("Validation error");
    }
    expect(m.runCreate).not.toHaveBeenCalled();
  });

  it("alt/üst sınırlar: idempotencyKey 7 → 400; 8 ve 128 kabul; message boş/boşluk → 400; 4000 message ve 200 planHash şemadan geçer", async () => {
    const base = await validBody();
    const bad = await call("/start", { ...base, idempotencyKey: "k".repeat(7) });
    expect(bad.statusCode).toBe(400);
    expect(bad.body.error).toBe("Validation error");
    for (const key of ["k".repeat(8), "k".repeat(128)]) {
      expect((await call("/start", { ...base, idempotencyKey: key })).statusCode).toBe(201);
    }
    for (const message of ["", "   "]) {
      const res = await call("/start", { ...base, message });
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toBe("Validation error");
    }
    // Şema geçer; hash eşleşmediği için 409 (400 değil) = sınır kabul edildi.
    const long = await call("/start", { message: "Rapor hazırla " + "a".repeat(3986), planHash: "h".repeat(200), idempotencyKey: KEY });
    expect(long.statusCode).toBe(409);
    expect(long.body).toEqual({ error: "plan_changed" });
  });

  it("onay atlama imkânı yok: yüksek riskli plan + onay alanı → 400, onaysız gönderim → 422 high_risk_start_unsupported", async () => {
    vi.stubEnv("STEP_APPROVAL_GATE", "");
    const risky = "Müşterilere kampanya e-postası gönder";
    const p = await call("/plan", { message: risky });
    const body = { message: risky, planHash: p.body.planHash, idempotencyKey: KEY };
    const withFlag = await call("/start", { ...body, approved: true });
    expect(withFlag.statusCode).toBe(400);
    expect(withFlag.body.error).toBe("Validation error");
    const res = await call("/start", body);
    expect(res.statusCode).toBe(422);
    expect(res.body.error).toBe("high_risk_start_unsupported");
    expect(m.claimQuota).not.toHaveBeenCalled();
    expect(m.runCreate).not.toHaveBeenCalled();
  });
});
