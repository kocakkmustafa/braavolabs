/**
 * Slack API Client
 *
 * Supports Slack Web API (bot token) and Incoming Webhooks.
 */

export interface SlackConfig {
  botToken: string;
  webhookUrl?: string;
}

const SLACK_API_BASE = "https://slack.com/api";

/**
 * Post a message to a Slack channel.
 */
export async function sendSlackMessage(
  config: SlackConfig,
  channel: string,
  text: string,
  blocks?: unknown[],
): Promise<{ ts: string; channel: string }> {
  const res = await fetch(`${SLACK_API_BASE}/chat.postMessage`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ channel, text, blocks }),
  });

  const data: any = await res.json();
  if (!data.ok) {
    throw new Error(`Slack postMessage failed: ${data.error}`);
  }

  return { ts: data.ts, channel: data.channel };
}

/**
 * Post a message via Incoming Webhook (no auth required beyond URL).
 */
export async function sendSlackWebhook(
  config: SlackConfig,
  text: string,
  blocks?: unknown[],
): Promise<void> {
  if (!config.webhookUrl) {
    throw new Error("Slack webhookUrl is not configured");
  }

  const res = await fetch(config.webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, blocks }),
  });

  if (!res.ok) {
    throw new Error(`Slack webhook failed: ${res.status}`);
  }
}

/**
 * List public channels in the workspace.
 */
export async function listSlackChannels(
  config: SlackConfig,
): Promise<Array<{ id: string; name: string; memberCount: number }>> {
  const res = await fetch(
    `${SLACK_API_BASE}/conversations.list?types=public_channel&limit=200`,
    { headers: { Authorization: `Bearer ${config.botToken}` } },
  );

  const data: any = await res.json();
  if (!data.ok) {
    throw new Error(`Slack conversations.list failed: ${data.error}`);
  }

  return (data.channels ?? []).map((c: any) => ({
    id: c.id,
    name: c.name,
    memberCount: c.num_members ?? 0,
  }));
}

/**
 * Test Slack connection by calling auth.test.
 */
export async function testSlackConnection(
  config: SlackConfig,
): Promise<{ ok: boolean; team: string; user: string }> {
  const res = await fetch(`${SLACK_API_BASE}/auth.test`, {
    headers: { Authorization: `Bearer ${config.botToken}` },
  });

  const data: any = await res.json();
  if (!data.ok) {
    throw new Error(`Slack auth.test failed: ${data.error}`);
  }

  return { ok: true, team: data.team, user: data.user };
}
