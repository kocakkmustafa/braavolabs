/**
 * B1(1) — POST /onboarding/validate-key. Validates a tenant-supplied
 * provider API key WITHOUT persisting it: a 1-token chatCompletion() ping,
 * same transport every other AI surface uses, key taken straight from the
 * request body instead of storage.
 *
 * Covered:
 *   • cloud provider, valid key → { valid: true, provider }
 *   • cloud provider, provider rejects (401-style) → { valid: false, reason }
 *     (200, not an HTTP error — provider rejection is a *result*)
 *   • cloud provider, missing apiKey → 400
 *   • unknown provider id → 400
 *   • CUSTOM without baseUrl → 400
 *   • local provider (OLLAMA), no apiKey required → validates fine
 *   • the raw apiKey is NEVER echoed back in the failure `reason`, even
 *     when the upstream error message contains it verbatim (key-leak guard)
 *   • prisma / DB is never touched — nothing is persisted by this route
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Router } from "express";

vi.mock("../../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../../middleware/auth", () => ({
  authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../../../middleware/rateLimit", () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

// prisma must stay fully mocked — an assertion below proves this route
// never calls it (validate-key persists nothing).
const prismaMock = vi.hoisted(() => ({
  companyCount: vi.fn(),
  runCount: vi.fn(),
  draftCount: vi.fn(),
  tenantFindUnique: vi.fn(),
  companyCreate: vi.fn(),
  agentCreate: vi.fn(),
  pipelineCreate: vi.fn(),
  activityLogCreate: vi.fn(),
}));
vi.mock("../../../lib/db", () => ({
  prisma: {
    company: { count: (...a: unknown[]) => prismaMock.companyCount(...a), create: (...a: unknown[]) => prismaMock.companyCreate(...a) },
    run: { count: (...a: unknown[]) => prismaMock.runCount(...a) },
    draft: { count: (...a: unknown[]) => prismaMock.draftCount(...a) },
    tenant: { findUnique: (...a: unknown[]) => prismaMock.tenantFindUnique(...a) },
    agent: { create: (...a: unknown[]) => prismaMock.agentCreate(...a) },
    pipeline: { create: (...a: unknown[]) => prismaMock.pipelineCreate(...a) },
    activityLog: { create: (...a: unknown[]) => prismaMock.activityLogCreate(...a) },
  },
}));

const chatCompletionMock = vi.hoisted(() => vi.fn());
vi.mock("../../../services/ai-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../services/ai-client")>();
  return {
    ...actual,
    chatCompletion: (...a: unknown[]) => chatCompletionMock(...a),
  };
});

import { onboardingRouter } from "../router";

function getHandler(router: Router, method: string, path: string) {
  const layer = (router as any).stack.find(
    (l: any) => l.route && l.route.path === path && l.route.methods[method.toLowerCase()],
  );
  if (!layer) throw new Error(`No route ${method} ${path}`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle as (req: any, res: any, next: any) => Promise<void> | void;
}

function mockRes() {
  const res: any = {
    statusCode: 200,
    body: undefined,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
  };
  return res;
}

async function invoke(handler: (req: any, res: any, next: any) => Promise<void> | void, body: any) {
  const res = mockRes();
  let nextErr: any;
  const next = (err?: any) => { nextErr = err; };
  await handler(
    { auth: { tenantId: "tenant-1", userId: "user-1", role: "admin" }, params: {}, body, query: {} },
    res,
    next,
  );
  return { res, nextErr };
}

const handler = getHandler(onboardingRouter, "post", "/validate-key");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /onboarding/validate-key", () => {
  it("valid cloud key (ANTHROPIC) → { valid: true, provider } — never touches prisma", async () => {
    chatCompletionMock.mockResolvedValue({ content: "OK", inputTokens: 5, outputTokens: 1, model: "claude-sonnet-4-5-20250929", provider: "ANTHROPIC" });

    const { res, nextErr } = await invoke(handler, { provider: "ANTHROPIC", apiKey: "sk-ant-real-key-123456" });

    expect(nextErr).toBeUndefined();
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ valid: true, provider: "ANTHROPIC" });
    expect(prismaMock.companyCreate).not.toHaveBeenCalled();
    expect(prismaMock.tenantFindUnique).not.toHaveBeenCalled();
  });

  it("provider rejects the key (401-style) → 200 with { valid: false, reason } — not an HTTP error", async () => {
    chatCompletionMock.mockRejectedValue(new Error("ANTHROPIC API error 401: authentication_error - invalid x-api-key"));

    const { res, nextErr } = await invoke(handler, { provider: "ANTHROPIC", apiKey: "sk-ant-bad-key-987654" });

    expect(nextErr).toBeUndefined();
    expect(res.statusCode).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.provider).toBe("ANTHROPIC");
    expect(typeof res.body.reason).toBe("string");
  });

  it("the raw apiKey is NEVER echoed back in `reason`, even when the upstream error contains it verbatim", async () => {
    const leakyKey = "sk-ant-super-secret-leak-me-0001";
    chatCompletionMock.mockRejectedValue(
      new Error(`OPENAI API error 401: Incorrect API key provided: ${leakyKey}. You can find your API key at...`),
    );

    const { res } = await invoke(handler, { provider: "OPENAI", apiKey: leakyKey });

    expect(res.body.valid).toBe(false);
    expect(res.body.reason).not.toContain(leakyKey);
  });

  it("cloud provider without apiKey → 400, chatCompletion never called", async () => {
    const { nextErr } = await invoke(handler, { provider: "OPENAI" });
    expect(nextErr?.statusCode).toBe(400);
    expect(chatCompletionMock).not.toHaveBeenCalled();
  });

  it("unknown provider id → 400", async () => {
    const { nextErr } = await invoke(handler, { provider: "NOTAPROVIDER", apiKey: "whatever-key-value" });
    expect(nextErr?.statusCode).toBe(400);
    expect(chatCompletionMock).not.toHaveBeenCalled();
  });

  it("CUSTOM provider without baseUrl → 400", async () => {
    const { nextErr } = await invoke(handler, { provider: "CUSTOM", apiKey: "some-key-value" });
    expect(nextErr?.statusCode).toBe(400);
    expect(chatCompletionMock).not.toHaveBeenCalled();
  });

  it("local provider (OLLAMA) validates without an apiKey", async () => {
    chatCompletionMock.mockResolvedValue({ content: "OK", inputTokens: 1, outputTokens: 1, model: "gemma3:4b", provider: "OLLAMA" });

    const { res, nextErr } = await invoke(handler, { provider: "OLLAMA", baseUrl: "http://localhost:11434/v1" });

    expect(nextErr).toBeUndefined();
    expect(res.body).toEqual({ valid: true, provider: "OLLAMA" });
  });

  it("lowercase provider id is normalized before validation", async () => {
    chatCompletionMock.mockResolvedValue({ content: "OK", inputTokens: 1, outputTokens: 1, model: "gpt-4o", provider: "OPENAI" });

    const { res, nextErr } = await invoke(handler, { provider: "openai", apiKey: "sk-lowercase-provider-test" });

    expect(nextErr).toBeUndefined();
    expect(res.body).toEqual({ valid: true, provider: "OPENAI" });
  });
});
