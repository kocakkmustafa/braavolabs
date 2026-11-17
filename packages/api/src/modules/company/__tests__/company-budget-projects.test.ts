/**
 * SINIR: groupBy/ilişki filtreleri bellek içi taklit edilir; gerçek Prisma/SQL ile birebir değildir.
 * BRA-P1-06-N3 — GET /companies/:id/budget/projects: sıralama, oran, null maliyet, kiracı 404,
 * 200 sınırı, UTC ay penceresi, bütçe yok -> state "none".
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Co = { id: string; tenantId: string; config?: unknown };
type Pl = { id: string; companyId: string; name: string };
type Rn = { pipelineId: string; costUsd: string | null; createdAt: Date };

const db = vi.hoisted(() => ({
  companies: [] as Co[], pipelines: [] as Pl[], runs: [] as Rn[],
  calls: { company: [] as any[], groupBy: 0, pipelineFind: 0 },
}));

const coOf = (pid: string) => {
  const p = db.pipelines.find((x) => x.id === pid);
  return p ? db.companies.find((c) => c.id === p.companyId) : undefined;
};

vi.mock("../../../lib/db", () => ({
  prisma: {
    company: {
      findFirst: async (a: any) => {
        db.calls.company.push(a);
        return db.companies.find((c) => c.id === a.where.id && c.tenantId === a.where.tenantId) ?? null;
      },
    },
    pipeline: {
      findMany: async (a: any) => {
        db.calls.pipelineFind++;
        return db.pipelines
          .filter((p) => a.where.id.in.includes(p.id) && p.companyId === a.where.companyId &&
            db.companies.find((c) => c.id === p.companyId)?.tenantId === a.where.company.tenantId)
          .map((p) => ({ id: p.id, name: p.name }));
      },
    },
    run: {
      groupBy: async (a: any) => {
        db.calls.groupBy++;
        const w = a.where;
        const rs = db.runs.filter((r) => {
          const c = coOf(r.pipelineId);
          return !!c && c.id === w.pipeline.companyId && c.tenantId === w.pipeline.company.tenantId &&
            r.createdAt >= w.createdAt.gte && r.createdAt < w.createdAt.lt;
        });
        const by = new Map<string, Rn[]>();
        for (const r of rs) by.set(r.pipelineId, [...(by.get(r.pipelineId) ?? []), r]);
        return [...by.entries()].map(([pipelineId, list]) => {
          const costed = list.filter((r) => r.costUsd !== null);
          const sum = costed.length ? costed.reduce((s, r) => s + Number(r.costUsd), 0) : null;
          return {
            pipelineId,
            _count: { _all: list.length },
            _sum: { costUsd: sum === null ? null : { toFixed: (d: number) => sum.toFixed(d) } },
            _max: { createdAt: new Date(Math.max(...list.map((r) => r.createdAt.getTime()))) },
          };
        });
      },
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
import { aggregateProjects, buildProjectBudget, MAX_BUDGET_PROJECTS } from "../budget-projects";
import * as authMod from "../../../middleware/auth";

const layer = (companyRouter as any).stack.find((l: any) => l.route?.path === "/:id/budget/projects" && l.route.methods.get);
const h = layer.route.stack[layer.route.stack.length - 1].handle as (req: any, res: any, next: any) => Promise<void>;

async function invoke(id = "co-1", tenantId = "t-1") {
  const res: any = { statusCode: 200, body: undefined, status(c: number) { this.statusCode = c; return this; }, json(p: unknown) { this.body = p; return this; } };
  let err: any;
  await h({ params: { id }, auth: { tenantId, userId: "u", role: "member" } }, res, (e?: any) => { err = e; });
  return { res, err };
}

const NOW = new Date();
const run = (pipelineId: string, costUsd: string | null, createdAt: Date = NOW): Rn => ({ pipelineId, costUsd, createdAt });

beforeEach(() => {
  db.companies = [{ id: "co-1", tenantId: "t-1" }, { id: "co-2", tenantId: "t-1" }, { id: "co-B", tenantId: "t-B" }];
  db.pipelines = []; db.runs = [];
  db.calls = { company: [], groupBy: 0, pipelineFind: 0 };
});

describe("sıralama ve oran", () => {
  it("harcamaya göre azalan, eşitlikte ada göre; oran 2 ondalık AŞAĞI; toplam doğru; tek groupBy", async () => {
    db.pipelines = [
      { id: "p1", companyId: "co-1", name: "Beta" }, { id: "p2", companyId: "co-1", name: "Alfa" },
      { id: "p3", companyId: "co-1", name: "Gama" }, { id: "p4", companyId: "co-1", name: "Delta" },
    ];
    db.runs = [
      run("p1", "1.000000"), run("p2", "1.000000"), // eşit: Alfa önce
      run("p3", "1.000000"), run("p3", "1.000000"), // 2.0 (en yüksek)
      run("p4", null),
    ];
    const { res, err } = await invoke();
    expect(err).toBeUndefined();
    expect(res.body.month).toBe(`${NOW.getUTCFullYear()}-${String(NOW.getUTCMonth() + 1).padStart(2, "0")}`);
    expect(res.body.totalSpentUsd).toBe("4.000000");
    expect(res.body.projects.map((p: any) => p.name)).toEqual(["Gama", "Alfa", "Beta", "Delta"]);
    expect(res.body.projects.map((p: any) => p.sharePct)).toEqual([50, 25, 25, null]);
    expect(res.body.truncated).toBeUndefined();
    expect(db.calls.groupBy).toBe(1);
    expect(db.calls.pipelineFind).toBe(1);
  });

  it("oran aşağı yuvarlanır (1/3 -> 33.33, 2/3 -> 66.66)", () => {
    const r = aggregateProjects(
      [
        { pipelineId: "a", runCount: 1, costSum: "1", lastRunAt: null },
        { pipelineId: "b", runCount: 1, costSum: "2", lastRunAt: null },
      ],
      new Map([["a", "A"], ["b", "B"]]),
    );
    expect(r.projects.map((p) => p.sharePct)).toEqual([66.66, 33.33]);
    expect(r.totalSpentUsd).toBe("3.000000");
  });
});

describe("null maliyet", () => {
  it("maliyetsiz pipeline: spentUsd null, runCount sayılır, toplamı etkilemez; hepsi null -> toplam null", async () => {
    db.pipelines = [{ id: "p1", companyId: "co-1", name: "A" }, { id: "p2", companyId: "co-1", name: "B" }];
    db.runs = [run("p1", "0.500000"), run("p2", null), run("p2", null)];
    const { res } = await invoke();
    expect(res.body.totalSpentUsd).toBe("0.500000");
    expect(res.body.projects).toEqual([
      expect.objectContaining({ pipelineId: "p1", runCount: 1, spentUsd: "0.500000", sharePct: 100 }),
      expect.objectContaining({ pipelineId: "p2", runCount: 2, spentUsd: null, sharePct: null }),
    ]);
    db.runs = [run("p2", null)];
    const r2 = (await invoke()).res.body;
    expect(r2.totalSpentUsd).toBeNull();
    expect(r2.projects[0].sharePct).toBeNull();
    expect(r2.budget.state).toBe("none");
  });

  it("lastRunAt = ayın en yeni koşusu (ISO); koşusuz şirket -> boş liste", async () => {
    db.pipelines = [{ id: "p1", companyId: "co-1", name: "A" }];
    const early = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), 1, 3));
    db.runs = [run("p1", "1", early), run("p1", "1", NOW)];
    expect((await invoke()).res.body.projects[0].lastRunAt).toBe(NOW.toISOString());
    db.runs = [];
    const empty = (await invoke()).res.body;
    expect(empty.projects).toEqual([]);
    expect(empty.totalSpentUsd).toBeNull();
    expect(db.calls.pipelineFind).toBe(1); // boş grupta ikinci sorgu yok
  });
});

describe("ay penceresi (UTC)", () => {
  it("ay başı DAHİL; ay başı-1ms ve sonraki ay başı HARİÇ", async () => {
    db.pipelines = [{ id: "p1", companyId: "co-1", name: "A" }];
    const now = new Date(Date.UTC(2026, 10, 14, 12));
    const start = new Date(Date.UTC(2026, 10, 1));
    db.runs = [
      run("p1", "1.000000", start),
      run("p1", "10.000000", new Date(start.getTime() - 1)),
      run("p1", "100.000000", new Date(Date.UTC(2026, 11, 1))),
    ];
    const v = await buildProjectBudget("t-1", "co-1", null, now);
    expect(v.month).toBe("2026-11");
    expect(v.totalSpentUsd).toBe("1.000000");
    expect(v.projects[0].runCount).toBe(1);
  });
});

describe("bütçe", () => {
  it("limit yok -> state none; limit var -> şirket toplamıyla durum", async () => {
    db.pipelines = [{ id: "p1", companyId: "co-1", name: "A" }];
    db.runs = [run("p1", "9.000000")];
    const none = await buildProjectBudget("t-1", "co-1", {}, NOW);
    expect(none.budget.state).toBe("none");
    expect(none.budget.limitUsd).toBeNull();
    const warn = await buildProjectBudget("t-1", "co-1", { monthlyBudgetUsd: 10 }, NOW);
    expect(warn.budget).toMatchObject({ limitUsd: 10, spentUsd: 9, state: "warn", usedPct: 90 });
  });
});

describe("200 sınırı", () => {
  it("201 proje -> 200 satır + truncated:true; toplam tüm projeleri kapsar", () => {
    const groups = Array.from({ length: 201 }, (_, i) => ({ pipelineId: `p${i}`, runCount: 1, costSum: "1", lastRunAt: null }));
    const names = new Map(groups.map((g) => [g.pipelineId, g.pipelineId] as [string, string]));
    const r = aggregateProjects(groups, names);
    expect(r.projects).toHaveLength(MAX_BUDGET_PROJECTS);
    expect(r.truncated).toBe(true);
    expect(r.totalSpentUsd).toBe("201.000000");
    expect(aggregateProjects(groups.slice(0, 200), names).truncated).toBe(false);
  });

  it("uç: 201 pipeline -> yanıtta truncated true", async () => {
    db.pipelines = Array.from({ length: 201 }, (_, i) => ({ id: `p${i}`, companyId: "co-1", name: `N${i}` }));
    db.runs = db.pipelines.map((p) => run(p.id, "1"));
    const { res } = await invoke();
    expect(res.body.projects).toHaveLength(200);
    expect(res.body.truncated).toBe(true);
  });
});

describe("yetki / kiracı", () => {
  it("başka kiracının şirketi -> 404, where {id, tenantId}; başka şirket/kiracı koşuları sızmaz", async () => {
    db.pipelines = [{ id: "p1", companyId: "co-1", name: "A" }, { id: "p2", companyId: "co-2", name: "B" }, { id: "pB", companyId: "co-B", name: "X" }];
    db.runs = [run("p1", "1"), run("p2", "5"), run("pB", "7")];
    const bad = await invoke("co-B", "t-1");
    expect(bad.err.statusCode).toBe(404);
    expect(bad.res.body).toBeUndefined();
    expect(db.calls.company[0].where).toEqual({ id: "co-B", tenantId: "t-1" });
    expect((await invoke("co-yok")).err.statusCode).toBe(404);
    const ok = (await invoke()).res.body;
    expect(ok.projects.map((p: any) => p.pipelineId)).toEqual(["p1"]);
    expect(ok.totalSpentUsd).toBe("1.000000");
  });

  it("authMiddleware rotadan ÖNCE kayıtlı; kimliksiz -> 401", async () => {
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
