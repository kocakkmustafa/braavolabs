/** Mount-order smoke: benchCompareRouter BEFORE the public benchRouter, as in index.ts. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import jwt from "jsonwebtoken";

const SECRET = "bench-mount-synthetic-jwt-secret-at-least-32-chars";
const m = vi.hoisted(() => ({
  user: vi.fn(), userUnique: vi.fn(), suites: vi.fn(), suite: vi.fn(), runs: vi.fn(),
  incr: vi.fn(), expire: vi.fn(), run: vi.fn(),
}));
vi.mock("../../../config/env", () => ({ env: { JWT_SECRET: "bench-mount-synthetic-jwt-secret-at-least-32-chars", AUTH_COOKIE_MODE: false, OFFLINE_MODE: false, NODE_ENV: "test" } }));
vi.mock("../../../lib/db", () => ({
  prisma: {
    user: { findFirst: m.user, findUnique: m.userUnique },
    benchSuite: { findMany: m.suites, findUnique: m.suite },
    benchRun: { findMany: m.runs },
  },
}));
vi.mock("../../../lib/redis", () => ({ redis: { incr: m.incr, expire: m.expire } }));
vi.mock("../../../lib/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../bench.service", () => ({ runBenchSuite: m.run }));
vi.mock("../../../services/multi-model", () => ({ MAX_CANDIDATES: 3 }));

import { benchRouter } from "../bench.router";
import { benchCompareRouter } from "../bench-compare.router";
import { errorHandler } from "../../../middleware/error";
import { BENCH_COMPARE_SUITE_SLUGS } from "../bench-compare";

const SUITE = BENCH_COMPARE_SUITE_SLUGS[0];
let server: http.Server;
let base: string;
const tok = (role: string) => jwt.sign({ userId: "u-" + role, tenantId: "t-a", role }, SECRET, { expiresIn: "1h" });
const runBody = { suiteSlug: SUITE, provider: "OPENAI", model: "m-1" };

beforeAll(async () => {
  delete process.env.BENCH_WORKER_TOKEN;
  process.env.MARKETPLACE_ADMIN_EMAILS = "admin@example.test";
  const app = express();
  app.use(express.json());
  // Same order as index.ts.
  app.use("/api/v1/bench/compare", benchCompareRouter);
  app.use("/api/v1/bench", benchRouter);
  app.use(errorHandler);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/bench`;
});
afterAll(() => new Promise<void>((r) => (server?.listening ? server.close(() => r()) : r())));
beforeEach(() => {
  vi.clearAllMocks();
  m.incr.mockResolvedValue(1);
  m.expire.mockResolvedValue(1);
  m.user.mockImplementation(async ({ where }: any) => ({ id: where.id, tenantId: where.tenantId, role: "MEMBER" }));
  m.userUnique.mockResolvedValue({ email: "member@example.test" });
  m.suites.mockResolvedValue([{ id: "s1", slug: "pub", name: "Pub", description: "d", maxScorePerTask: 10 }]);
  m.runs.mockResolvedValue([]);
  m.suite.mockImplementation(async ({ where }: any) =>
    where.slug === "pub" ? { id: "s1", slug: "pub", isPublic: true } : null);
});

describe("mount order: compare router does not shadow the public bench router", () => {
  it("GET /bench stays public (no auth)", async () => {
    const res = await fetch(base + "/");
    expect(res.status).toBe(200);
    expect((await res.json())[0]).toMatchObject({ slug: "pub", leaderboard: [] });
  });
  it("GET /bench/:slug stays public", async () => {
    const res = await fetch(base + "/pub");
    expect(res.status).toBe(200);
    expect((await res.json()).suite.slug).toBe("pub");
  });
  it("POST /bench/run without identity keeps the existing 401", async () => {
    const res = await fetch(base + "/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(runBody) });
    expect(res.status).toBe(401);
    expect(m.run).not.toHaveBeenCalled();
  });
  it("POST /bench/run as non-admin keeps the existing 403", async () => {
    const res = await fetch(base + "/run", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok("MEMBER")}` },
      body: JSON.stringify(runBody),
    });
    expect(res.status).toBe(403);
    expect(m.run).not.toHaveBeenCalled();
  });
  it("GET /bench/compare falls through to the public router (suite not found -> 404)", async () => {
    const res = await fetch(base + "/compare");
    expect(res.status).toBe(404);
    expect(m.suite).toHaveBeenCalledWith({ where: { slug: "compare" } });
  });
  it("POST /bench/compare is served by the compare router (401 without token)", async () => {
    const res = await fetch(base + "/compare", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
    expect(m.suite).not.toHaveBeenCalled();
  });
});

// BRA-P1-05-N2: FAILED/SKIPPED rows (score 0) must never reach public reads.
describe("public reads exclude non-COMPLETED BenchRun rows", () => {
  const rows = [
    { id: "ok", provider: "OPENAI", model: "m-ok", scoreNormalised: 0.8, costUsd: 1, durationMs: 5, ranAt: new Date("2026-01-02"), status: "COMPLETED" },
    { id: "bad", provider: "OPENAI", model: "m-bad", scoreNormalised: 0, costUsd: 0, durationMs: 5, ranAt: new Date("2026-01-03"), status: "FAILED" },
    { id: "skip", provider: "GROQ", model: "m-skip", scoreNormalised: 0, costUsd: 0, durationMs: 1, ranAt: new Date("2026-01-04"), status: "SKIPPED" },
  ];
  beforeEach(() => {
    // Honour the `where.status` the router sends (fail-closed: no filter => all rows come back).
    m.runs.mockImplementation(async ({ where }: any) => rows.filter((r) => !where.status || r.status === where.status));
  });
  it("GET /bench leaderboard drops FAILED/SKIPPED and the query pins status COMPLETED", async () => {
    const body = await (await fetch(base + "/")).json();
    expect(body[0].leaderboard.map((r: any) => r.id)).toEqual(["ok"]);
    expect(m.runs).toHaveBeenCalledWith(expect.objectContaining({ where: { suiteId: "s1", status: "COMPLETED" } }));
  });
  it("GET /bench/:slug runs list drops FAILED/SKIPPED", async () => {
    const body = await (await fetch(base + "/pub")).json();
    expect(body.runs.map((r: any) => r.id)).toEqual(["ok"]);
    expect(m.runs).toHaveBeenCalledWith(expect.objectContaining({ where: { suiteId: "s1", status: "COMPLETED" } }));
  });
});
