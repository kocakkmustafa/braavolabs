/**
 * BRA-P0-11c — PATCH /companies/:id/budget + summary.budget.
 * SINIR: Prisma bellek içi taklit; gerçek DB ile entegrasyon bu dilimin dışında.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Co = { id: string; tenantId: string; config: any; updatedAt: Date };
const db = vi.hoisted(() => ({
  companies: [] as any[], logs: [] as any[], where: [] as any[], raceOnce: false, alwaysConflict: false,
  runs: [] as { cost: string | null }[],
}));

vi.mock("../../../lib/db", () => ({
  prisma: {
    company: {
      findFirst: async (a: any) => {
        db.where.push(a.where);
        const c = db.companies.find((x: Co) => x.id === a.where.id && x.tenantId === a.where.tenantId);
        return c ? { ...c, config: c.config === undefined ? undefined : JSON.parse(JSON.stringify(c.config)) } : null;
      },
      updateMany: async (a: any) => {
        db.where.push(a.where);
        const c = db.companies.find((x: Co) => x.id === a.where.id && x.tenantId === a.where.tenantId);
        if (!c) return { count: 0 };
        if (db.alwaysConflict) return { count: 0 };
        if (db.raceOnce) { db.raceOnce = false; c.updatedAt = new Date(c.updatedAt.getTime() + 1); }
        if (a.where.updatedAt && a.where.updatedAt.getTime() !== c.updatedAt.getTime()) return { count: 0 };
        c.config = a.data.config;
        c.updatedAt = new Date(c.updatedAt.getTime() + 1);
        return { count: 1 };
      },
    },
    activityLog: { create: async (a: any) => { db.logs.push(a.data); } },
    agent: { count: async () => 0 },
    pipeline: { count: async () => 0 },
    run: {
      count: async () => 0,
      aggregate: async () => {
        const c = db.runs.filter((r) => r.cost !== null);
        const sum = c.length ? c.reduce((s, r) => s + Number(r.cost), 0) : null;
        return { _sum: { costUsd: sum === null ? null : { toFixed: (d: number) => sum.toFixed(d) } } };
      },
    },
    approval: { count: async () => 0 },
  },
  tenantTx: vi.fn(),
}));
vi.mock("../../../middleware/auth", async () => {
  const actual = await vi.importActual<typeof import("../../../middleware/auth")>("../../../middleware/auth");
  return { ...actual, authMiddleware: (_q: unknown, _s: unknown, n: () => void) => n(), realAuth: actual.authMiddleware };
});
vi.mock("../../../middleware/rateLimit", () => ({ rateLimit: () => (_q: unknown, _s: unknown, n: () => void) => n() }));
vi.mock("../../../lib/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { ZodError } from "zod";
import { companyRouter } from "../router";
import * as authMod from "../../../middleware/auth";

// Zincir (requirePermission + handler) sırayla çalıştırılır; gerçek rbac kullanılır.
function chain(layer: any) {
  const hs = layer.route.stack.map((x: any) => x.handle);
  return async (req: any, res: any, next: any) => {
    for (let i = 0; i < hs.length; i++) {
      let advanced = false;
      await hs[i](req, res, (e?: any) => { advanced = true; if (e) next(e); else advanced = true; });
      if (!advanced || res.statusCode >= 400) return;
    }
  };
}
function handler(path: string, method: "get" | "patch") {
  const l = (companyRouter as any).stack.find((x: any) => x.route?.path === path && x.route.methods[method]);
  return { layer: l, h: chain(l) as (q: any, s: any, n: any) => Promise<void> };
}
const patch = handler("/:id/budget", "patch");
const summary = handler("/:id/summary", "get");

async function call(h: any, id: string, body: unknown, tenantId = "t-1", role = "OWNER") {
  const res: any = { statusCode: 200, body: undefined, status(c: number) { this.statusCode = c; return this; }, json(p: unknown) { this.body = p; return this; } };
  let err: any;
  await h({ params: { id }, body, auth: { tenantId, userId: "u-1", role } }, res, (e?: any) => { err = e; });
  return { res, err };
}
const status = (e: any) => e?.statusCode ?? e?.status;

beforeEach(() => {
  db.logs = []; db.where = []; db.raceOnce = false; db.alwaysConflict = false; db.runs = [];
  db.companies = [
    { id: "co-1", tenantId: "t-1", config: { niche: "x", webhookSecret: "keep-me", kpi: { a: 1 } }, updatedAt: new Date(1000) },
    { id: "co-B", tenantId: "t-B", config: { monthlyBudgetUsd: 5 }, updatedAt: new Date(1000) },
  ];
});

describe("PATCH /:id/budget", () => {
  it("MEMBER -> 403, yazma ve log yok", async () => {
    const { res } = await call(patch.h, "co-1", { monthlyBudgetUsd: 9 }, "t-1", "MEMBER");
    expect(res.statusCode).toBe(403);
    expect(db.companies[0].config.monthlyBudgetUsd).toBeUndefined();
    expect(db.logs).toHaveLength(0);
  });
  it.each(["ADMIN", "OWNER"])("%s -> başarılı", async (role) => {
    const { res, err } = await call(patch.h, "co-1", { monthlyBudgetUsd: 9 }, "t-1", role);
    expect(err).toBeUndefined();
    expect(res.body).toEqual({ success: true, monthlyBudgetUsd: 9 });
  });
  it("3 deneme tükenince 409", async () => {
    db.alwaysConflict = true;
    const { err } = await call(patch.h, "co-1", { monthlyBudgetUsd: 4 });
    expect(status(err)).toBe(409);
    expect(db.logs).toHaveLength(0);
    expect(db.companies[0].config.monthlyBudgetUsd).toBeUndefined();
  });
  it("geçerli yazma config'in diğer anahtarlarını korur; activity_log yazılır", async () => {
    const { res, err } = await call(patch.h, "co-1", { monthlyBudgetUsd: 250.5 });
    expect(err).toBeUndefined();
    expect(res.body).toEqual({ success: true, monthlyBudgetUsd: 250.5 });
    expect(db.companies[0].config).toEqual({ niche: "x", webhookSecret: "keep-me", kpi: { a: 1 }, monthlyBudgetUsd: 250.5 });
    expect(db.logs).toEqual([expect.objectContaining({ tenantId: "t-1", actor: "u-1", action: "company.budget.update", resource: "company", resourceId: "co-1" })]);
  });
  it("0 geçerli bir bütçedir", async () => {
    await call(patch.h, "co-1", { monthlyBudgetUsd: 0 });
    expect(db.companies[0].config.monthlyBudgetUsd).toBe(0);
  });
  it("null anahtarı siler, diğerlerini korur", async () => {
    await call(patch.h, "co-1", { monthlyBudgetUsd: 10 });
    const { res } = await call(patch.h, "co-1", { monthlyBudgetUsd: null });
    expect(res.body).toEqual({ success: true, monthlyBudgetUsd: null });
    expect(db.companies[0].config).toEqual({ niche: "x", webhookSecret: "keep-me", kpi: { a: 1 } });
  });
  it("config bozuk/yok olsa da yazılır", async () => {
    db.companies[0].config = null;
    await call(patch.h, "co-1", { monthlyBudgetUsd: 7 });
    expect(db.companies[0].config).toEqual({ monthlyBudgetUsd: 7 });
  });
  it("başka kiracının şirketi 404, değişmez, tüm where'lerde tenantId", async () => {
    const { err } = await call(patch.h, "co-B", { monthlyBudgetUsd: 1 });
    expect(status(err)).toBe(404);
    expect(db.companies[1].config).toEqual({ monthlyBudgetUsd: 5 });
    expect(db.where.every((w) => w.tenantId === "t-1")).toBe(true);
    expect(db.logs).toHaveLength(0);
    expect(status((await call(patch.h, "yok", { monthlyBudgetUsd: 1 })).err)).toBe(404);
  });
  it.each([[-1], [NaN], ["10"], [1.234], [2_000_000], [true], [{}]])("geçersiz %s -> 400, yazma yok", async (v) => {
    const { err } = await call(patch.h, "co-1", { monthlyBudgetUsd: v });
    expect(status(err)).toBe(400);
    expect(db.companies[0].config.monthlyBudgetUsd).toBeUndefined();
    expect(db.logs).toHaveLength(0);
  });
  it("alan eksik / gövde boş -> 400", async () => {
    expect((await call(patch.h, "co-1", {})).err).toBeInstanceOf(ZodError); // error middleware: ZodError -> 400
    expect(db.companies[0].config.monthlyBudgetUsd).toBeUndefined();
    expect((await call(patch.h, "co-1", undefined)).err).toBeInstanceOf(ZodError);
  });
  it("eşzamanlı değişiklikte yeniden dener ve diğer anahtarı ezmez", async () => {
    db.raceOnce = true;
    const { res, err } = await call(patch.h, "co-1", { monthlyBudgetUsd: 3 });
    expect(err).toBeUndefined();
    expect(res.body.success).toBe(true);
    expect(db.companies[0].config.niche).toBe("x");
    expect(db.companies[0].config.monthlyBudgetUsd).toBe(3);
  });
  it("kimliksiz -> 401 (gerçek middleware) ve authMiddleware rotadan ÖNCE kayıtlı", async () => {
    const res: any = { code: 0, status(c: number) { this.code = c; return this; }, json() { return this; } };
    const next = vi.fn();
    await (authMod as any).realAuth({ headers: {}, query: {}, cookies: {} }, res, next);
    expect(res.code).toBe(401);
    expect(next).not.toHaveBeenCalled();
    const stack = (companyRouter as any).stack;
    const authIdx = stack.findIndex((l: any) => !l.route && l.handle === (authMod as any).authMiddleware);
    expect(authIdx).toBeGreaterThanOrEqual(0);
    expect(authIdx).toBeLessThan(stack.indexOf(patch.layer));
  });
});

describe("summary.budget", () => {
  it("tanımsız -> state none", async () => {
    db.runs = [{ cost: "2.000000" }];
    const { res } = await call(summary.h, "co-1", undefined);
    expect(res.body.budget).toEqual({ limitUsd: null, spentUsd: 2, remainingUsd: null, usedPct: null, state: "none" });
  });
  it("tanımlı + harcama -> doğru yüzde ve warn", async () => {
    db.companies[0].config = { monthlyBudgetUsd: 10 };
    db.runs = [{ cost: "8.500000" }];
    const { res } = await call(summary.h, "co-1", undefined);
    expect(res.body.monthCostUsd).toBe("8.500000");
    expect(res.body.budget).toEqual({ limitUsd: 10, spentUsd: 8.5, remainingUsd: 1.5, usedPct: 85, state: "warn" });
  });
  it("tanımlı + maliyet kaynağı yok -> none, usedPct null", async () => {
    db.companies[0].config = { monthlyBudgetUsd: 10 };
    const { res } = await call(summary.h, "co-1", undefined);
    expect(res.body.monthCostUsd).toBeNull();
    expect(res.body.budget).toEqual({ limitUsd: 10, spentUsd: null, remainingUsd: null, usedPct: null, state: "none" });
  });
  it("bozuk config -> none; mevcut alanlar yerinde", async () => {
    db.companies[0].config = { monthlyBudgetUsd: "abc" };
    const { res } = await call(summary.h, "co-1", undefined);
    expect(res.body.budget.state).toBe("none");
    expect(Object.keys(res.body)).toEqual(expect.arrayContaining(["companyId", "agents", "pipelines", "buckets", "pendingApprovals", "monthCostUsd", "budget"]));
  });
});
