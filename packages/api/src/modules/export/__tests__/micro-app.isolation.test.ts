/**
 * BRA-P1-07-N1 — tenant/company isolation NEGATIVE tests for the micro-app
 * pilot export. The Prisma stub is where-aware (it filters like the DB would),
 * so a missing tenantId/companyId predicate makes data leak and a test fail.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import http from "node:http";
import jwt from "jsonwebtoken";
import type { AddressInfo } from "node:net";

const SECRET = "test-secret-micro-app-iso-0123456789-abcdefghij";
const T_A = "tenant-A-1111";
const T_B = "tenant-B-2222";
const CO_A1 = "company-A1-aaaa";
const CO_A2 = "company-A2-bbbb";
const CO_B1 = "company-B1-cccc";

const db = vi.hoisted(() => ({ companies: [] as any[], agents: [] as any[], pipelines: [] as any[], memory: [] as any[] }));
const calls = vi.hoisted(() => ({
  company: [] as any[], agent: [] as any[], pipeline: [] as any[], memory: [] as any[], user: [] as any[], log: [] as any[],
}));

vi.mock("../../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../../config/env", () => ({
  env: { JWT_SECRET: "test-secret-micro-app-iso-0123456789-abcdefghij", AUTH_COOKIE_MODE: false, NODE_ENV: "test" },
}));
vi.mock("../../../lib/db", () => ({
  prisma: {
    user: {
      findFirst: async (a: any) => {
        calls.user.push(a);
        return a.where.id === "user-A" && a.where.tenantId === "tenant-A-1111"
          ? { id: a.where.id, tenantId: a.where.tenantId, role: "OWNER" }
          : null;
      },
    },
    company: {
      findFirst: async (a: any) => {
        calls.company.push(a);
        return db.companies.find((c) => c.id === a.where.id && c.tenantId === a.where.tenantId) ?? null;
      },
    },
    agent: {
      findMany: async (a: any) => {
        calls.agent.push(a);
        return db.agents.filter((x) => x.companyId === a.where.companyId);
      },
    },
    pipeline: {
      findMany: async (a: any) => {
        calls.pipeline.push(a);
        return db.pipelines.filter((x) => x.companyId === a.where.companyId);
      },
    },
    memoryItem: {
      findMany: async (a: any) => {
        calls.memory.push(a);
        return db.memory.filter((x) => x.companyId === a.where.companyId && x.status === a.where.status);
      },
    },
    activityLog: { create: async (a: any) => void calls.log.push(a) },
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

const agent = (id: string, companyId: string, name: string, role: string, extra: any = {}) => ({
  id, companyId, name, role, systemPrompt: `prompt-${name}`, model: "claude-sonnet", maxTokens: 1000,
  tools: [{ name: "search" }], ...extra,
});

beforeEach(() => {
  for (const k of Object.keys(calls) as (keyof typeof calls)[]) calls[k].length = 0;
  db.companies = [
    { id: CO_A1, tenantId: T_A, name: "Alpha One", description: "own", primitives: ["content"] },
    { id: CO_A2, tenantId: T_A, name: "SIBLING-CO-NAME", description: "sibling", primitives: ["content"] },
    { id: CO_B1, tenantId: T_B, name: "OTHER-TENANT-CO-NAME", description: "foreign", primitives: ["content"] },
  ];
  db.agents = [
    agent("ag-a1", CO_A1, "OwnWriter", "own-writer-role"),
    agent("ag-a2", CO_A2, "SiblingAgentZZZ", "sibling-role-ZZZ"),
    agent("ag-b1", CO_B1, "ForeignAgentYYY", "foreign-role-YYY", {
      tools: [{ name: "x", apiKey: "sk-live-foreign0123456789" }],
    }),
  ];
  db.pipelines = [
    { id: "pl-a1", companyId: CO_A1, name: "OwnPipe", trigger: "MANUAL", pipelineType: "SEQUENTIAL", maxDelegationDepth: 1, steps: [], config: {} },
    { id: "pl-a2", companyId: CO_A2, name: "SiblingPipeZZZ", trigger: "MANUAL", pipelineType: "SEQUENTIAL", maxDelegationDepth: 1, steps: [], config: {} },
  ];
  db.memory = [
    { id: "m-a1", companyId: CO_A1, status: "APPROVED", type: "semantic", content: "own-memory", metadata: {} },
    { id: "m-a2", companyId: CO_A2, status: "APPROVED", type: "semantic", content: "SIBLING-MEMORY-ZZZ", metadata: {} },
  ];
});

const token = (tenantId = T_A, userId = "user-A") => jwt.sign({ userId, tenantId, role: "OWNER" }, SECRET, { algorithm: "HS256" });
const get = async (id: string, tok: string | null = token(), qs = "") => {
  const res = await fetch(`${baseUrl}/api/v1/export/${id}/micro-app${qs}`, { headers: tok ? { authorization: `Bearer ${tok}` } : {} });
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) };
};

describe("micro-app export isolation (negative)", () => {
  it("(1) other tenant's company -> 404, no foreign data, tenantId in every company/user where", async () => {
    const r = await get(CO_B1, token(T_A));
    expect(r.status).toBe(404);
    for (const t of ["OTHER-TENANT-CO-NAME", "ForeignAgentYYY", "foreign-role-YYY", "sk-live-foreign", T_B, CO_B1]) {
      expect(r.text, t).not.toContain(t);
    }
    expect(calls.company).toHaveLength(1);
    expect(calls.company[0].where).toEqual({ id: CO_B1, tenantId: T_A });
    expect(calls.user[0].where.tenantId).toBe(T_A);
    // never reaches child tables, never logs activity
    expect(calls.agent.length + calls.pipeline.length + calls.memory.length + calls.log.length).toBe(0);
  });

  it("(1) reverse direction: tenant B cannot read tenant A's company either", async () => {
    // user-A only exists in tenant A, so B's token is rejected at auth (401): still no leak
    const r = await get(CO_A1, token(T_B));
    expect([401, 404]).toContain(r.status);
    expect(r.text).not.toContain("OwnWriter");
  });

  it("(2) same-tenant sibling company data is absent from the package; queries are scoped to the company", async () => {
    const r = await get(CO_A1);
    expect(r.status).toBe(200);
    for (const t of ["SiblingAgentZZZ", "sibling-role-ZZZ", "SiblingPipeZZZ", "SIBLING-MEMORY-ZZZ", "SIBLING-CO-NAME", "ForeignAgentYYY"]) {
      expect(r.text, t).not.toContain(t);
    }
    expect(r.text).toContain("own-writer-role");
    expect(calls.agent[0].where.companyId).toBe(CO_A1);
    expect(calls.pipeline[0].where.companyId).toBe(CO_A1);
    expect(calls.memory[0].where.companyId).toBe(CO_A1);
  });

  it("(2) sibling company id requested explicitly returns only sibling's own data, none of A1's", async () => {
    const r = await get(CO_A2);
    expect(r.status).toBe(200);
    expect(r.text).toContain("sibling-role-ZZZ");
    expect(r.text).not.toContain("own-writer-role");
  });

  it("(3) unauthenticated/unauthorized: missing, malformed, wrong-secret, refresh and unknown-user tokens -> 401, no DB reads", async () => {
    const bad = [
      null,
      "garbage",
      jwt.sign({ userId: "user-A", tenantId: T_A }, "wrong-secret-wrong-secret-wrong-secret-xx", { algorithm: "HS256" }),
      jwt.sign({ userId: "user-A", tenantId: T_A, typ: "refresh" }, SECRET, { algorithm: "HS256" }),
      jwt.sign({ userId: "user-A" }, SECRET, { algorithm: "HS256" }),
      token(T_A, "ghost-user"),
    ];
    for (const tok of bad) {
      const r = await get(CO_A1, tok);
      expect(r.status).toBe(401);
      expect(r.text).not.toContain("OwnWriter");
    }
    expect(calls.company.length + calls.agent.length + calls.log.length).toBe(0);
  });

  it("(5) idempotent: repeated exports of the same company are byte-identical (handles are not random)", async () => {
    db.agents.push(agent("ag-a1b", CO_A1, "SecondWriter", "second-role"));
    const a = await get(CO_A1, token(), "?seed=3&count=20");
    const b = await get(CO_A1, token(), "?seed=3&count=20");
    expect(a.status).toBe(200);
    expect(a.text).toBe(b.text);
  });

  it("(6) redaction: tenant id, e-mail, api key, webhookSecret and encrypted credentials never appear", async () => {
    db.companies[0] = {
      ...db.companies[0],
      description: "mail owner@alpha.example token sk-live-abcdef1234567890",
      config: { webhookSecret: "whsec_TRAP123456", apiKey: "KEY-TRAP-98765", nested: { password: "PW-TRAP" } },
    };
    db.agents[0] = agent("ag-a1", CO_A1, "OwnWriter", "own-writer-role", {
      systemPrompt: "email ceo@alpha.example webhookSecret=whsec_TRAP123456",
      tools: [
        { name: "search", apiKey: "KEY-TRAP-98765", webhookSecret: "whsec_TRAP123456", encryptedCredentials: "ENC-TRAP" },
        { provider: "gmail", scopes: ["read"], secret: "SECRET-TRAP", token: "TOK-TRAP" },
      ],
    });
    const r = await get(CO_A1, token(), "?count=1000");
    expect(r.status).toBe(200);
    for (const t of [
      T_A, CO_A1, "user-A", "ag-a1", "tenantId", "owner@alpha", "ceo@alpha", "@alpha.example", "sk-live", "whsec_", "TRAP", "apiKey",
      "webhookSecret", "encryptedCredentials", "password", "PW-TRAP",
    ]) {
      expect(r.text, t).not.toContain(t);
    }
  });
});
