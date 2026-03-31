/**
 * Discord API Client
 *
 * Supports Discord Bot API and Incoming Webhooks.
 */

export interface DiscordConfig {
  botToken: string;
  webhookUrl?: string;
}

const DISCORD_API_BASE = "https://discord.com/api/v10";

/**
 * Send a message to a Discord channel via Bot API.
 */
export async function sendDiscordMessage(
  config: DiscordConfig,
  channelId: string,
  content: string,
  embeds?: unknown[],
): Promise<{ id: string; channelId: string }> {
  const res = await fetch(`${DISCORD_API_BASE}/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${config.botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ content, embeds }),
  });

  if (!res.ok) {
    const err: any = await res.json().catch(() => ({}));
    throw new Error(`Discord send message failed: ${err?.message ?? res.status}`);
  }

  const data: any = await res.json();
  return { id: data.id, channelId: data.channel_id };
}

/**
 * Post a message via Incoming Webhook.
 */
export async function sendDiscordWebhook(
  config: DiscordConfig,
  content: string,
  embeds?: unknown[],
  username?: string,
): Promise<void> {
  if (!config.webhookUrl) {
    throw new Error("Discord webhookUrl is not configured");
  }

  const res = await fetch(config.webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, embeds, username }),
  });

  if (!res.ok) {
    throw new Error(`Discord webhook failed: ${res.status}`);
  }
}

/**
 * Get a list of guilds the bot is a member of.
 */
export async function listDiscordGuilds(
  config: DiscordConfig,
): Promise<Array<{ id: string; name: string }>> {
  const res = await fetch(`${DISCORD_API_BASE}/users/@me/guilds`, {
    headers: { Authorization: `Bot ${config.botToken}` },
  });

  if (!res.ok) {
    throw new Error(`Discord list guilds failed: ${res.status}`);
  }

  const data: any = await res.json();
  return (data ?? []).map((g: any) => ({ id: g.id, name: g.name }));
}

/**
 * Test Discord connection by fetching bot user info.
 */
export async function testDiscordConnection(
  config: DiscordConfig,
): Promise<{ ok: boolean; username: string; id: string }> {
  const res = await fetch(`${DISCORD_API_BASE}/users/@me`, {
    headers: { Authorization: `Bot ${config.botToken}` },
  });

  if (!res.ok) {
    throw new Error(`Discord auth check failed: ${res.status}`);
  }

  const data: any = await res.json();
  return { ok: true, username: data.username, id: data.id };
}
