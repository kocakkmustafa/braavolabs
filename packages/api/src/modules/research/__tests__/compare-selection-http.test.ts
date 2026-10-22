/** Real loopback HTTP, JWT auth, tenant context, router, service and selector resolution.
 * Only persistence, Redis storage and inference are mocked; no auth middleware bypass. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import jwt from "jsonwebtoken";
import { currentTenantContext } from "../../../lib/tenant-context";

// lib/encryption reads process.env.ENCRYPTION_KEY at call time (not the mocked env module);
// set the same synthetic key here so the suite does not depend on CI-provided variables.
vi.hoisted(() => { process.env.ENCRYPTION_KEY = "compare-http-synthetic-encryption-key-at-least-32"; });
const m = vi.hoisted(() => ({member: vi.fn(), company: vi.fn(), configs: vi.fn(), create: vi.fn(), update: vi.fn(), run: vi.fn(), incr: vi.fn(), expire: vi.fn()}));
vi.mock("../../../config/env", () => ({env: {
  JWT_SECRET: "compare-http-synthetic-jwt-secret-at-least-32",
  ENCRYPTION_KEY: "compare-http-synthetic-encryption-key-at-least-32",
  AUTH_COOKIE_MODE: false, OFFLINE_MODE: false, NODE_ENV: "test",
}}));
vi.mock("../../../lib/db", () => ({prisma: {
  user: {findFirst: m.member}, company: {findFirst: m.company}, userAIConfig: {findMany: m.configs},
  webResearchSession: {create: m.create, update: m.update},
}}));
vi.mock("../../../lib/redis", () => ({redis: {incr: m.incr, expire: m.expire}}));
vi.mock("../../../lib/logger", () => ({logger: {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}}));
vi.mock("../../agent/claude", () => ({runAgentLoop: m.run}));
vi.mock("../cascade.service", () => ({runTenantCascade: vi.fn()}));
// Auth, cookie helpers, rate limiter, provider-chain and error handler are real.
import { researchRouter } from "../research.router";
import { errorHandler } from "../../../middleware/error";
import { encryptForTenant } from "../../../lib/encryption";

const TENANT = "http-tenant-a";
const SECRET = "compare-http-synthetic-jwt-secret-at-least-32";
const selected = [{provider: "OPENAI", model: "gpt-4o"}];
const payload = {companyId: "company-a", query: "Question for exact tenant models", selections: selected};
let server: http.Server;
let baseUrl: string;
let token: string;
beforeAll(async () => {
  token = jwt.sign({userId: "user-a", tenantId: TENANT, role: "MEMBER"}, SECRET, {expiresIn: "1h"});
  const app = express();
  app.use(express.json());
  app.use("/api/v1/research", researchRouter);
  app.use(errorHandler);
  server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>(resolve => server?.listening ? server.close(() => resolve()) : resolve()));
beforeEach(() => {
  vi.clearAllMocks();
  m.member.mockImplementation(async ({where, select}) => {
    expect(currentTenantContext()).toEqual({kind: "tenant", tenantId: TENANT});
    expect(select).toEqual({id: true, tenantId: true, role: true});
    return where.id === "user-a" && where.tenantId === TENANT ? {id: "user-a", tenantId: TENANT, role: "MEMBER"} : null;
  });
  m.company.mockImplementation(async ({where}) => {
    expect(currentTenantContext()).toEqual({kind: "tenant", tenantId: TENANT});
    return where.id === "company-a" && where.tenantId === TENANT ? {id: "company-a", tenantId: TENANT} : null;
  });
  m.configs.mockImplementation(async ({where}) => {
    expect(currentTenantContext()).toEqual({kind: "tenant", tenantId: TENANT});
    return where.tenantId === TENANT ? [
      {provider: "DEEPSEEK", model: "deepseek-chat", isDefault: true},
      {provider: "GROQ", model: "llama-3.3-70b-versatile", isDefault: false},
      {provider: "OPENAI", model: "gpt-4o", isDefault: false},
      {provider: "CEREBRAS", model: "gpt-oss-120b", isDefault: false},
    ].map((row, i) => ({...row, tenantId: TENANT, id: `config-${i}`, fallbackOrder: i,
      createdAt: new Date(2026, 0, i + 1), baseUrl: null,
      encryptedApiKey: encryptForTenant("synthetic-provider-key-never-sent", TENANT)})) : [];
  });
  m.create.mockResolvedValue({id: "http-session"}); m.update.mockResolvedValue({});
  m.incr.mockResolvedValue(1); m.expire.mockResolvedValue(1);
  m.run.mockImplementation(async config => ({
    finalContent: "synthetic answer", totalCostUsd: 1, totalInputTokens: 1, totalOutputTokens: 1,
    provider: config.aiConfigOverride?.provider, model: config.aiConfigOverride?.model,
  }));
});
async function post(body: unknown, bearer: string | null = token, raw = false) {
  const res = await fetch(`${baseUrl}/api/v1/research/compare/selected`, {
    method: "POST", headers: {"Content-Type": "application/json", ...(bearer ? {Authorization: `Bearer ${bearer}`} : {})},
    body: raw ? String(body) : JSON.stringify(body),
  });
  return {status: res.status, body: await res.json()};
}
function expectNoSessionOrInference() { expect(m.create).not.toHaveBeenCalled(); expect(m.run).not.toHaveBeenCalled(); }

describe("selected compare over HTTP with real authentication", () => {
  it.each(["low", "medium", "high"])("preserves %s effort for the authenticated tenant's non-default exact model", async reasoningEffort => {
    const selections = [{provider: "CEREBRAS", model: "gpt-oss-120b", reasoningEffort}];
    expect((await post({...payload, selections})).status).toBe(201);
    await vi.waitFor(() => expect(m.update).toHaveBeenCalledWith(expect.objectContaining({data: expect.objectContaining({status: "COMPLETED"})})));
    expect(m.configs).toHaveBeenCalledWith({where: {tenantId: TENANT}});
    expect(m.run).toHaveBeenCalledOnce();
    expect(m.run.mock.calls[0][0]).toMatchObject({aiConfigOverride: {provider: "CEREBRAS", model: "gpt-oss-120b"}, reasoningEffort});
  });
  it.each([
    {selections: [{provider: "OPENAI", model: "gpt-4o", reasoningEffort: "high"}]},
    {selections: [{provider: "CEREBRAS", model: "gpt-oss-120b", reasoningEffort: "none"}]},
    {selections: [{provider: "CEREBRAS", model: "gpt-oss-120b", reasoningEffort: null}]},
    {reasoningEffort: "high"}, {reasoning_effort: "high"},
    {selections: [{provider: "CEREBRAS", model: "gpt-oss-120b", reasoningEffort: "low"}, {provider: "OPENAI", model: "gpt-4o", reasoningEffort: "high"}]},
  ])("rejects invalid, misplaced or mixed unsupported effort %j before any session/inference", async override => {
    expect((await post({...payload, ...override})).status).toBe(400); expectNoSessionOrInference();
  });
  it("rejects an authenticated tenant's proxy profile before creating a session", async () => {
    m.configs.mockResolvedValue([{provider: "CEREBRAS", model: "gpt-oss-120b", tenantId: TENANT, id: "proxy-config", isDefault: false,
      createdAt: new Date(), baseUrl: "https://proxy.example.invalid/v1", encryptedApiKey: encryptForTenant("synthetic-never-sent", TENANT)}]);
    expect((await post({...payload, selections: [{provider: "CEREBRAS", model: "gpt-oss-120b", reasoningEffort: "high"}]})).status).toBe(400);
    expectNoSessionOrInference();
  });
  it("registers the endpoint, verifies JWT membership and runs the exact non-default model", async () => {
    expect(await post({...payload, maxCandidates: 1})).toEqual({status: 201, body: {id: "http-session", status: "PENDING"}});
    expect(m.member).toHaveBeenCalledWith({where: {id: "user-a", tenantId: TENANT}, select: {id: true, tenantId: true, role: true}});
    expect(m.company).toHaveBeenCalledWith({where: {id: "company-a", tenantId: TENANT}});
    expect(m.configs).toHaveBeenCalledWith({where: {tenantId: TENANT}});
    expect(m.incr).toHaveBeenCalledWith(`rl:research:compare:${TENANT}`);
    expect(m.create.mock.calls[0][0].data.tenantId).toBe(TENANT);
    await vi.waitFor(() => expect(m.update).toHaveBeenCalledWith(expect.objectContaining({data: expect.objectContaining({status: "COMPLETED"})})));
    expect(m.run).toHaveBeenCalledOnce();
    expect(m.run.mock.calls[0][0].aiConfigOverride).toMatchObject({provider: "OPENAI", model: "gpt-4o"});
  });
  it.each([
    {label: "missing", selections: undefined}, {label: "empty", selections: []},
    {label: "unknown", selections: [{provider: "OPENAI", model: "missing"}]},
    {label: "over-limit", selections: Array(4).fill(selected[0])},
    {label: "duplicate", selections: Array(2).fill(selected[0])},
    {label: "injected key", selections: [{...selected[0], apiKey: "not-accepted"}]},
  ])("rejects $label selectors with HTTP 400 before session or inference", async ({selections}) => {
    expect((await post({...payload, selections})).status).toBe(400);
    expect(m.member).toHaveBeenCalledOnce(); expectNoSessionOrInference();
  });
  it("rejects malformed JSON through the real parser before authentication or model work", async () => {
    expect((await post('{"selections":', token, true)).status).toBe(400);
    expect(m.member).not.toHaveBeenCalled(); expect(m.configs).not.toHaveBeenCalled(); expectNoSessionOrInference();
  });
  it("rejects a foreign company under the authenticated tenant before provider lookup", async () => {
    expect((await post({...payload, companyId: "company-b"})).status).toBe(404);
    expect(m.company).toHaveBeenCalledWith({where: {id: "company-b", tenantId: TENANT}});
    expect(m.configs).not.toHaveBeenCalled(); expectNoSessionOrInference();
  });
  it("does not resolve a foreign model pair using a spoofed body tenant", async () => {
    expect((await post({...payload, tenantId: "http-tenant-b", selections: [{provider: "OPENAI", model: "foreign-model"}]})).status).toBe(400);
    expect(m.configs).not.toHaveBeenCalled(); expectNoSessionOrInference();
  });
  it.each(["missing", "wrong-signature", "refresh", "deleted-member"])("rejects %s credentials before business/model calls", async kind => {
    let bearer: string | null = null;
    if (kind === "wrong-signature") bearer = jwt.sign({userId: "user-a", tenantId: TENANT}, "different-synthetic-secret");
    if (kind === "refresh") bearer = jwt.sign({userId: "user-a", tenantId: TENANT, typ: "refresh"}, SECRET);
    if (kind === "deleted-member") {bearer = token; m.member.mockResolvedValue(null);}
    expect((await post(payload, bearer)).status).toBe(401);
    expect(m.company).not.toHaveBeenCalled(); expect(m.configs).not.toHaveBeenCalled(); expect(m.incr).not.toHaveBeenCalled(); expectNoSessionOrInference();
  });
});

async function options(query = "companyId=company-a", bearer: string | null = token) {
  const response = await fetch(`${baseUrl}/api/v1/research/compare/options?${query}`, {
    headers: bearer ? {Authorization: `Bearer ${bearer}`} : {},
  });
  const text = await response.text();
  return {status: response.status, cache: response.headers.get("cache-control"),
    body: response.headers.get("content-type")?.includes("application/json") ? JSON.parse(text) : text};
}

describe("authenticated secret-free compare options", () => {
  it("returns only ordered owned pairs and the exact supported effort profile", async () => {
    const result = await options();
    expect(result).toEqual({status: 200, cache: "private, no-store", body: {companyId: "company-a", maxCandidates: 3, selections: [
      {provider: "DEEPSEEK", model: "deepseek-chat", reasoningEfforts: []},
      {provider: "GROQ", model: "llama-3.3-70b-versatile", reasoningEfforts: []},
      {provider: "OPENAI", model: "gpt-4o", reasoningEfforts: []},
      {provider: "CEREBRAS", model: "gpt-oss-120b", reasoningEfforts: ["low", "medium", "high"]},
    ]}});
    expect(m.company).toHaveBeenCalledWith({where: {id: "company-a", tenantId: TENANT}});
    expect(m.configs).toHaveBeenCalledWith({where: {tenantId: TENANT}});
    expect(m.incr).not.toHaveBeenCalled(); expectNoSessionOrInference();
    // Full equality above excludes keys, lazy resolvers, masks, URLs and default config fields.
    expect(JSON.stringify(result.body)).not.toContain("synthetic");
  });
  it.each([
    {provider: "CEREBRAS", model: "gpt-oss-120b", baseUrl: "https://proxy.example.invalid/v1"},
    {provider: "CEREBRAS", model: "gpt-oss-120b-alias", baseUrl: null},
    {provider: "CEREBRAS", model: "glm-4.7", baseUrl: null},
    {provider: "OPENAI", model: "gpt-oss-120b", baseUrl: "https://api.cerebras.ai/v1"},
    {provider: "CUSTOM", model: "gpt-oss-120b", baseUrl: "https://api.cerebras.ai/v1"},
    {provider: "OLLAMA", model: "gpt-oss-120b", baseUrl: null},
  ])("does not infer effort support for %j", async row => {
    m.configs.mockResolvedValue([{...row, id: "unsupported", tenantId: TENANT, isDefault: true, fallbackOrder: 0,
      createdAt: new Date(), encryptedApiKey: "not-a-real-encrypted-key"}]);
    expect((await options()).body).toEqual({companyId: "company-a", maxCandidates: 3,
      selections: [{provider: row.provider, model: row.model, reasoningEfforts: []}]});
    // A deliberately invalid ciphertext proves discovery never resolves credentials.
    expectNoSessionOrInference();
  });
  it("accepts only the adapter's exact built-in endpoint normalization", async () => {
    m.configs.mockResolvedValue([{provider: "CEREBRAS", model: "gpt-oss-120b", id: "exact", tenantId: TENANT, isDefault: true,
      createdAt: new Date(), encryptedApiKey: "not-decrypted", baseUrl: " https://api.cerebras.ai/v1/// "}]);
    expect((await options()).body.selections).toEqual([{provider: "CEREBRAS", model: "gpt-oss-120b", reasoningEfforts: ["low", "medium", "high"]}]);
    expectNoSessionOrInference();
  });
  it("omits ambiguous pairs and cloud rows without key material, retaining keyless local links", async () => {
    const base = {tenantId: TENANT, isDefault: false, createdAt: new Date(), baseUrl: null};
    m.configs.mockResolvedValue([
      {...base, id: "a", provider: "CEREBRAS", model: "gpt-oss-120b", encryptedApiKey: "not-decrypted"},
      {...base, id: "b", provider: "CEREBRAS", model: "gpt-oss-120b", encryptedApiKey: "not-decrypted"},
      {...base, id: "c", provider: "OPENAI", model: "gpt-4o", encryptedApiKey: null},
      {...base, id: "d", provider: "OLLAMA", model: "local-exact", encryptedApiKey: null},
    ]);
    expect((await options()).body).toEqual({companyId: "company-a", maxCandidates: 3,
      selections: [{provider: "OLLAMA", model: "local-exact", reasoningEfforts: []}]});
    expectNoSessionOrInference();
  });
  it("revalidates stale options before session creation when a route changes", async () => {
    expect((await options()).body.selections.at(-1).reasoningEfforts).toEqual(["low", "medium", "high"]);
    m.configs.mockResolvedValue([{provider: "CEREBRAS", model: "gpt-oss-120b", tenantId: TENANT, id: "changed",
      isDefault: false, createdAt: new Date(), baseUrl: "https://proxy.example.invalid/v1", encryptedApiKey: "not-decrypted"}]);
    expect((await post({...payload, selections: [{provider: "CEREBRAS", model: "gpt-oss-120b", reasoningEffort: "high"}]})).status).toBe(400);
    expectNoSessionOrInference();
  });
  it("rejects foreign companies before reading provider links", async () => {
    expect((await options("companyId=company-b")).status).toBe(404);
    expect(m.company).toHaveBeenCalledWith({where: {id: "company-b", tenantId: TENANT}});
    expect(m.configs).not.toHaveBeenCalled(); expectNoSessionOrInference();
  });
  it.each(["", "companyId=", "companyId=company-a&tenantId=http-tenant-b", "companyId=company-a&companyId=company-b"])("rejects malformed or spoofed query %s before provider reads", async query => {
    expect((await options(query)).status).toBe(400);
    expect(m.company).not.toHaveBeenCalled(); expect(m.configs).not.toHaveBeenCalled(); expectNoSessionOrInference();
  });
  it.each(["missing", "refresh", "foreign", "deleted-member"])("rejects %s authentication before company or provider reads", async kind => {
    let bearer: string | null = null;
    if (kind === "refresh") bearer = jwt.sign({userId: "user-a", tenantId: TENANT, typ: "refresh"}, SECRET);
    if (kind === "foreign") bearer = jwt.sign({userId: "user-b", tenantId: "http-tenant-b", role: "MEMBER"}, SECRET);
    if (kind === "deleted-member") {bearer = token; m.member.mockResolvedValue(null);}
    // Foreign-token membership is rejected; the mock verifies the claimed tenant context.
    if (kind === "foreign") m.member.mockImplementation(async ({where}) => {
      expect(currentTenantContext()).toEqual({kind: "tenant", tenantId: "http-tenant-b"});
      expect(where).toEqual({id: "user-b", tenantId: "http-tenant-b"}); return null;
    });
    expect((await options("companyId=company-a", bearer)).status).toBe(401);
    expect(m.company).not.toHaveBeenCalled(); expect(m.configs).not.toHaveBeenCalled(); expectNoSessionOrInference();
  });
});

describe("compare options tenant and offline boundaries", () => {
  it("an authenticated second tenant sees only its own stored pairs", async () => {
    const tenant = "http-tenant-b";
    const bearer = jwt.sign({userId: "user-b", tenantId: tenant, role: "MEMBER"}, SECRET);
    m.member.mockImplementation(async ({where}) => {
      expect(currentTenantContext()).toEqual({kind: "tenant", tenantId: tenant});
      return where.id === "user-b" && where.tenantId === tenant ? {id: "user-b", tenantId: tenant, role: "MEMBER"} : null;
    });
    m.company.mockImplementation(async ({where}) => where.id === "company-b" && where.tenantId === tenant ? {id: "company-b", tenantId: tenant} : null);
    m.configs.mockImplementation(async ({where}) => {
      expect(where).toEqual({tenantId: tenant}); expect(currentTenantContext()).toEqual({kind: "tenant", tenantId: tenant});
      return [{id: "b-config", tenantId: tenant, provider: "OLLAMA", model: "b-only-model", isDefault: true, createdAt: new Date(), encryptedApiKey: null, baseUrl: null}];
    });
    expect((await options("companyId=company-b", bearer)).body).toEqual({companyId: "company-b", maxCandidates: 3,
      selections: [{provider: "OLLAMA", model: "b-only-model", reasoningEfforts: []}]});
    expectNoSessionOrInference();
  });
  it("offline discovery exposes no cloud pairs or effort levels", async () => {
    const { env } = await import("../../../config/env");
    const previous = env.OFFLINE_MODE;
    try {
      env.OFFLINE_MODE = true;
      expect((await options()).body).toEqual({companyId: "company-a", maxCandidates: 3, selections: []});
      expectNoSessionOrInference();
    } finally { env.OFFLINE_MODE = previous; }
  });
});
