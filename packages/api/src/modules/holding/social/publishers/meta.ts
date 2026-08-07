/**
 * Meta ailesi — Facebook Page, Instagram, Threads.
 *
 * ÜÇ AYRI HOST, üç ayrı token:
 *   Facebook Page → graph.facebook.com   + META_PAGE_TOKEN_<BRAND>   (EAA… , never-expire)
 *   Instagram     → graph.instagram.com  + IG_ACCESS_TOKEN_<BRAND>   (IGAA…, ~60 gün)
 *   Threads       → graph.threads.net    + THREADS_ACCESS_TOKEN_<BRAND>
 *
 * ⚠️ İKİ BUG 2026-08-07'de CANLI YAKALANDI, ikisi de burada düzeltilmiş hâlde:
 *  1) `IGAA…` token'ı graph.facebook.com'a gönderilirse geçerli olduğu hâlde
 *     "Invalid OAuth access token (code=190)" döner → IG host'u ayrı.
 *  2) Container beklemesi GÖRSEL için de gerekli; yalnız videoda beklemek
 *     "Media ID is not available (9007)" hatası verir.
 */

import { HOSTS, brandValue } from "../config";
import { getJson, graphError, pollUntil, postForm } from "../http";
import { instagramToken, metaPageToken, threadsToken } from "../tokens";
import { failed, published, type PublishResult, type SocialPost } from "../types";

const CONTAINER_TIMEOUT_MS = 420_000;

function firstMedia(post: SocialPost): string | undefined {
  return post.mediaUrls?.[0];
}

function isVideo(post: SocialPost): boolean {
  if (post.mediaKind) return post.mediaKind === "video";
  const url = (firstMedia(post) ?? "").toLowerCase().split("?")[0];
  return [".mp4", ".mov", ".webm", ".m4v"].some((e) => url.endsWith(e));
}

// ─── Facebook Page ─────────────────────────────────────────────────────────

export async function publishFacebook(post: SocialPost): Promise<PublishResult> {
  const platform = "facebook" as const;
  let token: string;
  try {
    token = await metaPageToken(post.brand);
  } catch (err) {
    return failed(platform, (err as Error).message);
  }
  const pageId = brandValue("FB_PAGE_ID", post.brand);
  if (!pageId) return failed(platform, `eksik env: FB_PAGE_ID_${post.brand.toUpperCase()}`);

  const media = firstMedia(post);
  const caption = post.caption.trim();
  let res;
  if (media && isVideo(post)) {
    res = await postForm(`${HOSTS.facebook}/${pageId}/videos`, {
      file_url: media,
      description: caption,
      access_token: token,
    });
  } else if (media) {
    res = await postForm(`${HOSTS.facebook}/${pageId}/photos`, {
      url: media,
      caption,
      access_token: token,
    });
  } else {
    res = await postForm(`${HOSTS.facebook}/${pageId}/feed`, {
      message: caption,
      access_token: token,
    });
  }

  if (res.status !== 200 || res.data.error) return failed(platform, graphError(res), res.data);
  const postId = (res.data.post_id as string) ?? (res.data.id as string) ?? null;
  return published(platform, postId, postId ? `https://facebook.com/${postId}` : null, res.data);
}

// ─── Instagram ─────────────────────────────────────────────────────────────

async function igContainerReady(containerId: string, token: string) {
  const res = await getJson(`${HOSTS.instagram}/${containerId}`, {
    fields: "status_code,status",
    access_token: token,
  });
  if (res.status !== 200) return { done: true, ok: false, message: graphError(res) };
  const status = String(res.data.status_code ?? "");
  if (status === "FINISHED") return { done: true, ok: true, message: "hazır" };
  if (status === "ERROR" || status === "EXPIRED") {
    return { done: true, ok: false, message: `container ${status}: ${res.data.status ?? ""}` };
  }
  return { done: false, ok: false, message: `işleniyor (${status || "IN_PROGRESS"})` };
}

export async function publishInstagram(post: SocialPost): Promise<PublishResult> {
  const platform = "instagram_feed" as const;
  let token: string;
  try {
    token = await instagramToken(post.brand);
  } catch (err) {
    return failed(platform, (err as Error).message);
  }
  const igUser = brandValue("IG_BUSINESS_ID", post.brand);
  if (!igUser) return failed(platform, `eksik env: IG_BUSINESS_ID_${post.brand.toUpperCase()}`);

  const media = firstMedia(post);
  if (!media) return failed(platform, "Instagram medyasız post kabul etmiyor");

  const video = isVideo(post);
  const params: Record<string, string | undefined> = {
    caption: post.caption.trim(),
    access_token: token,
  };
  if (video) {
    params.media_type = "REELS";
    params.video_url = media;
  } else {
    params.image_url = media;
  }

  const create = await postForm(`${HOSTS.instagram}/${igUser}/media`, params);
  const containerId = create.data.id as string | undefined;
  if (create.status !== 200 || !containerId) {
    return failed(platform, `container oluşturulamadı: ${graphError(create)}`, create.data);
  }

  // GÖRSEL için de bekle — 9007 bu yüzden çıkıyordu.
  const wait = await pollUntil(() => igContainerReady(containerId, token), {
    timeoutMs: CONTAINER_TIMEOUT_MS,
    intervalMs: video ? 5000 : 3000,
    label: video ? "IG video işleme" : "IG görsel işleme",
  });
  if (!wait.ok) return failed(platform, `container hazır olmadı: ${wait.message}`);

  const pub = await postForm(`${HOSTS.instagram}/${igUser}/media_publish`, {
    creation_id: containerId,
    access_token: token,
  });
  const mediaId = pub.data.id as string | undefined;
  if (pub.status !== 200 || !mediaId) {
    return failed(platform, `publish başarısız: ${graphError(pub)}`, pub.data);
  }

  const perma = await getJson(`${HOSTS.instagram}/${mediaId}`, {
    fields: "permalink",
    access_token: token,
  });
  return published(
    platform,
    mediaId,
    perma.status === 200 ? ((perma.data.permalink as string) ?? null) : null,
    pub.data,
  );
}

// ─── Threads ───────────────────────────────────────────────────────────────

async function threadsContainerReady(containerId: string, token: string) {
  const res = await getJson(`${HOSTS.threads}/${containerId}`, {
    fields: "status,error_message",
    access_token: token,
  });
  if (res.status !== 200) return { done: true, ok: false, message: graphError(res) };
  const status = String(res.data.status ?? "");
  if (status === "FINISHED") return { done: true, ok: true, message: "hazır" };
  if (status === "ERROR" || status === "EXPIRED") {
    return { done: true, ok: false, message: `container ${status}: ${res.data.error_message ?? ""}` };
  }
  return { done: false, ok: false, message: `işleniyor (${status || "IN_PROGRESS"})` };
}

export async function publishThreads(post: SocialPost): Promise<PublishResult> {
  const platform = "threads" as const;
  let token: string;
  try {
    token = await threadsToken(post.brand);
  } catch (err) {
    return failed(platform, (err as Error).message);
  }
  const userId = brandValue("THREADS_USER_ID", post.brand);
  if (!userId) return failed(platform, `eksik env: THREADS_USER_ID_${post.brand.toUpperCase()}`);

  const media = firstMedia(post);
  const params: Record<string, string | undefined> = {
    access_token: token,
    text: post.caption.trim(),
  };
  if (media && isVideo(post)) {
    params.media_type = "VIDEO";
    params.video_url = media;
  } else if (media) {
    params.media_type = "IMAGE";
    params.image_url = media;
  } else {
    params.media_type = "TEXT";
  }

  const create = await postForm(`${HOSTS.threads}/${userId}/threads`, params);
  const containerId = create.data.id as string | undefined;
  if (create.status !== 200 || !containerId) {
    return failed(platform, `container oluşturulamadı: ${graphError(create)}`, create.data);
  }

  if (media) {
    const wait = await pollUntil(() => threadsContainerReady(containerId, token), {
      timeoutMs: CONTAINER_TIMEOUT_MS,
      label: "Threads medya işleme",
    });
    if (!wait.ok) return failed(platform, `container hazır olmadı: ${wait.message}`);
  }

  const pub = await postForm(`${HOSTS.threads}/${userId}/threads_publish`, {
    creation_id: containerId,
    access_token: token,
  });
  const threadId = pub.data.id as string | undefined;
  if (pub.status !== 200 || !threadId) {
    return failed(platform, `publish başarısız: ${graphError(pub)}`, pub.data);
  }

  const perma = await getJson(`${HOSTS.threads}/${threadId}`, {
    fields: "permalink",
    access_token: token,
  });
  return published(
    platform,
    threadId,
    perma.status === 200 ? ((perma.data.permalink as string) ?? null) : null,
    pub.data,
  );
}
