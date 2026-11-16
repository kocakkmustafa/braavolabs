/**
 * BRA-P0-11f — genel PATCH /companies/:id config yazımı updatedAt iyimser kilidiyle (3 deneme + 409).
 * SINIR: Prisma bellek içi taklit; gerçek DB ile entegrasyon bu dilimin dışında.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Co = { id: string; tenantId: string; name: string; config: any; updatedAt: Date };
const db = vi.hoisted(() => ({
  companies: [] as any[], logs: [] as any[], calls: [] as { op: string; where: any }[],
  // raceOnce: ilk updateMany'den hemen önce başka bir uç (bütçe/kip) config'e yazar.
  raceOnce: null as null | Record<string, unknown>,
  alwaysConflict: false,
  conflicts: 0, tenantCalls: 0,
}));

vi.mock("../../../lib/db", () => ({
  prisma: {
    company: {
      findFirst: async (a: any) => {
        db.calls.push({ op: "findFirst", where: a.where });
        const c = db.companies.find((x: Co) => x.id === a.where.id && x.tenantId === a.where.tenantId);
        return c ? { ...c, config: JSON.parse(JSON.stringify(c.config ?? {})) } : null;
      },
      updateMany: async (a: any) => {
        db.calls.push({ op: "updateMany", where: a.where });
        const c = db.companies.find((x: Co) => x.id === a.where.id && x.tenantId === a.where.tenantId);
        if (!c) return { count: 0 };
        if (db.raceOnce) {
          c.config = { ...c.config, ...db.raceOnce };
          c.updatedAt = new Date(c.updatedAt.getTime() + 1);
          db.raceOnce = null;
        }
        if (db.conflicts > 0) {
          db.conflicts--;
          c.config = { ...c.config, [`race${db.conflicts}`]: true };
          c.updatedAt = new Date(c.updatedAt.getTime() + 1);
        }
        if (db.alwaysConflict) return { count: 0 };
        if (a.where.updatedAt && a.where.updatedAt.getTime() !== c.updatedAt.getTime()) return { count: 0 };
        if ("config" in a.data && a.data.config !== undefined) c.config = a.data.config;
        if (a.data.name !== undefined) c.name = a.data.name;
        c.updatedAt = new Date(c.updatedAt.getTime() + 1);
        return { count: 1 };
      },
    },
    tenant: { findUnique: async () => { db.tenantCalls++; return { plan: "INDIVIDUAL" }; } },
    entitlementEvent: { findMany: async () => [] },
    activityLog: { create: async (a: any) => { db.logs.push(a.data); } },
  },
  tenantTx: vi.fn(),
}));
vi.mock("../../../middleware/auth", async () => {
  const actual = await vi.importActual<typeof import("../../../middleware/auth")>("../../../middleware/auth");
  return { ...actual, authMiddleware: (_q: unknown, _s: unknown, n: () => void) => n() };
});
vi.mock("../../../middleware/rateLimit", () => ({ rateLimit: () => (_q: unknown, _s: unknown, n: () => void) => n() }));
vi.mock("../../../lib/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { companyRouter } from "../router";

const layer = (companyRouter as any).stack.find((x: any) => x.route?.path === "/:id" && x.route.methods.patch);
const handler = layer.route.stack.at(-1).handle as (q: any, s: any, n: any) => Promise<void>;

async function call(id: string, body: unknown, tenantId = "t-1") {
  const res: any = { statusCode: 200, body: undefined, status(c: number) { this.statusCode = c; return this; }, json(p: unknown) { this.body = p; return this; } };
  let err: any;
  await handler({ params: { id }, body, auth: { tenantId, userId: "u-1", role: "OWNER" } }, res, (e?: any) => { err = e; });
  return { res, err };
}
const status = (e: any) => e?.statusCode ?? e?.status;

beforeEach(() => {
  db.logs = []; db.calls = []; db.raceOnce = null; db.alwaysConflict = false; db.conflicts = 0; db.tenantCalls = 0;
  db.companies = [
    { id: "co-1", tenantId: "t-1", name: "Acme", config: { webhookSecret: "keep-me", kpi: { a: 1 } }, updatedAt: new Date(1000) },
    { id: "co-B", tenantId: "t-B", name: "Other", config: { niche: "b" }, updatedAt: new Date(1000) },
  ];
});

describe("genel PATCH /:id — iyimser kilit", () => {
  it("eşzamanlı bütçe yazımı yeniden denemede korunur (kayıp güncelleme yok)", async () => {
    db.raceOnce = { monthlyBudgetUsd: 42 };
    const { res, err } = await call("co-1", { config: { niche: "saas" } });
    expect(err).toBeUndefined();
    expect(res.body).toEqual({ success: true });
    expect(db.companies[0].config).toEqual({ webhookSecret: "keep-me", kpi: { a: 1 }, monthlyBudgetUsd: 42, niche: "saas" });
    expect(db.calls.filter((c) => c.op === "updateMany")).toHaveLength(2);
    expect(db.calls.filter((c) => c.op === "findFirst")).toHaveLength(2);
  });

  it("eşzamanlı model kipi yazımı da korunur", async () => {
    db.raceOnce = { modelMode: "COMPARE" };
    const { err } = await call("co-1", { config: { niche: "saas" } });
    expect(err).toBeUndefined();
    expect(db.companies[0].config.modelMode).toBe("COMPARE");
    expect(db.companies[0].config.niche).toBe("saas");
  });

  it("süregelen çakışmada 409; yazma ve log yok", async () => {
    db.alwaysConflict = true;
    const { err } = await call("co-1", { config: { niche: "saas" } });
    expect(status(err)).toBe(409);
    expect(db.calls.filter((c) => c.op === "updateMany")).toHaveLength(3);
    expect(db.logs).toHaveLength(0);
    expect(db.companies[0].config.niche).toBeUndefined();
  });

  it("başka kiracının şirketi 404; her sorguda kiracı where'i var", async () => {
    const { err } = await call("co-B", { config: { niche: "x" } }, "t-1");
    expect(status(err)).toBe(404);
    expect(db.logs).toHaveLength(0);
    expect(db.companies[1].config).toEqual({ niche: "b" });
    expect(db.calls.every((c) => c.where.tenantId === "t-1")).toBe(true);
  });

  it("yalnız-name yazımı kilit döngüsüne girmez (tek updateMany, findFirst yok)", async () => {
    const { res, err } = await call("co-1", { name: "Renamed" });
    expect(err).toBeUndefined();
    expect(res.body).toEqual({ success: true });
    expect(db.companies[0].name).toBe("Renamed");
    expect(db.calls.map((c) => c.op)).toEqual(["updateMany"]);
    expect(db.calls[0].where.updatedAt).toBeUndefined();
  });

  it("yalnız-name yazımında bulunamayan şirket 404", async () => {
    const { err } = await call("co-B", { name: "x" }, "t-1");
    expect(status(err)).toBe(404);
  });

  it("activity_log yarışlı yazımda da tam bir kez yazılır", async () => {
    db.raceOnce = { monthlyBudgetUsd: 1 };
    await call("co-1", { config: { niche: "saas" } });
    expect(db.logs).toEqual([expect.objectContaining({ tenantId: "t-1", actor: "u-1", action: "company.update", resource: "company", resourceId: "co-1" })]);
  });

  it("3. denemede başarı: iki çakışmadan sonra yazar, iki yarış yazımı da korunur", async () => {
    db.conflicts = 2;
    const { res, err } = await call("co-1", { config: { niche: "saas" } });
    expect(err).toBeUndefined();
    expect(res.body).toEqual({ success: true });
    expect(db.calls.filter((c) => c.op === "updateMany")).toHaveLength(3);
    expect(db.companies[0].config).toMatchObject({ niche: "saas", race0: true, race1: true, webhookSecret: "keep-me" });
    expect(db.logs).toHaveLength(1);
  });

  it("name + config birlikte: ikisi de yazılır ve yarışta korunur", async () => {
    db.raceOnce = { monthlyBudgetUsd: 7 };
    const { err } = await call("co-1", { name: "Renamed", config: { niche: "saas" } });
    expect(err).toBeUndefined();
    expect(db.companies[0].name).toBe("Renamed");
    expect(db.companies[0].config).toMatchObject({ niche: "saas", monthlyBudgetUsd: 7 });
    expect(db.logs).toHaveLength(1);
  });

  it("kanal: yamada plan dışı yeni kanal 403, yazma ve log yok", async () => {
    const { err } = await call("co-1", { config: { channels: ["youtube"] } });
    expect(status(err)).toBe(403);
    expect(db.calls.filter((c) => c.op === "updateMany")).toHaveLength(0);
    expect(db.logs).toHaveLength(0);
  });

  it("kanal: mevcut config'te plan dışı kanal kalmışsa ilgisiz yama {niche} 403 (davranış korunur, bilinçli)", async () => {
    db.companies[0].config.channels = ["youtube"];
    const { err } = await call("co-1", { config: { niche: "saas" } });
    expect(status(err)).toBe(403);
    expect(db.companies[0].config.niche).toBeUndefined();
    expect(db.logs).toHaveLength(0);
  });

  it("kanal: config'te kanal yoksa tenant/plan sorgusu hiç atılmaz", async () => {
    const { err } = await call("co-1", { config: { niche: "saas" } });
    expect(err).toBeUndefined();
    expect(db.tenantCalls).toBe(0);
  });

  it("kanal: plan sorgusu yeniden denemelerde tek (2 çakışma, 3 deneme)", async () => {
    db.conflicts = 2;
    const { err } = await call("co-1", { config: { channels: ["instagram"] } });
    expect(err).toBeUndefined();
    expect(db.calls.filter((c) => c.op === "updateMany")).toHaveLength(3);
    expect(db.tenantCalls).toBe(1);
  });

  it("allowlist dışı anahtar yazılmaz", async () => {
    await call("co-1", { config: { niche: "n", webhookSecret: "evil" } });
    expect(db.companies[0].config.webhookSecret).toBe("keep-me");
  });
});
