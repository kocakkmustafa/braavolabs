/**
 * Twitter / X API v2 Client
 *
 * Post tweets and retrieve metrics.
 */

export interface TwitterConfig {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessSecret: string;
}

const TWITTER_API_BASE = "https://api.twitter.com/2";

/**
 * Build OAuth 1.0a Authorization header.
 * Uses a simplified approach — for production use a proper OAuth library.
 */
function buildOAuthHeader(
  config: TwitterConfig,
  method: string,
  url: string,
  params: Record<string, string> = {},
): string {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: config.apiKey,
    oauth_nonce: Math.random().toString(36).substring(2),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: config.accessToken,
    oauth_version: "1.0",
  };

  const allParams = { ...params, ...oauthParams };
  const paramStr = Object.keys(allParams)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(allParams[k])}`)
    .join("&");

  const sigBase = `${method.toUpperCase()}&${encodeURIComponent(url)}&${encodeURIComponent(paramStr)}`;
  const sigKey = `${encodeURIComponent(config.apiSecret)}&${encodeURIComponent(config.accessSecret)}`;

  // HMAC-SHA1 via crypto module (Node.js)
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const crypto = require("crypto");
  const signature = crypto
    .createHmac("sha1", sigKey)
    .update(sigBase)
    .digest("base64");

  oauthParams["oauth_signature"] = signature;

  const headerValue = Object.keys(oauthParams)
    .sort()
    .map((k) => `${encodeURIComponent(k)}="${encodeURIComponent(oauthParams[k])}"`)
    .join(", ");

  return `OAuth ${headerValue}`;
}

/**
 * Post a tweet.
 */
export async function postTweet(
  config: TwitterConfig,
  text: string,
  replyToId?: string,
): Promise<{ tweetId: string; text: string }> {
  const url = `${TWITTER_API_BASE}/tweets`;
  const body: any = { text };
  if (replyToId) body.reply = { in_reply_to_tweet_id: replyToId };

  const authHeader = buildOAuthHeader(config, "POST", url);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err: any = await res.json().catch(() => ({}));
    throw new Error(`Twitter post tweet failed: ${err?.detail ?? err?.title ?? res.status}`);
  }

  const data: any = await res.json();
  return { tweetId: data.data?.id ?? "", text: data.data?.text ?? "" };
}

/**
 * Get tweet metrics (non-public metrics requires elevated access).
 */
export async function getTweetMetrics(
  config: TwitterConfig,
  tweetId: string,
): Promise<Record<string, number>> {
  const url = `${TWITTER_API_BASE}/tweets/${tweetId}?tweet.fields=public_metrics`;
  const authHeader = buildOAuthHeader(config, "GET", url);

  const res = await fetch(url, {
    headers: { Authorization: authHeader },
  });

  if (!res.ok) {
    throw new Error(`Twitter get metrics failed: ${res.status}`);
  }

  const data: any = await res.json();
  const m = data.data?.public_metrics ?? {};
  return {
    retweets: m.retweet_count ?? 0,
    replies: m.reply_count ?? 0,
    likes: m.like_count ?? 0,
    quotes: m.quote_count ?? 0,
    impressions: m.impression_count ?? 0,
  };
}

/**
 * Get the authenticated user's info.
 */
export async function getTwitterUser(
  config: TwitterConfig,
): Promise<{ id: string; username: string; name: string }> {
  const url = `${TWITTER_API_BASE}/users/me`;
  const authHeader = buildOAuthHeader(config, "GET", url);

  const res = await fetch(url, {
    headers: { Authorization: authHeader },
  });

  if (!res.ok) {
    throw new Error(`Twitter get user failed: ${res.status}`);
  }

  const data: any = await res.json();
  return {
    id: data.data?.id ?? "",
    username: data.data?.username ?? "",
    name: data.data?.name ?? "",
  };
}

/**
 * Test Twitter connection.
 */
export async function testTwitterConnection(
  config: TwitterConfig,
): Promise<{ ok: boolean; username: string }> {
  const user = await getTwitterUser(config);
  return { ok: true, username: user.username };
}
