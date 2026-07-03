/**
 * E3/T5 — GET /settings/ai-config/providers (plan §2.6 — B5.2). The multi-BYOK
 * LIST endpoint E2 never wrote. Asserts the contract the HandoffPanel picker
 * relies on: ordered (default → fallbackOrder → createdAt), key-MASKED (last 4
 * plaintext chars only, never the ciphertext or plaintext key), keyless-local
 * rows carry keyMasked=null.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Router } from "express";

vi.mock("../../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const userAIConfigFindMany = vi.hoisted(() => vi.fn());
const userAIConfigFindFirst = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/db", () => ({
  prisma: {
    userAIConfig: {
      findMany: (...a: unknown[]) => userAIConfigFindMany(...a),
      findFirst: (...a: unknown[]) => userAIConfigFindFirst(...a),
    },
  },
}));

vi.mock("../../../middleware/auth", () => ({
  authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

// decryptForTenant → echo a fake plaintext so .slice(-4) is deterministic.
const decryptForTenantMock = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/encryption", () => ({
  decryptForTenant: (...a: unknown[]) => decryptForTenantMock(...a),
}));

import { settingsRouter } from "../router";

function getHandler(router: Router, method: string, path: string) {
  const layer = (router as any).stack.find(
    (l: any) => l.route && l.route.path === path && l.route.methods[method.toLowerCase()],
  );
  if (!layer) throw new Error(`No route ${method} ${path}`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle as (req: any, res: any, next: any) => Promise<void>;
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

async function invoke(handler: any, req: any) {
  const res = mockRes();
  let nextErr: any;
  await handler({ auth: { tenantId: "tenant-1", userId: "user-1" }, params: {}, query: {}, body: {}, ...req }, res, (e?: any) => { nextErr = e; });
  return { res, nextErr };
}

beforeEach(() => {
  vi.clearAllMocks();
  decryptForTenantMock.mockReturnValue("sk-secret-abcd");
});

describe("GET /settings/ai-config/providers", () => {
  const handler = getHandler(settingsRouter, "get", "/ai-config/providers");

  it("returns MASKED keys, ordered default → fallbackOrder → createdAt, keyless-local null", async () => {
    const t0 = new Date("2026-01-01T00:00:00Z");
    userAIConfigFindMany.mockResolvedValue([
      // fallback cloud (order 2)
      { provider: "GROQ", model: "llama-3.3-70b", isDefault: false, fallbackOrder: 2, baseUrl: null, encryptedApiKey: "enc-groq", createdAt: t0 },
      // default cloud
      { provider: "ANTHROPIC", model: "claude-sonnet-4-5", isDefault: true, fallbackOrder: null, baseUrl: null, encryptedApiKey: "enc-anthropic", createdAt: t0 },
      // keyless local (order 1)
      { provider: "OLLAMA", model: "gemma3:4b", isDefault: false, fallbackOrder: 1, baseUrl: "http://localhost:11434/v1", encryptedApiKey: null, createdAt: t0 },
    ]);

    const { res, nextErr } = await invoke(handler, {});
    expect(nextErr).toBeUndefined();

    const providers = res.body.providers;
    // Order: default (ANTHROPIC) → fallbackOrder 1 (OLLAMA) → fallbackOrder 2 (GROQ)
    expect(providers.map((p: any) => p.provider)).toEqual(["ANTHROPIC", "OLLAMA", "GROQ"]);

    // Cloud rows masked to last 4 chars, keyless-local null.
    expect(providers[0].keyMasked).toBe("••••abcd");
    expect(providers[1].keyMasked).toBeNull(); // OLLAMA keyless
    expect(providers[2].keyMasked).toBe("••••abcd");

    // The plaintext / ciphertext never leaks.
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain("sk-secret-abcd");
    expect(serialized).not.toContain("enc-anthropic");
    expect(serialized).not.toContain("enc-groq");
  });

  it("a decrypt failure masks to ••••???? instead of throwing", async () => {
    decryptForTenantMock.mockImplementation(() => { throw new Error("bad key"); });
    userAIConfigFindMany.mockResolvedValue([
      { provider: "OPENAI", model: "gpt-4o", isDefault: true, fallbackOrder: null, baseUrl: null, encryptedApiKey: "enc-x", createdAt: new Date() },
    ]);
    const { res, nextErr } = await invoke(handler, {});
    expect(nextErr).toBeUndefined();
    expect(res.body.providers[0].keyMasked).toBe("••••????");
  });

  it("empty when the tenant has no configured providers", async () => {
    userAIConfigFindMany.mockResolvedValue([]);
    const { res } = await invoke(handler, {});
    expect(res.body).toEqual({ providers: [] });
  });
});
