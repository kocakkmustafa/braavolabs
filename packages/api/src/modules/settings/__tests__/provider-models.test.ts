/**
 * Provider model catalogue endpoint — E2/T10 API leg (mocked fetch, no
 * real provider calls; the live proxy is a runtime feature).
 *
 * Pins the plan-e2 T10 contract:
 *   1. tenant has a usable key for the provider → LIVE list from the
 *      provider's /models API (correct URL, auth in HEADERS — never `?key=`,
 *      the D-001 leak class), cached 5 minutes per tenant × provider;
 *   2. no key / wrong provider / decrypt failure / non-2xx / network error /
 *      empty list → static PROVIDER_MODELS fallback, NEVER a throw;
 *   3. every catalogue request goes through the socket-bound SSRF transport;
 *      local/private access requires an explicit OFFLINE_MODE deployment.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../../lib/db", () => ({
  prisma: { userAIConfig: { findFirst: vi.fn() } },
}));

vi.mock("../../../lib/encryption", () => ({
  encryptForTenant: vi.fn(() => "enc"),
  decryptForTenant: vi.fn(() => "sk-decrypted-key"),
}));

vi.mock("../../../lib/ssrf", () => ({
  safeExternalFetch: vi.fn(),
  SsrfError: class SsrfError extends Error {},
}));

vi.mock("../../../config/env", () => ({
  env: { OFFLINE_MODE: false },
}));

import { prisma } from "../../../lib/db";
import { decryptForTenant } from "../../../lib/encryption";
import { safeExternalFetch } from "../../../lib/ssrf";
import { env } from "../../../config/env";
import { PROVIDER_MODELS } from "../../../services/ai-client";
import {
  getProviderModels,
  isKnownProvider,
  clearProviderModelsCache,
} from "../provider-models";

const mockedFindFirst = prisma.userAIConfig.findFirst as unknown as ReturnType<typeof vi.fn>;
const mockedDecrypt = decryptForTenant as unknown as ReturnType<typeof vi.fn>;
const mockedSafeFetch = safeExternalFetch as unknown as ReturnType<typeof vi.fn>;
const mockedEnv = env as { OFFLINE_MODE: boolean };
const forbiddenGlobalFetch = vi.fn(async () => {
  throw new Error("REAL_NETWORK_FORBIDDEN");
});

const TENANT = "tenant-1";

/** Config row factory — single-row BYOK world (pre-T6). */
const row = (provider: string, over: Record<string, unknown> = {}) => ({
  tenantId: TENANT,
  provider,
  model: "whatever",
  encryptedApiKey: "v4:encrypted",
  baseUrl: null,
  ...over,
});

const okJson = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

function stubSafeFetch(impl: (...a: unknown[]) => unknown) {
  mockedSafeFetch.mockImplementation(impl);
  return mockedSafeFetch;
}

beforeEach(() => {
  vi.clearAllMocks();
  clearProviderModelsCache();
  // clearAllMocks clears calls but NOT implementations set with
  // mockReturnValue/mockRejectedValue in individual tests — re-pin the
  // happy-path defaults here so tests can't poison each other.
  mockedDecrypt.mockReturnValue("sk-decrypted-key");
  mockedSafeFetch.mockReset();
  mockedEnv.OFFLINE_MODE = false;
  forbiddenGlobalFetch.mockClear();
  vi.stubGlobal("fetch", forbiddenGlobalFetch);
});

afterEach(() => vi.unstubAllGlobals());

// ─── Provider id guard ────────────────────────────────────

describe("isKnownProvider", () => {
  it("accepts all 12 catalogue providers", () => {
    for (const p of Object.keys(PROVIDER_MODELS)) expect(isKnownProvider(p)).toBe(true);
  });

  it("rejects unknown / non-uppercased ids", () => {
    expect(isKnownProvider("FOO")).toBe(false);
    expect(isKnownProvider("groq")).toBe(false); // router uppercases first
    expect(isKnownProvider("")).toBe(false);
  });
});

// ─── Static fallback paths (never 500) ────────────────────

describe("getProviderModels — static fallback", () => {
  it("OFFLINE_MODE blocks cloud catalogues before cache, config lookup, key decryption, or transport", async () => {
    mockedEnv.OFFLINE_MODE = true;
    mockedFindFirst.mockResolvedValue(row("GROQ"));
    const f = stubSafeFetch(async () => okJson({ data: [{ id: "must-not-escape" }] }));

    const r = await getProviderModels(TENANT, "GROQ");

    expect(r).toEqual({ provider: "GROQ", models: PROVIDER_MODELS.GROQ, source: "static" });
    expect(mockedFindFirst).not.toHaveBeenCalled();
    expect(mockedDecrypt).not.toHaveBeenCalled();
    expect(f).not.toHaveBeenCalled();
    expect(forbiddenGlobalFetch).not.toHaveBeenCalled();
  });

  it("no config row → static catalogue, no provider call", async () => {
    mockedFindFirst.mockResolvedValue(null);
    const f = stubSafeFetch(async () => okJson({}));

    const r = await getProviderModels(TENANT, "GROQ");
    expect(r).toEqual({ provider: "GROQ", models: PROVIDER_MODELS.GROQ, source: "static" });
    expect(f).not.toHaveBeenCalled();
  });

  it("configured provider differs from the requested one → static (no key to proxy with)", async () => {
    // The provider filter lives in the QUERY (findFirst on tenantId +
    // provider — schema-agnostic pre/post T6): emulate the DB by only
    // matching the tenant's single ANTHROPIC row.
    mockedFindFirst.mockImplementation(async (args: { where: { provider: string } }) =>
      args.where.provider === "ANTHROPIC" ? row("ANTHROPIC") : null,
    );
    const f = stubSafeFetch(async () => okJson({}));

    const r = await getProviderModels(TENANT, "DEEPSEEK");
    expect(r.source).toBe("static");
    expect(r.models).toEqual(PROVIDER_MODELS.DEEPSEEK);
    expect(f).not.toHaveBeenCalled();
    expect(mockedFindFirst).toHaveBeenCalledWith({
      where: { tenantId: TENANT, provider: "DEEPSEEK" },
    });
  });

  it("cloud provider without a stored key → static, no call", async () => {
    mockedFindFirst.mockResolvedValue(row("GROQ", { encryptedApiKey: null }));
    const f = stubSafeFetch(async () => okJson({}));

    const r = await getProviderModels(TENANT, "GROQ");
    expect(r.source).toBe("static");
    expect(f).not.toHaveBeenCalled();
  });

  it("decrypt failure → static, provider is never called with an empty key (D-002 stance)", async () => {
    mockedFindFirst.mockResolvedValue(row("GROQ"));
    mockedDecrypt.mockImplementation(() => { throw new Error("bad ciphertext"); });
    const f = stubSafeFetch(async () => okJson({}));

    const r = await getProviderModels(TENANT, "GROQ");
    expect(r.source).toBe("static");
    expect(f).not.toHaveBeenCalled();
  });

  it("provider answers non-2xx → static, no throw", async () => {
    mockedFindFirst.mockResolvedValue(row("GROQ"));
    stubSafeFetch(async () => ({ ok: false, status: 401, json: async () => ({}) }));

    const r = await getProviderModels(TENANT, "GROQ");
    expect(r).toEqual({ provider: "GROQ", models: PROVIDER_MODELS.GROQ, source: "static" });
  });

  it("network error (fetch rejects) → static, no throw", async () => {
    mockedFindFirst.mockResolvedValue(row("GROQ"));
    stubSafeFetch(async () => { throw new Error("ECONNREFUSED"); });

    const r = await getProviderModels(TENANT, "GROQ");
    expect(r.source).toBe("static");
  });

  it("metadata target refusal → static and global fetch is never used", async () => {
    mockedFindFirst.mockResolvedValue(row("GROQ", { baseUrl: "https://169.254.169.254/v1" }));
    const f = stubSafeFetch(async () => { throw new Error("refused"); });

    const r = await getProviderModels(TENANT, "GROQ");
    expect(r.source).toBe("static");
    expect(f).toHaveBeenCalledWith(
      "https://169.254.169.254/v1/models",
      expect.any(Object),
      expect.objectContaining({ allowLoopback: false, allowPrivateNetworks: false }),
    );
    expect(forbiddenGlobalFetch).not.toHaveBeenCalled();
  });

  it("rejects a credential-bearing public HTTP catalogue before opening a socket", async () => {
    mockedFindFirst.mockResolvedValue(row("GROQ", { baseUrl: "http://models.example.com/v1" }));
    const f = stubSafeFetch(async () => okJson({ data: [{ id: "must-not-escape" }] }));

    const r = await getProviderModels(TENANT, "GROQ");

    expect(r).toEqual({ provider: "GROQ", models: PROVIDER_MODELS.GROQ, source: "static" });
    expect(mockedDecrypt).toHaveBeenCalledTimes(1);
    expect(f).not.toHaveBeenCalled();
    expect(forbiddenGlobalFetch).not.toHaveBeenCalled();
  });

  it("empty live list → static (selector must never go empty)", async () => {
    mockedFindFirst.mockResolvedValue(row("GROQ"));
    stubSafeFetch(async () => okJson({ data: [] }));

    const r = await getProviderModels(TENANT, "GROQ");
    expect(r.source).toBe("static");
    expect(r.models).toEqual(PROVIDER_MODELS.GROQ);
  });
});

// ─── Live listing per provider family ─────────────────────

describe("getProviderModels — live listing", () => {
  it("OpenAI-compatible (GROQ): GET {base}/models with Bearer header, ids parsed + deduped", async () => {
    mockedFindFirst.mockResolvedValue(row("GROQ"));
    const f = stubSafeFetch(async () =>
      okJson({ data: [
        { id: "llama-3.3-70b-versatile" },
        { id: "llama-3.1-8b-instant" },
        { id: "llama-3.3-70b-versatile" },   // dupe
        { id: "  " },                         // blank
        { notId: true },
      ] }),
    );

    const r = await getProviderModels(TENANT, "GROQ");
    expect(r.source).toBe("live");
    expect(r.models).toEqual(["llama-3.3-70b-versatile", "llama-3.1-8b-instant"]);

    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe("https://api.groq.com/openai/v1/models");
    expect(String(url)).not.toContain("key=");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer sk-decrypted-key");
    expect(init.signal).toBeDefined(); // short-timeout AbortController is wired

    // Cloud provider → strict SSRF policy (no loopback, no private nets).
    expect(f).toHaveBeenCalledWith(
      "https://api.groq.com/openai/v1/models",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
      expect.objectContaining({ allowLoopback: false, allowPrivateNetworks: false }),
    );
    expect(forbiddenGlobalFetch).not.toHaveBeenCalled();
  });

  it("filters non-chat ids (whisper / embeddings / dall-e / tts) out of OpenAI-compatible lists", async () => {
    mockedFindFirst.mockResolvedValue(row("OPENAI"));
    stubSafeFetch(async () =>
      okJson({ data: [
        { id: "gpt-4o" },
        { id: "whisper-1" },
        { id: "text-embedding-3-large" },
        { id: "dall-e-3" },
        { id: "tts-1-hd" },
        { id: "o1" },
      ] }),
    );

    const r = await getProviderModels(TENANT, "OPENAI");
    expect(r.models).toEqual(["gpt-4o", "o1"]);
  });

  it("tenant baseUrl override wins over the default and trailing slashes are trimmed", async () => {
    mockedFindFirst.mockResolvedValue(row("GROQ", { baseUrl: "https://litellm.example.com/v1///" }));
    const f = stubSafeFetch(async () => okJson({ data: [{ id: "proxy-model" }] }));

    await getProviderModels(TENANT, "GROQ");
    expect(String(f.mock.calls[0][0])).toBe("https://litellm.example.com/v1/models");
  });

  it("OPENROUTER sends the attribution headers (D-003 parity)", async () => {
    mockedFindFirst.mockResolvedValue(row("OPENROUTER"));
    const f = stubSafeFetch(async () => okJson({ data: [{ id: "openai/gpt-4o" }] }));

    await getProviderModels(TENANT, "OPENROUTER");
    const headers = (f.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers["HTTP-Referer"]).toBe("https://braavolabs.com");
    expect(headers["X-Title"]).toBe("Braavolabs");
  });

  it("local provider is fail-closed against localhost while OFFLINE_MODE is disabled", async () => {
    mockedFindFirst.mockResolvedValue(row("OLLAMA", { encryptedApiKey: null }));
    const f = stubSafeFetch(async () => okJson({ data: [{ id: "must-not-escape" }] }));

    const r = await getProviderModels(TENANT, "OLLAMA");
    expect(r.source).toBe("static");
    expect(f).not.toHaveBeenCalled();
    expect(forbiddenGlobalFetch).not.toHaveBeenCalled();
  });

  it("OFFLINE_MODE explicitly allows a local provider through the bound transport", async () => {
    mockedEnv.OFFLINE_MODE = true;
    mockedFindFirst.mockResolvedValue(row("OLLAMA", { encryptedApiKey: null }));
    const f = stubSafeFetch(async () => okJson({ data: [{ id: "gemma3:4b" }] }));

    const r = await getProviderModels(TENANT, "OLLAMA");
    expect(r).toEqual({ provider: "OLLAMA", models: ["gemma3:4b"], source: "live" });
    expect(f).toHaveBeenCalledWith(
      "http://localhost:11434/v1/models",
      expect.any(Object),
      expect.objectContaining({ allowLoopback: true, allowPrivateNetworks: true }),
    );
    expect(forbiddenGlobalFetch).not.toHaveBeenCalled();
  });

  it.each([
    ["OLLAMA", "http://8.8.8.8/v1"],
    ["OLLAMA", "https://8.8.8.8/v1"],
    ["LMSTUDIO", "http://[2606:4700:4700::1111]/v1"],
    ["LMSTUDIO", "https://[2606:4700:4700::1111]/v1"],
    ["CUSTOM", "http://models.example.test/v1"],
    ["CUSTOM", "https://models.example.test/v1"],
  ] as const)("OFFLINE_MODE %s public catalogue %s defers credentials and requires a local destination", async (provider, baseUrl) => {
    mockedEnv.OFFLINE_MODE = true;
    mockedFindFirst.mockResolvedValue(row(provider, { baseUrl }));
    const f = stubSafeFetch(async () => {
      throw new Error("LOCAL_DESTINATION_REQUIRED");
    });

    const result = await getProviderModels(TENANT, provider);

    expect(result).toEqual({ provider, models: PROVIDER_MODELS[provider], source: "static" });
    expect(mockedDecrypt).not.toHaveBeenCalled();
    expect(f).toHaveBeenCalledOnce();
    const [, init, options] = f.mock.calls[0] as [string, RequestInit, Record<string, unknown>];
    expect((init.headers as Record<string, string> | undefined)?.Authorization).toBeUndefined();
    expect(options).toMatchObject({
      allowLoopback: true,
      allowPrivateNetworks: true,
      requireLocalDestination: true,
      prepareRequest: expect.any(Function),
    });
    expect(forbiddenGlobalFetch).not.toHaveBeenCalled();
  });

  it("CUSTOM without a saved base URL → static (nothing to call)", async () => {
    mockedFindFirst.mockResolvedValue(row("CUSTOM", { encryptedApiKey: null, baseUrl: null }));
    const f = stubSafeFetch(async () => okJson({ data: [{ id: "x" }] }));

    const r = await getProviderModels(TENANT, "CUSTOM");
    expect(r.source).toBe("static");
    expect(f).not.toHaveBeenCalled();
  });

  it("ANTHROPIC: dedicated endpoint with x-api-key + anthropic-version headers", async () => {
    mockedFindFirst.mockResolvedValue(row("ANTHROPIC"));
    const f = stubSafeFetch(async () =>
      okJson({ data: [{ id: "claude-sonnet-4-5-20250929" }, { id: "claude-haiku-4-5-20251001" }] }),
    );

    const r = await getProviderModels(TENANT, "ANTHROPIC");
    expect(r.source).toBe("live");
    expect(r.models).toEqual(["claude-sonnet-4-5-20250929", "claude-haiku-4-5-20251001"]);

    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain("https://api.anthropic.com/v1/models");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-decrypted-key");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
  });

  it("GOOGLE: key travels in the x-goog-api-key HEADER, never `?key=` (D-001 pattern); models/ prefix stripped; non-chat models dropped", async () => {
    mockedFindFirst.mockResolvedValue(row("GOOGLE"));
    const f = stubSafeFetch(async () =>
      okJson({ models: [
        { name: "models/gemini-1.5-pro", supportedGenerationMethods: ["generateContent"] },
        { name: "models/embedding-001", supportedGenerationMethods: ["embedContent"] },
        { name: "models/gemini-2.0-flash" }, // capability field absent → tolerated
      ] }),
    );

    const r = await getProviderModels(TENANT, "GOOGLE");
    expect(r.source).toBe("live");
    expect(r.models).toEqual(["gemini-1.5-pro", "gemini-2.0-flash"]);

    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain("generativelanguage.googleapis.com/v1beta/models");
    expect(String(url)).not.toContain("key=");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("sk-decrypted-key");
  });
});

// ─── 5-minute cache ───────────────────────────────────────

describe("getProviderModels — cache", () => {
  it("second call within the TTL is served from cache (single upstream fetch)", async () => {
    mockedFindFirst.mockResolvedValue(row("GROQ"));
    const f = stubSafeFetch(async () => okJson({ data: [{ id: "llama-3.3-70b-versatile" }] }));

    const first = await getProviderModels(TENANT, "GROQ");
    const second = await getProviderModels(TENANT, "GROQ");
    expect(first.models).toEqual(second.models);
    expect(second.source).toBe("live");
    expect(f).toHaveBeenCalledTimes(1);
    expect(mockedFindFirst).toHaveBeenCalledTimes(1); // cache short-circuits the DB too
  });

  it("cache is tenant-scoped — another tenant triggers its own fetch", async () => {
    mockedFindFirst.mockResolvedValue(row("GROQ"));
    const f = stubSafeFetch(async () => okJson({ data: [{ id: "llama-3.3-70b-versatile" }] }));

    await getProviderModels("tenant-A", "GROQ");
    await getProviderModels("tenant-B", "GROQ");
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("failures are not cached — the next call retries the provider", async () => {
    mockedFindFirst.mockResolvedValue(row("GROQ"));
    let calls = 0;
    stubSafeFetch(async () => {
      calls += 1;
      if (calls === 1) throw new Error("ETIMEDOUT");
      return okJson({ data: [{ id: "llama-3.1-8b-instant" }] });
    });

    const first = await getProviderModels(TENANT, "GROQ");
    expect(first.source).toBe("static");
    const second = await getProviderModels(TENANT, "GROQ");
    expect(second.source).toBe("live");
    expect(second.models).toEqual(["llama-3.1-8b-instant"]);
  });
});
