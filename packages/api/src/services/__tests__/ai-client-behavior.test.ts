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

const anthropic = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class AnthropicMock {
    messages = { create: (...args: unknown[]) => anthropic.create(...args) };
  },
}));

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
const ssrf = vi.hoisted(() => ({
  assertSafeExternalUrl: vi.fn(),
  safeExternalFetch: vi.fn(),
}));
vi.mock("../../lib/ssrf", () => ({
  assertSafeExternalUrl: (...args: unknown[]) => ssrf.assertSafeExternalUrl(...args),
  safeExternalFetch: (...args: unknown[]) => ssrf.safeExternalFetch(...args),
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

function stubSafeExternalFetch(impl: (...a: any[]) => any) {
  const f = vi.fn(impl);
  ssrf.safeExternalFetch.mockImplementation(f);
  return f;
}

beforeEach(() => {
  db.findFirst.mockReset();
  crypto.decryptForTenant.mockReset();
  envMock.ANTHROPIC_API_KEY = "sk-ant-system-key";
  envMock.OFFLINE_MODE = false;
  ssrf.assertSafeExternalUrl.mockReset();
  ssrf.assertSafeExternalUrl.mockResolvedValue(undefined);
  ssrf.safeExternalFetch.mockReset();
  anthropic.create.mockReset();
});

afterEach(() => vi.unstubAllGlobals());

describe("local-provider endpoint errors", () => {
  it.each([
    {
      deployment: "hosted",
      offline: false,
      baseUrl: "https://models.example.com/v1",
      networkPolicy: { allowLoopback: false, allowPrivateNetworks: false, requireHttps: true },
    },
    {
      deployment: "offline self-hosted",
      offline: true,
      baseUrl: "http://localhost:11434/v1",
      networkPolicy: { allowLoopback: true, allowPrivateNetworks: true, requireLocalDestination: true },
    },
  ])(
    "describes reachability from the API server in $deployment mode",
    async ({ offline, baseUrl, networkPolicy }) => {
      envMock.OFFLINE_MODE = offline;
      stubSafeExternalFetch(async () => {
        throw new Error("ECONNREFUSED");
      });

      await expect(chatCompletion(
        { provider: "OLLAMA", model: "gemma3:4b", apiKey: "", baseUrl },
        "system",
        [{ role: "user", content: "hello" }],
      )).rejects.toThrow(
        "OLLAMA endpoint is unreachable from the Braavolabs API server. Verify the endpoint is running and reachable from that server.",
      );
      expect(ssrf.safeExternalFetch).toHaveBeenCalledWith(
        `${baseUrl}/chat/completions`,
        expect.objectContaining({ method: "POST" }),
        expect.objectContaining(networkPolicy),
      );
    },
  );
});

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

    const config = await getTenantAIConfig(TENANT);
    expect(crypto.decryptForTenant).not.toHaveBeenCalled();
    expect(() => config.getApiKey!()).toThrow(/credential/i);
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

    const config = await getTenantAIConfig(TENANT);
    expect(crypto.decryptForTenant).not.toHaveBeenCalled();
    expect(() => config.getApiKey!()).toThrow(/credential/i);
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
    expect(config.apiKey).not.toContain("corrupted-blob");
    expect(crypto.decryptForTenant).not.toHaveBeenCalled();
    expect(config.getApiKey!()).toBe("");
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
    expect(config.apiKey).not.toBe("gsk_plaintext");
    expect(config.getApiKey).toEqual(expect.any(Function));
    expect(crypto.decryptForTenant).not.toHaveBeenCalled();
    expect(config.getApiKey!()).toBe("gsk_plaintext");
    expect(config.getApiKey!()).toBe("gsk_plaintext");
    expect(crypto.decryptForTenant).toHaveBeenCalledOnce();
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

    const config = await getTenantAIConfig(TENANT);
    expect(config).toMatchObject({
      provider: "ANTHROPIC",
      model: "claude-sonnet-4-20250514",
      baseUrl: undefined,
    });
    expect(config.apiKey).not.toBe("sk-ant-tenant-owned");
    expect(crypto.decryptForTenant).not.toHaveBeenCalled();
    expect(config.getApiKey!()).toBe("sk-ant-tenant-owned");
    expect(crypto.decryptForTenant).toHaveBeenCalledOnce();
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

    const config = await getTenantAIConfig(TENANT);
    expect(crypto.decryptForTenant).not.toHaveBeenCalled();
    expect(() => config.getApiKey!()).toThrow(/credential/i);
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
    const f = stubSafeExternalFetch(async () => ({
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
    const [url, init, options] = f.mock.calls[0];
    expect(String(url)).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(init.headers).toBeUndefined();
    const prepared = await options.prepareRequest();
    const headers = prepared.headers as Record<string, string>;
    expect(headers["HTTP-Referer"]).toBe("https://braavolabs.com");
    expect(headers["X-Title"]).toBe("Braavolabs");
    expect(headers["Authorization"]).toBe("Bearer or-key");
    expect(options.requireHttps).toBe(true);
  });
});

describe("provider transport credential and error boundary", () => {
  it("sanitizes Anthropic SDK response details while retaining status", async () => {
    const canary = "RAW-ANTHROPIC-SECRET http://10.0.0.9";
    anthropic.create.mockRejectedValue(Object.assign(new Error(canary), { status: 401 }));

    let thrown: unknown;
    try {
      await chatCompletion(
        { provider: "ANTHROPIC", model: "claude-sonnet", apiKey: "sk-ant-test" },
        "system",
        [{ role: "user", content: "hello" }],
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).not.toContain(canary);
    expect(JSON.stringify(thrown)).not.toContain(canary);
    expect((thrown as Error & { status?: number }).status).toBe(401);
  });

  it("marks public HTTP as HTTPS-only without materializing credentials or headers", async () => {
    let credentialReads = 0;
    const f = stubSafeExternalFetch(async () => {
      throw new Error("HTTPS_REQUIRED");
    });

    await expect(chatCompletion(
      {
        provider: "CUSTOM",
        model: "tenant-model",
        apiKey: "[tenant-credential]",
        getApiKey: () => {
          credentialReads += 1;
          return "SECRET-PUBLIC-HTTP";
        },
        baseUrl: "http://public-provider.example/v1",
      },
      "system prompt",
      [{ role: "user", content: "sensitive prompt" }],
    )).rejects.toThrow();

    expect(credentialReads).toBe(0);
    const [, init, options] = f.mock.calls[0] as [string, RequestInit, Record<string, unknown>];
    expect(init.headers).toBeUndefined();
    expect(String(init.body)).toContain("sensitive prompt");
    expect(options).toMatchObject({ requireHttps: true, prepareRequest: expect.any(Function) });
  });

  it("materializes a public HTTPS credential once inside request preparation", async () => {
    let credentialReads = 0;
    const f = stubSafeExternalFetch(async (_url, init, options) => {
      const prepared = await options.prepareRequest();
      expect(prepared.headers.Authorization).toBe("Bearer SECRET-PUBLIC-HTTPS");
      expect(String(init.body)).toContain("sensitive prompt");
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: "ok" } }], usage: {} }),
      };
    });

    await chatCompletion(
      {
        provider: "CUSTOM",
        model: "tenant-model",
        apiKey: "[tenant-credential]",
        getApiKey: () => {
          credentialReads += 1;
          return "SECRET-PUBLIC-HTTPS";
        },
        baseUrl: "https://public-provider.example/v1",
      },
      "system prompt",
      [{ role: "user", content: "sensitive prompt" }],
    );

    expect(f).toHaveBeenCalledOnce();
    expect(credentialReads).toBe(1);
  });

  it("never exposes a raw OpenAI-compatible upstream body while preserving status", async () => {
    const canary = "RAW-UPSTREAM-SECRET http://10.0.0.8 internal-token";
    stubSafeExternalFetch(async (_url, _init, options) => {
      await options.prepareRequest();
      return new Response(canary, { status: 400 });
    });

    let thrown: unknown;
    try {
      await chatCompletion(
        { provider: "OPENROUTER", model: "openai/gpt-4o", apiKey: "or-key" },
        "system",
        [{ role: "user", content: "hello" }],
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).not.toContain(canary);
    expect(JSON.stringify(thrown)).not.toContain(canary);
    expect((thrown as Error & { status?: number }).status).toBe(400);
  });

  it("detects tool rejection without retaining the raw upstream body", async () => {
    const canary = "tool unsupported SECRET-INTERNAL-BODY";
    stubSafeExternalFetch(async (_url, _init, options) => {
      await options.prepareRequest();
      return new Response(canary, { status: 400 });
    });

    await expect(chatCompletion(
      { provider: "OPENROUTER", model: "openai/gpt-4o", apiKey: "or-key" },
      "system",
      [{ role: "user", content: "hello" }],
      4096,
      { tools: [{ name: "lookup", description: "lookup", parameters: {} }] },
    )).rejects.toSatisfy((err: Error) =>
      err.name === "ToolsUnsupportedError" && !err.message.includes(canary),
    );
  });
});

// ── SaaS SSRF boundary: tenant-controlled local/custom URLs ──

describe("local provider network policy", () => {
  it("routes CUSTOM through the socket-bound SaaS network policy", async () => {
    const f = stubSafeExternalFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    }));

    await chatCompletion(
      { provider: "CUSTOM", model: "tenant-model", apiKey: "tenant-key", baseUrl: "http://127.0.0.1:9000/v1" },
      "system prompt",
      [{ role: "user", content: "hello" }],
    );

    expect(f).toHaveBeenCalledWith(
      "http://127.0.0.1:9000/v1/chat/completions",
      expect.objectContaining({ method: "POST", signal: expect.any(AbortSignal) }),
      expect.objectContaining({
        allowLoopback: false,
        allowPrivateNetworks: false,
        requireHttps: true,
        prepareRequest: expect.any(Function),
      }),
    );
    expect(ssrf.assertSafeExternalUrl).not.toHaveBeenCalled();
  });

  it.each([
    ["OLLAMA", "http://8.8.8.8/v1"],
    ["OLLAMA", "https://8.8.8.8/v1"],
    ["LMSTUDIO", "http://[2606:4700:4700::1111]/v1"],
    ["LMSTUDIO", "https://[2606:4700:4700::1111]/v1"],
    ["CUSTOM", "http://provider.example.test/v1"],
    ["CUSTOM", "https://provider.example.test/v1"],
  ] as const)("OFFLINE_MODE %s blocks public chat target %s before credential/header preparation", async (provider, baseUrl) => {
    envMock.OFFLINE_MODE = true;
    let credentialReads = 0;
    const config = { provider, model: "local-model", baseUrl } as {
      provider: typeof provider;
      model: string;
      baseUrl: string;
      apiKey: string;
    };
    Object.defineProperty(config, "apiKey", {
      enumerable: true,
      get: () => {
        credentialReads += 1;
        return "local-secret";
      },
    });
    const f = stubSafeExternalFetch(async () => {
      throw new Error("LOCAL_DESTINATION_REQUIRED");
    });

    await expect(chatCompletion(
      config,
      "system prompt",
      [{ role: "user", content: "sensitive prompt" }],
    )).rejects.toThrow(/unreachable|refus/i);

    expect(credentialReads).toBe(0);
    expect(f).toHaveBeenCalledOnce();
    const [, init, options] = f.mock.calls[0] as [string, RequestInit, Record<string, unknown>];
    expect((init.headers as Record<string, string> | undefined)?.Authorization).toBeUndefined();
    expect(options).toMatchObject({
      allowLoopback: true,
      allowPrivateNetworks: true,
      requireLocalDestination: true,
      prepareRequest: expect.any(Function),
    });
  });
});
