/**
 * AI client behavior tests — mocked Prisma / crypto / fetch, no real network.
 *
 * Covers three E2 defects:
 *   D-002 — getTenantAIConfig: a CLOUD tenant whose stored key fails to
 *           decrypt must fall back to the system default (the old code
 *           returned the tenant provider with apiKey:"" → guaranteed 401).
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

const db = vi.hoisted(() => ({ findUnique: vi.fn() }));
vi.mock("../../lib/db", () => ({
  prisma: {
    userAIConfig: {
      findUnique: (...a: unknown[]) => db.findUnique(...a),
      upsert: vi.fn(),
    },
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
  db.findUnique.mockReset();
  crypto.decryptForTenant.mockReset();
  envMock.ANTHROPIC_API_KEY = "sk-ant-system-key";
});

afterEach(() => vi.unstubAllGlobals());

// ── D-002: decrypt-failure fallback ──

describe("getTenantAIConfig — decrypt failure fallback (D-002)", () => {
  it("cloud provider with an undecryptable key falls back to the system Anthropic default", async () => {
    db.findUnique.mockResolvedValue({
      tenantId: TENANT,
      provider: "GROQ",
      model: "llama-3.3-70b-versatile",
      encryptedApiKey: "v4:corrupted-blob",
      baseUrl: null,
    });
    crypto.decryptForTenant.mockImplementation(() => {
      throw new Error("Unsupported payload version");
    });

    const config = await getTenantAIConfig(TENANT);

    // The defect: the old code returned { provider:"GROQ", apiKey:"" },
    // which the provider rejects with 401. A broken cloud key must mean
    // "no usable tenant config" → system default.
    expect(config.provider).toBe("ANTHROPIC");
    expect(config.model).toBe(envMock.CLAUDE_MODEL);
    expect(config.apiKey).toBe("sk-ant-system-key");
    expect(config.apiKey).not.toBe("");
  });

  it("cloud provider with an undecryptable key and NO system key throws a meaningful error", async () => {
    envMock.ANTHROPIC_API_KEY = "";
    db.findUnique.mockResolvedValue({
      tenantId: TENANT,
      provider: "DEEPSEEK",
      model: "deepseek-chat",
      encryptedApiKey: "v4:corrupted-blob",
      baseUrl: null,
    });
    crypto.decryptForTenant.mockImplementation(() => {
      throw new Error("bad auth tag");
    });

    await expect(getTenantAIConfig(TENANT)).rejects.toThrow(/No AI provider configured/);
  });

  it("local provider with an undecryptable key keeps its own config (keyless is valid)", async () => {
    db.findUnique.mockResolvedValue({
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
    db.findUnique.mockResolvedValue({
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

  it("no tenant row → system Anthropic default", async () => {
    db.findUnique.mockResolvedValue(null);

    const config = await getTenantAIConfig(TENANT);

    expect(config.provider).toBe("ANTHROPIC");
    expect(config.apiKey).toBe("sk-ant-system-key");
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
