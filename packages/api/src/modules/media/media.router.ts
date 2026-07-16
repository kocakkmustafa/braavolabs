/**
 * Medya orkestrasyonu router'ı (FAZ E) — BYOK-only image (fal.ai FLUX) +
 * TTS (Google Cloud TTS / ElevenLabs) üretimi. Tümü authMiddleware
 * arkasında; tenant izolasyonu req.auth!.tenantId ile.
 *
 * Surfaces:
 *   GET    /catalog             sağlayıcı+anahtar durumu, model/fiyat katalogu
 *   PUT    /keys/:provider      BYOK anahtarı kaydet (encryptForTenant)
 *   DELETE /keys/:provider      BYOK anahtarı sil
 *   POST   /preview             maliyet tahmini (üretim YOK)
 *   POST   /generate            maliyet-ack zorunlu üretim
 *   GET    /generations         tenant geçmişi
 *   GET    /generations/:id     tek kayıt (cross-tenant 404)
 */

import { Router } from "express";
import { z } from "zod";
import { authMiddleware } from "../../middleware/auth";
import { AppError } from "../../middleware/error";
import { prisma } from "../../lib/db";
import { logger } from "../../lib/logger";
import { encryptForTenant, decryptForTenant } from "../../lib/encryption";
import { IMAGE_PRICES, TTS_PRICES, PRICING_CAPTURED_AT, estimateImage, estimateTts, type TtsProvider } from "../../lib/mediaPricing";
import { generateImage, synthesizeTts, recordGeneration } from "./media.service";
import type { MediaProvider } from "@prisma/client";

export const mediaRouter = Router();
mediaRouter.use(authMiddleware);

const MEDIA_PROVIDERS = ["FAL", "ELEVENLABS", "GOOGLE_TTS"] as const;
const IMAGE_MODEL_KEYS = Object.keys(IMAGE_PRICES) as [string, ...string[]];

const VIDEO_NOT_AVAILABLE_MESSAGE =
  "VIDEO_PREMIUM_NOT_AVAILABLE: video üretimi premium — henüz canlı değil; image + voice canlı";

// ─── GET /catalog ─────────────────────────────────────────────────────────

mediaRouter.get("/catalog", async (req, res, next) => {
  try {
    const rows = await prisma.mediaProviderKey.findMany({
      where: { tenantId: req.auth!.tenantId },
    });
    const byProvider = new Map(rows.map((row) => [row.provider, row]));

    const providers = MEDIA_PROVIDERS.map((provider) => {
      const row = byProvider.get(provider);
      if (!row) return { provider, configured: false, keyMasked: null as string | null };
      let keyMasked: string;
      try {
        keyMasked = "••••" + decryptForTenant(row.encryptedApiKey, req.auth!.tenantId).slice(-4);
      } catch {
        keyMasked = "••••????";
      }
      return { provider, configured: true, keyMasked };
    });

    res.json({
      providers,
      models: {
        image: Object.entries(IMAGE_PRICES).map(([model, price]) => ({
          model,
          usdPerMegapixel: price.usdPerMegapixel,
        })),
        tts: TTS_PRICES,
      },
      pricingNote:
        "tüm rakamlar tahmindir (captured ~2026-07); gerçek fatura sağlayıcınızın planına/kotasına bağlı",
    });
  } catch (err) { next(err); }
});

// ─── PUT /keys/:provider ──────────────────────────────────────────────────

const providerParamSchema = z.enum(MEDIA_PROVIDERS);
const putKeySchema = z.object({
  apiKey: z.string().trim().min(8).max(500),
});

mediaRouter.put("/keys/:provider", async (req, res, next) => {
  try {
    const provider = providerParamSchema.parse(req.params.provider) as MediaProvider;
    const { apiKey } = putKeySchema.parse(req.body);
    const encryptedApiKey = encryptForTenant(apiKey, req.auth!.tenantId);

    await prisma.mediaProviderKey.upsert({
      where: { tenantId_provider: { tenantId: req.auth!.tenantId, provider } },
      create: { tenantId: req.auth!.tenantId, provider, encryptedApiKey },
      update: { encryptedApiKey },
    });

    // Anahtar loglanmaz — sadece maskeli sonuç döner.
    res.json({ provider, keyMasked: "••••" + apiKey.slice(-4) });
  } catch (err) { next(err); }
});

// ─── DELETE /keys/:provider ───────────────────────────────────────────────

mediaRouter.delete("/keys/:provider", async (req, res, next) => {
  try {
    const provider = providerParamSchema.parse(req.params.provider) as MediaProvider;
    await prisma.mediaProviderKey.deleteMany({
      where: { tenantId: req.auth!.tenantId, provider },
    });
    res.status(204).end();
  } catch (err) { next(err); }
});

// ─── Preview / Generate ortak şema ────────────────────────────────────────

const imageBodySchema = z.object({
  kind: z.literal("image"),
  model: z.enum(IMAGE_MODEL_KEYS),
  prompt: z.string().min(1).max(2000),
  n: z.number().int().min(1).max(4).default(1),
  width: z.number().int().min(256).max(1536).default(1024),
  height: z.number().int().min(256).max(1536).default(1024),
});

const ttsBodySchema = z.object({
  kind: z.literal("tts"),
  provider: z.enum(["GOOGLE_TTS", "ELEVENLABS"]),
  text: z.string().min(1).max(5000),
  voice: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/).optional(),
  model: z.string().regex(/^[a-z0-9_]{1,48}$/).optional(),
});

const previewBodySchema = z.discriminatedUnion("kind", [imageBodySchema, ttsBodySchema]);

const acknowledgedCostSchema = z.object({ acknowledgedCostUsd: z.number().finite().min(0) });
const generateBodySchema = z.discriminatedUnion("kind", [
  imageBodySchema.merge(acknowledgedCostSchema),
  ttsBodySchema.merge(acknowledgedCostSchema),
]);

/** ElevenLabs "model" ledger alanı için sağlayıcı-efektif varsayılanla eşleşir. */
function resolveTtsModelLabel(input: z.infer<typeof ttsBodySchema>): string {
  if (input.provider === "ELEVENLABS") return input.model ?? "eleven_multilingual_v2";
  // Google TTS'te "model" kavramı yok — ses adı en yakın anlamlı etiket.
  return input.voice ?? "default";
}

function computeEstimate(input: z.infer<typeof previewBodySchema>) {
  if (input.kind === "image") {
    return { estimate: estimateImage(input.model, input.n, input.width, input.height), mediaProvider: "FAL" as MediaProvider };
  }
  return {
    estimate: estimateTts(input.provider as TtsProvider, input.text.length, input.voice),
    mediaProvider: input.provider as MediaProvider,
  };
}

// ─── POST /preview ─────────────────────────────────────────────────────────

mediaRouter.post("/preview", async (req, res, next) => {
  try {
    if ((req.body as { kind?: unknown } | null | undefined)?.kind === "video") {
      throw new AppError(400, VIDEO_NOT_AVAILABLE_MESSAGE);
    }
    const input = previewBodySchema.parse(req.body);
    const { estimate, mediaProvider } = computeEstimate(input);

    const keyRow = await prisma.mediaProviderKey.findUnique({
      where: { tenantId_provider: { tenantId: req.auth!.tenantId, provider: mediaProvider } },
      select: { id: true },
    });

    res.json({ estimate, keyConfigured: !!keyRow, acknowledgementRequired: true });
  } catch (err) { next(err); }
});

// ─── POST /generate ─────────────────────────────────────────────────────────

mediaRouter.post("/generate", async (req, res, next) => {
  try {
    if ((req.body as { kind?: unknown } | null | undefined)?.kind === "video") {
      throw new AppError(400, VIDEO_NOT_AVAILABLE_MESSAGE);
    }
    const body = generateBodySchema.parse(req.body);
    const { estimate, mediaProvider } = computeEstimate(body);

    // Dürüstlük mandate'i: maliyeti görmeden üretim yok. Sunucu tahmini
    // burada YENİDEN hesaplandı (client'tan estimate ASLA kabul edilmiyor,
    // yalnız acknowledgedCostUsd) — bu, o tahminle karşılaştırılıyor.
    if (estimate.usd > body.acknowledgedCostUsd + 1e-9) {
      res.status(400).json({
        code: "COST_ACK_REQUIRED",
        message: "Sunucu tahmini onaylanan maliyeti aşıyor — üretim öncesi maliyeti tekrar onaylayın.",
        estimate,
      });
      return;
    }

    if (body.kind === "image") {
      const promptPreview = body.prompt;
      const model = body.model;
      const paramsJson = { model: body.model, prompt: body.prompt, n: body.n, width: body.width, height: body.height, pricingCapturedAt: PRICING_CAPTURED_AT };

      let result: Awaited<ReturnType<typeof generateImage>>;
      try {
        result = await generateImage(req.auth!.tenantId, {
          model: body.model,
          prompt: body.prompt,
          n: body.n,
          width: body.width,
          height: body.height,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        const generationId = await recordGeneration({
          tenantId: req.auth!.tenantId,
          kind: "IMAGE",
          provider: mediaProvider,
          model,
          promptPreview,
          paramsJson,
          estimatedCostUsd: estimate.usd,
          status: "FAILED",
          errorMessage: message,
        });
        logger.warn({ tenantId: req.auth!.tenantId, kind: "image", provider: mediaProvider, generationId }, "media generation failed");
        throw err instanceof AppError ? err : new AppError(502, message);
      }

      const generationId = await recordGeneration({
        tenantId: req.auth!.tenantId,
        kind: "IMAGE",
        provider: mediaProvider,
        model,
        promptPreview,
        paramsJson,
        estimatedCostUsd: estimate.usd,
        status: "SUCCEEDED",
        resultUrl: result.images[0]?.url,
        resultMeta: { images: result.images, urlNote: result.urlNote },
      });

      res.json({
        generationId,
        // Ledger yazımı best-effort: DB hatasında generationId null döner ama
        // üretim gerçekleşti (tenant parası gitti). Kullanıcıya audit satırının
        // yazılamadığını dürüstçe bildir.
        ledgerRecorded: generationId !== null,
        estimate,
        result,
        storageNote: "görsel URL'leri sağlayıcı CDN'inde barınır; süresi dolabilir.",
      });
      return;
    }

    // body.kind === "tts"
    const promptPreview = body.text;
    const model = resolveTtsModelLabel(body);
    const paramsJson = { provider: body.provider, textLength: body.text.length, voice: body.voice ?? null, model: body.model ?? null, pricingCapturedAt: PRICING_CAPTURED_AT };

    let result: Awaited<ReturnType<typeof synthesizeTts>>;
    try {
      result = await synthesizeTts(req.auth!.tenantId, {
        provider: body.provider as TtsProvider,
        text: body.text,
        voice: body.voice,
        model: body.model,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      const generationId = await recordGeneration({
        tenantId: req.auth!.tenantId,
        kind: "TTS",
        provider: mediaProvider,
        model,
        promptPreview,
        paramsJson,
        estimatedCostUsd: estimate.usd,
        status: "FAILED",
        errorMessage: message,
      });
      logger.warn({ tenantId: req.auth!.tenantId, kind: "tts", provider: mediaProvider, generationId }, "media generation failed");
      throw err instanceof AppError ? err : new AppError(502, message);
    }

    const generationId = await recordGeneration({
      tenantId: req.auth!.tenantId,
      kind: "TTS",
      provider: mediaProvider,
      model,
      promptPreview,
      paramsJson,
      estimatedCostUsd: estimate.usd,
      status: "SUCCEEDED",
      resultMeta: { mime: result.mime, chars: result.chars },
    });

    res.json({
      generationId,
      ledgerRecorded: generationId !== null,
      estimate,
      result,
      storageNote: "TTS ses içeriği yalnız bu yanıtta döner, sunucuda saklanmaz.",
    });
  } catch (err) { next(err); }
});

// ─── GET /generations ───────────────────────────────────────────────────────

mediaRouter.get("/generations", async (req, res, next) => {
  try {
    // Math.max(1, …) negatif/0 take'in Prisma'da ters-take'e dönmesini engeller.
    const take = Math.max(1, Math.min(Number(req.query.take) || 20, 50));
    const generations = await prisma.mediaGeneration.findMany({
      where: { tenantId: req.auth!.tenantId },
      orderBy: { createdAt: "desc" },
      take,
    });
    res.json({ generations });
  } catch (err) { next(err); }
});

// ─── GET /generations/:id ───────────────────────────────────────────────────

mediaRouter.get("/generations/:id", async (req, res, next) => {
  try {
    const generation = await prisma.mediaGeneration.findFirst({
      where: { id: req.params.id, tenantId: req.auth!.tenantId },
    });
    if (!generation) throw new AppError(404, "Generation not found");
    res.json(generation);
  } catch (err) { next(err); }
});
