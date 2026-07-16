/**
 * Medya üretimi (görsel + TTS) fiyat tahmini — saf fonksiyonlar, ağ isteği
 * yok, gizli anahtar yok.
 *
 * ⚠️ BU RAKAMLAR TAHMİNDİR. Sağlayıcı liste fiyatları sık değişir ve gerçek
 * fatura, tenant'ın kendi hesabındaki plana/kotaya bağlıdır (BYOK — bu modül
 * hiçbir zaman sistem cüzdanından harcama yapmaz). captured ~2026-07:
 *   - fal.ai   → fal.run/pricing (megapiksel-bazlı, per-model)
 *   - Google   → cloud.google.com/text-to-speech/pricing (karakter/tier-bazlı)
 *   - ElevenLabs → elevenlabs.io/pricing (abonelik-kotalı; burada kullanılan
 *     oran Creator-planının EFEKTİF $/1k-karakter oranı — gerçek marjinal
 *     maliyet tenant'ın kendi planına göre değişir)
 *
 * UI bu modülden gelen her rakamı "tahmini maliyet" olarak etiketlemeli —
 * asla kesin fatura gibi sunmamalı. media_generations.estimated_cost_usd
 * bu fonksiyonların ürettiği değerin dondurulmuş kopyasıdır (audit).
 */

// ─── Görsel (image) fiyatlandırma ──────────────────────────────────────────

export interface ImagePriceEntry {
  /** USD, üretilen görsel başına megapiksel oranı. */
  usdPerMegapixel: number;
}

// fal.ai — megapiksel-bazlı. Kaynak: fal.ai/pricing (captured ~2026-07).
export const IMAGE_PRICES: Record<string, ImagePriceEntry> = {
  "fal-ai/flux/schnell": { usdPerMegapixel: 0.003 },
  "fal-ai/flux/dev": { usdPerMegapixel: 0.025 },
};

// ─── TTS (metin-konuşma) fiyatlandırma ─────────────────────────────────────

export interface GoogleTtsPricing {
  /** USD / 1.000.000 karakter — Standard ses. */
  standardPerMChars: number;
  /** USD / 1.000.000 karakter — Neural2/Wavenet/News/Polyglot ses ailesi. */
  neuralPerMChars: number;
  /** USD / 1.000.000 karakter — Studio ses ailesi. */
  studioPerMChars: number;
  freeTierNote: string;
}

export interface ElevenLabsPricing {
  /** USD / 1.000 karakter — plan-efektif oran. */
  effectivePer1kChars: number;
  note: string;
}

export const TTS_PRICES: {
  GOOGLE_TTS: GoogleTtsPricing;
  ELEVENLABS: ElevenLabsPricing;
} = {
  // Kaynak: cloud.google.com/text-to-speech/pricing (captured ~2026-07).
  GOOGLE_TTS: {
    standardPerMChars: 4,
    neuralPerMChars: 16,
    studioPerMChars: 160,
    freeTierNote: "kendi anahtarında aylık 1-4M karakter ücretsiz kota olabilir",
  },
  // Kaynak: elevenlabs.io/pricing, Creator planı (captured ~2026-07).
  ELEVENLABS: {
    effectivePer1kChars: 0.3,
    note: "abonelik-kotalı; Creator-planı efektif oranı — gerçek marjinal maliyet plana bağlı",
  },
};

/** Round to 6 decimals — matches the DB Decimal(10,6) precision for costs. */
const round = (n: number): number => Math.round(n * 1e6) / 1e6;

// ─── Görsel tahmini ─────────────────────────────────────────────────────

export interface ImageEstimate {
  kind: "image";
  model: string;
  /** Toplam megapiksel birimi (n görsel × min-1MP-uygulanmış megapiksel). */
  units: number;
  usd: number;
  estimate: true;
  note: string;
}

/**
 * n adet width×height görsel üretiminin TAHMİNİ USD maliyeti.
 *
 * Her görsel en az 1 megapiksel olarak faturalandırılır (fal.ai'nin küçük
 * görsellerde uyguladığı taban ücretin muhafazakâr yaklaşımı) — gerçek
 * megapiksel bundan büyükse gerçek değer kullanılır.
 *
 * Bilinmeyen model → Error fırlatır (AppError DEĞİL — bu saf bir kütüphane
 * fonksiyonu, HTTP'den habersiz). router.ts zaten zod allowlist'iyle
 * bilinmeyen modeli reddeder; buradaki throw ikinci savunma hattı.
 */
export function estimateImage(model: string, n: number, width: number, height: number): ImageEstimate {
  const price = IMAGE_PRICES[model];
  if (!price) {
    throw new Error(`Unknown image model for pricing: ${model}`);
  }
  const megapixelsPerImage = Math.max(1, (width * height) / 1_000_000);
  const units = n * megapixelsPerImage;
  const usd = round(units * price.usdPerMegapixel);
  return {
    kind: "image",
    model,
    units,
    usd,
    estimate: true,
    note: `${n} görsel × ${megapixelsPerImage.toFixed(3)}MP (min 1MP/görsel) × $${price.usdPerMegapixel}/MP — TAHMİN`,
  };
}

// ─── TTS tahmini ────────────────────────────────────────────────────────

export type TtsProvider = "GOOGLE_TTS" | "ELEVENLABS";

export interface TtsEstimate {
  kind: "tts";
  provider: TtsProvider;
  /** Karakter sayısı (image'daki "units" ile simetrik alan). */
  units: number;
  usd: number;
  estimate: true;
  note: string;
}

type GoogleTtsTier = "standard" | "neural" | "studio";

/**
 * Google ses adından tier türetir: "…Studio…" → studio,
 * "…Neural2…|…Wavenet…|…News…|…Polyglot…" → neural, aksi halde standard.
 * Ses adı verilmemişse (voiceName undefined) standard varsayılır.
 */
function googleTtsTierFromVoiceName(voiceName?: string): GoogleTtsTier {
  if (!voiceName) return "standard";
  if (voiceName.includes("Studio")) return "studio";
  const neuralMarkers = ["Neural2", "Wavenet", "News", "Polyglot"];
  if (neuralMarkers.some((marker) => voiceName.includes(marker))) return "neural";
  return "standard";
}

/**
 * chars karakterlik TTS üretiminin TAHMİNİ USD maliyeti.
 *
 * GOOGLE_TTS: voiceName'den türetilen tier'e göre $/1M karakter oranı.
 * ELEVENLABS: sabit plan-efektif $/1k karakter oranı (voiceName etkisiz —
 * ElevenLabs faturalandırması ses/model'e göre değil karaktere göredir).
 *
 * Bilinmeyen provider → Error fırlatır (defense-in-depth; router zod enum'u
 * zaten GOOGLE_TTS|ELEVENLABS dışını reddeder).
 */
export function estimateTts(provider: TtsProvider, chars: number, voiceName?: string): TtsEstimate {
  if (provider === "GOOGLE_TTS") {
    const tier = googleTtsTierFromVoiceName(voiceName);
    const rate =
      tier === "studio"
        ? TTS_PRICES.GOOGLE_TTS.studioPerMChars
        : tier === "neural"
          ? TTS_PRICES.GOOGLE_TTS.neuralPerMChars
          : TTS_PRICES.GOOGLE_TTS.standardPerMChars;
    const usd = round((chars / 1_000_000) * rate);
    return {
      kind: "tts",
      provider,
      units: chars,
      usd,
      estimate: true,
      note: `${chars} karakter × ${tier} tier ($${rate}/1M karakter) — TAHMİN. ${TTS_PRICES.GOOGLE_TTS.freeTierNote}`,
    };
  }
  if (provider === "ELEVENLABS") {
    const usd = round((chars / 1000) * TTS_PRICES.ELEVENLABS.effectivePer1kChars);
    return {
      kind: "tts",
      provider,
      units: chars,
      usd,
      estimate: true,
      note: `${chars} karakter × $${TTS_PRICES.ELEVENLABS.effectivePer1kChars}/1k karakter — TAHMİN. ${TTS_PRICES.ELEVENLABS.note}`,
    };
  }
  throw new Error(`Unknown TTS provider for pricing: ${provider as string}`);
}
