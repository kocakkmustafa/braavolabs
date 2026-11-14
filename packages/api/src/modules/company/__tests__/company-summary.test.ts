/**
 * SINIR: Prisma ilişki filtreleri ({ pipeline: { companyId, company: { tenantId } } }) burada
 * bellek içi bir değerlendiriciyle taklit edilir; gerçek Prisma/SQL davranışıyla birebir değildir.
 * Gerçek veritabanıyla entegrasyon testi bu dilimin kapsamı dışındadır.
 *
 * BRA-P0-11b — GET /companies/:id/summary: fixture sayı eşleşmesi (bucketWhere bellek içi
 * değerlendirilir; kopya eşleme yok), null maliyet, kiracı yetkisi (404 / 401).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Co = { id: string; tenantId: string };
type Pl = { id: string; companyId: string };
type Rn = { id: string; pipelineId: string; state: string | null; status: string; heartbeatAt: Date | null; costUsd: string | null; createdAt: Date };
type Ap = { id: string; runId: string; status: string };

const db = vi.hoisted(() => ({
  companies: [] as Co[], agents: [] as { id: string; companyId: string }[],
  pipelines: [] as Pl[], runs: [] as Rn[], approvals: [] as Ap[],
  calls: { company: [] as any[] },
}));

const tenantOf = (cid: string) => db.companies.find((c) => c.id === cid)?.tenantId;
function matchVal(v: any, c: any): boolean {
  if (c !== null && typeof c === "object" && !(c instanceof Date)) {
    return (!("in" in c) || c.in.includes(v)) &&
      (!("lt" in c) || (v !== null && v < c.lt)) &&
      (!("gte" in c) || (v !== null && v >= c.gte)) &&
      (!("lte" in c) || (v !== null && v <= c.lte));
  }
  return v === c;
}
function runMatch(r: Rn, w: any): boolean {
  return Object.entries(w).every(([k, c]: [string, any]) => {
    if (k === "AND") return c.every((x: any) => runMatch(r, x));
    if (k === "OR") return c.some((x: any) => runMatch(r, x));
    if (k === "pipeline") {
      const p = db.pipelines.find((x) => x.id === r.pipelineId);
      return !!p && p.companyId === c.companyId && tenantOf(p.companyId) === c.company.tenantId;
    }
    return matchVal((r as any)[k], c);
  });
}

vi.mock("../../../lib/db", () => ({
  prisma: {
    company: {
      findFirst: async (a: any) => {
        db.calls.company.push(a);
        return db.companies.find((c) => c.id === a.where.id && c.tenantId === a.where.tenantId) ?? null;
      },
    },
    agent: { count: async (a: any) => db.agents.filter((x) => x.companyId === a.where.companyId && tenantOf(x.companyId) === a.where.company.tenantId).length },
    pipeline: { count: async (a: any) => db.pipelines.filter((x) => x.companyId === a.where.companyId && tenantOf(x.companyId) === a.where.company.tenantId).length },
    run: {
      count: async (a: any) => db.runs.filter((r) => runMatch(r, a.where)).length,
      aggregate: async (a: any) => {
        const rs = db.runs.filter((r) => runMatch(r, a.where));
        const costed = rs.filter((r) => r.costUsd !== null);
        const sum = costed.length ? costed.reduce((s, r) => s + Number(r.costUsd), 0) : null;
        return { _sum: { costUsd: sum === null ? null : { toFixed: (d: number) => sum.toFixed(d) } } };
      },
    },
    approval: {
      count: async (a: any) =>
        db.approvals.filter((x) => {
          const r = db.runs.find((y) => y.id === x.runId);
          return x.status === a.where.status && !!r && runMatch(r, a.where.run);
        }).length,
    },
  },
  tenantTx: vi.fn(),
}));
vi.mock("../../../middleware/auth", async () => {
  const actual = await vi.importActual<typeof import("../../../middleware/auth")>("../../../middleware/auth");
  return { ...actual, authMiddleware: (_q: unknown, _s: unknown, n: () => void) => n(), realAuth: actual.authMiddleware };
});
vi.mock("../../../middleware/require-permission", () => ({ requirePermission: () => (_q: unknown, _s: unknown, n: () => void) => n() }));
vi.mock("../../../middleware/rateLimit", () => ({ rateLimit: () => (_q: unknown, _s: unknown, n: () => void) => n() }));
vi.mock("../../../lib/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { companyRouter } from "../router";
import { buildCompanySummary } from "../summary";
import * as authMod from "../../../middleware/auth";

const layer = (companyRouter as any).stack.find((l: any) => l.route?.path === "/:id/summary" && l.route.methods.get);
const h = layer.route.stack[layer.route.stack.length - 1].handle as (req: any, res: any, next: any) => Promise<void>;

async function invoke(id = "co-1", tenantId = "t-1") {
  const res: any = { statusCode: 200, body: undefined, status(c: number) { this.statusCode = c; return this; }, json(p: unknown) { this.body = p; return this; } };
  let err: any;
  await h({ params: { id }, auth: { tenantId, userId: "u", role: "member" } }, res, (e?: any) => { err = e; });
  return { res, err };
}

const NOW = new Date();
const old = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth() - 1, 15));
let n = 0;
const run = (pipelineId: string, state: string | null, status: string, o: Partial<Rn> = {}): Rn =>
  ({ id: `r${++n}`, pipelineId, state, status, heartbeatAt: null, costUsd: null, createdAt: NOW, ...o });

beforeEach(() => {
  n = 0;
  db.companies = [{ id: "co-1", tenantId: "t-1" }, { id: "co-2", tenantId: "t-1" }, { id: "co-B", tenantId: "t-B" }];
  db.agents = []; db.pipelines = []; db.runs = []; db.approvals = []; db.calls.company = [];
});

describe("fixture sayı eşleşmesi", () => {
  it("ajan/pipeline/kova/onay/maliyet; 25+ kayıtta toplam doğru; başka şirket ve kiracı hariç", async () => {
    db.agents = [{ id: "a1", companyId: "co-1" }, { id: "a2", companyId: "co-1" }, { id: "a3", companyId: "co-2" }];
    db.pipelines = [{ id: "p1", companyId: "co-1" }, { id: "p2", companyId: "co-1" }, { id: "p3", companyId: "co-2" }, { id: "pB", companyId: "co-B" }];
    const stale = new Date(NOW.getTime() - 3_600_000);
    const mine: Rn[] = [];
    for (let i = 0; i < 12; i++) mine.push(run("p1", "COMPLETED", "COMPLETED", { costUsd: "0.100000" })); // done x12
    for (let i = 0; i < 9; i++) mine.push(run("p2", "RUNNING", "RUNNING", { heartbeatAt: NOW })); // working x9
    mine.push(run("p1", null, "PENDING"), run("p1", "READY", "PENDING")); // working +2 = 11
    mine.push(run("p2", "NEEDS_APPROVAL", "WAITING_APPROVAL"), run("p2", null, "WAITING_APPROVAL")); // needs_approval x2
    mine.push(run("p1", "FAILED", "FAILED"), run("p1", "PAUSED", "PAUSED"), run("p2", "RUNNING", "RUNNING", { heartbeatAt: stale })); // stuck x3
    mine.push(run("p1", "DRAFT", "PENDING")); // hiçbir kovada yok
    mine.push(run("p1", "COMPLETED", "COMPLETED", { costUsd: "5.000000", createdAt: old })); // geçen ay: toplama girmez
    db.runs = [...mine, run("p3", "COMPLETED", "COMPLETED", { costUsd: "9" }), run("pB", "FAILED", "FAILED", { costUsd: "9" })];
    expect(mine.length).toBeGreaterThanOrEqual(25);
    db.approvals = [
      // x1/x2: needs_approval koşularına (mine[23], mine[24]) bağlı
      { id: "x1", runId: mine[23].id, status: "PENDING" }, { id: "x2", runId: mine[24].id, status: "PENDING" },
      { id: "x3", runId: mine[0].id, status: "APPROVED" },
      { id: "x4", runId: db.runs[db.runs.length - 2].id, status: "PENDING" }, // co-2
      { id: "x5", runId: db.runs[db.runs.length - 1].id, status: "PENDING" }, // başka kiracı
    ];
    const { res, err } = await invoke();
    expect(err).toBeUndefined();
    expect(res.body).toEqual({
      companyId: "co-1", agents: 2, pipelines: 2,
      buckets: { working: 11, needs_approval: 2, done: 13, stuck: 3 },
      pendingApprovals: 2, monthCostUsd: "1.200000",
    });
  });

  it("kaynak yok: sayımlar 0, maliyet null (0 değil)", async () => {
    db.pipelines = [{ id: "p1", companyId: "co-1" }];
    db.runs = [run("p1", "COMPLETED", "COMPLETED")]; // maliyeti boş
    const { res } = await invoke();
    expect(res.body).toEqual({
      companyId: "co-1", agents: 0, pipelines: 1,
      buckets: { working: 0, needs_approval: 0, done: 1, stuck: 0 },
      pendingApprovals: 0, monthCostUsd: null,
    });
    expect((await invoke("co-2")).res.body.monthCostUsd).toBeNull();
  });
});

describe("ay penceresi (UTC)", () => {
  it("ay başı DAHİL; ay başı-1ms ve sonraki ay başı HARİÇ", async () => {
    db.pipelines = [{ id: "p1", companyId: "co-1" }];
    const now = new Date(Date.UTC(2026, 10, 14, 12));
    const start = new Date(Date.UTC(2026, 10, 1));
    const next = new Date(Date.UTC(2026, 11, 1));
    db.runs = [
      run("p1", "COMPLETED", "COMPLETED", { costUsd: "1.000000", createdAt: start }),
      run("p1", "COMPLETED", "COMPLETED", { costUsd: "10.000000", createdAt: new Date(start.getTime() - 1) }),
      run("p1", "COMPLETED", "COMPLETED", { costUsd: "100.000000", createdAt: next }),
    ];
    expect((await buildCompanySummary("t-1", "co-1", now)).monthCostUsd).toBe("1.000000");
  });
});

describe("yetki", () => {
  it("başka kiracının şirketi -> 404 ve where {id, tenantId}", async () => {
    db.agents = [{ id: "aB", companyId: "co-B" }];
    const { err, res } = await invoke("co-B", "t-1");
    expect(err.statusCode).toBe(404);
    expect(res.body).toBeUndefined();
    expect(db.calls.company[0].where).toEqual({ id: "co-B", tenantId: "t-1" });
    expect((await invoke("co-yok")).err.statusCode).toBe(404);
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
    expect(authIdx).toBeLessThan(stack.indexOf(layer));
  });
});
