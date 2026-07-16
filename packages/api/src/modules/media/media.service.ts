/**
 * Medya orkestrasyonu (FAZ E) — BYOK-only image (fal.ai FLUX) ve TTS
 * (Google Cloud TTS / ElevenLabs) üretimi.
 *
 * Sabit sağlayıcı host'ları — kullanıcıdan baseUrl alınmıyor, dolayısıyla bu
 * modülde SSRF yapısal olarak imkânsız (modules/external'ın rastgele-webhook
 * adaptörlerinin aksine, onlar assertPublicUrl'e ihtiyaç duyar). Her çağrı
 * TEK deneme: paid bir sağlayıcı çağrısı harcanmış paradır — retry etmek
 * çifte-harcama riski taşır.
 *
 * Fail-closed BYOK: bu modülde sistem/env fallback anahtarı YOK, trial
 * kredisi YOK (D-009 dersi — bkz. FABLE plan). Kendi anahtarı olmayan tenant
 * sessizce sistem kimliğiyle faturalandırılmaz — 402 alır.
 */

import { prisma } from "../../lib/db";
import { logger } from "../../lib/logger";
import { AppError } from "../../middleware/error";
import { decryptForTenant } from "../../lib/encryption";
import type { MediaProvider, MediaGenerationKind, MediaGenerationStatus, Prisma } from "@prisma/client";
import type { TtsProvider } from "../../lib/mediaPricing";

const FAL_HOST = "https://fal.run";
const GOOGLE_TTS_URL = "https://texttospeech.googleapis.com/v1/text:synthesize";
const elevenLabsTtsUrl = (voiceId: string) =>
  `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`;

const IMAGE_TIMEOUT_MS = 60_000;
const TTS_TIMEOUT_MS = 30_000;
const ELEVENLABS_MAX_BYTES = 15 * 1024 * 1024; // 15MB okuma tavanı

// ─── Tenant anahtarı (fail-closed) ──────────────────────────────────────

/**
 * Tenant'ın (provider) için sakladığı BYOK anahtarını çözer. Anahtar yoksa
 * AppError(402) fırlatır — sistem cüzdanı fallback'i YOK, trial YOK.
 */
export async function getTenantMediaKey(tenantId: string, provider: MediaProvider): Promise<string> {
  const row = await prisma.mediaProviderKey.findUnique({
    where: { tenantId_provider: { tenantId, provider } },
  });
  if (!row) {
    throw new AppError(
      402,
      `No ${provider} API key configured — media generation is BYOK-only (add your key under /media/keys)`,
    );
  }
  return decryptForTenant(row.encryptedApiKey, tenantId);
}

// ─── Hata gövdesi sanitizasyonu ─────────────────────────────────────────

/** Sağlayıcı hata gövdesini 200 karaktere kırpar — ham yanıttan anahtar/iç detay sızmasın. */
function truncateProviderError(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return "(empty response body)";
  return clean.length > 200 ? `${clean.slice(0, 200)}…` : clean;
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

// ─── Görsel üretimi (fal.ai) ─────────────────────────────────────────────

export interface GenerateImageParams {
  model: string;
  prompt: string;
  n: number;
  width: number;
  height: number;
}

export interface GenerateImageResult {
  images: Array<{ url: string; width?: number; height?: number }>;
  urlNote: string;
}

export async function generateImage(
  tenantId: string,
  params: GenerateImageParams,
): Promise<GenerateImageResult> {
  const apiKey = await getTenantMediaKey(tenantId, "FAL");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await fetch(`${FAL_HOST}/${params.model}`, {
        method: "POST",
        headers: {
          Authorization: `Key ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt: params.prompt,
          image_size: { width: params.width, height: params.height },
          num_images: params.n,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new AppError(504, "fal.ai request timed out after 60s");
      }
      throw new AppError(
        502,
        `fal.ai request failed: ${truncateProviderError(err instanceof Error ? err.message : String(err))}`,
      );
    }

    if (!res.ok) {
      const bodyText = await safeReadText(res);
      throw new AppError(502, `fal.ai request failed (${res.status}): ${truncateProviderError(bodyText)}`);
    }

    const data = (await res.json()) as { images?: Array<{ url?: unknown; width?: unknown; height?: unknown }> };
    const rawImages = Array.isArray(data.images) ? data.images : [];
    const images = rawImages
      .filter((img) => typeof img?.url === "string" && img.url.length > 0)
      .map((img) => ({
        url: img.url as string,
        width: typeof img.width === "number" ? img.width : undefined,
        height: typeof img.height === "number" ? img.height : undefined,
      }));

    if (images.length === 0) {
      throw new AppError(502, "fal.ai response did not include any image URLs");
    }

    return {
      images,
      urlNote: "sağlayıcı CDN'inde barınır; süresi dolabilir — kalıcı isteyen indirsin",
    };
  } finally {
    clearTimeout(timer);
  }
}

// ─── TTS üretimi (Google Cloud TTS / ElevenLabs) ─────────────────────────

export interface SynthesizeTtsParams {
  provider: TtsProvider;
  text: string;
  voice?: string;
  model?: string;
}

export interface SynthesizeTtsResult {
  audioBase64: string;
  mime: string;
  chars: number;
}

/**
 * Google ses adından languageCode türetir: ilk iki tire-ayrılı segment
 * (ör. "tr-TR-Standard-A" → "tr-TR"). Ses adı verilmemişse "en-US" varsayılır.
 */
function deriveGoogleLanguageCode(voiceName?: string): string {
  if (!voiceName) return "en-US";
  const segments = voiceName.split("-");
  return segments.length >= 2 ? `${segments[0]}-${segments[1]}` : voiceName;
}

async function synthesizeGoogleTts(apiKey: string, params: SynthesizeTtsParams, signal: AbortSignal): Promise<SynthesizeTtsResult> {
  const languageCode = deriveGoogleLanguageCode(params.voice);
  let res: Response;
  try {
    res = await fetch(GOOGLE_TTS_URL, {
      method: "POST",
      headers: {
        // Anahtar HEADER'da — ASLA query-param'da değil.
        "X-Goog-Api-Key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: { text: params.text },
        voice: { languageCode, ...(params.voice ? { name: params.voice } : {}) },
        audioConfig: { audioEncoding: "MP3" },
      }),
      signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new AppError(504, "Google TTS request timed out after 30s");
    }
    throw new AppError(
      502,
      `Google TTS request failed: ${truncateProviderError(err instanceof Error ? err.message : String(err))}`,
    );
  }

  if (!res.ok) {
    const bodyText = await safeReadText(res);
    throw new AppError(502, `Google TTS request failed (${res.status}): ${truncateProviderError(bodyText)}`);
  }

  const data = (await res.json()) as { audioContent?: unknown };
  if (typeof data.audioContent !== "string" || data.audioContent.length === 0) {
    throw new AppError(502, "Google TTS response did not include audioContent");
  }

  return { audioBase64: data.audioContent, mime: "audio/mpeg", chars: params.text.length };
}

async function synthesizeElevenLabsTts(apiKey: string, params: SynthesizeTtsParams, signal: AbortSignal): Promise<SynthesizeTtsResult> {
  if (!params.voice) {
    throw new AppError(400, "ElevenLabs TTS requires a voice (voice ID)");
  }

  let res: Response;
  try {
    res = await fetch(elevenLabsTtsUrl(params.voice), {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: params.text,
        model_id: params.model ?? "eleven_multilingual_v2",
      }),
      signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new AppError(504, "ElevenLabs request timed out after 30s");
    }
    throw new AppError(
      502,
      `ElevenLabs request failed: ${truncateProviderError(err instanceof Error ? err.message : String(err))}`,
    );
  }

  if (!res.ok) {
    const bodyText = await safeReadText(res);
    throw new AppError(502, `ElevenLabs request failed (${res.status}): ${truncateProviderError(bodyText)}`);
  }

  // Content-Length ön-kontrolü (varsa) + gerçek okuma boyutu kontrolü —
  // sağlayıcı header'ı yalan söylerse (chunked / eksik) ikinci kontrol yakalar.
  const contentLengthHeader = res.headers.get("content-length");
  if (contentLengthHeader && Number(contentLengthHeader) > ELEVENLABS_MAX_BYTES) {
    throw new AppError(502, "ElevenLabs audio response exceeded the 15MB read cap");
  }

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > ELEVENLABS_MAX_BYTES) {
    throw new AppError(502, "ElevenLabs audio response exceeded the 15MB read cap");
  }

  return { audioBase64: buf.toString("base64"), mime: "audio/mpeg", chars: params.text.length };
}

export async function synthesizeTts(tenantId: string, params: SynthesizeTtsParams): Promise<SynthesizeTtsResult> {
  const apiKey = await getTenantMediaKey(tenantId, params.provider);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TTS_TIMEOUT_MS);
  try {
    if (params.provider === "GOOGLE_TTS") {
      return await synthesizeGoogleTts(apiKey, params, controller.signal);
    }
    return await synthesizeElevenLabsTts(apiKey, params, controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

// ─── Ledger (best-effort) ────────────────────────────────────────────────

export interface RecordGenerationParams {
  tenantId: string;
  kind: MediaGenerationKind;
  provider: MediaProvider;
  model: string;
  promptPreview: string;
  paramsJson: Prisma.InputJsonValue;
  estimatedCostUsd: number;
  status: MediaGenerationStatus;
  errorMessage?: string;
  resultUrl?: string;
  resultMeta?: Prisma.InputJsonValue;
}

/**
 * Başarı VE hata durumunda media_generations satırı yazar. Ledger yazımı
 * best-effort'tur — bu yazım hata verirse kullanıcı yanıtı düşmez, sadece
 * uyarı loglanır (anahtar/authorization ASLA loglanmaz, ASLA yazılmaz).
 */
export async function recordGeneration(params: RecordGenerationParams): Promise<string | null> {
  try {
    const row = await prisma.mediaGeneration.create({
      data: {
        tenantId: params.tenantId,
        kind: params.kind,
        provider: params.provider,
        model: params.model,
        promptPreview: params.promptPreview.slice(0, 300),
        paramsJson: params.paramsJson,
        estimatedCostUsd: params.estimatedCostUsd,
        status: params.status,
        errorMessage: params.errorMessage ? params.errorMessage.slice(0, 500) : null,
        resultUrl: params.resultUrl ?? null,
        resultMeta: params.resultMeta ?? undefined,
      },
    });
    return row.id;
  } catch (err) {
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        tenantId: params.tenantId,
        kind: params.kind,
        provider: params.provider,
        status: params.status,
      },
      "media_generations ledger write failed (best-effort, response not affected)",
    );
    return null;
  }
}
