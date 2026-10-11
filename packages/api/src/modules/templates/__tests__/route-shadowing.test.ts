/**
 * Intra-router shadowing regression (BR-P0-004, found by independent review).
 *
 * `GET /:slug` matches any single segment, so every literal sibling route with
 * the same verb and segment count registered AFTER it is unreachable.
 * `GET /api/v1/marketplace/templates/my-installs` was answering
 * 404 "Template not found" — the catch-all handled it and the real handler on
 * tenantRouter never ran.
 *
 * This is the same shadowing class as the index.ts mount-order rule, one level
 * down, and index.ts's top-level scan structurally cannot see it. It also pins
 * something tsc cannot: that tenantRouter is actually MOUNTED — an unmounted
 * router is silently dead, and typechecks perfectly.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";

vi.mock("../../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../../lib/db", () => ({
  prisma: { companyTemplate: { findUnique: async () => null, findMany: async () => [] } },
  tenantTx: (fn: any) => fn({}),
}));
vi.mock("../../../config/env", () => ({
  env: { JWT_SECRET: "test-secret-shadowing", AUTH_COOKIE_MODE: false, NODE_ENV: "test" },
}));

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const { templatesRouter } = await import("../templates.router");
  const app = express();
  app.use(express.json());
  app.use("/api/v1/marketplace/templates", templatesRouter);
  app.use((err: any, _q: any, res: any, _n: any) =>
    res.status(err?.statusCode ?? err?.status ?? 500).json({ error: err?.message ?? "error" }));
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const get = async (p: string) => {
  const res = await fetch(`${baseUrl}${p}`);
  return { status: res.status, body: await res.json().catch(() => null) };
};

describe("templates router: literal routes are not shadowed by /:slug", () => {
  it("GET /my-installs reaches its own handler, not the /:slug catch-all", async () => {
    const r = await get("/api/v1/marketplace/templates/my-installs");
    // It is authMiddleware-gated, so 401 is the CORRECT answer for an
    // unauthenticated caller. 404 "Template not found" would mean /:slug
    // swallowed it — the bug.
    expect(r.status).toBe(401);
    expect(r.body).not.toEqual({ error: "Template not found" });
  });

  it("an ACTUAL unknown slug still 404s through the catch-all", async () => {
    const r = await get("/api/v1/marketplace/templates/some-unknown-slug");
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: "Template not found" });
  });

  it("the public catalog is still reachable unauthenticated", async () => {
    const r = await get("/api/v1/marketplace/templates/");
    expect(r.status).toBe(200);
  });

  it("tenantRouter is actually MOUNTED (an unmounted router typechecks fine)", async () => {
    // If `templatesRouter.use(tenantRouter)` is ever dropped, every tenant
    // route silently becomes the /:slug 404 — with no compile error at all.
    const r = await get("/api/v1/marketplace/templates/my-installs");
    expect(r.status).not.toBe(404);
  });
});
