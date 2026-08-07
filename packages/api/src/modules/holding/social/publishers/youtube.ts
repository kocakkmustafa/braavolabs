/**
 * YouTube Data API v3 — resumable upload.
 *
 * ⚠️ SCOPE SINIRI (2026-08-06 denetimi): elimizdeki OAuth scope'u yalnız
 * `youtube.upload` + `youtube.readonly`. Video YÜKLENEBİLİR ama kanal
 * branding, playlist yönetimi ve derin Analytics YAPILAMAZ. Hatta yüklenen
 * videoyu SİLMEK bile yetkimiz dışında (2026-08-07: DELETE → 403).
 *
 * Shorts kuralı: dikey (9:16) ve ≤180sn videolar otomatik Shorts sayılır —
 * ayrı bir API alanı yoktur.
 */

import { HOSTS } from "../config";
import { youtubeAccessToken } from "../tokens";
import { failed, published, type PublishResult, type SocialPost } from "../types";

const MAX_TITLE = 100;
const MAX_DESCRIPTION = 5000;
const DEFAULT_CATEGORY = "22"; // People & Blogs
const MAX_VIDEO_BYTES = 300 * 1024 * 1024;

function splitTitleDescription(post: SocialPost): { title: string; description: string } {
  const explicit = post.title?.trim();
  const caption = post.caption.trim();
  if (explicit) return { title: explicit.slice(0, MAX_TITLE), description: caption.slice(0, MAX_DESCRIPTION) };

  const lines = caption.split("\n").filter((l) => l.trim());
  if (!lines.length) return { title: "Video", description: "" };
  // YouTube başlıkta < ve > karakterlerini reddeder
  const title = lines[0].replace(/[<>]/g, "").slice(0, MAX_TITLE) || "Video";
  return { title, description: lines.slice(1).join("\n").trim().slice(0, MAX_DESCRIPTION) };
}

export async function publishYouTube(post: SocialPost): Promise<PublishResult> {
  const platform = post.platform === "youtube_long" ? "youtube_long" : "youtube_short";
  const media = post.mediaUrls?.[0];
  if (!media) return failed(platform, "YouTube video zorunlu — medya yok");

  let token: string;
  try {
    token = await youtubeAccessToken(post.brand);
  } catch (err) {
    return failed(platform, (err as Error).message);
  }

  let buf: Buffer;
  try {
    const res = await fetch(media);
    if (!res.ok) return failed(platform, `medya indirilemedi: HTTP ${res.status}`);
    buf = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    return failed(platform, `medya indirilemedi: ${(err as Error).message}`);
  }
  if (buf.length === 0) return failed(platform, "indirilen video 0 byte");
  if (buf.length > MAX_VIDEO_BYTES) return failed(platform, `video çok büyük (${buf.length} bayt)`);

  const { title, description } = splitTitleDescription(post);
  const metadata = {
    snippet: {
      title,
      description,
      tags: (post.hashtags ?? []).map((t) => t.replace(/^#/, "")).slice(0, 15),
      categoryId: DEFAULT_CATEGORY,
    },
    status: {
      privacyStatus: post.privacyStatus ?? "public",
      selfDeclaredMadeForKids: false, // API zorunlu alan
    },
  };

  // 1) resumable session
  let sessionUrl: string | null = null;
  try {
    const init = await fetch(`${HOSTS.youtubeUpload}?uploadType=resumable&part=snippet,status`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=UTF-8",
        "x-upload-content-length": String(buf.length),
        "x-upload-content-type": "video/*",
      },
      body: JSON.stringify(metadata),
    });
    if (!init.ok) {
      return failed(platform, `resumable session açılamadı: HTTP ${init.status} — ${(await init.text()).slice(0, 300)}`);
    }
    sessionUrl = init.headers.get("location");
  } catch (err) {
    return failed(platform, `resumable session ağ hatası: ${(err as Error).message}`);
  }
  if (!sessionUrl) return failed(platform, "resumable session Location header döndürmedi");

  // 2) gövdeyi yükle
  try {
    const up = await fetch(sessionUrl, {
      method: "PUT",
      headers: { "content-type": "video/*", "content-length": String(buf.length) },
      body: new Uint8Array(buf),
    });
    const raw = await up.text();
    if (!up.ok) return failed(platform, `yükleme reddedildi: HTTP ${up.status} — ${raw.slice(0, 300)}`);
    const data = JSON.parse(raw || "{}") as Record<string, unknown>;
    const videoId = data.id as string | undefined;
    if (!videoId) return failed(platform, `yanıtta video id yok: ${raw.slice(0, 200)}`, data);
    return published(platform, videoId, `https://youtu.be/${videoId}`, data);
  } catch (err) {
    return failed(platform, `yükleme ağ hatası: ${(err as Error).message}`);
  }
}
