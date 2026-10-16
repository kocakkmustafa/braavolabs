/** Real loopback HTTP/auth/tenant context, provider-link discovery, selection and
 * cascade orchestration. Persistence, Redis storage and inference are synthetic. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import jwt from "jsonwebtoken";
import { currentTenantContext } from "../../../lib/tenant-context";

const m = vi.hoisted(() => ({member: vi.fn(), configs: vi.fn(), company: vi.fn(), session: vi.fn(),
  research: vi.fn(), compare: vi.fn(), run: vi.fn(), incr: vi.fn(), expire: vi.fn()}));
vi.mock("../../../config/env", () => ({env: {
  JWT_SECRET: "cascade-http-synthetic-jwt-secret-at-least-32",
  ENCRYPTION_KEY: "cascade-http-synthetic-encryption-key-at-least-32",
  AUTH_COOKIE_MODE: false, OFFLINE_MODE: false, NODE_ENV: "test",
}}));
vi.mock("../../../lib/db", () => ({prisma: {
  user: {findFirst: m.member}, userAIConfig: {findMany: m.configs},
  company: {findFirst: m.company}, webResearchSession: {findFirst: m.session},
}}));
vi.mock("../../../lib/redis", () => ({redis: {incr: m.incr, expire: m.expire}}));
vi.mock("../../../lib/logger", () => ({logger: {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}}));
vi.mock("../../agent/claude", () => ({runAgentLoop: m.run}));
vi.mock("../research.service", () => ({startResearch: m.research, startCompare: m.compare}));
import { researchRouter } from "../research.router";
import { runTenantSelectedCascade } from "../cascade.service";
import { AppError, errorHandler } from "../../../middleware/error";
import { encryptForTenant } from "../../../lib/encryption";
import { env } from "../../../config/env";

const TENANT = "cascade-tenant-a";
const SECRET = "cascade-http-synthetic-jwt-secret-at-least-32";
const ANSWER = "This synthetic complete answer is long enough for the existing confidence heuristic.";
const choice = {provider: "OPENAI", model: "gpt-4o"};
const payload = {prompt: "A synthetic question", selection: choice};
let server: http.Server;
let baseUrl: string;
let token: string;
function row(provider: string, model: string, i = 0, tenantId = TENANT, baseUrl: string | null = null) {
  return {id: `config-${i}`, tenantId, provider, model, isDefault: i === 0, fallbackOrder: i,
    createdAt: new Date(2026, 0, i + 1), baseUrl,
    encryptedApiKey: encryptForTenant("synthetic-key-never-sent", tenantId)};
}
function completion(provider: string, model: string, finalContent = ANSWER) {
  return {provider, model, finalContent, totalCostUsd: 0.0123, totalInputTokens: 1, totalOutputTokens: 1,
    turns: [{content: finalContent, toolCalls: [], inputTokens: 1, outputTokens: 1, costUsd: 0.0123, stopReason: "end_turn"}],
    totalToolCalls: 0};
}
beforeAll(async () => {
  token = jwt.sign({userId: "user-a", tenantId: TENANT, role: "MEMBER"}, SECRET, {expiresIn: "1h"});
  const app = express(); app.use(express.json());
  app.use("/api/v1/research", researchRouter); app.use(errorHandler);
  server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>(resolve => server?.listening ? server.close(() => resolve()) : resolve()));
beforeEach(() => {
  vi.clearAllMocks(); env.OFFLINE_MODE = false;
  m.member.mockImplementation(async ({where, select}) => {
    expect(currentTenantContext()).toEqual({kind: "tenant", tenantId: where.tenantId});
    expect(select).toEqual({id: true, tenantId: true, role: true});
    if (where.id === "user-a" && where.tenantId === TENANT) return {id: "user-a", tenantId: TENANT, role: "MEMBER"};
    if (where.id === "user-b" && where.tenantId === "cascade-tenant-b") return {id: "user-b", tenantId: where.tenantId, role: "MEMBER"};
    return null;
  });
  m.configs.mockImplementation(async ({where}) => {
    expect(currentTenantContext()).toEqual({kind: "tenant", tenantId: where.tenantId});
    expect(Object.keys(where)).toEqual(["tenantId"]);
    return where.tenantId === TENANT ? [row("DEEPSEEK", "deepseek-chat"), row("OPENAI", "gpt-4o", 1),
      row("CEREBRAS", "gpt-oss-120b", 2)] : [row("OLLAMA", "tenant-b-only", 0, where.tenantId)];
  });
  m.incr.mockResolvedValue(1); m.expire.mockResolvedValue(1);
  m.run.mockImplementation(async config => completion(config.aiConfigOverride.provider, config.aiConfigOverride.model));
  for (const unrelated of [m.company, m.session, m.research, m.compare]) {
    unrelated.mockImplementation(() => {throw new Error("Unrelated research/Compare work must not run");});
  }
});
async function request(path: string, body?: unknown, bearer: string | null = token, raw = false) {
  const res = await fetch(`${baseUrl}/api/v1/research${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {"Content-Type": "application/json", ...(bearer ? {Authorization: `Bearer ${bearer}`} : {})},
    ...(body === undefined ? {} : {body: raw ? String(body) : JSON.stringify(body)}),
  });
  const text = await res.text();
  return {status: res.status, cache: res.headers.get("cache-control"), limit: res.headers.get("x-ratelimit-limit"),
    body: res.headers.get("content-type")?.includes("application/json") ? JSON.parse(text) : text};
}
const post = (body: unknown = payload, bearer: string | null = token) => request("/cascade/selected", body, bearer);
const options = (bearer: string | null = token) => request("/cascade/options", undefined, bearer);
function noInference() {
  expect(m.run).not.toHaveBeenCalled(); expect(m.research).not.toHaveBeenCalled(); expect(m.compare).not.toHaveBeenCalled();
}

describe("exact-single-v1 discovery", () => {
  it("returns only ordered tenant-owned metadata without company lookup, rate debit or inference", async () => {
    const result = await options();
    expect(result.status).toBe(200); expect(result.cache).toBe("private, no-store");
    expect(result.body).toEqual({selectionContract: "exact-single-v1", selections: [
      {provider: "DEEPSEEK", model: "deepseek-chat", reasoningEfforts: []},
      {provider: "OPENAI", model: "gpt-4o", reasoningEfforts: []},
      {provider: "CEREBRAS", model: "gpt-oss-120b", reasoningEfforts: ["low", "medium", "high"]},
    ]});
    expect(m.configs).toHaveBeenCalledWith({where: {tenantId: TENANT}});
    expect(m.company).not.toHaveBeenCalled(); expect(m.session).not.toHaveBeenCalled();
    expect(m.incr).not.toHaveBeenCalled(); noInference();
  });
  it("never decrypts metadata and omits duplicate pairs and cloud rows without keys", async () => {
    m.configs.mockResolvedValue([
      {...row("OPENAI", "duplicate"), encryptedApiKey: "invalid-ciphertext-never-resolved"},
      {...row("OPENAI", "duplicate", 1), encryptedApiKey: "invalid-ciphertext-never-resolved"},
      {...row("GROQ", "missing-key", 2), encryptedApiKey: null},
      {...row("OLLAMA", "local-model", 3), encryptedApiKey: null},
      {...row("CUSTOM", "custom-model", 4), encryptedApiKey: "invalid-ciphertext-never-resolved"},
    ]);
    expect((await options()).body.selections).toEqual([
      {provider: "OLLAMA", model: "local-model", reasoningEfforts: []},
      {provider: "CUSTOM", model: "custom-model", reasoningEfforts: []},
    ]); noInference();
  });
  it.each(["empty", "offline"])("returns an empty list for %s tenant eligibility", async kind => {
    if (kind === "empty") m.configs.mockResolvedValue([]); else env.OFFLINE_MODE = true;
    expect((await options()).body).toEqual({selectionContract: "exact-single-v1", selections: []}); noInference();
  });
  it("keeps two authenticated tenants' options and execution separate", async () => {
    const bearer = jwt.sign({userId: "user-b", tenantId: "cascade-tenant-b", role: "MEMBER"}, SECRET);
    expect((await options(bearer)).body.selections).toEqual([{provider: "OLLAMA", model: "tenant-b-only", reasoningEfforts: []}]);
    expect((await post(payload, bearer)).status).toBe(400); noInference();
    expect((await post({prompt: payload.prompt, selection: {provider: "OLLAMA", model: "tenant-b-only"}}, bearer)).status).toBe(200);
    expect(m.configs).toHaveBeenLastCalledWith({where: {tenantId: "cascade-tenant-b"}});
  });
});

describe("selected cascade execution", () => {
  it("runs one non-default exact pair, preserves all result fields and omits unspecified effort", async () => {
    const result = await post();
    expect(result.status).toBe(200); expect(result.body).toEqual({
      answer: ANSWER, provider: "OPENAI", model: "gpt-4o", tier: "cheap", confidence: 0.9,
      escalated: false, totalCostUsd: 0.0123, stoppedReason: "confident",
      rationale: expect.any(String), attempts: [{provider: "OPENAI", model: "gpt-4o", tier: "cheap", confidence: 0.9, costUsd: 0.0123}],
      selection: choice,
    });
    expect(m.run).toHaveBeenCalledOnce(); const call = m.run.mock.calls[0][0];
    expect(call).toMatchObject({userMessage: payload.prompt, toolNames: [], maxTurns: 1, maxTokens: 1024, rejectToolCalls: true,
      aiConfigOverride: {provider: "OPENAI", model: "gpt-4o"}});
    expect(call).not.toHaveProperty("reasoningEffort"); expect(call).not.toHaveProperty("tenantId");
    expect(await call.aiConfigOverride.getApiKey()).toBe("synthetic-key-never-sent");
    expect(m.compare).not.toHaveBeenCalled(); expect(m.research).not.toHaveBeenCalled();
  });
  it("distinguishes two providers with the same model ID before the legacy model-ID map", async () => {
    m.configs.mockResolvedValue([row("OPENAI", "shared-model"), row("CUSTOM", "shared-model", 1)]);
    const selection = {provider: "CUSTOM", model: "shared-model"};
    const result = await post({...payload, selection});
    expect(result.status).toBe(200); expect(result.body.selection).toEqual(selection);
    expect(result.body.provider).toBe("CUSTOM"); expect(result.body.model).toBe("shared-model");
    expect(result.body.attempts).toHaveLength(1); expect(result.body.attempts[0].provider).toBe("CUSTOM");
    expect(m.run).toHaveBeenCalledOnce(); expect(m.run.mock.calls[0][0].aiConfigOverride.provider).toBe("CUSTOM");
  });
  it("does not escalate a low-confidence answer or turn a zero cap into a new pre-call guarantee", async () => {
    m.run.mockResolvedValue(completion("OPENAI", "gpt-4o", "Unsure."));
    const result = await post({...payload, confidenceThreshold: 1, secondOpinion: false, budgetUsdCap: 0});
    expect(result.status).toBe(200); expect(result.body).toMatchObject({escalated: false, totalCostUsd: 0.0123, stoppedReason: "frontier-reached"});
    expect(result.body.attempts).toHaveLength(1); expect(m.run).toHaveBeenCalledOnce();
  });
  it.each(["low", "medium", "high"])("forwards advertised %s effort unchanged", async reasoningEffort => {
    const selection = {provider: "CEREBRAS", model: "gpt-oss-120b", reasoningEffort};
    const result = await post({...payload, selection});
    expect(result.status).toBe(200); expect(result.body.selection).toEqual(selection);
    expect(m.run).toHaveBeenCalledOnce(); expect(m.run.mock.calls[0][0]).toMatchObject({reasoningEffort, aiConfigOverride: {provider: "CEREBRAS", model: "gpt-oss-120b"}});
  });
  it.each([
    {provider: "OPENAI", model: "gpt-4o", reasoningEffort: "high"},
    {provider: "CEREBRAS", model: "gpt-oss-120b", reasoningEffort: "high", proxy: true},
  ])("rejects unsupported positive effort profiles before inference: %j", async requested => {
    if (requested.proxy) m.configs.mockResolvedValue([row("CEREBRAS", "gpt-oss-120b", 0, TENANT, "https://proxy.example.invalid/v1")]);
    const {proxy: _proxy, ...selection} = requested;
    expect((await post({...payload, selection})).status).toBe(400); noInference();
  });
  it("re-resolves a discovered pair and rejects removal rather than using another configured model", async () => {
    expect((await options()).body.selections).toContainEqual({...choice, reasoningEfforts: []});
    m.configs.mockResolvedValue([row("DEEPSEEK", "deepseek-chat")]);
    expect((await post()).status).toBe(400); noInference();
  });
  it("revalidates effort support when a discovered endpoint changes", async () => {
    expect((await options()).body.selections.at(-1).reasoningEfforts).toEqual(["low", "medium", "high"]);
    m.configs.mockResolvedValue([row("CEREBRAS", "gpt-oss-120b", 0, TENANT, "https://proxy.example.invalid/v1")]);
    expect((await post({...payload, selection: {provider: "CEREBRAS", model: "gpt-oss-120b", reasoningEffort: "high"}})).status).toBe(400); noInference();
  });
  it("rejects an ambiguous exact pair before inference", async () => {
    m.configs.mockResolvedValue([row("OPENAI", "gpt-4o"), row("OPENAI", "gpt-4o", 1)]);
    expect((await post()).status).toBe(400); noInference();
  });
  it.each([
    {provider: "CUSTOM", model: "unknown"}, {provider: "openai", model: "gpt-4o"},
    {provider: "OPENAI", model: "GPT-4O"}, {provider: "OPENAI", model: " gpt-4o"},
    {provider: "OPENAI", model: "gpt-4o "}, {provider: "OPENAI", model: " "},
  ])("does not reinterpret an unavailable/non-canonical exact selection: %j", async selection => {
    expect((await post({...payload, selection})).status).toBe(400); noInference();
  });
  it.each(["provider", "model", "missing"])("fails closed on %s response identity mismatch", async kind => {
    const result = completion("OPENAI", "gpt-4o") as Partial<ReturnType<typeof completion>>;
    if (kind === "missing") {delete result.provider; delete result.model;}
    else result[kind as "provider" | "model"] = "different";
    m.run.mockResolvedValue(result);
    expect((await post()).status).toBe(502); expect(m.run).toHaveBeenCalledOnce();
  });
  it.each(["provider-429", "timeout", "network"])("propagates %s failure without another candidate or secret response text", async kind => {
    m.run.mockRejectedValue(kind === "provider-429" ? new AppError(429, "Provider rate limit") : new Error(`synthetic-private-diagnostic-${kind}`));
    const result = await post(); expect(result.status).toBe(kind === "provider-429" ? 429 : 500);
    expect(JSON.stringify(result.body)).not.toContain("synthetic-private-diagnostic"); expect(m.run).toHaveBeenCalledOnce();
    expect(m.compare).not.toHaveBeenCalled(); expect(m.research).not.toHaveBeenCalled();
  });
  it("also rejects a second opinion at the service boundary before tenant/provider work", async () => {
    await expect(runTenantSelectedCascade(TENANT, payload.prompt, choice, {secondOpinion: true})).rejects.toMatchObject({statusCode: 400});
    expect(m.configs).not.toHaveBeenCalled(); noInference();
  });
});

describe("HTTP validation and shared legacy boundaries", () => {
  it.each([
    {selection: undefined}, {selection: null}, {selection: []}, {selection: {}},
    {selection: {provider: "", model: "gpt-4o"}}, {selection: {provider: "OPENAI"}},
    {selection: {...choice, apiKey: "never-accepted"}}, {selection: {...choice, baseUrl: "https://example.invalid"}},
    {selection: {...choice, reasoningEffort: "none"}}, {selection: {...choice, reasoningEffort: null}},
    {secondOpinion: true}, {tenantId: "cascade-tenant-b"}, {reasoningEffort: "high"},
    {prompt: ""}, {prompt: "x".repeat(4001)}, {budgetUsdCap: 10.01}, {confidenceThreshold: -0.01},
  ])("rejects malformed/extra selected input before inference: %j", async override => {
    expect((await post({...payload, ...override})).status).toBe(400); noInference();
  });
  it.each(["missing", "wrong-signature", "refresh", "deleted-member"])("rejects %s auth for discovery and execution before provider/rate calls", async kind => {
    let bearer: string | null = null;
    if (kind === "wrong-signature") bearer = jwt.sign({userId: "user-a", tenantId: TENANT}, "wrong-synthetic-secret");
    if (kind === "refresh") bearer = jwt.sign({userId: "user-a", tenantId: TENANT, typ: "refresh"}, SECRET);
    if (kind === "deleted-member") {bearer = token; m.member.mockResolvedValue(null);}
    expect((await options(bearer)).status).toBe(401); expect((await post(payload, bearer)).status).toBe(401);
    expect(m.configs).not.toHaveBeenCalled(); expect(m.incr).not.toHaveBeenCalled(); noInference();
  });
  it("uses the real JSON parser and rejects malformed JSON before auth or inference", async () => {
    expect((await request("/cascade/selected", '{"selection":', token, true)).status).toBe(400);
    expect(m.member).not.toHaveBeenCalled(); noInference();
  });
  it("shares the existing 20/hour cascade bucket across legacy and selected requests", async () => {
    let count = 0; m.incr.mockImplementation(async () => ++count);
    for (let i = 0; i < 20; i++) {
      const result = await request(i % 2 ? "/cascade/selected" : "/cascade", payload);
      expect(result.status).toBe(200); expect(result.limit).toBe("20");
    }
    expect((await post()).status).toBe(429); expect(m.run).toHaveBeenCalledTimes(20);
    expect(new Set(m.incr.mock.calls.map(([key]) => key))).toEqual(new Set([`rl:research:cascade:${TENANT}`]));
    expect(m.expire).toHaveBeenCalledOnce(); expect(m.expire).toHaveBeenCalledWith(`rl:research:cascade:${TENANT}`, 3600);
  });
  it("retains automatic legacy routing, unknown-field stripping and the original result shape", async () => {
    m.configs.mockResolvedValue([row("ZHIPU", "glm-4.7-flash"), row("ANTHROPIC", "claude-sonnet", 1)]);
    const result = await request("/cascade", payload);
    expect(result.status).toBe(200); expect(result.body.provider).toBe("ZHIPU");
    expect(result.body.model).toBe("glm-4.7-flash"); expect(result.body).not.toHaveProperty("selection");
    expect(Object.keys(result.body).sort()).toEqual(["answer", "provider", "model", "tier", "confidence", "escalated", "totalCostUsd", "stoppedReason", "rationale", "attempts"].sort());
    expect(m.run).toHaveBeenCalledOnce(); expect(m.run.mock.calls[0][0]).not.toHaveProperty("reasoningEffort");
    expect(m.run.mock.calls[0][0]).not.toHaveProperty("rejectToolCalls");
  });
  it("retains legacy second-opinion escalation", async () => {
    m.configs.mockResolvedValue([row("ZHIPU", "glm-4.7-flash"), row("ANTHROPIC", "claude-sonnet", 1)]);
    const result = await request("/cascade", {prompt: payload.prompt, secondOpinion: true});
    expect(result.status).toBe(200); expect(result.body.escalated).toBe(true);
    expect(result.body.attempts).toHaveLength(2); expect(m.run).toHaveBeenCalledTimes(2);
  });
});
