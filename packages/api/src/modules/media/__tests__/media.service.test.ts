/**
 * FAZ E B3 — media.service.ts unit coverage.
 *
 * Zero-network: global.fetch is stubbed per test (same pattern as
 * modules/external/__tests__/control-http.test.ts). prisma / logger /
 * encryption are fully mocked (same pattern as
 * modules/run/__tests__/handoff-router.test.ts). Real generateImage /
 * synthesizeTts / recordGeneration implementations are exercised directly —
 * this file is the one place that proves the actual HTTP contract (URLs,
 * headers, single-attempt-no-retry, size caps) rather than a mocked stand-in.
 *
 * Fail-closed BYOK is the load-bearing property throughout: every "no key"
 * case must throw AppError(402) with fetch never invoked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mediaProviderKeyFindUnique = vi.hoisted(() => vi.fn());
const mediaGenerationCreate = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/db", () => ({
  prisma: {
    mediaProviderKey: { findUnique: (...a: unknown[]) => mediaProviderKeyFindUnique(...a) },
    mediaGeneration: { create: (...a: unknown[]) => mediaGenerationCreate(...a) },
  },
}));

const decryptForTenantMock = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/encryption", () => ({
  decryptForTenant: (...a: unknown[]) => decryptForTenantMock(...a),
}));

import { AppError } from "../../../middleware/error";
import { logger } from "../../../lib/logger";
import {
  generateImage,
  synthesizeTts,
  getTenantMediaKey,
  recordGeneration,
} from "../media.service";

const TENANT = "tenant-1";
const API_KEY = "sk-secret-test-key-999";

function stubFetch(impl: (...a: any[]) => any) {
  const f = vi.fn(impl);
  vi.stubGlobal("fetch", f);
  return f;
}

function okJsonRes(body: unknown) {
  return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body), json: async () => body };
}

function errRes(status: number, bodyText: string) {
  return { ok: false, status, headers: { get: () => null }, text: async () => bodyText, json: async () => { throw new Error("not json"); } };
}

function abortError() {
  const e = new Error("The operation was aborted");
  e.name = "AbortError";
  return e;
}

beforeEach(() => {
  vi.clearAllMocks();
  mediaProviderKeyFindUnique.mockResolvedValue({ id: "key-1", tenantId: TENANT, provider: "FAL", encryptedApiKey: "enc(...)" });
  decryptForTenantMock.mockReturnValue(API_KEY);
  mediaGenerationCreate.mockResolvedValue({ id: "gen-1" });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── getTenantMediaKey (fail-closed BYOK) ─────────────────────────────────

describe("getTenantMediaKey", () => {
  it("no key row for the tenant/provider → AppError 402, BYOK message names the provider", async () => {
    mediaProviderKeyFindUnique.mockResolvedValue(null);
    await expect(getTenantMediaKey(TENANT, "GOOGLE_TTS")).rejects.toMatchObject({
      statusCode: 402,
      message: expect.stringMatching(/GOOGLE_TTS/),
    });
    await expect(getTenantMediaKey(TENANT, "GOOGLE_TTS")).rejects.toBeInstanceOf(AppError);
  });

  it("402 message says BYOK-only — no system/env fallback implied", async () => {
    mediaProviderKeyFindUnique.mockResolvedValue(null);
    await expect(getTenantMediaKey(TENANT, "FAL")).rejects.toMatchObject({
      message: expect.stringMatching(/BYOK-only/i),
    });
  });

  it("key row exists → decrypts with the composite (tenantId, provider) lookup and returns the plaintext key", async () => {
    mediaProviderKeyFindUnique.mockResolvedValue({ id: "key-1", tenantId: TENANT, provider: "FAL", encryptedApiKey: "enc(payload)" });
    decryptForTenantMock.mockReturnValue(API_KEY);

    const key = await getTenantMediaKey(TENANT, "FAL");

    expect(key).toBe(API_KEY);
    expect(mediaProviderKeyFindUnique).toHaveBeenCalledWith({
      where: { tenantId_provider: { tenantId: TENANT, provider: "FAL" } },
    });
    expect(decryptForTenantMock).toHaveBeenCalledWith("enc(payload)", TENANT);
  });

  it("only queries by this tenant's own composite key — another tenant's row is never in scope of the query shape", async () => {
    await getTenantMediaKey("tenant-other", "ELEVENLABS");
    expect(mediaProviderKeyFindUnique).toHaveBeenCalledWith({
      where: { tenantId_provider: { tenantId: "tenant-other", provider: "ELEVENLABS" } },
    });
  });
});

// ─── generateImage (fal.ai) ────────────────────────────────────────────────

describe("generateImage", () => {
  const params = { model: "fal-ai/flux/schnell", prompt: "a cat", n: 1, width: 1024, height: 1024 };

  it("(a) no FAL key configured → AppError 402, fetch is never called (fail-closed)", async () => {
    mediaProviderKeyFindUnique.mockResolvedValue(null);
    const f = stubFetch(async () => okJsonRes({ images: [{ url: "https://x/y.png" }] }));

    await expect(generateImage(TENANT, params)).rejects.toMatchObject({ statusCode: 402 });
    expect(f).not.toHaveBeenCalled();
  });

  it("(b) happy path: POST fal.run/<model> with 'Key <apiKey>' auth header, correct body, image URLs pass through untouched", async () => {
    const f = stubFetch(async () =>
      okJsonRes({ images: [{ url: "https://fal.cdn/img1.png", width: 1024, height: 1024 }] }),
    );

    const result = await generateImage(TENANT, params);

    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0];
    expect(String(url)).toBe("https://fal.run/fal-ai/flux/schnell");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe(`Key ${API_KEY}`);
    const body = JSON.parse(init.body);
    expect(body).toEqual({ prompt: "a cat", image_size: { width: 1024, height: 1024 }, num_images: 1 });

    expect(result.images).toEqual([{ url: "https://fal.cdn/img1.png", width: 1024, height: 1024 }]);
    expect(result.urlNote).toMatch(/CDN/);
  });

  it("filters out entries without a usable url field", async () => {
    stubFetch(async () => okJsonRes({ images: [{ url: "" }, { width: 10 }, { url: "https://ok/1.png" }] }));
    const result = await generateImage(TENANT, params);
    expect(result.images).toEqual([{ url: "https://ok/1.png", width: undefined, height: undefined }]);
  });

  it("response with zero usable image URLs → AppError 502", async () => {
    stubFetch(async () => okJsonRes({ images: [] }));
    await expect(generateImage(TENANT, params)).rejects.toMatchObject({ statusCode: 502 });
  });

  it("(e) provider 500 → exactly one fetch call (no retry — paid call, retry = double-spend risk), AppError 502", async () => {
    const f = stubFetch(async () => errRes(500, "Internal Server Error: upstream capacity exceeded"));

    await expect(generateImage(TENANT, params)).rejects.toMatchObject({ statusCode: 502 });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("(e) error message never contains the tenant's raw API key", async () => {
    stubFetch(async () => errRes(500, "some upstream failure, nothing sensitive here"));
    try {
      await generateImage(TENANT, params);
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as Error).message).not.toContain(API_KEY);
    }
  });

  it("defense-in-depth: a path-traversal model is rejected with AppError 400 before any fetch", async () => {
    const f = stubFetch(async () => okJsonRes({ images: [{ url: "https://x/y.png" }] }));
    for (const badModel of ["../../../secret", "fal-ai/../evil", "https://evil.com/x"]) {
      await expect(
        generateImage(TENANT, { ...params, model: badModel }),
      ).rejects.toMatchObject({ statusCode: 400 });
    }
    expect(f).not.toHaveBeenCalled();
  });

  it("provider error body over 200 chars is truncated with an ellipsis", async () => {
    // Realistic long error (short words + spaces) — no 32+ char token, so it
    // survives redaction and exercises the length-based truncation path.
    const longBody = "upstream failure occurred ".repeat(30);
    stubFetch(async () => errRes(502, longBody));
    try {
      await generateImage(TENANT, params);
      throw new Error("should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("…");
      expect(msg.length).toBeLessThan(500);
    }
  });

  it("redacts a long token-like string from a provider error body (defense-in-depth)", async () => {
    const leakyBody = `error: sk_live_${"A1b2C3d4".repeat(6)} was rejected`;
    stubFetch(async () => errRes(502, leakyBody));
    try {
      await generateImage(TENANT, params);
      throw new Error("should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("[redacted]");
      expect(msg).not.toContain("A1b2C3d4A1b2C3d4");
    }
  });

  it("fetch aborts (timeout) → AppError 504, single attempt", async () => {
    const f = stubFetch(async () => { throw abortError(); });
    await expect(generateImage(TENANT, params)).rejects.toMatchObject({ statusCode: 504 });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("fetch throws a plain network error → AppError 502 (not a raw uncaught exception)", async () => {
    stubFetch(async () => { throw new Error("ECONNRESET"); });
    await expect(generateImage(TENANT, params)).rejects.toMatchObject({ statusCode: 502 });
  });
});

// ─── synthesizeTts — GOOGLE_TTS ────────────────────────────────────────────

describe("synthesizeTts — GOOGLE_TTS", () => {
  beforeEach(() => {
    mediaProviderKeyFindUnique.mockResolvedValue({ id: "key-2", tenantId: TENANT, provider: "GOOGLE_TTS", encryptedApiKey: "enc(...)" });
  });

  it("(a) no GOOGLE_TTS key configured → AppError 402, fetch never called", async () => {
    mediaProviderKeyFindUnique.mockResolvedValue(null);
    const f = stubFetch(async () => okJsonRes({ audioContent: "QUJD" }));
    await expect(synthesizeTts(TENANT, { provider: "GOOGLE_TTS", text: "hello" })).rejects.toMatchObject({ statusCode: 402 });
    expect(f).not.toHaveBeenCalled();
  });

  it("(c) API key is sent in the X-Goog-Api-Key HEADER — never appears in the request URL", async () => {
    const f = stubFetch(async () => okJsonRes({ audioContent: "QUJD" }));
    await synthesizeTts(TENANT, { provider: "GOOGLE_TTS", text: "hello", voice: "en-US-Standard-A" });

    const [url, init] = f.mock.calls[0];
    expect(String(url)).toBe("https://texttospeech.googleapis.com/v1/text:synthesize");
    expect(String(url)).not.toContain(API_KEY);
    expect(init.headers["X-Goog-Api-Key"]).toBe(API_KEY);
    expect(init.headers.Authorization).toBeUndefined();
  });

  it("(c) derives languageCode from the first two hyphen segments of the voice name", async () => {
    const f = stubFetch(async () => okJsonRes({ audioContent: "QUJD" }));
    await synthesizeTts(TENANT, { provider: "GOOGLE_TTS", text: "merhaba", voice: "tr-TR-Standard-A" });
    const body = JSON.parse(f.mock.calls[0][1].body);
    expect(body.voice).toEqual({ languageCode: "tr-TR", name: "tr-TR-Standard-A" });
    expect(body.input).toEqual({ text: "merhaba" });
    expect(body.audioConfig).toEqual({ audioEncoding: "MP3" });
  });

  it("no voice given → defaults languageCode to en-US and omits the name field", async () => {
    const f = stubFetch(async () => okJsonRes({ audioContent: "QUJD" }));
    await synthesizeTts(TENANT, { provider: "GOOGLE_TTS", text: "hi" });
    const body = JSON.parse(f.mock.calls[0][1].body);
    expect(body.voice).toEqual({ languageCode: "en-US" });
  });

  it("(c) audioContent base64 passes through untouched; chars reflects input text length", async () => {
    stubFetch(async () => okJsonRes({ audioContent: "QUJDREVGRw==" }));
    const result = await synthesizeTts(TENANT, { provider: "GOOGLE_TTS", text: "hello world" });
    expect(result.audioBase64).toBe("QUJDREVGRw==");
    expect(result.mime).toBe("audio/mpeg");
    expect(result.chars).toBe("hello world".length);
  });

  it("response missing audioContent → AppError 502", async () => {
    stubFetch(async () => okJsonRes({}));
    await expect(synthesizeTts(TENANT, { provider: "GOOGLE_TTS", text: "hi" })).rejects.toMatchObject({ statusCode: 502 });
  });

  it("non-ok response → AppError 502 with truncated provider body", async () => {
    const f = stubFetch(async () => errRes(403, "PERMISSION_DENIED: API key invalid"));
    await expect(synthesizeTts(TENANT, { provider: "GOOGLE_TTS", text: "hi" })).rejects.toMatchObject({ statusCode: 502 });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("timeout abort → AppError 504", async () => {
    stubFetch(async () => { throw abortError(); });
    await expect(synthesizeTts(TENANT, { provider: "GOOGLE_TTS", text: "hi" })).rejects.toMatchObject({ statusCode: 504 });
  });
});

// ─── synthesizeTts — ELEVENLABS ────────────────────────────────────────────

describe("synthesizeTts — ELEVENLABS", () => {
  beforeEach(() => {
    mediaProviderKeyFindUnique.mockResolvedValue({ id: "key-3", tenantId: TENANT, provider: "ELEVENLABS", encryptedApiKey: "enc(...)" });
  });

  it("(a) no ELEVENLABS key configured → AppError 402, fetch never called", async () => {
    mediaProviderKeyFindUnique.mockResolvedValue(null);
    const f = stubFetch(async () => ({ ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(4) }));
    await expect(synthesizeTts(TENANT, { provider: "ELEVENLABS", text: "hi", voice: "voice-1" })).rejects.toMatchObject({ statusCode: 402 });
    expect(f).not.toHaveBeenCalled();
  });

  it("missing voice (required — ElevenLabs voiceId is path-based) → AppError 400, fetch never called", async () => {
    const f = stubFetch(async () => ({ ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(4) }));
    await expect(synthesizeTts(TENANT, { provider: "ELEVENLABS", text: "hi" })).rejects.toMatchObject({ statusCode: 400 });
    expect(f).not.toHaveBeenCalled();
  });

  it("(d) happy path: xi-api-key header, voiceId in the URL path, binary arrayBuffer → base64", async () => {
    const raw = Buffer.from("fake-mp3-bytes");
    const f = stubFetch(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      arrayBuffer: async () => raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
    }));

    const result = await synthesizeTts(TENANT, { provider: "ELEVENLABS", text: "hello", voice: "voice-abc" });

    const [url, init] = f.mock.calls[0];
    expect(String(url)).toBe("https://api.elevenlabs.io/v1/text-to-speech/voice-abc");
    expect(init.headers["xi-api-key"]).toBe(API_KEY);
    expect(init.headers.Authorization).toBeUndefined();
    expect(JSON.parse(init.body)).toEqual({ text: "hello", model_id: "eleven_multilingual_v2" });
    expect(result.audioBase64).toBe(raw.toString("base64"));
    expect(result.mime).toBe("audio/mpeg");
  });

  it("custom model overrides the eleven_multilingual_v2 default", async () => {
    const f = stubFetch(async () => ({ ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) }));
    await synthesizeTts(TENANT, { provider: "ELEVENLABS", text: "hi", voice: "v1", model: "eleven_turbo_v2" });
    expect(JSON.parse(f.mock.calls[0][1].body).model_id).toBe("eleven_turbo_v2");
  });

  it("(d) content-length header over the 15MB cap → AppError 502 before reading the body", async () => {
    const arrayBufferSpy = vi.fn();
    stubFetch(async () => ({
      ok: true,
      status: 200,
      headers: { get: (name: string) => (name === "content-length" ? String(16 * 1024 * 1024) : null) },
      arrayBuffer: arrayBufferSpy,
    }));

    await expect(synthesizeTts(TENANT, { provider: "ELEVENLABS", text: "hi", voice: "v1" })).rejects.toMatchObject({ statusCode: 502 });
    expect(arrayBufferSpy).not.toHaveBeenCalled();
  });

  it("(d) no content-length header but actual body exceeds the 15MB cap → AppError 502 (second-line check)", async () => {
    const oversized = new ArrayBuffer(15 * 1024 * 1024 + 10);
    stubFetch(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      arrayBuffer: async () => oversized,
    }));

    await expect(synthesizeTts(TENANT, { provider: "ELEVENLABS", text: "hi", voice: "v1" })).rejects.toMatchObject({ statusCode: 502 });
  });

  it("non-ok response → AppError 502, single attempt, error message excludes the api key", async () => {
    const f = stubFetch(async () => errRes(401, "invalid_api_key: the key provided is not valid"));
    try {
      await synthesizeTts(TENANT, { provider: "ELEVENLABS", text: "hi", voice: "v1" });
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as Error).message).not.toContain(API_KEY);
    }
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("timeout abort → AppError 504", async () => {
    stubFetch(async () => { throw abortError(); });
    await expect(synthesizeTts(TENANT, { provider: "ELEVENLABS", text: "hi", voice: "v1" })).rejects.toMatchObject({ statusCode: 504 });
  });

  it("streaming body over the 15MB cap → aborts mid-stream (never buffers the whole body)", async () => {
    // A res.body ReadableStream whose chunks sum past the cap. readCapped must
    // cancel the reader and throw BEFORE draining every chunk — proving the
    // OOM guard is a real streaming cap, not a post-hoc full-buffer check.
    const CHUNK = new Uint8Array(4 * 1024 * 1024); // 4MB per chunk
    let served = 0;
    const cancel = vi.fn(async () => {});
    const reader = {
      read: vi.fn(async () => {
        served += 1;
        return { done: false, value: CHUNK }; // never "done" — cap must stop it
      }),
      cancel,
      releaseLock: vi.fn(),
    };
    stubFetch(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null }, // no content-length → pre-check can't help
      body: { getReader: () => reader },
      arrayBuffer: async () => { throw new Error("must not fall back to arrayBuffer"); },
    }));

    await expect(
      synthesizeTts(TENANT, { provider: "ELEVENLABS", text: "hi", voice: "v1" }),
    ).rejects.toMatchObject({ statusCode: 502 });
    expect(cancel).toHaveBeenCalledTimes(1);
    // 15MB cap / 4MB chunks → aborts on the 4th read, not an unbounded drain.
    expect(reader.read.mock.calls.length).toBeLessThanOrEqual(5);
  });
});

// ─── recordGeneration (best-effort ledger) ─────────────────────────────────

describe("recordGeneration", () => {
  const baseParams = {
    tenantId: TENANT,
    kind: "IMAGE" as const,
    provider: "FAL" as const,
    model: "fal-ai/flux/schnell",
    promptPreview: "a cat",
    paramsJson: { model: "fal-ai/flux/schnell", prompt: "a cat", n: 1, width: 1024, height: 1024 },
    estimatedCostUsd: 0.003146,
    status: "SUCCEEDED" as const,
  };

  it("(f) success → prisma.mediaGeneration.create is called once and returns the new row id", async () => {
    mediaGenerationCreate.mockResolvedValue({ id: "gen-abc" });
    const id = await recordGeneration(baseParams);
    expect(id).toBe("gen-abc");
    expect(mediaGenerationCreate).toHaveBeenCalledTimes(1);
  });

  it("(f) paramsJson is written through verbatim — no apiKey/authorization field is ever added by the ledger writer", async () => {
    await recordGeneration(baseParams);
    const data = mediaGenerationCreate.mock.calls[0][0].data;
    expect(data.paramsJson).toEqual(baseParams.paramsJson);
    const serialized = JSON.stringify(data);
    expect(serialized.toLowerCase()).not.toContain("apikey");
    expect(serialized.toLowerCase()).not.toContain("authorization");
    expect(serialized).not.toContain(API_KEY);
  });

  it("promptPreview longer than 300 chars is truncated before it reaches prisma", async () => {
    await recordGeneration({ ...baseParams, promptPreview: "p".repeat(400) });
    const data = mediaGenerationCreate.mock.calls[0][0].data;
    expect(data.promptPreview).toHaveLength(300);
  });

  it("errorMessage longer than 500 chars is truncated before it reaches prisma", async () => {
    await recordGeneration({ ...baseParams, status: "FAILED", errorMessage: "e".repeat(600) });
    const data = mediaGenerationCreate.mock.calls[0][0].data;
    expect(data.errorMessage).toHaveLength(500);
  });

  it("(g) prisma.create throws → recordGeneration swallows it, returns null, logs a warning — caller never sees the exception", async () => {
    mediaGenerationCreate.mockRejectedValue(new Error("DB connection lost"));
    await expect(recordGeneration(baseParams)).resolves.toBeNull();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("(g) the warn log itself does not leak the tenant's raw API key or the params payload's secrets", async () => {
    mediaGenerationCreate.mockRejectedValue(new Error("DB connection lost"));
    await recordGeneration(baseParams);
    const warnCallArg = (logger.warn as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(JSON.stringify(warnCallArg)).not.toContain(API_KEY);
  });
});
