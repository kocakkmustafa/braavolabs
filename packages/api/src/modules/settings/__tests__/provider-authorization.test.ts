import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Router } from "express";

const ai = vi.hoisted(() => ({
  saveTenantAIConfig: vi.fn(),
  getTenantAIConfig: vi.fn(),
  chatCompletion: vi.fn(),
}));

vi.mock("../../../services/ai-client", () => ({
  ...ai,
  PROVIDER_MODELS: {
    ANTHROPIC: ["claude-sonnet-4-20250514"],
    GROQ: ["llama-3.3-70b-versatile"],
  },
  PROVIDER_DEFAULT_MODELS: {
    ANTHROPIC: "claude-sonnet-4-20250514",
    GROQ: "llama-3.3-70b-versatile",
  },
  PROVIDER_INFO: {},
  PROVIDER_BASE_URLS: {},
}));

const db = vi.hoisted(() => ({
  findFirst: vi.fn(),
  findMany: vi.fn(),
  findUnique: vi.fn(),
  deleteMany: vi.fn(),
  updateMany: vi.fn(),
  update: vi.fn(),
  tenantFindUnique: vi.fn(),
  createActivity: vi.fn(),
  tenantTx: vi.fn(),
  entitlementFindMany: vi.fn(),
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
    tenant: {
      findUnique: (...args: unknown[]) => db.tenantFindUnique(...args),
    },
    entitlementEvent: { findMany: (...args: unknown[]) => db.entitlementFindMany(...args) },
    activityLog: {
      create: (...args: unknown[]) => db.createActivity(...args),
    },
  },
  tenantTx: (...args: unknown[]) => db.tenantTx(...args),
}));

vi.mock("../../../middleware/auth", () => ({
  authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireRole: (...roles: string[]) => (
    req: { auth?: { role?: string } },
    res: ReturnType<typeof mockResponse>,
    next: () => void,
  ) => {
    if (!req.auth) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    if (!req.auth.role || !roles.includes(req.auth.role)) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }
    next();
  },
}));

const decryptForTenant = vi.hoisted(() => vi.fn((..._args: unknown[]) => "tenant-key"));
vi.mock("../../../lib/encryption", () => ({
  decryptForTenant: (...args: unknown[]) => decryptForTenant(...args),
}));

vi.mock("../../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const providerModels = vi.hoisted(() => ({
  getProviderModels: vi.fn(),
  isKnownProvider: vi.fn((..._args: unknown[]) => true),
}));
vi.mock("../provider-models", () => ({
  getProviderModels: (...args: unknown[]) => providerModels.getProviderModels(...args),
  isKnownProvider: (...args: unknown[]) => providerModels.isKnownProvider(...args),
}));

import { settingsRouter } from "../router";

type RouteHandler = (
  req: Record<string, unknown>,
  res: ReturnType<typeof mockResponse>,
  next: (error?: unknown) => void,
) => unknown;

function getRouteStack(router: Router, method: string, path: string): RouteHandler[] {
  const layer = (router as any).stack.find(
    (candidate: any) =>
      candidate.route
      && candidate.route.path === path
      && candidate.route.methods[method.toLowerCase()],
  );
  if (!layer) throw new Error(`No route ${method} ${path}`);
  return layer.route.stack.map((entry: any) => entry.handle as RouteHandler);
}

function mockResponse() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
}

async function invokeRoute(
  method: string,
  path: string,
  options: {
    role?: string;
    includeAuth?: boolean;
    body?: unknown;
    countBodyAccess?: boolean;
    params?: Record<string, string>;
  } = {},
) {
  const res = mockResponse();
  let bodyAccesses = 0;
  const req: Record<string, unknown> = {
    auth: options.includeAuth === false
      ? undefined
      : {
          tenantId: "tenant-acl",
          userId: "user-acl",
          role: options.role,
        },
    params: options.params ?? {},
    query: {},
  };
  Object.defineProperty(req, "body", {
    configurable: true,
    enumerable: true,
    get() {
      bodyAccesses += 1;
      return options.body ?? {};
    },
  });

  let nextError: unknown;
  for (const handler of getRouteStack(settingsRouter, method, path)) {
    let advanced = false;
    let layerError: unknown;
    const next = (error?: unknown) => {
      advanced = true;
      layerError = error;
    };

    await handler(req, res, next);

    if (layerError !== undefined) {
      nextError = layerError;
      break;
    }
    if (!advanced) break;
  }

  return { res, nextError, bodyAccesses };
}

function expectNoMutationOrProviderWork() {
  expect(db.findFirst).not.toHaveBeenCalled();
  expect(db.findMany).not.toHaveBeenCalled();
  expect(db.findUnique).not.toHaveBeenCalled();
  expect(db.deleteMany).not.toHaveBeenCalled();
  expect(db.updateMany).not.toHaveBeenCalled();
  expect(db.update).not.toHaveBeenCalled();
  expect(db.tenantFindUnique).not.toHaveBeenCalled();
  expect(db.tenantTx).not.toHaveBeenCalled();
  expect(db.createActivity).not.toHaveBeenCalled();
  expect(ai.saveTenantAIConfig).not.toHaveBeenCalled();
  expect(ai.getTenantAIConfig).not.toHaveBeenCalled();
  expect(ai.chatCompletion).not.toHaveBeenCalled();
  expect(decryptForTenant).not.toHaveBeenCalled();
  expect(providerModels.getProviderModels).not.toHaveBeenCalled();
}

const mutationCases = [
  {
    method: "put",
    path: "/ai-config",
    body: {
      provider: "ANTHROPIC",
      model: "claude-sonnet-4-20250514",
      apiKey: "sk-ant-test-123456",
    },
  },
  { method: "post", path: "/ai-config/test", body: {} },
  { method: "delete", path: "/ai-config", body: {} },
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  db.findFirst.mockResolvedValue(null);
  db.findMany.mockResolvedValue([]);
  db.deleteMany.mockResolvedValue({ count: 1 });
  db.createActivity.mockResolvedValue({});
  db.entitlementFindMany.mockResolvedValue([]);
  ai.saveTenantAIConfig.mockResolvedValue(undefined);
  ai.getTenantAIConfig.mockResolvedValue({
    provider: "ANTHROPIC",
    model: "claude-sonnet-4-20250514",
    apiKey: "tenant-key",
  });
  ai.chatCompletion.mockResolvedValue({
    content: "OK",
    provider: "ANTHROPIC",
    model: "claude-sonnet-4-20250514",
  });
  providerModels.getProviderModels.mockResolvedValue({
    provider: "GROQ",
    models: ["llama-3.3-70b-versatile"],
    source: "static",
  });
});

describe("settings provider mutation authorization", () => {
  it("rejects a self-hosted save after paid ledger expiry before config or provider mutation", async () => {
    db.tenantFindUnique.mockResolvedValue({ plan: "INDIVIDUAL" });
    db.entitlementFindMany.mockResolvedValue([{
      id: "local-expired-grant", source: "google", streamId: "local-google-stream",
      sourceTimestamp: new Date("2026-08-01T00:00:00Z"), type: "purchase", planTier: "INDIVIDUAL",
      expiresAt: new Date(Date.now() - 1_000), autoRenew: true,
    }]);
    const { nextError } = await invokeRoute("put", "/ai-config", { role: "OWNER", body: { provider: "OLLAMA", model: "local-model" } });
    expect(nextError).toMatchObject({ statusCode: 402 });
    expect(ai.saveTenantAIConfig).not.toHaveBeenCalled();
    expect(db.createActivity).not.toHaveBeenCalled();
    expect(db.entitlementFindMany).toHaveBeenCalledWith({ where: { tenantId: "tenant-acl" } });
  });

  it.each(["INDIVIDUAL", "TEAM", "CREATOR", "PRO"])("preserves the normalized empty-ledger %s local provider baseline", async (plan) => {
    db.tenantFindUnique.mockResolvedValue({ plan });
    const { nextError } = await invokeRoute("put", "/ai-config", { role: "OWNER", body: { provider: "OLLAMA", model: "local-model" } });
    expect(nextError).toBeUndefined();
    expect(ai.saveTenantAIConfig).toHaveBeenCalledOnce();
  });

  for (const route of mutationCases) {
    it.each(["MEMBER", "member", "SUPERADMIN", undefined])(
      `${route.method.toUpperCase()} ${route.path} rejects role %s before application work`,
      async (role) => {
        const { res, nextError, bodyAccesses } = await invokeRoute(route.method, route.path, {
          role,
          body: route.body,
          countBodyAccess: true,
        });

        expect(nextError).toBeUndefined();
        expect(res.statusCode).toBe(403);
        expect(res.body).toEqual({ error: "Insufficient permissions" });
        expect(bodyAccesses).toBe(0);
        expectNoMutationOrProviderWork();
      },
    );
  }

  it.each(mutationCases)(
    "$method $path returns 401 without an authenticated principal",
    async (route) => {
      const { res, nextError, bodyAccesses } = await invokeRoute(route.method, route.path, {
        includeAuth: false,
        body: route.body,
      });

      expect(nextError).toBeUndefined();
      expect(res.statusCode).toBe(401);
      expect(res.body).toEqual({ error: "Not authenticated" });
      expect(bodyAccesses).toBe(0);
      expectNoMutationOrProviderWork();
    },
  );

  it.each(["OWNER", "ADMIN"])("allows %s to update provider configuration", async (role) => {
    const { res, nextError } = await invokeRoute("put", "/ai-config", {
      role,
      body: {
        provider: "ANTHROPIC",
        model: "claude-sonnet-4-20250514",
        apiKey: "sk-ant-test-123456",
      },
    });

    expect(nextError).toBeUndefined();
    expect(res.statusCode).toBe(200);
    expect(ai.saveTenantAIConfig).toHaveBeenCalledOnce();
    expect(db.createActivity).toHaveBeenCalledOnce();
  });

  it.each(["OWNER", "ADMIN"])("allows %s to test provider configuration", async (role) => {
    const { res, nextError } = await invokeRoute("post", "/ai-config/test", { role });

    expect(nextError).toBeUndefined();
    expect(res.statusCode).toBe(200);
    expect(ai.getTenantAIConfig).toHaveBeenCalledOnce();
    expect(ai.chatCompletion).toHaveBeenCalledOnce();
  });

  it.each(["OWNER", "ADMIN"])("allows %s to delete provider configuration", async (role) => {
    const { res, nextError } = await invokeRoute("delete", "/ai-config", { role });

    expect(nextError).toBeUndefined();
    expect(res.statusCode).toBe(200);
    expect(db.deleteMany).toHaveBeenCalledWith({ where: { tenantId: "tenant-acl" } });
    expect(db.createActivity).toHaveBeenCalledOnce();
  });
});

describe("settings provider read compatibility", () => {
  it("keeps GET /ai-config available to MEMBER", async () => {
    const { res, nextError } = await invokeRoute("get", "/ai-config", { role: "MEMBER" });

    expect(nextError).toBeUndefined();
    expect(res.statusCode).toBe(200);
    expect(db.findFirst).toHaveBeenCalledWith({
      where: { tenantId: "tenant-acl" },
      orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    });
  });

  it("keeps GET /ai-config/providers available to MEMBER", async () => {
    const { res, nextError } = await invokeRoute("get", "/ai-config/providers", { role: "MEMBER" });

    expect(nextError).toBeUndefined();
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ providers: [] });
  });

  it("keeps GET model catalogue available to MEMBER", async () => {
    const { res, nextError } = await invokeRoute(
      "get",
      "/ai-providers/:provider/models",
      { role: "MEMBER", params: { provider: "groq" } },
    );

    expect(nextError).toBeUndefined();
    expect(res.statusCode).toBe(200);
    expect(providerModels.getProviderModels).toHaveBeenCalledWith("tenant-acl", "GROQ");
  });
});

describe("advertised Cerebras settings validation", () => {
  it("saves the exact advertised provider/model with a synthetic key without provider traffic", async () => {
    const { res, nextError } = await invokeRoute("put", "/ai-config", {role: "OWNER", body: {
      provider: "CEREBRAS", model: "gpt-oss-120b", apiKey: "synthetic-cerebras-key-never-sent",
    }});
    expect(nextError).toBeUndefined();
    expect(res.statusCode).toBe(200);
    expect(ai.saveTenantAIConfig).toHaveBeenCalledWith("tenant-acl", "CEREBRAS", "gpt-oss-120b", "synthetic-cerebras-key-never-sent", undefined, undefined);
    expect(ai.chatCompletion).not.toHaveBeenCalled(); expect(ai.getTenantAIConfig).not.toHaveBeenCalled();
    expect(providerModels.getProviderModels).not.toHaveBeenCalled(); expect(decryptForTenant).not.toHaveBeenCalled();
  });
  it("reuses only the authenticated tenant's existing Cerebras key without decryption", async () => {
    db.findUnique.mockResolvedValue({encryptedApiKey: "synthetic-encrypted-marker"});
    db.tenantTx.mockImplementation(async fn => fn({userAIConfig: {updateMany: db.updateMany, update: db.update}}));
    const { nextError } = await invokeRoute("put", "/ai-config", {role: "ADMIN", body: {provider: "CEREBRAS", model: "gpt-oss-120b"}});
    expect(nextError).toBeUndefined();
    expect(db.findUnique).toHaveBeenCalledWith({where: {tenantId_provider: {tenantId: "tenant-acl", provider: "CEREBRAS"}}});
    expect(db.update).toHaveBeenCalledWith({where: {tenantId_provider: {tenantId: "tenant-acl", provider: "CEREBRAS"}}, data: {model: "gpt-oss-120b", baseUrl: null, isDefault: true}});
    expect(ai.saveTenantAIConfig).not.toHaveBeenCalled(); expect(decryptForTenant).not.toHaveBeenCalled(); expect(ai.chatCompletion).not.toHaveBeenCalled();
  });
  it("still requires a Cerebras key on first save", async () => {
    db.findUnique.mockResolvedValue(null);
    const { nextError } = await invokeRoute("put", "/ai-config", {role: "OWNER", body: {provider: "CEREBRAS", model: "gpt-oss-120b"}});
    expect(nextError).toMatchObject({statusCode: 400});
    expect(db.tenantTx).not.toHaveBeenCalled(); expect(ai.saveTenantAIConfig).not.toHaveBeenCalled(); expect(ai.chatCompletion).not.toHaveBeenCalled();
  });
  it("keeps an unrecognized provider rejected before mutation", async () => {
    const { nextError } = await invokeRoute("put", "/ai-config", {role: "OWNER", body: {provider: "UNKNOWN", model: "gpt-oss-120b", apiKey: "synthetic-key"}});
    expect(nextError).toMatchObject({name: "ZodError"}); expectNoMutationOrProviderWork();
  });
  it("requires permission before parsing even the newly admitted provider", async () => {
    const { res, bodyAccesses } = await invokeRoute("put", "/ai-config", {role: "MEMBER", body: {provider: "CEREBRAS", model: "gpt-oss-120b", apiKey: "synthetic-key"}});
    expect(res.statusCode).toBe(403); expect(bodyAccesses).toBe(0); expectNoMutationOrProviderWork();
  });
});
