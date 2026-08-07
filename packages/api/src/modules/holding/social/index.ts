/**
 * Sosyal yayın registry'si — platform → publisher.
 *
 * Mimari karar 2026-08-07 (kurucu): "onay-kapılı doğrudan API".
 * İçerik üretilir → compliance → post_queue → Telegram onayı → BURASI yayınlar.
 */

import { logger } from "../../../lib/logger";
import { publishFacebook, publishInstagram, publishThreads } from "./publishers/meta";
import { publishDiscord, publishTelegramChannel } from "./publishers/messaging";
import { publishTikTok } from "./publishers/tiktok";
import { publishYouTube } from "./publishers/youtube";
import {
  MANUAL_REASON,
  failed,
  isManualPlatform,
  type PublishResult,
  type SocialBrand,
  type SocialPost,
} from "./types";

export type Publisher = (post: SocialPost) => Promise<PublishResult>;

export const REGISTRY: Record<string, Publisher> = {
  facebook: publishFacebook,
  instagram_feed: publishInstagram,
  threads: publishThreads,
  tiktok: publishTikTok,
  youtube_short: publishYouTube,
  youtube_long: publishYouTube,
  telegram: publishTelegramChannel,
  discord: publishDiscord,
};

/** Tek bir post'u kendi platformuna yayınla. Asla fırlatmaz. */
export async function publish(post: SocialPost): Promise<PublishResult> {
  const platform = post.platform;
  if (isManualPlatform(platform)) {
    return {
      platform,
      status: "manual_required",
      error: MANUAL_REASON[platform],
    };
  }
  const handler = REGISTRY[platform];
  if (!handler) return failed(platform, `tanımsız platform: ${platform}`);
  try {
    return await handler(post);
  } catch (err) {
    logger.error({ err, platform }, "publisher beklenmedik hata");
    return failed(platform, `beklenmedik hata: ${(err as Error).name}: ${(err as Error).message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// YENİDEN DENEME POLİTİKASI — kurucu kararı 2026-08-07
// ─────────────────────────────────────────────────────────────────────────────
// "Sadece KESİN-GEÇİCİ hatalarda 1 tekrar."
//
// Ayrımın özü hatanın TÜRÜ değil ZAMANI: istek platforma ulaşmadan önce mi
// patladı, sonra mı? Sonraysa içerik platforma varmış OLABİLİR ve tekrar
// denemek ÇİFT POST üretir. Şüphede olan her durum tehlikeli sayılır.
export const MAX_ATTEMPTS = 2;

const TRANSIENT_MARKERS = [
  "ağ hatası",
  "medya indirilemedi",
  "http 500",
  "http 502",
  "http 503",
  "http 504",
  "connection",
  "timed out",
  "timeout",
];

/** Bu izlerden biri varsa içerik ulaşmış OLABİLİR → asla tekrarlama. */
const UNSAFE_MARKERS = ["chunk", "yükleme", "publish", "yayın zaman aşımı", "status"];

export function shouldRetry(result: PublishResult, attempt: number, _brand: SocialBrand): boolean {
  if (attempt >= MAX_ATTEMPTS) return false;
  const err = (result.error ?? "").toLowerCase();
  if (!err) return false;
  if (UNSAFE_MARKERS.some((m) => err.includes(m))) return false;
  return TRANSIENT_MARKERS.some((m) => err.includes(m));
}

/** Tekrar politikasını uygulayarak yayınla. */
export async function publishWithRetry(post: SocialPost): Promise<PublishResult> {
  let result = await publish(post);
  let attempt = 1;
  while (
    result.status === "failed" &&
    shouldRetry(result, attempt, post.brand) &&
    attempt < MAX_ATTEMPTS
  ) {
    attempt += 1;
    logger.info(
      { brand: post.brand, platform: post.platform, attempt, error: result.error },
      "geçici hata — yeniden deneniyor",
    );
    result = await publish(post);
  }
  return result;
}

export * from "./types";
