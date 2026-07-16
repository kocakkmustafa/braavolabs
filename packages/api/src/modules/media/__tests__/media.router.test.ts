/**
 * FAZ E B3 — media.router.ts unit coverage.
 *
 * Same harness as modules/run/__tests__/handoff-router.test.ts: handlers are
 * pulled directly off the Express Router stack and driven with a mock
 * req/res/next. authMiddleware is mocked to pass through (auth is injected
 * per-request by the test harness); ./media.service is mocked wholesale so
 * this file stays about the HTTP surface — request validation (zod), the
 * mandatory cost-acknowledgement gate, tenant-scoped prisma queries, and
 * key-masking — not the provider HTTP contract (that's media.service.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Router } from "express";

vi.mock("../../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mediaProviderKeyFindMany = vi.hoisted(() => vi.fn());
const mediaProviderKeyFindUnique = vi.hoisted(() => vi.fn());
const mediaProviderKeyUpsert = vi.hoisted(() => vi.fn());
const mediaProviderKeyDeleteMany = vi.hoisted(() => vi.fn());
const mediaGenerationFindMany = vi.hoisted(() => vi.fn());
const mediaGenerationFindFirst = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/db", () => ({
  prisma: {
    mediaProviderKey: {
      findMany: (...a: unknown[]) => mediaProviderKeyFindMany(...a),
      findUnique: (...a: unknown[]) => mediaProviderKeyFindUnique(...a),
      upsert: (...a: unknown[]) => mediaProviderKeyUpsert(...a),
      deleteMany: (...a: unknown[]) => mediaProviderKeyDeleteMany(...a),
    },
    mediaGeneration: {
      findMany: (...a: unknown[]) => mediaGenerationFindMany(...a),
      findFirst: (...a: unknown[]) => mediaGenerationFindFirst(...a),
    },
  },
}));

const encryptForTenantMock = vi.hoisted(() => vi.fn());
const decryptForTenantMock = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/encryption", () => ({
  encryptForTenant: (...a: unknown[]) => encryptForTenantMock(...a),
  decryptForTenant: (...a: unknown[]) => decryptForTenantMock(...a),
}));

vi.mock("../../../middleware/auth", () => ({
  authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const generateImageMock = vi.hoisted(() => vi.fn());
const synthesizeTtsMock = vi.hoisted(() => vi.fn());
const recordGenerationMock = vi.hoisted(() => vi.fn());
vi.mock("../media.service", () => ({
  generateImage: (...a: unknown[]) => generateImageMock(...a),
  synthesizeTts: (...a: unknown[]) => synthesizeTtsMock(...a),
  recordGeneration: (...a: unknown[]) => recordGenerationMock(...a),
}));

import { mediaRouter } from "../media.router";
import { estimateImage, estimateTts } from "../../../lib/mediaPricing";

const TENANT = "tenant-1";
const OTHER_TENANT = "tenant-2";

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
    ended: false,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
    end() { this.ended = true; return this; },
  };
  return res;
}

async function invoke(handler: (req: any, res: any, next: any) => Promise<void> | void, req: any) {
  const res = mockRes();
  let nextErr: any;
  const next = (err?: any) => { nextErr = err; };
  await handler(
    { auth: { tenantId: TENANT, userId: "user-1", role: "admin" }, params: {}, body: {}, query: {}, ...req },
    res,
    next,
  );
  return { res, nextErr };
}

beforeEach(() => {
  vi.clearAllMocks();
  mediaProviderKeyFindMany.mockResolvedValue([]);
  mediaProviderKeyFindUnique.mockResolvedValue(null);
  mediaProviderKeyUpsert.mockResolvedValue({});
  mediaProviderKeyDeleteMany.mockResolvedValue({ count: 1 });
  mediaGenerationFindMany.mockResolvedValue([]);
  mediaGenerationFindFirst.mockResolvedValue(null);
  encryptForTenantMock.mockImplementation((plaintext: string) => `enc(${plaintext})`);
  decryptForTenantMock.mockImplementation((encoded: string) => encoded.replace(/^enc\(/, "").replace(/\)$/, ""));
  generateImageMock.mockResolvedValue({ images: [{ url: "https://fal.cdn/img.png", width: 1024, height: 1024 }], urlNote: "cdn note" });
  synthesizeTtsMock.mockResolvedValue({ audioBase64: "QUJD", mime: "audio/mpeg", chars: 5 });
  recordGenerationMock.mockResolvedValue("gen-1");
});

// ─── GET /catalog ─────────────────────────────────────────────────────────

describe("GET /media/catalog", () => {
  const handler = getHandler(mediaRouter, "get", "/catalog");

  it("(q) configured provider → keyMasked is '••••' + last 4 of the DECRYPTED key, raw key never appears in the response", async () => {
    mediaProviderKeyFindMany.mockResolvedValue([
      { id: "k1", tenantId: TENANT, provider: "FAL", encryptedApiKey: "enc(super-secret-abcd1234)" },
    ]);
    const { res } = await invoke(handler, {});
    const falRow = res.body.providers.find((p: any) => p.provider === "FAL");
    expect(falRow).toEqual({ provider: "FAL", configured: true, keyMasked: "••••1234" });
    expect(JSON.stringify(res.body)).not.toContain("super-secret-abcd1234");
  });

  it("unconfigured providers report configured:false and keyMasked:null", async () => {
    mediaProviderKeyFindMany.mockResolvedValue([]);
    const { res } = await invoke(handler, {});
    expect(res.body.providers).toEqual([
      { provider: "FAL", configured: false, keyMasked: null },
      { provider: "ELEVENLABS", configured: false, keyMasked: null },
      { provider: "GOOGLE_TTS", configured: false, keyMasked: null },
    ]);
  });

  it("model/price catalog mirrors mediaPricing's IMAGE_PRICES and TTS_PRICES, with a pricing-is-an-estimate disclaimer", async () => {
    const { res } = await invoke(handler, {});
    expect(res.body.models.image).toEqual(
      expect.arrayContaining([expect.objectContaining({ model: "fal-ai/flux/schnell", usdPerMegapixel: 0.003 })]),
    );
    expect(res.body.models.tts.GOOGLE_TTS.standardPerMChars).toBe(4);
    expect(res.body.pricingNote).toMatch(/tahmindir/);
  });

  it("queries mediaProviderKey.findMany scoped to the caller's own tenantId", async () => {
    await invoke(handler, {});
    expect(mediaProviderKeyFindMany).toHaveBeenCalledWith({ where: { tenantId: TENANT } });
  });
});

// ─── PUT /keys/:provider ──────────────────────────────────────────────────

describe("PUT /media/keys/:provider", () => {
  const handler = getHandler(mediaRouter, "put", "/keys/:provider");

  it("invalid provider name → zod validation error forwarded to next()", async () => {
    const { nextErr } = await invoke(handler, { params: { provider: "NOT_A_PROVIDER" }, body: { apiKey: "a-long-enough-key" } });
    expect(nextErr).toBeDefined();
    expect(nextErr.name).toBe("ZodError");
  });

  it("apiKey shorter than 8 chars → zod validation error", async () => {
    const { nextErr } = await invoke(handler, { params: { provider: "FAL" }, body: { apiKey: "short" } });
    expect(nextErr).toBeDefined();
    expect(nextErr.name).toBe("ZodError");
  });

  it("(p) happy path: encryptForTenant is called with the RAW key and the caller's own tenantId; response contains only the mask", async () => {
    const { res, nextErr } = await invoke(handler, { params: { provider: "FAL" }, body: { apiKey: "sk-live-abcd1234" } });

    expect(nextErr).toBeUndefined();
    expect(encryptForTenantMock).toHaveBeenCalledWith("sk-live-abcd1234", TENANT);
    expect(mediaProviderKeyUpsert).toHaveBeenCalledWith({
      where: { tenantId_provider: { tenantId: TENANT, provider: "FAL" } },
      create: { tenantId: TENANT, provider: "FAL", encryptedApiKey: "enc(sk-live-abcd1234)" },
      update: { encryptedApiKey: "enc(sk-live-abcd1234)" },
    });
    expect(res.body).toEqual({ provider: "FAL", keyMasked: "••••1234" });
    expect(JSON.stringify(res.body)).not.toContain("sk-live-abcd1234");
  });

  it("upserts under a different tenant's id when that tenant is the caller — never a hardcoded/shared id", async () => {
    await invoke(handler, { auth: { tenantId: OTHER_TENANT, userId: "u2", role: "admin" }, params: { provider: "GOOGLE_TTS" }, body: { apiKey: "another-long-key" } });
    expect(encryptForTenantMock).toHaveBeenCalledWith("another-long-key", OTHER_TENANT);
    expect(mediaProviderKeyUpsert.mock.calls[0][0].where).toEqual({ tenantId_provider: { tenantId: OTHER_TENANT, provider: "GOOGLE_TTS" } });
  });
});

// ─── DELETE /keys/:provider ───────────────────────────────────────────────

describe("DELETE /media/keys/:provider", () => {
  const handler = getHandler(mediaRouter, "delete", "/keys/:provider");

  it("invalid provider name → zod validation error", async () => {
    const { nextErr } = await invoke(handler, { params: { provider: "BOGUS" } });
    expect(nextErr).toBeDefined();
    expect(nextErr.name).toBe("ZodError");
  });

  it("(u) deletes only the caller's own tenant+provider row, responds 204", async () => {
    const { res, nextErr } = await invoke(handler, { params: { provider: "ELEVENLABS" } });
    expect(nextErr).toBeUndefined();
    expect(mediaProviderKeyDeleteMany).toHaveBeenCalledWith({ where: { tenantId: TENANT, provider: "ELEVENLABS" } });
    expect(res.statusCode).toBe(204);
    expect(res.ended).toBe(true);
  });

  it("(u) a different tenant's DELETE call scopes to ITS OWN tenantId, not TENANT", async () => {
    await invoke(handler, { auth: { tenantId: OTHER_TENANT, userId: "u2", role: "admin" }, params: { provider: "FAL" } });
    expect(mediaProviderKeyDeleteMany).toHaveBeenCalledWith({ where: { tenantId: OTHER_TENANT, provider: "FAL" } });
  });
});

// ─── POST /preview ─────────────────────────────────────────────────────────

describe("POST /media/preview", () => {
  const handler = getHandler(mediaRouter, "post", "/preview");

  it("(i) kind:'video' → 400 VIDEO_PREMIUM_NOT_AVAILABLE, short-circuits before any zod parse", async () => {
    const { nextErr } = await invoke(handler, { body: { kind: "video" } });
    expect(nextErr?.statusCode).toBe(400);
    expect(nextErr?.message).toMatch(/VIDEO_PREMIUM_NOT_AVAILABLE/);
  });

  it("image preview happy path: real estimateImage() shape, keyConfigured reflects the FAL row", async () => {
    mediaProviderKeyFindUnique.mockResolvedValue({ id: "k1" });
    const { res, nextErr } = await invoke(handler, {
      body: { kind: "image", model: "fal-ai/flux/schnell", prompt: "a cat", n: 1, width: 1024, height: 1024 },
    });
    expect(nextErr).toBeUndefined();
    expect(res.body.estimate).toEqual(estimateImage("fal-ai/flux/schnell", 1, 1024, 1024));
    expect(res.body.keyConfigured).toBe(true);
    expect(res.body.acknowledgementRequired).toBe(true);
    expect(mediaProviderKeyFindUnique).toHaveBeenCalledWith({
      where: { tenantId_provider: { tenantId: TENANT, provider: "FAL" } },
      select: { id: true },
    });
  });

  it("tts preview (GOOGLE_TTS) happy path: keyConfigured false when no row exists", async () => {
    mediaProviderKeyFindUnique.mockResolvedValue(null);
    const { res, nextErr } = await invoke(handler, { body: { kind: "tts", provider: "GOOGLE_TTS", text: "merhaba dünya" } });
    expect(nextErr).toBeUndefined();
    expect(res.body.estimate).toEqual(estimateTts("GOOGLE_TTS", "merhaba dünya".length, undefined));
    expect(res.body.keyConfigured).toBe(false);
  });

  it("tts preview (ELEVENLABS) happy path checks the ELEVENLABS key row, not GOOGLE_TTS's", async () => {
    mediaProviderKeyFindUnique.mockResolvedValue({ id: "k2" });
    await invoke(handler, { body: { kind: "tts", provider: "ELEVENLABS", text: "hello", voice: "v1" } });
    expect(mediaProviderKeyFindUnique).toHaveBeenCalledWith({
      where: { tenantId_provider: { tenantId: TENANT, provider: "ELEVENLABS" } },
      select: { id: true },
    });
  });

  it("(n) unknown image model → zod enum rejection, 400-shaped ZodError", async () => {
    const { nextErr } = await invoke(handler, { body: { kind: "image", model: "not-a-real-model", prompt: "x" } });
    expect(nextErr?.name).toBe("ZodError");
  });

  it("(n) n=5 (max 4) → zod validation error", async () => {
    const { nextErr } = await invoke(handler, { body: { kind: "image", model: "fal-ai/flux/schnell", prompt: "x", n: 5 } });
    expect(nextErr?.name).toBe("ZodError");
  });

  it("(n) width=2048 (max 1536) → zod validation error", async () => {
    const { nextErr } = await invoke(handler, { body: { kind: "image", model: "fal-ai/flux/schnell", prompt: "x", width: 2048 } });
    expect(nextErr?.name).toBe("ZodError");
  });

  it("(n) prompt of 2001 chars (max 2000) → zod validation error", async () => {
    const { nextErr } = await invoke(handler, { body: { kind: "image", model: "fal-ai/flux/schnell", prompt: "a".repeat(2001) } });
    expect(nextErr?.name).toBe("ZodError");
  });

  it("(n) tts text of 5001 chars (max 5000) → zod validation error", async () => {
    const { nextErr } = await invoke(handler, { body: { kind: "tts", provider: "GOOGLE_TTS", text: "a".repeat(5001) } });
    expect(nextErr?.name).toBe("ZodError");
  });

  it.each([
    ["path traversal", "../x"],
    ["embedded space", "voice one"],
    ["over max length (65 chars)", "v".repeat(65)],
  ])("(o) voice regex rejects %s", async (_label, badVoice) => {
    const { nextErr } = await invoke(handler, { body: { kind: "tts", provider: "GOOGLE_TTS", text: "hi", voice: badVoice } });
    expect(nextErr?.name).toBe("ZodError");
  });
});

// ─── POST /generate ─────────────────────────────────────────────────────────

describe("POST /media/generate", () => {
  const handler = getHandler(mediaRouter, "post", "/generate");

  it("(i) kind:'video' → 400 VIDEO_PREMIUM_NOT_AVAILABLE", async () => {
    const { nextErr } = await invoke(handler, { body: { kind: "video" } });
    expect(nextErr?.statusCode).toBe(400);
    expect(nextErr?.message).toMatch(/VIDEO_PREMIUM_NOT_AVAILABLE/);
  });

  it("(j) missing acknowledgedCostUsd → zod validation error, service never called", async () => {
    const { nextErr } = await invoke(handler, {
      body: { kind: "image", model: "fal-ai/flux/schnell", prompt: "a cat", n: 1, width: 1024, height: 1024 },
    });
    expect(nextErr?.name).toBe("ZodError");
    expect(generateImageMock).not.toHaveBeenCalled();
  });

  it.each([
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["negative", -1],
  ])("(m) acknowledgedCostUsd=%s → zod validation error before the cost-ack gate runs", async (_label, badAck) => {
    const { nextErr } = await invoke(handler, {
      body: { kind: "image", model: "fal-ai/flux/schnell", prompt: "a cat", acknowledgedCostUsd: badAck },
    });
    expect(nextErr?.name).toBe("ZodError");
    expect(generateImageMock).not.toHaveBeenCalled();
  });

  it("(k) acknowledgedCostUsd below the freshly recomputed server estimate → 400 COST_ACK_REQUIRED, carries a fresh estimate, service never called", async () => {
    const real = estimateImage("fal-ai/flux/schnell", 1, 1024, 1024);
    const { res, nextErr } = await invoke(handler, {
      body: { kind: "image", model: "fal-ai/flux/schnell", prompt: "a cat", n: 1, width: 1024, height: 1024, acknowledgedCostUsd: real.usd - 0.001 },
    });
    expect(nextErr).toBeUndefined();
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe("COST_ACK_REQUIRED");
    expect(res.body.estimate).toEqual(real);
    expect(generateImageMock).not.toHaveBeenCalled();
    expect(recordGenerationMock).not.toHaveBeenCalled();
  });

  it("(l) acknowledgedCostUsd meets/exceeds the server estimate → generateImage IS called, ledger recorded SUCCEEDED, response includes generationId+estimate+result", async () => {
    const real = estimateImage("fal-ai/flux/schnell", 1, 1024, 1024);
    const { res, nextErr } = await invoke(handler, {
      body: { kind: "image", model: "fal-ai/flux/schnell", prompt: "a cat", n: 1, width: 1024, height: 1024, acknowledgedCostUsd: real.usd },
    });

    expect(nextErr).toBeUndefined();
    expect(generateImageMock).toHaveBeenCalledWith(TENANT, { model: "fal-ai/flux/schnell", prompt: "a cat", n: 1, width: 1024, height: 1024 });
    expect(recordGenerationMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT, kind: "IMAGE", provider: "FAL", status: "SUCCEEDED", estimatedCostUsd: real.usd,
    }));
    expect(res.body.generationId).toBe("gen-1");
    expect(res.body.ledgerRecorded).toBe(true);
    expect(res.body.estimate).toEqual(real);
    expect(res.body.result.images).toEqual([{ url: "https://fal.cdn/img.png", width: 1024, height: 1024 }]);
    // pricingCapturedAt is written into the ledger params for audit traceability.
    expect(recordGenerationMock.mock.calls[0][0].paramsJson).toMatchObject({ pricingCapturedAt: "2026-07" });
  });

  it("SUCCEEDED but ledger write fails (generationId null) → response honestly flags ledgerRecorded:false", async () => {
    recordGenerationMock.mockResolvedValue(null);
    const real = estimateImage("fal-ai/flux/schnell", 1, 1024, 1024);
    const { res } = await invoke(handler, {
      body: { kind: "image", model: "fal-ai/flux/schnell", prompt: "a cat", n: 1, width: 1024, height: 1024, acknowledgedCostUsd: real.usd },
    });
    expect(res.body.generationId).toBeNull();
    expect(res.body.ledgerRecorded).toBe(false);
    // The generated result is still returned — the user's provider charge happened.
    expect(res.body.result.images.length).toBeGreaterThan(0);
  });

  it("(l) tts generate happy path calls synthesizeTts and records the TTS ledger row", async () => {
    const real = estimateTts("ELEVENLABS", "hello".length, undefined);
    const { res, nextErr } = await invoke(handler, {
      body: { kind: "tts", provider: "ELEVENLABS", text: "hello", voice: "v1", acknowledgedCostUsd: real.usd },
    });
    expect(nextErr).toBeUndefined();
    expect(synthesizeTtsMock).toHaveBeenCalledWith(TENANT, { provider: "ELEVENLABS", text: "hello", voice: "v1", model: undefined });
    expect(recordGenerationMock).toHaveBeenCalledWith(expect.objectContaining({ kind: "TTS", provider: "ELEVENLABS", status: "SUCCEEDED" }));
    expect(res.body.result.audioBase64).toBe("QUJD");
  });

  it("(e) service throws (simulated provider 500 surfaced as AppError 502) → FAILED ledger row recorded, error propagated with no key leak, response is the error not a 200", async () => {
    const providerErr = Object.assign(new Error("fal.ai request failed (500): upstream unavailable"), { name: "AppError", statusCode: 502 });
    generateImageMock.mockRejectedValue(providerErr);
    const real = estimateImage("fal-ai/flux/schnell", 1, 1024, 1024);

    const { nextErr } = await invoke(handler, {
      body: { kind: "image", model: "fal-ai/flux/schnell", prompt: "a cat", n: 1, width: 1024, height: 1024, acknowledgedCostUsd: real.usd },
    });

    expect(nextErr?.statusCode).toBe(502);
    expect(recordGenerationMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT, kind: "IMAGE", status: "FAILED", errorMessage: providerErr.message,
    }));
    expect(JSON.stringify(recordGenerationMock.mock.calls[0][0])).not.toMatch(/sk-[a-z0-9-]+key/i);
  });

  it("(n) n=5 on generate → zod validation error, service never called", async () => {
    const { nextErr } = await invoke(handler, {
      body: { kind: "image", model: "fal-ai/flux/schnell", prompt: "x", n: 5, acknowledgedCostUsd: 100 },
    });
    expect(nextErr?.name).toBe("ZodError");
    expect(generateImageMock).not.toHaveBeenCalled();
  });

  it("(o) invalid voice on generate → zod validation error, service never called", async () => {
    const { nextErr } = await invoke(handler, {
      body: { kind: "tts", provider: "GOOGLE_TTS", text: "hi", voice: "../etc/passwd", acknowledgedCostUsd: 100 },
    });
    expect(nextErr?.name).toBe("ZodError");
    expect(synthesizeTtsMock).not.toHaveBeenCalled();
  });
});

// ─── GET /generations ───────────────────────────────────────────────────────

describe("GET /media/generations", () => {
  const handler = getHandler(mediaRouter, "get", "/generations");

  it("(r) findMany is scoped to the caller's own tenantId, newest first, default take=20", async () => {
    await invoke(handler, { query: {} });
    expect(mediaGenerationFindMany).toHaveBeenCalledWith({
      where: { tenantId: TENANT },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
  });

  it("take is clamped to a maximum of 50 even if the query asks for more", async () => {
    await invoke(handler, { query: { take: "999" } });
    expect(mediaGenerationFindMany.mock.calls[0][0].take).toBe(50);
  });

  it("non-numeric take falls back to the default of 20", async () => {
    await invoke(handler, { query: { take: "not-a-number" } });
    expect(mediaGenerationFindMany.mock.calls[0][0].take).toBe(20);
  });

  it("a negative take is clamped up to 1 (never a Prisma reverse-take)", async () => {
    await invoke(handler, { query: { take: "-5" } });
    expect(mediaGenerationFindMany.mock.calls[0][0].take).toBe(1);
  });

  it("a different tenant's request is scoped to ITS OWN tenantId", async () => {
    await invoke(handler, { auth: { tenantId: OTHER_TENANT, userId: "u2", role: "admin" }, query: {} });
    expect(mediaGenerationFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: OTHER_TENANT } }));
  });
});

// ─── GET /generations/:id ───────────────────────────────────────────────────

describe("GET /media/generations/:id", () => {
  const handler = getHandler(mediaRouter, "get", "/generations/:id");

  it("(s) found row for the caller's own tenant → returned as-is", async () => {
    mediaGenerationFindFirst.mockResolvedValue({ id: "gen-1", tenantId: TENANT, kind: "IMAGE" });
    const { res, nextErr } = await invoke(handler, { params: { id: "gen-1" } });
    expect(nextErr).toBeUndefined();
    expect(res.body).toEqual({ id: "gen-1", tenantId: TENANT, kind: "IMAGE" });
  });

  it("(s) query is scoped by BOTH id and the caller's tenantId (cross-tenant lookup shape)", async () => {
    mediaGenerationFindFirst.mockResolvedValue({ id: "gen-1" });
    await invoke(handler, { params: { id: "gen-1" } });
    expect(mediaGenerationFindFirst).toHaveBeenCalledWith({ where: { id: "gen-1", tenantId: TENANT } });
  });

  it("(s) another tenant's generation id → findFirst (tenant-scoped) returns null → AppError 404, never leaks existence", async () => {
    mediaGenerationFindFirst.mockResolvedValue(null);
    const { nextErr } = await invoke(handler, { params: { id: "someone-elses-gen" } });
    expect(nextErr?.statusCode).toBe(404);
  });
});
