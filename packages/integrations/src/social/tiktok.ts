/**
 * TikTok API Client — Faz 8
 *
 * Content publishing for TikTok (hero company channel).
 */

export interface TikTokConfig {
  clientKey: string;
  clientSecret: string;
  accessToken: string;
}

export async function publishVideo(
  _config: TikTokConfig,
  _videoUrl: string,
  _caption: string,
): Promise<{ postId: string }> {
  // TODO: Faz 8
  throw new Error("Not implemented — Faz 8");
}

export async function getVideoMetrics(
  _config: TikTokConfig,
  _postId: string,
): Promise<Record<string, number>> {
  // TODO: Faz 8
  throw new Error("Not implemented — Faz 8");
}
