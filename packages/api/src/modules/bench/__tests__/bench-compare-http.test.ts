/** Real loopback HTTP + real JWT auth/RBAC/rate limit; persistence, Redis and logger mocked. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import jwt from "jsonwebtoken";

const SECRET = "bench-compare-synthetic-jwt-secret-at-least-32";
const m = vi.hoisted(() => ({ user: vi.fn(), incr: vi.fn(), expire: vi.fn(), run: vi.fn() }));
vi.mock("../../../config/env", () => ({ env: { JWT_SECRET: "bench-compare-synthetic-jwt-secret-at-least-32", AUTH_COOKIE_MODE: false, OFFLINE_MODE: false, NODE_ENV: "test" } }));
vi.mock("../../../lib/db", () => ({ prisma: { user: { findFirst: m.user } } }));
vi.mock("../../../lib/redis", () => ({ redis: { incr: m.incr, expire: m.expire } }));
vi.mock("../../../lib/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../bench.service", () => ({ runBenchSuite: m.run }));
vi.mock("../../../services/multi-model", () => ({ MAX_CANDIDATES: 3 }));

import { benchCompareRouter } from "../bench-compare.router";
import { errorHandler } from "../../../middleware/error";
import { BENCH_COMPARE_SUITE_SLUGS, runBenchCompare } from "../bench-compare";

const SUITE = BENCH_COMPARE_SUITE_SLUGS[0];
const sel = (...models: string[]) => models.map((model) => ({ provider: "OPENAI", model }));
let server: http.Server;
let base: string;
const tok = (role: string, tenantId = "t-a") => jwt.sign({ userId: "u-" + role, tenantId, role }, SECRET, { expiresIn: "1h" });

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/bench/compare", benchCompareRouter);
  app.use(errorHandler);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => (server?.listening ? server.close(() => r()) : r())));
beforeEach(() => {
  vi.clearAllMocks();
  m.incr.mockResolvedValue(1);
  m.expire.mockResolvedValue(1);
  m.user.mockImplementation(async ({ where }: any) => {
    const role = String(where.id).replace("u-", "").toUpperCase();
    return { id: where.id, tenantId: where.tenantId, role };
  });
});
async function post(body: unknown, bearer: string | null = tok("ADMIN")) {
  const res = await fetch(`${base}/api/v1/bench/compare`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.clone().text(), body: await res.json() };
}

describe("POST /bench/compare authorisation", () => {
  it("401 without token", async () => {
    expect((await post({ suite: SUITE, selections: sel("a-1", "b-1") }, null)).status).toBe(401);
  });
  it("403 for MEMBER, no run", async () => {
    const r = await post({ suite: SUITE, selections: sel("a-1", "b-1") }, tok("MEMBER"));
    expect(r.status).toBe(403);
    expect(m.run).not.toHaveBeenCalled();
  });
  it.each(["ADMIN", "OWNER"])("200 for %s with metrics summary", async (role) => {
    const r = await post({ suite: SUITE, selections: sel("a-1", "b-1", "c-1") }, tok(role));
    expect(r.status).toBe(200);
    expect(r.body.candidates).toHaveLength(3);
    expect(r.body.metrics.totals).toMatchObject({ candidateCount: 3, succeeded: 3, failed: 0 });
    for (const c of r.body.candidates) {
      expect(c.scoreNormalised).toBeGreaterThanOrEqual(0);
      expect(c.scoreNormalised).toBeLessThanOrEqual(1);
      expect(c.durationMs).toBeGreaterThan(0);
      expect(c.costUsd).toBeGreaterThan(0);
    }
    expect(m.run).not.toHaveBeenCalled(); // real runBenchSuite never used
  });
  it("rate limit key uses tenant; 429 beyond cap", async () => {
    await post({ suite: SUITE, selections: sel("a-1", "b-1") });
    expect(m.incr).toHaveBeenCalledWith("rl:bench:compare:t-a");
    m.incr.mockResolvedValue(21);
    expect((await post({ suite: SUITE, selections: sel("a-1", "b-1") })).status).toBe(429);
  });
});

describe("validation", () => {
  it.each([
    ["one model", { suite: SUITE, selections: sel("a-1") }],
    ["four models", { suite: SUITE, selections: sel("a", "b", "c", "d") }],
    ["duplicate", { suite: SUITE, selections: sel("a-1", "a-1") }],
    ["unknown suite", { suite: "nope", selections: sel("a-1", "b-1") }],
    ["url model", { suite: SUITE, selections: sel("a-1", "https://evil.example/v1") }],
    ["path model", { suite: SUITE, selections: sel("a-1", "../../etc/passwd") }],
    ["key-like model", { suite: SUITE, selections: sel("a-1", "sk-abcdefghijklmnop") }],
    ["unknown provider", { suite: SUITE, selections: [{ provider: "EVIL", model: "a" }, { provider: "OPENAI", model: "b" }] }],
    ["extra key baseUrl", { suite: SUITE, selections: [{ provider: "OPENAI", model: "a", baseUrl: "http://x" }, { provider: "OPENAI", model: "b" }] }],
    ["prompt field", { suite: SUITE, selections: sel("a", "b"), prompt: "hi" }],
  ])("400 for %s", async (_l, body) => {
    expect((await post(body)).status).toBe(400);
  });
});

describe("failure, budget, leakage, determinism", () => {
  it("error/skip/timeout rows are reported skipped, endpoint stays 200", async () => {
    const r = await post({ suite: SUITE, selections: sel("fake-error-x", "fake-skip-x", "ok-model") });
    expect(r.status).toBe(200);
    expect(r.body.candidates.map((c: any) => c.status)).toEqual(["error", "skipped", "ok"]);
    expect(r.body.metrics.totals).toMatchObject({ succeeded: 1, failed: 2 });
    expect(r.body.candidates[0]).toMatchObject({ scoreNormalised: null, durationMs: null, costUsd: null });
    expect(JSON.stringify(r.body.metrics.candidates)).not.toContain("fake provider error");
  });
  it("timeout candidate is cut and reported (service, short timeout)", async () => {
    const r = await runBenchCompare({
      suiteSlug: SUITE,
      candidates: sel("fake-timeout-x", "ok-model"),
      timeoutMs: 20,
    });
    expect(r.candidates.map((c) => c.status)).toEqual(["error", "ok"]);
    expect(r.metrics.totals).toMatchObject({ succeeded: 1, failed: 1 });
    expect(r.candidates[0].durationMs).toBeNull();
  });
  it("cost ceiling skips remaining candidates", async () => {
    const r = await post({ suite: SUITE, selections: sel("a-1", "b-1", "c-1"), maxCostUsd: 0.001 });
    expect(r.status).toBe(200);
    expect(r.body.candidates.map((c: any) => c.status)).toEqual(["ok", "budget_skipped", "budget_skipped"]);
    expect(r.body.budgetExceeded).toBe(true);
    expect(r.body.metrics.budget).toMatchObject({ maxCostUsd: 0.001, exceeded: true });
  });
  it("cap above max is rejected", async () => {
    expect((await post({ suite: SUITE, selections: sel("a", "b"), maxCostUsd: 50 })).status).toBe(400);
  });
  it("no prompt/rubric/key/baseUrl in the response", async () => {
    const r = await post({ suite: SUITE, selections: sel("a-1", "b-1") });
    expect(r.text).not.toMatch(/rubric|prompt|apiKey|baseUrl|https?:\/\//i);
  });
  it("is deterministic and tenant-independent (nothing persisted)", async () => {
    const a = await post({ suite: SUITE, selections: sel("a-1", "b-1") });
    const b = await post({ suite: SUITE, selections: sel("a-1", "b-1") }, tok("ADMIN", "t-b"));
    expect(b.body).toEqual(a.body);
    expect(m.user).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "u-ADMIN", tenantId: "t-b" } }));
  });
});
