/**
 * AI client behavior tests — mocked Prisma / crypto / fetch, no real network.
 *
 * Covers three E2 defects:
 *   BR-P0-002-D — getTenantAIConfig must resolve only tenant-owned BYOK/local
 *           config. Missing/corrupt cloud config cannot reach a shared key.
 *           Local providers legitimately run keyless and keep their config.
 *   D-001 — Gemini: the API key must travel in the `x-goog-api-key` header,
 *           never in the URL query string (log / proxy leak).
 *   D-003 — OpenRouter: HTTP-Referer must be the real brand domain
 *           (braavolabs.com), consistent with X-Title.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Module mocks (must be declared before importing the SUT) ──

const envMock = vi.hoisted(() => ({
  ANTHROPIC_API_KEY: "sk-ant-system-key" as string | undefined,
  CLAUDE_MODEL: "claude-sonnet-4-20250514",
  OFFLINE_MODE: false,
}));
vi.mock("../../config/env", () => ({ env: envMock }));

// Multi-key BYOK (E2/T6): getTenantAIConfig resolves the tenant's DEFAULT
// row via findFirst (isDefault-first ordering) instead of the old
// findUnique-on-tenantId — the mock follows the new query shape.
const db = vi.hoisted(() => ({ findFirst: vi.fn() }));
vi.mock("../../lib/db", () => ({
  prisma: {
    userAIConfig: {
      findFirst: (...a: unknown[]) => db.findFirst(...a),
      updateMany: vi.fn(),
      upsert: vi.fn(),
    },
    $transaction: (ops: unknown[]) => Promise.all(ops as Promise<unknown>[]),
  },
}));

const crypto = vi.hoisted(() => ({ decryptForTenant: vi.fn() }));
vi.mock("../../lib/encryption", () => ({
  decryptForTenant: (...a: [string, string]) => crypto.decryptForTenant(...a),
  encryptForTenant: vi.fn(() => "encrypted"),
}));

// Skip real DNS resolution in the SSRF guard; the guard's contract has its
// own suite (ssrf.test.ts) — here we only care about the outgoing request.
vi.mock("../../lib/ssrf", () => ({
  assertSafeExternalUrl: async () => {},
  SsrfError: class SsrfError extends Error {},
}));

vi.mock("../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { getTenantAIConfig, chatCompletion } from "../ai-client";

const TENANT = "tenant-1";

function stubFetch(impl: (...a: any[]) => any) {
  const f = vi.fn(impl);
  vi.stubGlobal("fetch", f);
  return f;
}

beforeEach(() => {
  db.findFirst.mockReset();
  crypto.decryptForTenant.mockReset();
  envMock.ANTHROPIC_API_KEY = "sk-ant-system-key";
});

afterEach(() => vi.unstubAllGlobals());

// ── BR-P0-002-D: tenant-owned config only ──

describe("getTenantAIConfig — BYOK/local only", () => {
  it("rejects an undecryptable cloud key even when a shared Anthropic key exists", async () => {
    db.findFirst.mockResolvedValue({
      tenantId: TENANT,
      provider: "GROQ",
      model: "llama-3.3-70b-versatile",
      encryptedApiKey: "v4:corrupted-blob",
      baseUrl: null,
    });
    crypto.decryptForTenant.mockImplementation(() => {
      throw new Error("Unsupported payload version");
    });

    await expect(getTenantAIConfig(TENANT)).rejects.toThrow(/tenant-owned.*BYOK.*local/i);
  });

  it("cloud provider with an undecryptable key and NO system key throws the same actionable error", async () => {
    envMock.ANTHROPIC_API_KEY = "";
    db.findFirst.mockResolvedValue({
      tenantId: TENANT,
      provider: "DEEPSEEK",
      model: "deepseek-chat",
      encryptedApiKey: "v4:corrupted-blob",
      baseUrl: null,
    });
    crypto.decryptForTenant.mockImplementation(() => {
      throw new Error("bad auth tag");
    });

    await expect(getTenantAIConfig(TENANT)).rejects.toThrow(/tenant-owned.*BYOK.*local/i);
  });

  it("local provider with an undecryptable key keeps its own config (keyless is valid)", async () => {
    db.findFirst.mockResolvedValue({
      tenantId: TENANT,
      provider: "OLLAMA",
      model: "gemma3:4b",
      encryptedApiKey: "v4:corrupted-blob",
      baseUrl: "http://localhost:11434/v1",
    });
    crypto.decryptForTenant.mockImplementation(() => {
      throw new Error("bad auth tag");
    });

    const config = await getTenantAIConfig(TENANT);

    expect(config.provider).toBe("OLLAMA");
    expect(config.model).toBe("gemma3:4b");
    expect(config.apiKey).toBe("");
    expect(config.baseUrl).toBe("http://localhost:11434/v1");
  });

  it("cloud provider with a valid key returns the decrypted tenant config", async () => {
    db.findFirst.mockResolvedValue({
      tenantId: TENANT,
      provider: "GROQ",
      model: "llama-3.3-70b-versatile",
      encryptedApiKey: "v4:good-blob",
      baseUrl: null,
    });
    crypto.decryptForTenant.mockReturnValue("gsk_plaintext");

    const config = await getTenantAIConfig(TENANT);

    expect(config.provider).toBe("GROQ");
    expect(config.apiKey).toBe("gsk_plaintext");
    expect(config.baseUrl).toBeUndefined();
  });

  it("a tenant-provided Anthropic key remains a valid BYOK config", async () => {
    db.findFirst.mockResolvedValue({
      tenantId: TENANT,
      provider: "ANTHROPIC",
      model: "claude-sonnet-4-20250514",
      encryptedApiKey: "v4:tenant-anthropic",
      baseUrl: null,
      allowSystemFallback: false,
    });
    crypto.decryptForTenant.mockReturnValue("sk-ant-tenant-owned");

    await expect(getTenantAIConfig(TENANT)).resolves.toEqual({
      provider: "ANTHROPIC",
      model: "claude-sonnet-4-20250514",
      apiKey: "sk-ant-tenant-owned",
      baseUrl: undefined,
    });
  });

  it("no tenant row rejects instead of returning the shared Anthropic key", async () => {
    db.findFirst.mockResolvedValue(null);

    await expect(getTenantAIConfig(TENANT)).rejects.toThrow(/tenant-owned.*BYOK.*local/i);
  });

  it("an adversarial allowSystemFallback flag cannot revive a shared key", async () => {
    db.findFirst.mockResolvedValue({
      tenantId: TENANT,
      provider: "ANTHROPIC",
      model: "claude-sonnet-4-20250514",
      encryptedApiKey: "v4:corrupted-blob",
      baseUrl: null,
      allowSystemFallback: true,
    });
    crypto.decryptForTenant.mockImplementation(() => {
      throw new Error("bad auth tag");
    });

    await expect(getTenantAIConfig(TENANT)).rejects.toThrow(/tenant-owned.*BYOK.*local/i);
  });

  it("rejects a keyless CUSTOM row without its tenant-owned base URL", async () => {
    db.findFirst.mockResolvedValue({
      tenantId: TENANT,
      provider: "CUSTOM",
      model: "tenant-model",
      encryptedApiKey: null,
      baseUrl: null,
      allowSystemFallback: true,
    });

    await expect(getTenantAIConfig(TENANT)).rejects.toThrow(/CUSTOM.*base URL/i);
  });
});

// ── D-001: Gemini key placement ──

describe("callGoogle request shape (D-001)", () => {
  it("sends the API key in the x-goog-api-key header, never in the URL", async () => {
    const f = stubFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: "hi" }] } }],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 5 },
      }),
    }));

    const result = await chatCompletion(
      { provider: "GOOGLE", model: "gemini-1.5-pro", apiKey: "SECRET-GEMINI-KEY" },
      "system prompt",
      [{ role: "user", content: "hello" }],
    );

    expect(f).toHaveBeenCalledOnce();
    const [url, init] = f.mock.calls[0];
    expect(String(url)).toContain("generativelanguage.googleapis.com");
    expect(String(url)).toContain("gemini-1.5-pro:generateContent");
    // The leak: key must not appear anywhere in the URL.
    expect(String(url)).not.toContain("key=");
    expect(String(url)).not.toContain("SECRET-GEMINI-KEY");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("SECRET-GEMINI-KEY");
    // Response still parses fine.
    expect(result.content).toBe("hi");
    expect(result.inputTokens).toBe(3);
    expect(result.outputTokens).toBe(5);
  });
});

// ── D-003: OpenRouter attribution headers ──

describe("OpenRouter attribution headers (D-003)", () => {
  it("sends HTTP-Referer=https://braavolabs.com and X-Title=Braavolabs", async () => {
    const f = stubFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 1, completion_tokens: 2 },
      }),
    }));

    await chatCompletion(
      { provider: "OPENROUTER", model: "openai/gpt-4o", apiKey: "or-key" },
      "system prompt",
      [{ role: "user", content: "hello" }],
    );

    expect(f).toHaveBeenCalledOnce();
    const [url, init] = f.mock.calls[0];
    expect(String(url)).toBe("https://openrouter.ai/api/v1/chat/completions");
    const headers = init.headers as Record<string, string>;
    expect(headers["HTTP-Referer"]).toBe("https://braavolabs.com");
    expect(headers["X-Title"]).toBe("Braavolabs");
    expect(headers["Authorization"]).toBe("Bearer or-key");
  });
});
