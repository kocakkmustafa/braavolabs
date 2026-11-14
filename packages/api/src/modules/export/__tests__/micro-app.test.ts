/**
 * BRA-P1-07c — GET /export/:companyId/micro-app (pilot package).
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import http from "node:http";
import jwt from "jsonwebtoken";
import type { AddressInfo } from "node:net";

const SECRET = "test-secret-micro-app-0123456789-abcdefghij";
const TENANT = "tenant-own-AAAA";
const OTHER_TENANT = "tenant-other-BBBB";
const COMPANY = "company-trap-CCCC";
const USER = "user-trap-DDDD";

const state = vi.hoisted(() => ({ company: null as any, agents: [] as any[], pipelines: [] as any[] }));
const activityCreate = vi.hoisted(() => vi.fn());

vi.mock("../../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../../config/env", () => ({
  env: { JWT_SECRET: "test-secret-micro-app-0123456789-abcdefghij", AUTH_COOKIE_MODE: false, NODE_ENV: "test" },
}));
vi.mock("../../../lib/db", () => ({
  prisma: {
    user: {
      findFirst: async ({ where }: any) =>
        where.id === "user-trap-DDDD" ? { id: where.id, tenantId: where.tenantId, role: "OWNER" } : null,
    },
    company: {
      findFirst: async ({ where }: any) =>
        state.company && state.company.id === where.id && state.company.tenantId === where.tenantId
          ? state.company
          : null,
    },
    agent: { findMany: async () => state.agents },
    pipeline: { findMany: async () => state.pipelines },
    memoryItem: { findMany: async () => [] },
    activityLog: { create: (...a: unknown[]) => activityCreate(...a) },
  },
  tenantTx: (fn: any) => fn({}),
}));

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const { exportRouter } = await import("../router");
  const { errorHandler } = await import("../../../middleware/error");
  const app = express();
  app.use("/api/v1/export", exportRouter);
  app.use(errorHandler);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

beforeEach(() => {
  activityCreate.mockReset();
  state.company = {
    id: COMPANY,
    tenantId: TENANT,
    name: "Acme Demo",
    description: "Contact boss@acme.example about sk-live-abcdef1234567890",
    primitives: ["content"],
  };
  state.agents = [
    {
      id: "agent-id-EEEE",
      companyId: COMPANY,
      name: "Writer",
      role: "writer",
      systemPrompt: "secret prompt with sk-live-abcdef1234567890",
      model: "claude-sonnet",
      maxTokens: 1000,
      tools: [
        { name: "search", apiKey: "sk-live-abcdef1234567890", encryptedCredentials: "ENC-TRAP-ZZZ" },
        { provider: "gmail", scopes: ["read"], encryptedCredentials: "ENC-TRAP-ZZZ" },
      ],
    },
  ];
  state.pipelines = [];
});

const token = (tenantId = TENANT, userId = USER) => jwt.sign({ userId, tenantId, role: "OWNER" }, SECRET, { algorithm: "HS256" });
const get = async (qs = "", tok: string | null = token(), id = COMPANY) => {
  const res = await fetch(`${baseUrl}/api/v1/export/${id}/micro-app${qs}`, {
    headers: tok ? { authorization: `Bearer ${tok}` } : {},
  });
  const text = await res.text();
  return { status: res.status, type: res.headers.get("content-type") ?? "", cache: res.headers.get("cache-control") ?? "", text, body: JSON.parse(text) };
};

describe("GET /export/:companyId/micro-app", () => {
  it("returns { manifest, syntheticData } as JSON with default count 25", async () => {
    const r = await get();
    expect(r.status).toBe(200);
    expect(r.type).toMatch(/application\/json/);
    expect(Object.keys(r.body).sort()).toEqual(["manifest", "syntheticData"]);
    expect(r.body.manifest.schemaVersion).toBe("1");
    expect(r.body.syntheticData).toHaveLength(25);
    expect(r.text.length).toBeLessThan(500_000);
    expect(r.cache).toBe("private, no-store");
  });

  it("leaks no ids, credentials or e-mail anywhere in the response", async () => {
    const { text } = await get("?seed=7&count=1000");
    for (const trap of [TENANT, OTHER_TENANT, COMPANY, USER, "agent-id-EEEE", "apiKey", "encryptedCredentials", "ENC-TRAP", "sk-live", "boss@acme", "@acme.example", "secret prompt", "systemPrompt"]) {
      expect(text, trap).not.toContain(trap);
    }
  });

  it("another tenant's company and a missing company are both 404 (same body)", async () => {
    const other = await get("", token(OTHER_TENANT));
    const missing = await get("", token(), "nope");
    expect(other.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(other.text).toBe(missing.text);
  });

  it("no token -> 401; bad token -> 401", async () => {
    expect((await get("", null)).status).toBe(401);
    expect((await get("", "garbage")).status).toBe(401);
  });

  it.each([
    "?seed=-1", "?seed=NaN", "?seed=1.5", "?seed=", "?seed=abc", "?seed=4294967296", "?seed=1&seed=2",
    "?seed=0x10", "?seed=1%202", "?seed=%201", "?seed=12345678901", "?seed[]=1",
    "?count=-1", "?count=NaN", "?count=1001", "?count=2.5", "?count=", "?count=1e2", "?count=1&count=2",
  ])("bad query %s -> 400", async (qs) => {
    expect((await get(qs)).status).toBe(400);
  });

  it("accepts boundaries: count=0, count=1000, seed=0, seed=4294967295", async () => {
    expect((await get("?count=0")).body.syntheticData).toEqual([]);
    expect((await get("?count=1000")).body.syntheticData).toHaveLength(1000);
    expect((await get("?seed=0&count=3")).status).toBe(200);
    expect((await get("?seed=4294967295&count=3")).status).toBe(200);
  });

  it("same seed+count -> identical body; different seed -> different data", async () => {
    const a = await get("?seed=5&count=10");
    const b = await get("?seed=5&count=10");
    const c = await get("?seed=6&count=10");
    expect(a.text).toBe(b.text);
    expect(c.body.syntheticData).not.toEqual(a.body.syntheticData);
    expect(c.body.manifest).toEqual(a.body.manifest);
  });

  it("seed is independent of the company id", async () => {
    const a = await get("?seed=9&count=5");
    state.company = { ...state.company, id: "other-company-id" };
    const b = await get("?seed=9&count=5", token(), "other-company-id");
    expect(b.body.syntheticData).toEqual(a.body.syntheticData);
  });

  it("writes an activity log entry", async () => {
    await get("?seed=7&count=2");
    expect(activityCreate).toHaveBeenCalledTimes(1);
    const arg = activityCreate.mock.calls[0][0];
    expect(arg.data.details).toEqual({ format: "micro-app", seed: 7, count: 2 });
  });

  it("does not write an activity log entry on 404 or 400", async () => {
    await get("", token(OTHER_TENANT));
    await get("", token(), "nope");
    await get("?seed=-1");
    expect(activityCreate).not.toHaveBeenCalled();
  });
});
