/**
 * LinkedIn API Client — Faz 8
 *
 * Content publishing and metrics for LinkedIn.
 * Uses LinkedIn Marketing API.
 */

export interface LinkedInConfig {
  clientId: string;
  clientSecret: string;
  accessToken: string;
  organizationId?: string; // URN for org pages, omit for personal
}

const LINKEDIN_API_BASE = "https://api.linkedin.com/v2";

/**
 * Publish a text post (optionally with a link or image).
 */
export async function publishPost(
  config: LinkedInConfig,
  content: string,
  mediaUrl?: string,
): Promise<{ postId: string }> {
  const author = config.organizationId
    ? `urn:li:organization:${config.organizationId}`
    : "urn:li:person:me";

  const payload: any = {
    author,
    lifecycleState: "PUBLISHED",
    specificContent: {
      "com.linkedin.ugc.ShareContent": {
        shareCommentary: { text: content },
        shareMediaCategory: mediaUrl ? "ARTICLE" : "NONE",
      },
    },
    visibility: {
      "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC",
    },
  };

  if (mediaUrl) {
    payload.specificContent["com.linkedin.ugc.ShareContent"].media = [
      {
        status: "READY",
        originalUrl: mediaUrl,
      },
    ];
  }

  const res = await fetch(`${LINKEDIN_API_BASE}/ugcPosts`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.accessToken}`,
      "Content-Type": "application/json",
      "X-Restli-Protocol-Version": "2.0.0",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err: any = await res.json().catch(() => ({}));
    throw new Error(`LinkedIn publish failed: ${err?.message ?? res.status}`);
  }

  const postId = res.headers.get("x-restli-id") ?? "";
  return { postId };
}

/**
 * Get engagement metrics for a post.
 */
export async function getPostMetrics(
  config: LinkedInConfig,
  postId: string,
): Promise<Record<string, number>> {
  const res = await fetch(
    `${LINKEDIN_API_BASE}/socialActions/${encodeURIComponent(postId)}`,
    {
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        "X-Restli-Protocol-Version": "2.0.0",
      },
    },
  );

  if (!res.ok) {
    throw new Error(`LinkedIn metrics fetch failed: ${res.status}`);
  }

  const data: any = await res.json();
  return {
    likes: data.likesSummary?.totalLikes ?? 0,
    comments: data.commentsSummary?.totalFirstLevelComments ?? 0,
    shares: data.totalShareStatistics ?? 0,
    impressions: data.impressionCount ?? 0,
  };
}

/**
 * Share an existing article/url on LinkedIn.
 */
export async function shareArticle(
  config: LinkedInConfig,
  title: string,
  description: string,
  articleUrl: string,
): Promise<{ postId: string }> {
  return publishPost(config, `${title}\n\n${description}`, articleUrl);
}
