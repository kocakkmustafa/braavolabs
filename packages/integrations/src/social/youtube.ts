/**
 * YouTube Data API v3 Client
 *
 * Upload videos and retrieve channel analytics.
 */

export interface YouTubeConfig {
  apiKey: string;
  clientId: string;
  clientSecret: string;
  refreshToken?: string;
}

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const YT_API_BASE = "https://www.googleapis.com/youtube/v3";

async function getAccessToken(config: YouTubeConfig): Promise<string> {
  if (!config.refreshToken) {
    throw new Error("YouTube refreshToken is required for authenticated requests");
  }

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: config.refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) {
    throw new Error(`YouTube token refresh failed: ${res.status}`);
  }

  const data: any = await res.json();
  return data.access_token;
}

/**
 * Get channel info by ID or username.
 */
export async function getYouTubeChannel(
  config: YouTubeConfig,
  channelId: string,
): Promise<{ id: string; title: string; subscriberCount: number; videoCount: number }> {
  const url = new URL(`${YT_API_BASE}/channels`);
  url.searchParams.set("part", "snippet,statistics");
  url.searchParams.set("id", channelId);
  url.searchParams.set("key", config.apiKey);

  const res = await fetch(url.toString());

  if (!res.ok) {
    throw new Error(`YouTube get channel failed: ${res.status}`);
  }

  const data: any = await res.json();
  const ch = data.items?.[0];
  if (!ch) throw new Error("YouTube channel not found");

  return {
    id: ch.id,
    title: ch.snippet?.title ?? "",
    subscriberCount: parseInt(ch.statistics?.subscriberCount ?? "0", 10),
    videoCount: parseInt(ch.statistics?.videoCount ?? "0", 10),
  };
}

/**
 * Search for videos.
 */
export async function searchYouTubeVideos(
  config: YouTubeConfig,
  query: string,
  maxResults = 10,
): Promise<Array<{ videoId: string; title: string; channelTitle: string }>> {
  const url = new URL(`${YT_API_BASE}/search`);
  url.searchParams.set("part", "snippet");
  url.searchParams.set("q", query);
  url.searchParams.set("type", "video");
  url.searchParams.set("maxResults", String(maxResults));
  url.searchParams.set("key", config.apiKey);

  const res = await fetch(url.toString());

  if (!res.ok) {
    throw new Error(`YouTube search failed: ${res.status}`);
  }

  const data: any = await res.json();
  return (data.items ?? []).map((item: any) => ({
    videoId: item.id?.videoId ?? "",
    title: item.snippet?.title ?? "",
    channelTitle: item.snippet?.channelTitle ?? "",
  }));
}

/**
 * Get video statistics.
 */
export async function getYouTubeVideoStats(
  config: YouTubeConfig,
  videoId: string,
): Promise<Record<string, number>> {
  const url = new URL(`${YT_API_BASE}/videos`);
  url.searchParams.set("part", "statistics");
  url.searchParams.set("id", videoId);
  url.searchParams.set("key", config.apiKey);

  const res = await fetch(url.toString());

  if (!res.ok) {
    throw new Error(`YouTube get video stats failed: ${res.status}`);
  }

  const data: any = await res.json();
  const stats = data.items?.[0]?.statistics ?? {};
  return {
    viewCount: parseInt(stats.viewCount ?? "0", 10),
    likeCount: parseInt(stats.likeCount ?? "0", 10),
    commentCount: parseInt(stats.commentCount ?? "0", 10),
    favoriteCount: parseInt(stats.favoriteCount ?? "0", 10),
  };
}

/**
 * Post a comment on a video.
 */
export async function postYouTubeComment(
  config: YouTubeConfig,
  videoId: string,
  text: string,
): Promise<{ commentId: string }> {
  const token = await getAccessToken(config);

  const res = await fetch(`${YT_API_BASE}/commentThreads?part=snippet`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      snippet: {
        videoId,
        topLevelComment: {
          snippet: { textOriginal: text },
        },
      },
    }),
  });

  if (!res.ok) {
    const err: any = await res.json().catch(() => ({}));
    throw new Error(`YouTube post comment failed: ${err?.error?.message ?? res.status}`);
  }

  const data: any = await res.json();
  return { commentId: data.id };
}

/**
 * Test YouTube connection by calling channels.list with mine=true.
 */
export async function testYouTubeConnection(
  config: YouTubeConfig,
): Promise<{ ok: boolean; channelTitle?: string }> {
  if (config.refreshToken) {
    const token = await getAccessToken(config);
    const url = new URL(`${YT_API_BASE}/channels`);
    url.searchParams.set("part", "snippet");
    url.searchParams.set("mine", "true");

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      throw new Error(`YouTube connection test failed: ${res.status}`);
    }

    const data: any = await res.json();
    return { ok: true, channelTitle: data.items?.[0]?.snippet?.title };
  }

  // API key only — just validate it works
  const url = new URL(`${YT_API_BASE}/videos`);
  url.searchParams.set("part", "id");
  url.searchParams.set("chart", "mostPopular");
  url.searchParams.set("maxResults", "1");
  url.searchParams.set("key", config.apiKey);

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`YouTube connection test failed: ${res.status}`);
  }

  return { ok: true };
}
