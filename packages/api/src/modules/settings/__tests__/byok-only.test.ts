import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Router } from "express";

const ai = vi.hoisted(() => ({
  getTenantAIConfig: vi.fn(),
  chatCompletion: vi.fn(),
  saveTenantAIConfig: vi.fn(),
}));

vi.mock("../../../services/ai-client", () => ({
  ...ai,
  PROVIDER_MODELS: { ANTHROPIC: ["claude-sonnet-4-20250514"], OLLAMA: ["gemma3:4b"] },
  PROVIDER_DEFAULT_MODELS: { ANTHROPIC: "claude-sonnet-4-20250514", OLLAMA: "gemma3:4b" },
  PROVIDER_INFO: {},
  PROVIDER_BASE_URLS: { OLLAMA: "http://localhost:11434/v1" },
}));

const db = vi.hoisted(() => ({
  findFirst: vi.fn(),
  findMany: vi.fn(),
  findUnique: vi.fn(),
  deleteMany: vi.fn(),
  updateMany: vi.fn(),
  update: vi.fn(),
  createActivity: vi.fn(),
}));

vi.mock("../../../lib/db", () => ({
  prisma: {
    userAIConfig: {
      findFirst: (...args: unknown[]) => db.findFirst(...args),
      findMany: (...args: unknown[]) => db.findMany(...args),
      findUnique: (...args: unknown[]) => db.findUnique(...args),
      deleteMany: (...args: unknown[]) => db.deleteMany(...args),
      updateMany: (...args: unknown[]) => db.updateMany(...args),
      update: (...args: unknown[]) => db.update(...args),
    },
    activityLog: { create: (...args: unknown[]) => db.createActivity(...args) },
  },
  tenantTx: async (fn: (tx: unknown) => Promise<unknown>) => fn({ userAIConfig: {} }),
}));

vi.mock("../../../middleware/auth", () => ({
  authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../../../middleware/require-permission", () => ({
  requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../../../lib/encryption", () => ({ decryptForTenant: vi.fn(() => "tenant-key") }));
vi.mock("../../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../provider-models", () => ({
  getProviderModels: vi.fn(),
  isKnownProvider: vi.fn(() => true),
}));

import { settingsRouter } from "../router";

const routerSource = readFileSync(fileURLToPath(new URL("../router.ts", import.meta.url)), "utf8");

function getHandler(router: Router, method: string, path: string) {
  const layer = (router as any).stack.find(
    (candidate: any) => candidate.route
      && candidate.route.path === path
      && candidate.route.methods[method.toLowerCase()],
  );
  if (!layer) throw new Error(`No route ${method} ${path}`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle as (req: any, res: any, next: any) => Promise<void>;
}

function mockResponse() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
  };
}

async function invoke(handler: ReturnType<typeof getHandler>) {
  const res = mockResponse();
  let nextError: unknown;
  await handler(
    { auth: { tenantId: "tenant-byok", userId: "user-byok" }, params: {}, query: {}, body: {} },
    res,
    (error?: unknown) => { nextError = error; },
  );
  return { res, nextError };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.deleteMany.mockResolvedValue({ count: 1 });
  db.createActivity.mockResolvedValue({});
});

describe("POST /settings/ai-config/test — tenant-owned provider only", () => {
  const handler = getHandler(settingsRouter, "post", "/ai-config/test");

  it("returns an actionable 4xx and never calls chatCompletion when no tenant config is usable", async () => {
    ai.getTenantAIConfig.mockRejectedValue(
      new Error("No usable tenant-owned AI provider configured. Add a BYOK key or local provider in Settings → AI Provider."),
    );

    const { res, nextError } = await invoke(handler);

    expect(nextError).toBeUndefined();
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      success: false,
      error: expect.stringMatching(/tenant-owned.*BYOK.*local/i),
    });
    expect(ai.chatCompletion).not.toHaveBeenCalled();
  });

  it("tests an explicit tenant Anthropic BYOK config without substituting a shared key", async () => {
    ai.getTenantAIConfig.mockResolvedValue({
      provider: "ANTHROPIC",
      model: "claude-sonnet-4-20250514",
      apiKey: "sk-ant-tenant-owned",
    });
    ai.chatCompletion.mockResolvedValue({ content: "OK", provider: "ANTHROPIC", model: "claude-sonnet-4-20250514" });

    const { res, nextError } = await invoke(handler);

    expect(nextError).toBeUndefined();
    expect(res.statusCode).toBe(200);
    expect(ai.chatCompletion).toHaveBeenCalledOnce();
    expect(ai.chatCompletion.mock.calls[0][0].apiKey).toBe("sk-ant-tenant-owned");
    expect(res.body).toMatchObject({ success: true, provider: "ANTHROPIC", response: "OK" });
  });
});

describe("DELETE /settings/ai-config — honest BYOK-only copy", () => {
  const handler = getHandler(settingsRouter, "delete", "/ai-config");

  it("states that provider execution is disabled until the tenant configures BYOK/local", async () => {
    const { res, nextError } = await invoke(handler);

    expect(nextError).toBeUndefined();
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      success: true,
      message: expect.stringMatching(/disabled.*BYOK.*local/i),
    });
  });

  it("contains no system-default or system-key fallback claim in route source", () => {
    expect(routerSource).not.toMatch(/system default|Anthropic system key/i);
    expect(routerSource).toMatch(/LOCAL_LLM_PLANS[\s\S]*"INDIVIDUAL", "TEAM"/);
    expect(routerSource).not.toMatch(/LOCAL_LLM_PLANS[\s\S]*"CREATOR", "PRO", "BUSINESS", "ENTERPRISE"/);
  });
});
