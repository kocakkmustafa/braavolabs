/**
 * Facebook Graph API Client
 *
 * Publish posts and manage Facebook Pages.
 */

export interface FacebookConfig {
  accessToken: string;
  pageId: string;
}

const FB_API_BASE = "https://graph.facebook.com/v20.0";

/**
 * Publish a text post to a Facebook Page.
 */
export async function publishFacebookPost(
  config: FacebookConfig,
  message: string,
  link?: string,
): Promise<{ postId: string }> {
  const body: any = { message, access_token: config.accessToken };
  if (link) body.link = link;

  const res = await fetch(`${FB_API_BASE}/${config.pageId}/feed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err: any = await res.json().catch(() => ({}));
    throw new Error(`Facebook publish post failed: ${err?.error?.message ?? res.status}`);
  }

  const data: any = await res.json();
  return { postId: data.id };
}

/**
 * Publish a photo post to a Facebook Page.
 */
export async function publishFacebookPhoto(
  config: FacebookConfig,
  imageUrl: string,
  caption: string,
): Promise<{ postId: string; photoId: string }> {
  const res = await fetch(`${FB_API_BASE}/${config.pageId}/photos`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: imageUrl,
      caption,
      access_token: config.accessToken,
    }),
  });

  if (!res.ok) {
    const err: any = await res.json().catch(() => ({}));
    throw new Error(`Facebook publish photo failed: ${err?.error?.message ?? res.status}`);
  }

  const data: any = await res.json();
  return { postId: data.post_id ?? "", photoId: data.id };
}

/**
 * Get post insights.
 */
export async function getFacebookPostInsights(
  config: FacebookConfig,
  postId: string,
): Promise<Record<string, number>> {
  const url = new URL(`${FB_API_BASE}/${postId}/insights`);
  url.searchParams.set("metric", "post_impressions,post_reactions_by_type_total,post_clicks");
  url.searchParams.set("access_token", config.accessToken);

  const res = await fetch(url.toString());

  if (!res.ok) {
    throw new Error(`Facebook get insights failed: ${res.status}`);
  }

  const data: any = await res.json();
  const result: Record<string, number> = {};
  for (const item of data.data ?? []) {
    result[item.name] = item.values?.[0]?.value ?? 0;
  }
  return result;
}

/**
 * Get Page info to test connection.
 */
export async function testFacebookConnection(
  config: FacebookConfig,
): Promise<{ ok: boolean; pageName: string; category: string }> {
  const url = new URL(`${FB_API_BASE}/${config.pageId}`);
  url.searchParams.set("fields", "name,category");
  url.searchParams.set("access_token", config.accessToken);

  const res = await fetch(url.toString());

  if (!res.ok) {
    const err: any = await res.json().catch(() => ({}));
    throw new Error(`Facebook connection test failed: ${err?.error?.message ?? res.status}`);
  }

  const data: any = await res.json();
  return { ok: true, pageName: data.name ?? "", category: data.category ?? "" };
}
