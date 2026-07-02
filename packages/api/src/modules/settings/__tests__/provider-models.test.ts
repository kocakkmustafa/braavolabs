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
 *   3. tenant-controllable base URLs go through the ai-client SSRF policy
 *      (loopback + private ranges only for local-first providers).
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
  assertSafeExternalUrl: vi.fn(async () => {}),
  SsrfError: class SsrfError extends Error {},
}));

import { prisma } from "../../../lib/db";
import { decryptForTenant } from "../../../lib/encryption";
import { assertSafeExternalUrl } from "../../../lib/ssrf";
import { PROVIDER_MODELS } from "../../../services/ai-client";
import {
  getProviderModels,
  isKnownProvider,
  clearProviderModelsCache,
} from "../provider-models";

const mockedFindFirst = prisma.userAIConfig.findFirst as unknown as ReturnType<typeof vi.fn>;
const mockedDecrypt = decryptForTenant as unknown as ReturnType<typeof vi.fn>;
const mockedSsrf = assertSafeExternalUrl as unknown as ReturnType<typeof vi.fn>;

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

function stubFetch(impl: (...a: unknown[]) => unknown) {
  const f = vi.fn(impl);
  vi.stubGlobal("fetch", f);
  return f;
}

beforeEach(() => {
  vi.clearAllMocks();
  clearProviderModelsCache();
  // clearAllMocks clears calls but NOT implementations set with
  // mockReturnValue/mockRejectedValue in individual tests — re-pin the
  // happy-path defaults here so tests can't poison each other.
  mockedDecrypt.mockReturnValue("sk-decrypted-key");
  mockedSsrf.mockResolvedValue(undefined);
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
  it("no config row → static catalogue, no provider call", async () => {
    mockedFindFirst.mockResolvedValue(null);
    const f = stubFetch(async () => okJson({}));

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
    const f = stubFetch(async () => okJson({}));

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
    const f = stubFetch(async () => okJson({}));

    const r = await getProviderModels(TENANT, "GROQ");
    expect(r.source).toBe("static");
    expect(f).not.toHaveBeenCalled();
  });

  it("decrypt failure → static, provider is never called with an empty key (D-002 stance)", async () => {
    mockedFindFirst.mockResolvedValue(row("GROQ"));
    mockedDecrypt.mockImplementation(() => { throw new Error("bad ciphertext"); });
    const f = stubFetch(async () => okJson({}));

    const r = await getProviderModels(TENANT, "GROQ");
    expect(r.source).toBe("static");
    expect(f).not.toHaveBeenCalled();
  });

  it("provider answers non-2xx → static, no throw", async () => {
    mockedFindFirst.mockResolvedValue(row("GROQ"));
    stubFetch(async () => ({ ok: false, status: 401, json: async () => ({}) }));

    const r = await getProviderModels(TENANT, "GROQ");
    expect(r).toEqual({ provider: "GROQ", models: PROVIDER_MODELS.GROQ, source: "static" });
  });

  it("network error (fetch rejects) → static, no throw", async () => {
    mockedFindFirst.mockResolvedValue(row("GROQ"));
    stubFetch(async () => { throw new Error("ECONNREFUSED"); });

    const r = await getProviderModels(TENANT, "GROQ");
    expect(r.source).toBe("static");
  });

  it("SSRF refusal → static, no fetch", async () => {
    mockedFindFirst.mockResolvedValue(row("GROQ", { baseUrl: "https://169.254.169.254/v1" }));
    mockedSsrf.mockRejectedValue(new Error("refused"));
    const f = stubFetch(async () => okJson({ data: [{ id: "x" }] }));

    const r = await getProviderModels(TENANT, "GROQ");
    expect(r.source).toBe("static");
    expect(f).not.toHaveBeenCalled();
  });

  it("empty live list → static (selector must never go empty)", async () => {
    mockedFindFirst.mockResolvedValue(row("GROQ"));
    stubFetch(async () => okJson({ data: [] }));

    const r = await getProviderModels(TENANT, "GROQ");
    expect(r.source).toBe("static");
    expect(r.models).toEqual(PROVIDER_MODELS.GROQ);
  });
});

// ─── Live listing per provider family ─────────────────────

describe("getProviderModels — live listing", () => {
  it("OpenAI-compatible (GROQ): GET {base}/models with Bearer header, ids parsed + deduped", async () => {
    mockedFindFirst.mockResolvedValue(row("GROQ"));
    const f = stubFetch(async () =>
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
    expect(mockedSsrf).toHaveBeenCalledWith(
      "https://api.groq.com/openai/v1",
      expect.objectContaining({ allowLoopback: false, allowPrivateNetworks: false }),
    );
  });

  it("filters non-chat ids (whisper / embeddings / dall-e / tts) out of OpenAI-compatible lists", async () => {
    mockedFindFirst.mockResolvedValue(row("OPENAI"));
    stubFetch(async () =>
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
    const f = stubFetch(async () => okJson({ data: [{ id: "proxy-model" }] }));

    await getProviderModels(TENANT, "GROQ");
    expect(String(f.mock.calls[0][0])).toBe("https://litellm.example.com/v1/models");
  });

  it("OPENROUTER sends the attribution headers (D-003 parity)", async () => {
    mockedFindFirst.mockResolvedValue(row("OPENROUTER"));
    const f = stubFetch(async () => okJson({ data: [{ id: "openai/gpt-4o" }] }));

    await getProviderModels(TENANT, "OPENROUTER");
    const headers = (f.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers["HTTP-Referer"]).toBe("https://braavolabs.com");
    expect(headers["X-Title"]).toBe("Braavolabs");
  });

  it("local provider (OLLAMA): keyless listing against localhost default, loopback allowed", async () => {
    mockedFindFirst.mockResolvedValue(row("OLLAMA", { encryptedApiKey: null }));
    const f = stubFetch(async () => okJson({ data: [{ id: "gemma3:4b" }, { id: "qwen2.5:14b" }] }));

    const r = await getProviderModels(TENANT, "OLLAMA");
    expect(r.source).toBe("live");
    expect(r.models).toEqual(["gemma3:4b", "qwen2.5:14b"]);

    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe("http://localhost:11434/v1/models");
    expect((init.headers as Record<string, string>)["Authorization"]).toBeUndefined();
    expect(mockedSsrf).toHaveBeenCalledWith(
      "http://localhost:11434/v1",
      expect.objectContaining({ allowLoopback: true, allowPrivateNetworks: true }),
    );
  });

  it("CUSTOM without a saved base URL → static (nothing to call)", async () => {
    mockedFindFirst.mockResolvedValue(row("CUSTOM", { encryptedApiKey: null, baseUrl: null }));
    const f = stubFetch(async () => okJson({ data: [{ id: "x" }] }));

    const r = await getProviderModels(TENANT, "CUSTOM");
    expect(r.source).toBe("static");
    expect(f).not.toHaveBeenCalled();
  });

  it("ANTHROPIC: dedicated endpoint with x-api-key + anthropic-version headers", async () => {
    mockedFindFirst.mockResolvedValue(row("ANTHROPIC"));
    const f = stubFetch(async () =>
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
    const f = stubFetch(async () =>
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
    const f = stubFetch(async () => okJson({ data: [{ id: "llama-3.3-70b-versatile" }] }));

    const first = await getProviderModels(TENANT, "GROQ");
    const second = await getProviderModels(TENANT, "GROQ");
    expect(first.models).toEqual(second.models);
    expect(second.source).toBe("live");
    expect(f).toHaveBeenCalledTimes(1);
    expect(mockedFindFirst).toHaveBeenCalledTimes(1); // cache short-circuits the DB too
  });

  it("cache is tenant-scoped — another tenant triggers its own fetch", async () => {
    mockedFindFirst.mockResolvedValue(row("GROQ"));
    const f = stubFetch(async () => okJson({ data: [{ id: "llama-3.3-70b-versatile" }] }));

    await getProviderModels("tenant-A", "GROQ");
    await getProviderModels("tenant-B", "GROQ");
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("failures are not cached — the next call retries the provider", async () => {
    mockedFindFirst.mockResolvedValue(row("GROQ"));
    let calls = 0;
    stubFetch(async () => {
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
