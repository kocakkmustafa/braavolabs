/**
 * TikTok API Client — Faz 8
 *
 * Content publishing and metrics for TikTok.
 * Uses TikTok Content Posting API v2.
 */

export interface TikTokConfig {
  clientKey: string;
  clientSecret: string;
  accessToken: string;
}

const TIKTOK_API_BASE = "https://open.tiktokapis.com/v2";

/**
 * Initiate a video upload to TikTok.
 * Returns a publish_id to track the upload status.
 */
export async function publishVideo(
  config: TikTokConfig,
  videoUrl: string,
  caption: string,
): Promise<{ postId: string; publishId: string }> {
  const res = await fetch(`${TIKTOK_API_BASE}/post/publish/video/init/`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      post_info: {
        title: caption.slice(0, 150),
        privacy_level: "PUBLIC_TO_EVERYONE",
        disable_duet: false,
        disable_comment: false,
        disable_stitch: false,
      },
      source_info: {
        source: "PULL_FROM_URL",
        video_url: videoUrl,
      },
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({} as any));
    throw new Error(`TikTok publish failed: ${(err as any)?.error?.message ?? res.status}`);
  }

  const data: any = await res.json();
  return {
    postId: data.data?.publish_id ?? "",
    publishId: data.data?.publish_id ?? "",
  };
}

/**
 * Check the status of a video publish.
 */
export async function getPublishStatus(
  config: TikTokConfig,
  publishId: string,
): Promise<{ status: string; postId?: string }> {
  const res = await fetch(`${TIKTOK_API_BASE}/post/publish/status/fetch/`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ publish_id: publishId }),
  });

  if (!res.ok) {
    throw new Error(`TikTok status check failed: ${res.status}`);
  }

  const statusData: any = await res.json();
  return {
    status: statusData.data?.status ?? "UNKNOWN",
    postId: statusData.data?.publicaly_available_post_id?.[0],
  };
}

/**
 * Get basic metrics for a video (views, likes, comments, shares).
 */
export async function getVideoMetrics(
  config: TikTokConfig,
  postId: string,
): Promise<Record<string, number>> {
  const res = await fetch(`${TIKTOK_API_BASE}/video/query/`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      filters: { video_ids: [postId] },
      fields: ["view_count", "like_count", "comment_count", "share_count"],
    }),
  });

  if (!res.ok) {
    throw new Error(`TikTok metrics fetch failed: ${res.status}`);
  }

  const metricsData: any = await res.json();
  const video = metricsData.data?.videos?.[0];
  return {
    views: video?.view_count ?? 0,
    likes: video?.like_count ?? 0,
    comments: video?.comment_count ?? 0,
    shares: video?.share_count ?? 0,
  };
}
