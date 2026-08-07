/**
 * Token yaşam döngüsü — TEK GERÇEK KAYNAĞI Supabase `social_tokens` tablosu.
 *
 * ⚠️ NEDEN TABLO, NEDEN .env DEĞİL (kritik):
 * TikTok `refresh_token` HER KULLANIMDA rotasyona uğrar. Artık iki taraf da
 * yenileyebiliyor — Mac'teki Python hattı ve buradaki motor. İkisi ayrı
 * `.env` dosyalarına yazsaydı biri diğerinin token'ını geçersiz kılar ve
 * hesap KİLİTLENİRDİ. Tablo bu sınıfı tamamen ortadan kaldırır.
 *
 * Okuma sırası: tablo → yoksa env (ilk kurulum/tohumlama için geriye dönük
 * uyumluluk). Yazma DAİMA tabloya.
 */

import { logger } from "../../../lib/logger";
import { HOSTS, brandValue, requireBrandValue, requireValue, socialSupabase } from "./config";
import { postForm } from "./http";
import type { SocialBrand } from "./types";

export class TokenError extends Error {}

export type TokenPlatform = "tiktok" | "youtube" | "instagram" | "threads" | "meta_page";

export interface StoredToken {
  accessToken?: string | null;
  refreshToken?: string | null;
  expiresAt?: string | null;
  rotationCount?: number;
}

/** TikTok access_token 24 saat yaşar — 10 dk güvenlik payıyla yenilenir. */
const TIKTOK_REFRESH_MARGIN_MS = 10 * 60_000;

function restHeaders(): Record<string, string> {
  const { serviceKey } = socialSupabase();
  return {
    apikey: serviceKey,
    authorization: `Bearer ${serviceKey}`,
    "content-type": "application/json",
  };
}

export interface TokenStoreDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export async function readStoredToken(
  brand: SocialBrand,
  platform: TokenPlatform,
  deps: TokenStoreDeps = {},
): Promise<StoredToken | null> {
  const { url } = socialSupabase();
  const doFetch = deps.fetchImpl ?? fetch;
  const endpoint = `${url}/rest/v1/social_tokens?brand=eq.${brand}&platform=eq.${platform}&select=*`;
  try {
    const res = await doFetch(endpoint, { headers: restHeaders() });
    if (!res.ok) return null;
    const rows = (await res.json()) as Array<Record<string, unknown>>;
    if (!rows.length) return null;
    const r = rows[0];
    return {
      accessToken: (r.access_token as string) ?? null,
      refreshToken: (r.refresh_token as string) ?? null,
      expiresAt: (r.expires_at as string) ?? null,
      rotationCount: (r.rotation_count as number) ?? 0,
    };
  } catch (err) {
    logger.warn({ err, brand, platform }, "social_tokens okunamadı — env'e düşülüyor");
    return null;
  }
}

/**
 * Token'ı tabloya yaz (upsert). access + refresh BİRLİKTE yazılır —
 * kısmi yazma TikTok'ta hesabı kilitler.
 */
export async function writeStoredToken(
  brand: SocialBrand,
  platform: TokenPlatform,
  token: StoredToken,
  deps: TokenStoreDeps = {},
): Promise<void> {
  const { url } = socialSupabase();
  const doFetch = deps.fetchImpl ?? fetch;
  const body = [
    {
      brand,
      platform,
      access_token: token.accessToken ?? null,
      refresh_token: token.refreshToken ?? null,
      expires_at: token.expiresAt ?? null,
      updated_by: "holding-motor",
      rotation_count: (token.rotationCount ?? 0) + 1,
    },
  ];
  const res = await doFetch(`${url}/rest/v1/social_tokens?on_conflict=brand,platform`, {
    method: "POST",
    headers: { ...restHeaders(), prefer: "resolution=merge-duplicates" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new TokenError(`social_tokens yazılamadı: HTTP ${res.status} ${await res.text()}`);
  }
}

/** Tablo → env sırasıyla oku. */
async function resolveToken(
  brand: SocialBrand,
  platform: TokenPlatform,
  envPrefix: string,
  deps: TokenStoreDeps,
): Promise<StoredToken> {
  const stored = await readStoredToken(brand, platform, deps);
  if (stored?.accessToken) return stored;
  const fromEnv = brandValue(envPrefix, brand);
  if (!fromEnv) {
    throw new TokenError(`token yok: ${platform}/${brand} (ne tabloda ne ${envPrefix}_${brand.toUpperCase()})`);
  }
  return { accessToken: fromEnv, refreshToken: stored?.refreshToken ?? null, expiresAt: stored?.expiresAt ?? null };
}

// ─── TikTok ────────────────────────────────────────────────────────────────

function tiktokNeedsRefresh(token: StoredToken, now: number): boolean {
  if (!token.expiresAt) return true; // bilinmiyorsa güvenli taraf
  const expires = Date.parse(token.expiresAt);
  if (Number.isNaN(expires)) return true;
  return now + TIKTOK_REFRESH_MARGIN_MS >= expires;
}

export async function refreshTikTok(
  brand: SocialBrand,
  deps: TokenStoreDeps = {},
): Promise<string> {
  const stored = await readStoredToken(brand, "tiktok", deps);
  const refreshToken = stored?.refreshToken ?? brandValue("TIKTOK_REFRESH_TOKEN", brand);
  if (!refreshToken) throw new TokenError(`TikTok refresh_token yok: ${brand}`);

  const res = await postForm(
    `${HOSTS.tiktok}/oauth/token/`,
    {
      client_key: requireValue("TIKTOK_CLIENT_KEY"),
      client_secret: requireValue("TIKTOK_CLIENT_SECRET"),
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    },
    { fetchImpl: deps.fetchImpl },
  );
  const access = res.data.access_token as string | undefined;
  if (res.status !== 200 || !access) {
    throw new TokenError(
      `TikTok refresh başarısız [${brand}]: ${res.status} ${res.data.error_description ?? res.data.error ?? res.raw}`,
    );
  }
  const newRefresh = res.data.refresh_token as string | undefined;
  const expiresIn = Number(res.data.expires_in ?? 86400);
  const now = deps.now?.() ?? Date.now();

  if (!newRefresh) {
    // Rotasyon beklenirdi — kaydı yine de yaz ama uyar.
    logger.warn({ brand }, "TikTok yanıtında refresh_token YOK (rotasyon beklenirdi)");
  }
  await writeStoredToken(
    brand,
    "tiktok",
    {
      accessToken: access,
      refreshToken: newRefresh ?? refreshToken,
      expiresAt: new Date(now + expiresIn * 1000).toISOString(),
      rotationCount: stored?.rotationCount ?? 0,
    },
    deps,
  );
  return access;
}

export async function tiktokAccessToken(
  brand: SocialBrand,
  opts: { forceRefresh?: boolean } & TokenStoreDeps = {},
): Promise<string> {
  const now = opts.now?.() ?? Date.now();
  const stored = await readStoredToken(brand, "tiktok", opts);
  if (!opts.forceRefresh && stored?.accessToken && !tiktokNeedsRefresh(stored, now)) {
    return stored.accessToken;
  }
  return refreshTikTok(brand, opts);
}

// ─── YouTube ───────────────────────────────────────────────────────────────

/**
 * YouTube refresh_token KALICIDIR (rotasyon yok) — access token 1 saat
 * yaşadığı için her yayında taze üretmek en basit ve en güvenli yol.
 */
export async function youtubeAccessToken(
  brand: SocialBrand,
  deps: TokenStoreDeps = {},
): Promise<string> {
  const stored = await readStoredToken(brand, "youtube", deps);
  const refreshToken = stored?.refreshToken ?? brandValue("YT_REFRESH_TOKEN", brand);
  if (!refreshToken) throw new TokenError(`YouTube refresh_token yok: ${brand}`);

  const res = await postForm(
    HOSTS.googleToken,
    {
      client_id: requireValue("YT_CLIENT_ID"),
      client_secret: requireValue("YT_CLIENT_SECRET"),
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    },
    { fetchImpl: deps.fetchImpl },
  );
  const access = res.data.access_token as string | undefined;
  if (res.status !== 200 || !access) {
    throw new TokenError(
      `YouTube token başarısız [${brand}]: ${res.status} ${res.data.error_description ?? res.data.error ?? res.raw}`,
    );
  }
  return access;
}

// ─── Meta ailesi (rotasyonsuz okuma) ───────────────────────────────────────

export async function metaPageToken(brand: SocialBrand, deps: TokenStoreDeps = {}): Promise<string> {
  const t = await resolveToken(brand, "meta_page", "META_PAGE_TOKEN", deps);
  return t.accessToken!;
}

export async function instagramToken(brand: SocialBrand, deps: TokenStoreDeps = {}): Promise<string> {
  const t = await resolveToken(brand, "instagram", "IG_ACCESS_TOKEN", deps);
  return t.accessToken!;
}

export async function threadsToken(brand: SocialBrand, deps: TokenStoreDeps = {}): Promise<string> {
  const t = await resolveToken(brand, "threads", "THREADS_ACCESS_TOKEN", deps);
  return t.accessToken!;
}

export function requireBrandEnv(prefix: string, brand: SocialBrand): string {
  return requireBrandValue(prefix, brand);
}
