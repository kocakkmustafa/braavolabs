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

/**
 * Fiyat tablolarının yakalandığı sürüm etiketi. media_generations.params_json'a
 * yazılır ki tarihsel bir satırın estimate'i hangi fiyat-snapshot'ından geldiği
 * audit'te geri-izlenebilsin (fiyat tablosu ileride değişse bile).
 */
export const PRICING_CAPTURED_AT = "2026-07";

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

interface GoogleTtsTierResult {
  tier: GoogleTtsTier;
  /** true when the voice name was given but matched no known family — the
   * tier is a conservative guess, not a certainty (drives the estimate note). */
  uncertain: boolean;
}

/**
 * Google ses adından tier türetir (fiyat-dürüstlüğü kuralı: bilinmeyeni ASLA
 * en-ucuz tier'a düşürme — o, kullanıcıya gerçek maliyetten düşük rakam
 * gösterir).
 *
 *   - ses adı YOK               → standard (Google'ın gerçek default sesi
 *                                 standard ailedendir; belirsizlik yok).
 *   - "…Standard…"              → standard.
 *   - premium aileler (Studio /
 *     Journey / Casual / Chirp)  → studio-fiyatı (bu aileler Studio ile
 *                                 aynı üst-katmanda faturalanır).
 *   - "…Neural2/Wavenet/News/
 *     Polyglot…"                 → neural.
 *   - ses adı VERİLDİ ama hiçbir
 *     aileye uymadı              → neural (muhafazakâr orta tahmin) +
 *                                 uncertain=true → "tier tanınmadı" notu.
 *
 * Böylece yeni/bilinmeyen bir premium ses (ör. gelecekteki bir aile) sessizce
 * $4/1M'e düşüp kullanıcıyı yanıltmaz; en fazla neural ($16/1M) tahmini +
 * açık belirsizlik uyarısı görür.
 */
function googleTtsTierFromVoiceName(voiceName?: string): GoogleTtsTierResult {
  if (!voiceName) return { tier: "standard", uncertain: false };
  const studioMarkers = ["Studio", "Journey", "Casual", "Chirp"];
  if (studioMarkers.some((marker) => voiceName.includes(marker))) {
    return { tier: "studio", uncertain: false };
  }
  const neuralMarkers = ["Neural2", "Wavenet", "News", "Polyglot"];
  if (neuralMarkers.some((marker) => voiceName.includes(marker))) {
    return { tier: "neural", uncertain: false };
  }
  if (voiceName.includes("Standard")) return { tier: "standard", uncertain: false };
  // Ses adı var ama tanınmadı → en-ucuza DEĞİL, muhafazakâr neural'a düş + uyar.
  return { tier: "neural", uncertain: true };
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
    const { tier, uncertain } = googleTtsTierFromVoiceName(voiceName);
    const rate =
      tier === "studio"
        ? TTS_PRICES.GOOGLE_TTS.studioPerMChars
        : tier === "neural"
          ? TTS_PRICES.GOOGLE_TTS.neuralPerMChars
          : TTS_PRICES.GOOGLE_TTS.standardPerMChars;
    const usd = round((chars / 1_000_000) * rate);
    const tierNote = uncertain
      ? `${tier} tier VARSAYILDI (ses "${voiceName}" tanınmadı — gerçek maliyet farklı olabilir)`
      : `${tier} tier`;
    return {
      kind: "tts",
      provider,
      units: chars,
      usd,
      estimate: true,
      note: `${chars} karakter × ${tierNote} ($${rate}/1M karakter) — TAHMİN. ${TTS_PRICES.GOOGLE_TTS.freeTierNote}`,
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
