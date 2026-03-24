/**
 * LinkedIn API Client — Faz 8
 *
 * Content publishing for LinkedIn (hero company channel).
 */

export interface LinkedInConfig {
  clientId: string;
  clientSecret: string;
  accessToken: string;
}

export async function publishPost(
  _config: LinkedInConfig,
  _content: string,
  _mediaUrl?: string,
): Promise<{ postId: string }> {
  // TODO: Faz 8
  throw new Error("Not implemented — Faz 8");
}

export async function getPostMetrics(
  _config: LinkedInConfig,
  _postId: string,
): Promise<Record<string, number>> {
  // TODO: Faz 8
  throw new Error("Not implemented — Faz 8");
}
