/**
 * BRA-P2-03a: GET /templates read filters + cursor pagination.
 * Prisma is faked in memory so where-clauses are actually evaluated.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";

vi.mock("../../../lib/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../../../config/env", () => ({ env: { JWT_SECRET: "t", AUTH_COOKIE_MODE: false, NODE_ENV: "test" } }));

type Row = any;
let rows: Row[] = [];
let lastArgs: any;
const matches = (r: Row, w: any): boolean => {
  if (!w) return true;
  for (const [k, v] of Object.entries<any>(w)) {
    if (k === "AND") { if (!v.every((x: any) => matches(r, x))) return false; }
    else if (k === "OR") { if (!v.some((x: any) => matches(r, x))) return false; }
    else if (v && typeof v === "object" && "array_contains" in v) { if (!v.array_contains.every((p: string) => r[k].includes(p))) return false; }
    else if (v && typeof v === "object" && "contains" in v) { if (!String(r[k]).toLowerCase().includes(v.contains.toLowerCase())) return false; }
    else if (v && typeof v === "object" && "lt" in v) { if (!(r[k] < v.lt)) return false; }
    else if (r[k] instanceof Date && v instanceof Date) { if (r[k].getTime() !== v.getTime()) return false; }
    else if (r[k] !== v) return false;
  }
  return true;
};
vi.mock("../../../lib/db", () => ({
  prisma: {
    companyTemplate: {
      findUnique: async () => null,
      findMany: async (args: any) => {
        lastArgs = args;
        const out = rows.filter((r) => matches(r, args.where));
        const ob = args.orderBy as any[];
        out.sort((a, b) => {
          for (const o of ob) {
            const [k, d] = Object.entries<string>(o)[0];
            const av = a[k], bv = b[k];
            if (av < bv) return d === "asc" ? -1 : 1;
            if (av > bv) return d === "asc" ? 1 : -1;
          }
          return 0;
        });
        return args.take === undefined ? out : out.slice(0, args.take);
      },
    },
  },
  tenantTx: (fn: any) => fn({}),
}));

let server: http.Server; let base: string;
beforeAll(async () => {
  const { templatesRouter } = await import("../templates.router");
  const app = express();
  app.use("/t", templatesRouter);
  app.use((err: any, _q: any, res: any, _n: any) =>
    res.status(err?.name === "ZodError" ? 400 : err?.statusCode ?? err?.status ?? 500).json({ error: err?.message }));
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const mk = (i: number, o: Row = {}): Row => ({
  id: `id${String(i).padStart(3, "0")}`, slug: `s${i}`, name: `T${i}`, description: `d${i}`,
  ratingAvg: 0, installCount: 0, primitives: ["CONTENT"], pricing: "FREE", visibility: "PUBLIC", isApproved: true,
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)), ...o,
});
const get = async (qs = "") => {
  const r = await fetch(`${base}/t/${qs}`);
  return { status: r.status, body: await r.json().catch(() => null), next: r.headers.get("x-next-cursor") };
};
beforeEach(() => { rows = []; lastArgs = undefined; });

describe("GET /templates filters", () => {
  it("no params: legacy order, no take, bare array, no header", async () => {
    rows = [mk(1, { ratingAvg: 3 }), mk(2, { ratingAvg: 5 }), mk(3, { ratingAvg: 3, installCount: 9 }), mk(4, { ratingAvg: 3, installCount: 9, name: "A" })];
    const r = await get();
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
    expect(lastArgs.orderBy).toEqual([{ ratingAvg: "desc" }, { installCount: "desc" }, { name: "asc" }]);
    expect(lastArgs.take).toBe(501);
    expect(r.body.map((x: any) => x.slug)).toEqual(["s2", "s4", "s3", "s1"]);
    expect(r.next).toBeNull();
    expect(lastArgs.where).toMatchObject({ visibility: "PUBLIC", isApproved: true });
  });
  it("UNLISTED, PRIVATE and unapproved never listed", async () => {
    rows = [mk(1), mk(2, { visibility: "UNLISTED" }), mk(3, { visibility: "PRIVATE" }), mk(4, { isApproved: false })];
    expect((await get()).body.map((x: any) => x.slug)).toEqual(["s1"]);
    expect((await get("?sort=newest")).body.map((x: any) => x.slug)).toEqual(["s1"]);
  });
  it("q passes percent and underscore through unescaped (same as legacy endpoint)", async () => {
    rows = [mk(1, { name: "100% real" }), mk(2, { name: "plain" })];
    await get("?q=%25");
    expect(lastArgs.where.AND[0].OR[0].name).toEqual({ contains: "%", mode: "insensitive" });
  });
  it("category / primitives / pricing / q combine", async () => {
    rows = [
      mk(1, { primitives: ["CONTENT", "SALES"] }),
      mk(2, { primitives: ["SALES"], pricing: "PAID" }),
      mk(3, { primitives: ["CONTENT", "SALES"], pricing: "PAID", name: "Alpha" }),
    ];
    expect((await get("?category=SALES")).body).toHaveLength(3);
    expect((await get("?primitives=CONTENT,SALES")).body.map((x: any) => x.slug)).toEqual(["s3", "s1"]);
    expect((await get("?pricing=PAID")).body.map((x: any) => x.slug)).toEqual(["s3", "s2"]);
    expect((await get("?category=CONTENT&pricing=PAID&q=alpha")).body.map((x: any) => x.slug)).toEqual(["s3"]);
  });
  it("invalid filter values -> 400", async () => {
    for (const qs of ["?pricing=free", "?sort=oldest", "?category=NOPE", "?primitives=SALES,BAD", "?bogus=1", "?pricing=FREE&pricing=PAID"]) {
      expect((await get(qs)).status).toBe(400);
    }
  });
});

describe("legacy hard cap", () => {
  it("501 templates -> 500 rows, X-Truncated, legacy order kept", async () => {
    rows = Array.from({ length: 501 }, (_, i) => mk(i + 1, { ratingAvg: i }));
    const res = await fetch(base + "/t/");
    const body: any[] = await res.json();
    expect(lastArgs.take).toBe(501);
    expect(lastArgs.orderBy).toEqual([{ ratingAvg: "desc" }, { installCount: "desc" }, { name: "asc" }]);
    expect(body).toHaveLength(500);
    expect(body[0].slug).toBe("s501");
    expect(res.headers.get("x-truncated")).toBe("true");
  });
  it("exactly 500 -> not truncated", async () => {
    rows = Array.from({ length: 500 }, (_, i) => mk(i + 1));
    const res = await fetch(base + "/t/");
    expect((await res.json()).length).toBe(500);
    expect(res.headers.get("x-truncated")).toBeNull();
  });
});

describe("GET /templates pagination (sort=newest)", () => {
  it("cursor with default/rating sort -> 400", async () => {
    rows = [mk(1)];
    expect((await get("?cursor=abc")).status).toBe(400);
    expect((await get("?sort=rating&cursor=abc")).status).toBe(400);
  });
  it("sort=rating with limit: take is a plain cap, no header", async () => {
    rows = [mk(1), mk(2), mk(3)];
    const r = await get("?limit=2");
    expect(lastArgs.take).toBe(2);
    expect(r.body).toHaveLength(2);
    expect(r.next).toBeNull();
  });
  it("walks pages with stable order, no dup/skip, ties on createdAt broken by id", async () => {
    const same = new Date(Date.UTC(2026, 0, 2));
    rows = [...[1, 2, 3, 4, 5].map((i) => mk(i)), mk(6, { createdAt: same }), mk(7, { createdAt: same })];
    const seen: string[] = [];
    let cur: string | null = null;
    for (let n = 0; n < 10; n++) {
      const r: any = await get(`?sort=newest&limit=3${cur ? `&cursor=${cur}` : ""}`);
      expect(r.status).toBe(200);
      seen.push(...r.body.map((x: any) => x.slug));
      cur = r.next;
      if (!cur) break;
    }
    expect(seen).toEqual(["s7", "s6", "s5", "s4", "s3", "s2", "s1"]);
  });
  it("limit bounds: 1 and 100 ok; 0, 101, abc, -1 -> 400; take is limit+1", async () => {
    rows = [mk(1)];
    expect((await get("?sort=newest&limit=100")).status).toBe(200);
    expect(lastArgs.take).toBe(101);
    expect(lastArgs.orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
    expect((await get("?sort=newest")).status).toBe(200);
    expect(lastArgs.take).toBe(25);
    expect((await get("?limit=1")).status).toBe(200);
    for (const l of ["0", "101", "abc", "-1", "1.5"]) expect((await get(`?limit=${l}`)).status).toBe(400);
  });
  it("malformed cursor -> 400", async () => {
    for (const c of ["garbage", Buffer.from("{}").toString("base64url"), "a".repeat(300)]) {
      expect((await get(`?sort=newest&cursor=${c}`)).status).toBe(400);
    }
  });
});
