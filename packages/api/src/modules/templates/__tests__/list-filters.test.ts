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
        const out = rows.filter((r) => matches(r, args.where))
          .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
        return out.slice(0, args.take);
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
  primitives: ["CONTENT"], pricing: "FREE", visibility: "PUBLIC", isApproved: true,
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)), ...o,
});
const get = async (qs = "") => {
  const r = await fetch(`${base}/t/${qs}`);
  return { status: r.status, body: await r.json().catch(() => null), next: r.headers.get("x-next-cursor") };
};
beforeEach(() => { rows = []; lastArgs = undefined; });

describe("GET /templates filters", () => {
  it("no params: bare array, default limit, visibility pinned in where", async () => {
    rows = [mk(1), mk(2)];
    const r = await get();
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
    expect(r.body.map((x: any) => x.slug)).toEqual(["s2", "s1"]);
    expect(r.next).toBeNull();
    expect(lastArgs.where).toMatchObject({ visibility: "PUBLIC", isApproved: true });
  });
  it("UNLISTED, PRIVATE and unapproved never listed", async () => {
    rows = [mk(1), mk(2, { visibility: "UNLISTED" }), mk(3, { visibility: "PRIVATE" }), mk(4, { isApproved: false })];
    expect((await get()).body.map((x: any) => x.slug)).toEqual(["s1"]);
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
    for (const qs of ["?pricing=free", "?category=NOPE", "?primitives=SALES,BAD", "?bogus=1", "?pricing=FREE&pricing=PAID"]) {
      expect((await get(qs)).status).toBe(400);
    }
  });
});

describe("GET /templates pagination", () => {
  it("walks pages with stable order, no dup/skip, ties on createdAt broken by id", async () => {
    const same = new Date(Date.UTC(2026, 0, 2));
    rows = [...[1, 2, 3, 4, 5].map((i) => mk(i)), mk(6, { createdAt: same }), mk(7, { createdAt: same })];
    const seen: string[] = [];
    let cur: string | null = null;
    for (let n = 0; n < 10; n++) {
      const r: any = await get(`?limit=3${cur ? `&cursor=${cur}` : ""}`);
      expect(r.status).toBe(200);
      seen.push(...r.body.map((x: any) => x.slug));
      cur = r.next;
      if (!cur) break;
    }
    expect(seen).toEqual(["s7", "s6", "s5", "s4", "s3", "s2", "s1"]);
  });
  it("limit bounds: 1 and 100 ok; 0, 101, abc, -1 -> 400; take is limit+1", async () => {
    rows = [mk(1)];
    expect((await get("?limit=100")).status).toBe(200);
    expect(lastArgs.take).toBe(101);
    expect((await get("?limit=1")).status).toBe(200);
    for (const l of ["0", "101", "abc", "-1", "1.5"]) expect((await get(`?limit=${l}`)).status).toBe(400);
  });
  it("malformed cursor -> 400", async () => {
    for (const c of ["garbage", Buffer.from("{}").toString("base64url"), "a".repeat(300)]) {
      expect((await get(`?cursor=${c}`)).status).toBe(400);
    }
  });
});
