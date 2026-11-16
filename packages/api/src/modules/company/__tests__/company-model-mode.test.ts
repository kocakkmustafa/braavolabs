/**
 * BRA-P0-06a-2 dilim 2 — PATCH /companies/:id/model-mode ve ajan kip alanları.
 * SINIR: Prisma bellek içi taklit; gerçek DB ile entegrasyon bu dilimin dışında.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Co = { id: string; tenantId: string; config: any; updatedAt: Date };
const db = vi.hoisted(() => ({
  companies: [] as any[], logs: [] as any[], agentCreates: [] as any[], updates: [] as any[],
  raceOnce: false, alwaysConflict: false,
}));

vi.mock("../../../lib/db", () => ({
  prisma: {
    company: {
      findFirst: async (a: any) => {
        const c = db.companies.find((x: Co) => x.id === a.where.id && x.tenantId === a.where.tenantId);
        return c ? { ...c, config: JSON.parse(JSON.stringify(c.config ?? {})) } : null;
      },
      updateMany: async (a: any) => {
        const c = db.companies.find((x: Co) => x.id === a.where.id && x.tenantId === a.where.tenantId);
        if (!c || db.alwaysConflict) return { count: 0 };
        if (db.raceOnce) { db.raceOnce = false; c.updatedAt = new Date(c.updatedAt.getTime() + 1); }
        if (a.where.updatedAt && a.where.updatedAt.getTime() !== c.updatedAt.getTime()) return { count: 0 };
        c.config = a.data.config;
        c.updatedAt = new Date(c.updatedAt.getTime() + 1);
        return { count: 1 };
      },
    },
    agent: { create: async (a: any) => { db.agentCreates.push(a.data); return { id: "ag-1", ...a.data }; } },
    activityLog: { create: async (a: any) => { db.logs.push(a.data); } },
  },
  tenantTx: vi.fn(),
}));
vi.mock("../agent-update", () => ({
  updateAgentWithHistory: async (a: any) => { db.updates.push(a); return { agent: { id: a.agentId, ...a.data }, version: 2 }; },
}));
vi.mock("../../../middleware/auth", async () => {
  const actual = await vi.importActual<typeof import("../../../middleware/auth")>("../../../middleware/auth");
  return { ...actual, authMiddleware: (_q: unknown, _s: unknown, n: () => void) => n() };
});
vi.mock("../../../middleware/require-permission", () => ({
  requirePermission: () => (_q: unknown, _s: unknown, n: () => void) => n(),
}));
vi.mock("../../../middleware/rateLimit", () => ({ rateLimit: () => (_q: unknown, _s: unknown, n: () => void) => n() }));
vi.mock("../../../lib/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../company-capacity", () => ({ assertCompanyCapacity: vi.fn() }));

import { ZodError } from "zod";
import { Prisma } from "@prisma/client";
import { companyRouter } from "../router";

function find(path: string, method: "post" | "patch") {
  const l = (companyRouter as any).stack.find((x: any) => x.route?.path === path && x.route.methods[method]);
  const hs = l.route.stack.map((x: any) => x.handle);
  return hs[hs.length - 1] as (q: any, s: any, n: any) => Promise<void>;
}
const patchMode = find("/:id/model-mode", "patch");
const createAgent = find("/:id/agents", "post");
const patchAgent = find("/:companyId/agents/:agentId", "patch");

async function call(h: any, params: any, body: unknown, tenantId = "t-1") {
  const res: any = { statusCode: 200, body: undefined, status(c: number) { this.statusCode = c; return this; }, json(p: unknown) { this.body = p; return this; } };
  let err: any;
  await h({ params, body, auth: { tenantId, userId: "u-1", role: "MEMBER" } }, res, (e?: any) => { err = e; });
  return { res, err };
}
// errorHandler ZodError'ı 400'e çevirir; AppError statusCode taşır.
const status = (e: any) => (e instanceof ZodError ? 400 : e?.statusCode ?? e?.status);

beforeEach(() => {
  db.logs = []; db.agentCreates = []; db.updates = []; db.raceOnce = false; db.alwaysConflict = false;
  db.companies = [
    { id: "co-1", tenantId: "t-1", config: { niche: "x", webhookSecret: "keep-me", monthlyBudgetUsd: 10 }, updatedAt: new Date(1000) },
    { id: "co-B", tenantId: "t-B", config: { modelMode: "COMPARE" }, updatedAt: new Date(1000) },
  ];
});

describe("PATCH /:id/model-mode", () => {
  it("yazar, diğer anahtarları korur, activity_log düşer", async () => {
    const { res, err } = await call(patchMode, { id: "co-1" }, { modelMode: "CASCADE", autoSelection: { enabled: true } });
    expect(err).toBeUndefined();
    expect(res.body).toEqual({ success: true, modelMode: "CASCADE", autoSelection: { enabled: true } });
    expect(db.companies[0].config).toEqual({
      niche: "x", webhookSecret: "keep-me", monthlyBudgetUsd: 10, modelMode: "CASCADE", autoSelection: { enabled: true },
    });
    expect(db.logs).toEqual([expect.objectContaining({
      tenantId: "t-1", actor: "u-1", action: "company.model_mode.update", resourceId: "co-1",
      details: { modelMode: "CASCADE", autoSelection: { enabled: true } },
    })]);
  });
  it("null ayarı siler; kısmi yama diğer ayara dokunmaz", async () => {
    await call(patchMode, { id: "co-1" }, { modelMode: "COMPARE", autoSelection: { enabled: false } });
    const { res } = await call(patchMode, { id: "co-1" }, { modelMode: null });
    expect(res.body).toEqual({ success: true, modelMode: null, autoSelection: { enabled: false } });
    expect(db.companies[0].config.modelMode).toBeUndefined();
    expect(db.companies[0].config.autoSelection).toEqual({ enabled: false });
  });
  it.each([
    [{ modelMode: "AUTO" }], [{ autoSelection: true }], [{}], [{ webhookSecret: "x" }], [{ modelMode: "DIRECT", niche: "x" }],
  ])("geçersiz gövde %j -> 400, yazma/log yok", async (body) => {
    const { err } = await call(patchMode, { id: "co-1" }, body);
    expect(status(err)).toBe(400);
    expect(db.logs).toHaveLength(0);
    expect(db.companies[0].config.modelMode).toBeUndefined();
  });
  it("başka kiracının şirketi -> 404, yazma yok", async () => {
    const { err } = await call(patchMode, { id: "co-B" }, { modelMode: "DIRECT" }, "t-1");
    expect(status(err)).toBe(404);
    expect(db.companies[1].config.modelMode).toBe("COMPARE");
    expect(db.logs).toHaveLength(0);
  });
  it("eşzamanlı yazma bir kez yeniden denenir; süregelen çakışmada 409", async () => {
    db.raceOnce = true;
    const ok = await call(patchMode, { id: "co-1" }, { modelMode: "DIRECT" });
    expect(ok.err).toBeUndefined();
    expect(db.companies[0].config.modelMode).toBe("DIRECT");
    db.alwaysConflict = true;
    const bad = await call(patchMode, { id: "co-1" }, { modelMode: "COMPARE" });
    expect(status(bad.err)).toBe(409);
    expect(db.companies[0].config.modelMode).toBe("DIRECT");
  });
  it.each([[[]], [{ autoSelection: { enabled: true, x: 1 } }], [{ autoSelection: { enabled: "yes" } }]])(
    "gövde %j -> 400",
    async (body) => {
      const { err } = await call(patchMode, { id: "co-1" }, body);
      expect(status(err)).toBe(400);
      expect(db.logs).toHaveLength(0);
    },
  );
  it("ikinci denemede başarı: activity_log tam bir kez yazılır", async () => {
    db.raceOnce = true;
    await call(patchMode, { id: "co-1" }, { modelMode: "COMPARE" });
    expect(db.logs).toHaveLength(1);
  });
  it("şirket OLUŞTURMA: geçersiz kip anahtarları 400 (tenantTx çağrılmaz); geçerli/yok olanlar doğrulamayı geçer", async () => {
    const create = find("/", "post");
    const base = { name: "Acme", slug: "acme", primitives: ["SALES"] };
    for (const config of [{ modelMode: "AUTO" }, { autoSelection: true }, { autoSelection: { enabled: 1 } }]) {
      const { err } = await call(create, {}, { ...base, config });
      expect(status(err)).toBe(400);
    }
  });
  it("genel PATCH /:id bu anahtarları kabul etmez (allowlist dışı)", async () => {
    const generic = find("/:id", "patch");
    await call(generic, { id: "co-1" }, { config: { modelMode: "COMPARE", autoSelection: { enabled: true }, niche: "y" } });
    // bellek içi updateMany genel yolda config'i yazar; allowlist süzgeci anahtarları düşürmüş olmalı
    expect(db.companies[0].config.modelMode).toBeUndefined();
    expect(db.companies[0].config.autoSelection).toBeUndefined();
    expect(db.companies[0].config.niche).toBe("y");
  });
});

describe("ajan kip alanları", () => {
  it("oluşturma: kip ve doğrulanmış config yazılır", async () => {
    const { res, err } = await call(createAgent, { id: "co-1" }, {
      name: "a", role: "r", modelMode: "COMPARE", modelModeConfig: { compareModels: ["m1", "m2"], budgetUsdCap: 1 },
    });
    expect(err).toBeUndefined();
    expect(res.statusCode).toBe(201);
    expect(db.agentCreates[0]).toMatchObject({ modelMode: "COMPARE", modelModeConfig: { compareModels: ["m1", "m2"], budgetUsdCap: 1 } });
  });
  it("oluşturma: kip verilmezse alan yazılmaz (miras)", async () => {
    await call(createAgent, { id: "co-1" }, { name: "a", role: "r" });
    expect("modelMode" in db.agentCreates[0]).toBe(false);
    expect("modelModeConfig" in db.agentCreates[0]).toBe(false);
  });
  it("oluşturma: geçersiz kip/config -> 400, ajan oluşmaz", async () => {
    for (const body of [
      { name: "a", role: "r", modelMode: "AUTO" },
      { name: "a", role: "r", modelModeConfig: { compareModels: ["only-one"] } },
      { name: "a", role: "r", modelModeConfig: { apiKey: "sk-x" } },
      { name: "a", role: "r", modelModeConfig: "x" },
    ]) {
      const { err } = await call(createAgent, { id: "co-1" }, body);
      expect(status(err)).toBe(400);
    }
    expect(db.agentCreates).toHaveLength(0);
  });
  it("güncelleme: kip ve config aktarılır; null -> temizle (DbNull)", async () => {
    await call(patchAgent, { companyId: "co-1", agentId: "ag-1" }, { modelMode: "CASCADE", modelModeConfig: { cheapModel: "mini", confidenceThreshold: 0.5 } });
    expect(db.updates[0].data).toMatchObject({ modelMode: "CASCADE", modelModeConfig: { cheapModel: "mini", confidenceThreshold: 0.5 } });
    await call(patchAgent, { companyId: "co-1", agentId: "ag-1" }, { modelMode: null, modelModeConfig: null });
    expect(db.updates[1].data.modelMode).toBeNull();
    expect(db.updates[1].data.modelModeConfig).toBe(Prisma.DbNull);
  });
  it("güncelleme: kip alanları yoksa data'ya eklenmez; geçersiz -> 400 ve güncelleme çağrılmaz", async () => {
    await call(patchAgent, { companyId: "co-1", agentId: "ag-1" }, { name: "yeni" });
    expect("modelMode" in db.updates[0].data).toBe(false);
    expect("modelModeConfig" in db.updates[0].data).toBe(false);
    const { err } = await call(patchAgent, { companyId: "co-1", agentId: "ag-1" }, { modelMode: "direct" });
    expect(status(err)).toBe(400);
    const bad = await call(patchAgent, { companyId: "co-1", agentId: "ag-1" }, { modelModeConfig: { budgetUsdCap: 0 } });
    expect(status(bad.err)).toBe(400);
    expect(db.updates).toHaveLength(1);
  });
});
