/**
 * Sosyal hat konfigürasyonu — marka × platform kimlik matrisi.
 *
 * Neden zod env şemasında değil: 100+ değişken (4 marka × ~8 platform ×
 * token/id) zod şemasını okunamaz hale getirirdi. Bunun yerine burada
 * PREFIX kuralıyla dinamik okunur ve eksiklik ÇAĞRI ANINDA net bir hatayla
 * bildirilir — "sessizce boş token" durumu oluşmaz (bkz. DEFTER H-012:
 * değişken varlığı ≠ geçerliliği).
 *
 * İsimler Mac tarafındaki `ops/social-media/secrets/.env` ile BİREBİR aynı
 * tutulur; tek bir .env iki tarafı da besleyebilsin diye.
 */

import type { SocialBrand } from "./types";

export class SocialConfigError extends Error {}

function readEnv(key: string, source: NodeJS.ProcessEnv): string | undefined {
  const v = source[key];
  return v && v.trim() !== "" ? v.trim() : undefined;
}

/** `<PREFIX>_<BRAND>` deseniyle marka-özel değer oku. */
export function brandValue(
  prefix: string,
  brand: SocialBrand,
  source: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return readEnv(`${prefix}_${brand.toUpperCase()}`, source);
}

export function requireBrandValue(
  prefix: string,
  brand: SocialBrand,
  source: NodeJS.ProcessEnv = process.env,
): string {
  const v = brandValue(prefix, brand, source);
  if (!v) throw new SocialConfigError(`eksik env: ${prefix}_${brand.toUpperCase()}`);
  return v;
}

export function requireValue(key: string, source: NodeJS.ProcessEnv = process.env): string {
  const v = readEnv(key, source);
  if (!v) throw new SocialConfigError(`eksik env: ${key}`);
  return v;
}

/** Yayın hattının kendi Supabase projesi (kuyruk + storage + edge function). */
export interface SocialSupabase {
  url: string;
  serviceKey: string;
}

/**
 * Yayın hattı Braavolabs'ın Prisma veritabanını DEĞİL, kendi Supabase
 * projesini kullanır — çünkü onay kuyruğu, Telegram callback edge function'ı
 * ve medya bucket'ı 2026-08-07'de orada kuruldu ve canlı kanıtlandı.
 * Çalışan altyapıyı taşımak yerine motor ona REST ile bağlanır.
 */
export function socialSupabase(source: NodeJS.ProcessEnv = process.env): SocialSupabase {
  // Motorun kendi SUPABASE_* değişkenleriyle çakışmasın diye önce
  // YULA_SOCIAL_* öneki denenir, yoksa Mac .env'indeki sade isimlere düşer.
  const url =
    readEnv("YULA_SOCIAL_SUPABASE_URL", source) ?? readEnv("SUPABASE_URL", source);
  const serviceKey =
    readEnv("YULA_SOCIAL_SUPABASE_SERVICE_KEY", source) ?? readEnv("SUPABASE_SERVICE_KEY", source);
  if (!url || !serviceKey) {
    throw new SocialConfigError(
      "sosyal Supabase yapılandırılmamış (YULA_SOCIAL_SUPABASE_URL + _SERVICE_KEY ya da SUPABASE_URL + SUPABASE_SERVICE_KEY)",
    );
  }
  return { url: url.replace(/\/+$/, ""), serviceKey };
}

export const META_GRAPH_VERSION = process.env.META_GRAPH_VERSION?.trim() || "v21.0";

/**
 * ⚠️ HOST TUZAĞI (2026-08-07 canlı yakalandı, DEFTER):
 * `IG_ACCESS_TOKEN_*` değerleri `IGAA…` ile başlar = "Instagram API with
 * Instagram Login" token'ı ve YALNIZ graph.instagram.com'da çalışır.
 * graph.facebook.com'a gönderilirse geçerli token bile "Invalid OAuth
 * access token (code=190)" döner. Page token'ları (`EAA…`) ise
 * graph.facebook.com'a aittir.
 */
export const HOSTS = {
  facebook: `https://graph.facebook.com/${META_GRAPH_VERSION}`,
  instagram: `https://graph.instagram.com/${META_GRAPH_VERSION}`,
  threads: "https://graph.threads.net/v1.0",
  tiktok: "https://open.tiktokapis.com/v2",
  telegram: "https://api.telegram.org",
  discord: "https://discord.com/api/v10",
  youtubeUpload: "https://www.googleapis.com/upload/youtube/v3/videos",
  googleToken: "https://oauth2.googleapis.com/token",
} as const;

/** Marka bazlı kimlik özeti — sağlık kontrolü için (DEĞER BASMAZ). */
export function credentialHealth(
  brand: SocialBrand,
  source: NodeJS.ProcessEnv = process.env,
): Record<string, boolean> {
  return {
    meta_page: !!brandValue("META_PAGE_TOKEN", brand, source),
    fb_page_id: !!brandValue("FB_PAGE_ID", brand, source),
    instagram: !!brandValue("IG_ACCESS_TOKEN", brand, source),
    ig_business_id: !!brandValue("IG_BUSINESS_ID", brand, source),
    threads: !!brandValue("THREADS_ACCESS_TOKEN", brand, source),
    threads_user_id: !!brandValue("THREADS_USER_ID", brand, source),
    tiktok: !!brandValue("TIKTOK_ACCESS_TOKEN", brand, source),
    youtube_refresh: !!brandValue("YT_REFRESH_TOKEN", brand, source),
    telegram_channel: !!brandValue("TG_CHANNEL", brand, source),
    discord_channel: !!brandValue("DISCORD_CHANNEL_ID", brand, source),
  };
}
