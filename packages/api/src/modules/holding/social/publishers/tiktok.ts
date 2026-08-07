/**
 * TikTok Content Posting API — Direct Post (FILE_UPLOAD).
 *
 * ⛔ ŞU AN BLOKE (DEFTER H-018, 2026-08-07 canlı ölçüm):
 * App henüz TikTok denetiminden geçmemiş. `video/init` çağrısı
 * `unaudited_client_can_only_post_to_private_accounts` döndürüyor —
 * denetlenmemiş app'ler yalnız PRIVATE hesaplara post atabilir, marka
 * hesaplarımız public. Denetim onayı gelene kadar bu publisher net bir
 * hata mesajıyla durur (sessizce başarısız olmaz).
 *
 * ⚠️ `creator_info` YANILTICIDIR: `privacy_level_options` içinde
 * PUBLIC_TO_EVERYONE görünse bile gerçek `init` reddedebilir — o alan
 * HESABIN seçeneklerini gösterir, APP'in denetim durumunu değil.
 * Ders: yayın iznini yalnız gerçek yayın denemesi kanıtlar.
 */

import { HOSTS, brandValue } from "../config";
import { pollUntil, postJson } from "../http";
import { tiktokAccessToken } from "../tokens";
import { failed, published, type PublishResult, type SocialPost } from "../types";

const MIN_CHUNK = 5 * 1024 * 1024;
const MAX_CHUNK = 64 * 1024 * 1024;
const PUBLISH_TIMEOUT_MS = 600_000;
const MAX_VIDEO_BYTES = 300 * 1024 * 1024;

const PRIVACY_PREFERENCE = [
  "PUBLIC_TO_EVERYONE",
  "MUTUAL_FOLLOW_FRIENDS",
  "FOLLOWER_OF_CREATOR",
  "SELF_ONLY",
];

function auth(token: string) {
  return { authorization: `Bearer ${token}`, "content-type": "application/json; charset=UTF-8" };
}

function ttError(data: Record<string, unknown>, raw: string): string {
  const err = (data?.error ?? {}) as Record<string, unknown>;
  const code = err.code as string | undefined;
  if (code && code !== "ok") {
    return `${code}: ${err.message ?? ""} ${err.log_id ?? ""}`.trim();
  }
  return raw.slice(0, 300);
}

async function creatorInfo(token: string): Promise<{ info: Record<string, unknown> | null; error: string }> {
  const res = await postJson(`${HOSTS.tiktok}/post/publish/creator_info/query/`, {}, auth(token));
  if (res.status !== 200) return { info: null, error: ttError(res.data, res.raw) };
  const err = ((res.data.error ?? {}) as Record<string, unknown>).code as string | undefined;
  if (err && err !== "ok") return { info: null, error: ttError(res.data, res.raw) };
  return { info: (res.data.data ?? {}) as Record<string, unknown>, error: "" };
}

function pickPrivacy(info: Record<string, unknown>): { picked: string | null; options: string[] } {
  const options = (info.privacy_level_options as string[]) ?? [];
  for (const candidate of PRIVACY_PREFERENCE) {
    if (options.includes(candidate)) return { picked: candidate, options };
  }
  return { picked: options[0] ?? null, options };
}

async function downloadVideo(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`medya indirilemedi: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error("indirilen video 0 byte");
  if (buf.length > MAX_VIDEO_BYTES) throw new Error(`video çok büyük (${buf.length} bayt)`);
  return buf;
}

async function uploadChunks(uploadUrl: string, buf: Buffer, chunkSize: number): Promise<string | null> {
  const size = buf.length;
  let offset = 0;
  while (offset < size) {
    const end = Math.min(offset + chunkSize, size) - 1;
    const chunk = buf.subarray(offset, end + 1);
    try {
      const res = await fetch(uploadUrl, {
        method: "PUT",
        headers: {
          "content-range": `bytes ${offset}-${end}/${size}`,
          "content-type": "video/mp4",
          "content-length": String(chunk.length),
        },
        body: new Uint8Array(chunk),
      });
      if (![200, 201, 206].includes(res.status)) {
        return `chunk reddedildi HTTP ${res.status} (offset=${offset})`;
      }
    } catch (err) {
      return `chunk yükleme ağ hatası (offset=${offset}): ${(err as Error).message}`;
    }
    offset = end + 1;
  }
  return null;
}

export async function publishTikTok(post: SocialPost): Promise<PublishResult> {
  const platform = "tiktok" as const;
  const media = post.mediaUrls?.[0];
  if (!media) return failed(platform, "TikTok video zorunlu — medya yok");

  let token: string;
  try {
    token = await tiktokAccessToken(post.brand);
  } catch (err) {
    return failed(platform, (err as Error).message);
  }

  let { info, error } = await creatorInfo(token);
  if (!info && /access_token|expired|401/i.test(error)) {
    try {
      token = await tiktokAccessToken(post.brand, { forceRefresh: true });
    } catch (err) {
      return failed(platform, `token yenilenemedi: ${(err as Error).message}`);
    }
    ({ info, error } = await creatorInfo(token));
  }
  if (!info) return failed(platform, `creator_info alınamadı: ${error}`);

  const { picked: privacy, options } = pickPrivacy(info);
  if (!privacy) return failed(platform, "hiçbir privacy_level seçeneği dönmedi (app onayı eksik olabilir)");

  let buf: Buffer;
  try {
    buf = await downloadVideo(media);
  } catch (err) {
    return failed(platform, (err as Error).message);
  }

  const size = buf.length;
  const chunkSize = size < MIN_CHUNK ? size : Math.min(MAX_CHUNK, Math.max(MIN_CHUNK, size));
  const totalChunks = Math.max(1, Math.ceil(size / chunkSize));

  const init = await postJson(
    `${HOSTS.tiktok}/post/publish/video/init/`,
    {
      post_info: {
        title: post.caption.slice(0, 2200),
        privacy_level: privacy,
        disable_duet: false,
        disable_comment: false,
        disable_stitch: false,
      },
      source_info: {
        source: "FILE_UPLOAD",
        video_size: size,
        chunk_size: chunkSize,
        total_chunk_count: totalChunks,
      },
    },
    auth(token),
  );

  const payload = (init.data.data ?? {}) as Record<string, unknown>;
  const publishId = payload.publish_id as string | undefined;
  if (init.status !== 200 || !publishId) {
    let err = ttError(init.data, init.raw);
    if (err.includes("unaudited_client")) {
      err =
        "TikTok app'i HENÜZ DENETLENMEDİ (unaudited) — denetimden geçmemiş app'ler yalnız PRIVATE " +
        "hesaplara post atabilir, marka hesaplarımız public. Çözüm: developers.tiktok.com'da " +
        `Content Posting API app denetimine başvur. [ham: ${err}]`;
    }
    return failed(platform, `init başarısız: ${err}`, init.data);
  }

  const uploadUrl = payload.upload_url as string | undefined;
  if (!uploadUrl) return failed(platform, "init upload_url döndürmedi", init.data);

  const upErr = await uploadChunks(uploadUrl, buf, chunkSize);
  if (upErr) return failed(platform, upErr);

  const wait = await pollUntil(
    async () => {
      const res = await postJson(
        `${HOSTS.tiktok}/post/publish/status/fetch/`,
        { publish_id: publishId },
        auth(token),
      );
      if (res.status !== 200) return { done: true, ok: false, message: ttError(res.data, res.raw) };
      const d = (res.data.data ?? {}) as Record<string, unknown>;
      const status = String(d.status ?? "");
      if (status === "PUBLISH_COMPLETE") return { done: true, ok: true, message: "yayınlandı" };
      if (status === "FAILED") {
        return { done: true, ok: false, message: `TikTok reddetti: ${d.fail_reason ?? d.error_code ?? "bilinmeyen"}` };
      }
      return { done: false, ok: false, message: `işleniyor (${status || "PROCESSING"})` };
    },
    { timeoutMs: PUBLISH_TIMEOUT_MS, label: "TikTok yayın" },
  );
  if (!wait.ok) return failed(platform, wait.message);

  const username = brandValue("TIKTOK_TARGET_USER", post.brand);
  const result = published(
    platform,
    publishId,
    username ? `https://www.tiktok.com/@${username}` : null,
    { privacy_level: privacy, publish_id: publishId },
  );

  // DÜRÜSTLÜK KAPISI: SELF_ONLY ise "yayınlandı" yanıltıcı olur.
  if (privacy === "SELF_ONLY") {
    result.raw = {
      ...result.raw,
      warning:
        `privacy_level=SELF_ONLY — video YALNIZCA hesap sahibi tarafından görülebilir ` +
        `(app'in izin verdiği seçenekler: ${options.join(", ")}).`,
    };
  }
  return result;
}
