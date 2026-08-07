/**
 * Sosyal yayın hattı — paylaşılan tipler.
 *
 * Bu modül, Mac tarafında Python olarak kurulup CANLI KANITLANAN yayın
 * hattının TypeScript portudur (kurucu kararı 2026-08-07: "TS'e port et,
 * motora göm"). Python tarafındaki davranış birebir korunur — orada gerçek
 * gönderilerle doğrulanmış mantığı yeniden icat etmiyoruz.
 *
 * Kanıtlanmış kaynak: ops/social-media/scripts/common/ (Telegram, Threads,
 * Instagram, Facebook, YouTube gerçek gönderiyle doğrulandı 2026-08-07).
 */

export const SOCIAL_BRANDS = ["yulalab", "braavolabs", "burunfarki", "lifeos"] as const;
export type SocialBrand = (typeof SOCIAL_BRANDS)[number];

/** API ile yayınlanabilen platformlar. */
export const AUTO_PLATFORMS = [
  "facebook",
  "instagram_feed",
  "threads",
  "tiktok",
  "youtube_short",
  "youtube_long",
  "telegram",
  "discord",
] as const;
export type AutoPlatform = (typeof AUTO_PLATFORMS)[number];

/** API'den yayınlanmayan — Slack taslağı olarak kalır, insan paylaşır. */
export const MANUAL_PLATFORMS = ["reddit", "linkedin_company", "x", "instagram_story"] as const;
export type ManualPlatform = (typeof MANUAL_PLATFORMS)[number];

export type SocialPlatform = AutoPlatform | ManualPlatform;

export const MANUAL_REASON: Record<ManualPlatform, string> = {
  reddit: "kurucu kararı 2026-08-07: Reddit API kurulmayacak, taslağı insan paylaşır",
  linkedin_company: "Community Management API onayı beklemede (app 77620d1wgp6286)",
  x: "kalıcı iptal — ücretli API alınmayacak (kurucu kararı)",
  instagram_story: "Story yayını API kapsamı dışında",
};

export type MediaKind = "video" | "image" | "none";

export interface SocialPost {
  brand: SocialBrand;
  platform: SocialPlatform;
  caption: string;
  mediaUrls: string[];
  mediaKind: MediaKind;
  hashtags?: string[];
  /** YouTube başlığı — verilmezse caption'ın ilk satırı kullanılır. */
  title?: string;
  /** YouTube gizliliği: public | unlisted | private. */
  privacyStatus?: string;
  /** post_queue satır kimliği (varsa). */
  queueId?: number;
}

export type PublishStatus = "published" | "failed" | "manual_required";

export interface PublishResult {
  platform: SocialPlatform;
  status: PublishStatus;
  platformPostId?: string | null;
  platformUrl?: string | null;
  error?: string | null;
  /** Ham yanıt + uyarılar (örn. TikTok SELF_ONLY dürüstlük uyarısı). */
  raw?: Record<string, unknown>;
}

export function isAutoPlatform(p: string): p is AutoPlatform {
  return (AUTO_PLATFORMS as readonly string[]).includes(p);
}

export function isManualPlatform(p: string): p is ManualPlatform {
  return (MANUAL_PLATFORMS as readonly string[]).includes(p);
}

export function failed(platform: SocialPlatform, error: string, raw?: Record<string, unknown>): PublishResult {
  return { platform, status: "failed", error, raw: raw ?? {} };
}

export function published(
  platform: SocialPlatform,
  platformPostId: string | null,
  platformUrl: string | null,
  raw: Record<string, unknown> = {},
): PublishResult {
  return { platform, status: "published", platformPostId, platformUrl, raw };
}
