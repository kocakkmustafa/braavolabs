/**
 * Instagram Graph API Client
 *
 * Publish media and retrieve analytics for Instagram Business accounts.
 */

export interface InstagramConfig {
  accessToken: string;
  businessAccountId: string;
}

const IG_API_BASE = "https://graph.facebook.com/v20.0";

/**
 * Create a media container for an image post.
 */
async function createMediaContainer(
  config: InstagramConfig,
  imageUrl: string,
  caption: string,
): Promise<string> {
  const url = new URL(`${IG_API_BASE}/${config.businessAccountId}/media`);
  url.searchParams.set("image_url", imageUrl);
  url.searchParams.set("caption", caption);
  url.searchParams.set("access_token", config.accessToken);

  const res = await fetch(url.toString(), { method: "POST" });

  if (!res.ok) {
    const err: any = await res.json().catch(() => ({}));
    throw new Error(`Instagram create container failed: ${err?.error?.message ?? res.status}`);
  }

  const data: any = await res.json();
  return data.id;
}

/**
 * Publish a media container.
 */
async function publishMediaContainer(
  config: InstagramConfig,
  creationId: string,
): Promise<string> {
  const url = new URL(`${IG_API_BASE}/${config.businessAccountId}/media_publish`);
  url.searchParams.set("creation_id", creationId);
  url.searchParams.set("access_token", config.accessToken);

  const res = await fetch(url.toString(), { method: "POST" });

  if (!res.ok) {
    const err: any = await res.json().catch(() => ({}));
    throw new Error(`Instagram publish failed: ${err?.error?.message ?? res.status}`);
  }

  const data: any = await res.json();
  return data.id;
}

/**
 * Publish an image post to Instagram.
 */
export async function publishInstagramPost(
  config: InstagramConfig,
  imageUrl: string,
  caption: string,
): Promise<{ mediaId: string }> {
  const containerId = await createMediaContainer(config, imageUrl, caption);
  const mediaId = await publishMediaContainer(config, containerId);
  return { mediaId };
}

/**
 * Get insights/metrics for a media post.
 */
export async function getInstagramMediaMetrics(
  config: InstagramConfig,
  mediaId: string,
): Promise<Record<string, number>> {
  const url = new URL(`${IG_API_BASE}/${mediaId}/insights`);
  url.searchParams.set("metric", "impressions,reach,likes,comments,shares,saved");
  url.searchParams.set("access_token", config.accessToken);

  const res = await fetch(url.toString());

  if (!res.ok) {
    throw new Error(`Instagram get metrics failed: ${res.status}`);
  }

  const data: any = await res.json();
  const result: Record<string, number> = {};
  for (const item of data.data ?? []) {
    result[item.name] = item.values?.[0]?.value ?? 0;
  }
  return result;
}

/**
 * Get account-level insights.
 */
export async function getInstagramAccountInsights(
  config: InstagramConfig,
  since: number,
  until: number,
): Promise<Record<string, number>> {
  const url = new URL(`${IG_API_BASE}/${config.businessAccountId}/insights`);
  url.searchParams.set("metric", "impressions,reach,profile_views,follower_count");
  url.searchParams.set("period", "day");
  url.searchParams.set("since", String(since));
  url.searchParams.set("until", String(until));
  url.searchParams.set("access_token", config.accessToken);

  const res = await fetch(url.toString());

  if (!res.ok) {
    throw new Error(`Instagram account insights failed: ${res.status}`);
  }

  const data: any = await res.json();
  const result: Record<string, number> = {};
  for (const item of data.data ?? []) {
    const vals = item.values ?? [];
    result[item.name] = vals.reduce((s: number, v: any) => s + (v.value ?? 0), 0);
  }
  return result;
}

/**
 * Test Instagram connection by fetching account info.
 */
export async function testInstagramConnection(
  config: InstagramConfig,
): Promise<{ ok: boolean; username: string; followersCount: number }> {
  const url = new URL(`${IG_API_BASE}/${config.businessAccountId}`);
  url.searchParams.set("fields", "username,followers_count");
  url.searchParams.set("access_token", config.accessToken);

  const res = await fetch(url.toString());

  if (!res.ok) {
    const err: any = await res.json().catch(() => ({}));
    throw new Error(`Instagram connection test failed: ${err?.error?.message ?? res.status}`);
  }

  const data: any = await res.json();
  return {
    ok: true,
    username: data.username ?? "",
    followersCount: data.followers_count ?? 0,
  };
}
