/**
 * BRA-P0-03d — POST /runs/steps/:id/rerun kesin kimlik + fail-closed (güvenlik taraması bulgusu).
 * Aynı ada/sıraya sahip iki adım: biri needsApproval, diğeri değil → rerun gevşek eşleşmeyle
 * kapısız config'i seçemez. Handler doğrudan sürülür (sıfır ağ).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Router } from "express";

vi.mock("../../../lib/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const m = vi.hoisted(() => ({
  stepFindUnique: vi.fn(), cancelHandoff: vi.fn(), stepUpdate: vi.fn(), handoffFindFirst: vi.fn(), activityCreate: vi.fn(), executeStep: vi.fn(),
}));
vi.mock("../../../lib/db", () => ({
  prisma: {
    runStep: { findUnique: (...a: unknown[]) => m.stepFindUnique(...a), update: (...a: unknown[]) => m.stepUpdate(...a) },
    handoffLedger: { findFirst: (...a: unknown[]) => m.handoffFindFirst(...a) },
    activityLog: { create: (...a: unknown[]) => m.activityCreate(...a) },
  },
  tenantTx: (fn: (tx: unknown) => unknown) => fn({}),
}));
vi.mock("../../../middleware/auth", () => ({ authMiddleware: (_q: unknown, _s: unknown, next: () => void) => next() }));
vi.mock("../../../middleware/rateLimit", () => ({ rateLimit: () => (_q: unknown, _s: unknown, next: () => void) => next() }));
vi.mock("../../pipeline/runner", () => ({ enqueueRun: vi.fn() }));
vi.mock("../../pipeline/executor", () => ({ executeStep: (...a: unknown[]) => m.executeStep(...a) }));
vi.mock("../../../services/ai-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../services/ai-client")>();
  return { ...actual, getTenantAIConfig: vi.fn().mockResolvedValue({ provider: "ANTHROPIC", model: "m" }), chatCompletion: vi.fn() };
});
vi.mock("../../../services/provider-chain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../services/provider-chain")>();
  return { ...actual, listTenantProviderLinks: vi.fn().mockResolvedValue([{ provider: "OPENAI" }]) };
});
vi.mock("../handoff.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../handoff.service")>();
  return { ...actual, cancelOpenHandoffForRun: (...a: unknown[]) => m.cancelHandoff(...a) };
});
vi.mock("../../../config/env", () => ({ env: { NODE_ENV: "development", OFFLINE_MODE: false } }));

import { runRouter } from "../router";

function handler() {
  const layer = (runRouter as Router as any).stack.find((l: any) => l.route?.path === "/steps/:id/rerun" && l.route.methods.post);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle as (q: any, s: any, n: any) => Promise<void>;
}
async function rerun() {
  let err: any; const res: any = { json: vi.fn() };
  await handler()({ params: { id: "rs-1" }, auth: { tenantId: "t-1", userId: "u-1" } }, res, (e?: any) => { err = e; });
  return { err, res };
}

const SAFE = { name: "Gönder", agentRole: "operator", order: 0, config: { planned: true, risk: "low", needsApproval: false } };
const RISKY = { name: "Gönder", agentRole: "operator", order: 1, config: { planned: true, risk: "high", needsApproval: true } };

function seed(stepName: string, stepIndex: number, steps: unknown[], runStatus = "RUNNING") {
  m.stepFindUnique.mockResolvedValue({
    id: "rs-1", runId: "run-1", name: stepName, stepIndex, status: "FAILED", input: {}, completedAt: new Date(),
    run: { status: runStatus, pipeline: { steps, company: { tenantId: "t-1" } } },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  m.handoffFindFirst.mockResolvedValue(null);
  m.stepUpdate.mockResolvedValue({});
  m.activityCreate.mockResolvedValue({});
  m.executeStep.mockResolvedValue({ stepId: "", status: "INTERRUPTED" });
});
afterEach(() => vi.unstubAllEnvs());

describe("rerun × STEP_APPROVAL_GATE", () => {
  it("kapı açık: aynı ad, riskli adım stepIndex 1 → riskli config taşınır (gevşek ad eşleşmesi güvenli adımı seçmez)", async () => {
    vi.stubEnv("STEP_APPROVAL_GATE", "true");
    seed("Gönder", 1, [SAFE, RISKY]); // find(name) ilk adım SAFE'i seçerdi
    const { err } = await rerun();
    expect(err).toBeUndefined();
    expect(m.executeStep.mock.calls[0][1].config).toEqual(RISKY.config);
  });

  it("kapı açık: ad uyuşmuyorsa / indeks yoksa belirsiz → 409, executeStep ve durum yazımı yok", async () => {
    vi.stubEnv("STEP_APPROVAL_GATE", "true");
    for (const [name, idx] of [["Başka", 1], ["Gönder", 5]] as const) {
      seed(name, idx, [SAFE, RISKY]);
      const { err } = await rerun();
      expect(err?.statusCode ?? err?.status).toBe(409);
      expect(err.message).toMatch(/step_identity_unresolved/);
    }
    expect(m.executeStep).not.toHaveBeenCalled();
    expect(m.stepUpdate).not.toHaveBeenCalled();
  });

  it("kapı açık: eksik order alanı runner gibi dizi indeksine düşer", async () => {
    vi.stubEnv("STEP_APPROVAL_GATE", "true");
    const { order: _o, ...noOrder } = RISKY;
    seed("Gönder", 1, [SAFE, noOrder]);
    const { err } = await rerun();
    expect(err).toBeUndefined();
    expect(m.executeStep.mock.calls[0][1].config).toEqual(RISKY.config);
  });

  it("kapı çalıştırmadıysa (stepId boş) RunStep önceki durumuna döner", async () => {
    vi.stubEnv("STEP_APPROVAL_GATE", "true");
    seed("Gönder", 1, [SAFE, RISKY]);
    await rerun();
    expect(m.stepUpdate).toHaveBeenLastCalledWith({ where: { id: "rs-1" }, data: expect.objectContaining({ status: "FAILED" }) });
  });

  it("kapı kapalı: eski gevşek eşleşme değişir DEĞİL ve executeStep'e config VERİLMEZ (prompt birebir eski)", async () => {
    seed("Gönder", 1, [SAFE, RISKY]);
    const { err } = await rerun();
    expect(err).toBeUndefined();
    expect(m.executeStep.mock.calls[0][1]).toEqual({ name: "Gönder", agentRole: "operator", order: 1 });
    expect(m.executeStep.mock.calls[0][1].config).toBeUndefined();
  });

  it("kapı açık + gated adım + bitmiş koşu (FAILED/CANCELLED/COMPLETED): 409 step_gate_requires_retry, hiçbir yazım yok", async () => {
    vi.stubEnv("STEP_APPROVAL_GATE", "true");
    for (const st of ["FAILED", "CANCELLED", "COMPLETED"]) {
      seed("Gönder", 1, [SAFE, RISKY], st);
      const { err } = await rerun();
      expect(err?.statusCode ?? err?.status).toBe(409);
      expect(err.message).toMatch(/step_gate_requires_retry/);
    }
    expect(m.executeStep).not.toHaveBeenCalled();
    expect(m.stepUpdate).not.toHaveBeenCalled();
  });

  it("kapı açık + gated OLMAYAN adım + FAILED koşu: eski rerun kuralı bozulmaz", async () => {
    vi.stubEnv("STEP_APPROVAL_GATE", "true");
    seed("Gönder", 0, [SAFE, RISKY], "FAILED");
    const { err } = await rerun();
    expect(err).toBeUndefined();
    expect(m.executeStep).toHaveBeenCalledTimes(1);
  });

  it("kapı açık: config false/0/'' (falsy) adım rerun'a taşınır → executeStep gated görür", async () => {
    vi.stubEnv("STEP_APPROVAL_GATE", "true");
    for (const cfg of [false, 0, ""]) {
      m.executeStep.mockClear();
      seed("Gönder", 0, [{ name: "Gönder", agentRole: "operator", order: 0, config: cfg }]);
      await rerun();
      if (m.executeStep.mock.calls[0]) expect(m.executeStep.mock.calls[0][1].config).toBe(cfg);
      else expect(m.executeStep).toHaveBeenCalledTimes(0); // finished-run 409 yolu da kabul
    }
  });

  it("reddedilen rerun açık handoff'u İPTAL ETMEZ; kabul edilen eder (sıra: kimlik/kapı → iptal → yazım)", async () => {
    m.handoffFindFirst.mockResolvedValue({ id: "h1", status: "OPEN" });
    vi.stubEnv("STEP_APPROVAL_GATE", "true");
    seed("Başka", 1, [SAFE, RISKY]); // kimlik reddi
    expect((await rerun()).err?.message).toMatch(/step_identity_unresolved/);
    seed("Gönder", 1, [SAFE, RISKY], "FAILED"); // kapı reddi (gated + bitmiş koşu)
    expect((await rerun()).err?.message).toMatch(/step_gate_requires_retry/);
    expect(m.cancelHandoff).not.toHaveBeenCalled();
    seed("Gönder", 1, [SAFE, RISKY], "RUNNING");
    expect((await rerun()).err).toBeUndefined();
    expect(m.cancelHandoff).toHaveBeenCalledTimes(1);
  });
});
