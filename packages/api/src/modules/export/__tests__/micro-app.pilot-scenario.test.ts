/**
 * BRA-P1-07-N2 — pilot scenario end to end through GET /export/:companyId/micro-app.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import http from "node:http";
import jwt from "jsonwebtoken";
import type { AddressInfo } from "node:net";
import { pilotScenarioSnapshot, buildPilotPackage, validatePilotPackage } from "../../template-pilot/pilot-scenario";

const SECRET = "test-secret-pilot-scenario-0123456789-abcdefgh";
const TENANT = "tenant-own-AAAA";
const OTHER_TENANT = "tenant-other-BBBB";
const COMPANY = "company-pilot-CCCC";
const USER = "user-pilot-DDDD";

const state = vi.hoisted(() => ({ company: null as any, agents: [] as any[], pipelines: [] as any[] }));

vi.mock("../../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../../config/env", () => ({
  env: { JWT_SECRET: "test-secret-pilot-scenario-0123456789-abcdefgh", AUTH_COOKIE_MODE: false, NODE_ENV: "test" },
}));
vi.mock("../../../lib/db", () => ({
  prisma: {
    user: {
      findFirst: async ({ where }: any) =>
        where.id === "user-pilot-DDDD" ? { id: where.id, tenantId: where.tenantId, role: "OWNER" } : null,
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
    activityLog: { create: async () => ({}) },
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

/** DB rows derived from the pilot snapshot, as the exporter would read them. */
beforeEach(() => {
  const snap = pilotScenarioSnapshot();
  state.company = {
    id: COMPANY,
    tenantId: TENANT,
    name: snap.name,
    description: snap.description,
    primitives: snap.primitives,
  };
  state.agents = snap.agents.map((a, i) => ({
    id: `agent-id-EEEE-${i}`,
    companyId: COMPANY,
    name: a.name,
    role: a.role,
    systemPrompt: a.systemPrompt,
    model: a.model,
    maxTokens: a.maxTokens,
    tools: a.tools,
  }));
  state.pipelines = snap.pipelines.map((p) => ({ ...p, id: "pipe-id-FFFF", companyId: COMPANY, description: p.description ?? null, schedule: p.schedule ?? null, managerAgentId: null }));
});

const token = (tenantId = TENANT) => jwt.sign({ userId: USER, tenantId, role: "OWNER" }, SECRET, { algorithm: "HS256" });
const get = async (qs = "", tenantId = TENANT) => {
  const res = await fetch(`${baseUrl}/api/v1/export/${COMPANY}/micro-app${qs}`, {
    headers: { authorization: `Bearer ${token(tenantId)}` },
  });
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) };
};

describe("pilot scenario through the export endpoint", () => {
  it("exported package validates and matches the scenario manifest (apart from the data ref)", async () => {
    const r = await get("?seed=20260101&count=12");
    expect(r.status).toBe(200);
    const pkg = validatePilotPackage(r.body);
    expect(pkg.manifest).toEqual({ ...buildPilotPackage().manifest, syntheticDataRef: null });
  });

  it("same seed gives byte-identical package, different seed gives different data", async () => {
    const a = await get("?seed=11&count=10");
    const b = await get("?seed=11&count=10");
    const c = await get("?seed=12&count=10");
    expect(a.text).toBe(b.text);
    expect(c.body.syntheticData).not.toEqual(a.body.syntheticData);
    expect(() => validatePilotPackage(c.body)).not.toThrow();
  });

  it("no ids, secrets or system-prompt text leak; another tenant gets a 404 body", async () => {
    const r = await get("?seed=3&count=50");
    const prompts = pilotScenarioSnapshot().agents.map((a) => a.systemPrompt);
    for (const trap of [TENANT, OTHER_TENANT, COMPANY, USER, "agent-id-EEEE", "pipe-id-FFFF", "systemPrompt", ...prompts]) {
      expect(r.text, trap).not.toContain(trap);
    }
    const other = await get("", OTHER_TENANT);
    expect(other.status).toBe(404);
    expect(other.body).toEqual({ error: "Company not found" });
    expect(other.text).not.toContain(COMPANY);
  });

  it("a tampered exported package is rejected by the intended rule", async () => {
    const r = await get("?seed=1&count=3");
    const bad = JSON.parse(r.text);
    bad.manifest.agents[0].toolNames.push("sk-live-abcdef1234567890");
    expect(() => validatePilotPackage(bad)).toThrow(/^\[manifest-secret\]/);
    const badScope = JSON.parse(r.text);
    badScope.manifest.connectorRequests[0].scopes.push("gmail.send");
    expect(() => validatePilotPackage(badScope)).toThrow(/^\[manifest-pin\]/);
    const badData = JSON.parse(r.text);
    badData.syntheticData[0].name = "Sahte x@y.z";
    expect(() => validatePilotPackage(badData)).toThrow(/^\[data-name\]/);
  });
});
