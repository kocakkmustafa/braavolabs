/**
 * Kendi kanallarımız — Telegram kanalı ve Discord sunucusu.
 *
 * Kurucu kararı 2026-08-07: bunlar da onay kapısından geçer. Tek kural,
 * iki istisna değil — "kendi evim" muafiyeti akılda iki farklı model
 * tutmayı gerektirirdi.
 *
 * ⚠️ Discord notu: geliştirme makinesinden discord.com'a bağlanılamıyor
 * (2026-08-07 ortam kısıtı). Kod Python'daki kanıtlanmış akışın portudur
 * ama Discord canlı sınanmadı — sunucuda ilk gerçek gönderide doğrulanmalı.
 */

import { HOSTS, brandValue, requireValue } from "../config";
import { postJson } from "../http";
import { failed, published, type PublishResult, type SocialPost } from "../types";

const TELEGRAM_CAPTION_LIMIT = 1024;
const TELEGRAM_TEXT_LIMIT = 4096;
const DISCORD_CONTENT_LIMIT = 2000;

export async function publishTelegramChannel(post: SocialPost): Promise<PublishResult> {
  const platform = "telegram" as const;
  const chatId = brandValue("TG_CHANNEL", post.brand);
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!chatId) return failed(platform, `eksik env: TG_CHANNEL_${post.brand.toUpperCase()}`);
  if (!token) return failed(platform, "eksik env: TELEGRAM_BOT_TOKEN");

  const base = `${HOSTS.telegram}/bot${token}`;
  const caption = post.caption.trim();
  const media = post.mediaUrls?.[0];
  const video = post.mediaKind === "video";

  let res;
  if (media && video) {
    res = await postJson(`${base}/sendVideo`, {
      chat_id: chatId,
      video: media,
      caption: caption.slice(0, TELEGRAM_CAPTION_LIMIT),
    });
  } else if (media) {
    res = await postJson(`${base}/sendPhoto`, {
      chat_id: chatId,
      photo: media,
      caption: caption.slice(0, TELEGRAM_CAPTION_LIMIT),
    });
  } else {
    res = await postJson(`${base}/sendMessage`, {
      chat_id: chatId,
      text: caption.slice(0, TELEGRAM_TEXT_LIMIT),
      disable_web_page_preview: true,
    });
  }

  if (res.status !== 200 || res.data.ok !== true) {
    return failed(platform, `Telegram reddetti: ${res.data.description ?? res.raw.slice(0, 200)}`, res.data);
  }
  const result = (res.data.result ?? {}) as Record<string, unknown>;
  const msgId = result.message_id as number | undefined;
  const chat = (result.chat ?? {}) as Record<string, unknown>;
  const username = chat.username as string | undefined;
  return published(
    platform,
    msgId ? String(msgId) : null,
    username && msgId ? `https://t.me/${username}/${msgId}` : null,
    result,
  );
}

export async function publishDiscord(post: SocialPost): Promise<PublishResult> {
  const platform = "discord" as const;
  const caption = post.caption.trim().slice(0, DISCORD_CONTENT_LIMIT);
  const media = post.mediaUrls?.[0];
  const content = (media ? `${caption}\n${media}` : caption).slice(0, DISCORD_CONTENT_LIMIT);

  const channelId = brandValue("DISCORD_CHANNEL_ID", post.brand);
  const botToken = process.env.DISCORD_BOT_TOKEN?.trim();
  let botError = "bot yolu atlandı (channel_id veya bot_token yok)";

  if (channelId && botToken) {
    const res = await postJson(
      `${HOSTS.discord}/channels/${channelId}/messages`,
      { content },
      { authorization: `Bot ${botToken}` },
    );
    if (res.status === 200 || res.status === 201) {
      const msgId = res.data.id ? String(res.data.id) : null;
      const guild = process.env.DISCORD_GUILD_ID_YULALAB?.trim();
      return published(
        platform,
        msgId,
        guild && msgId ? `https://discord.com/channels/${guild}/${channelId}/${msgId}` : null,
        res.data,
      );
    }
    botError = `bot yolu HTTP ${res.status}: ${res.data.message ?? res.raw.slice(0, 200)}`;
  }

  const webhook = brandValue("DISCORD_WEBHOOK", post.brand);
  if (!webhook) {
    return failed(platform, `${botError}; webhook da yok (DISCORD_WEBHOOK_${post.brand.toUpperCase()})`);
  }
  const res = await postJson(`${webhook}?wait=true`, { content });
  if (res.status !== 200 && res.status !== 201) {
    return failed(platform, `${botError}; webhook da başarısız HTTP ${res.status}: ${res.raw.slice(0, 200)}`);
  }
  return published(platform, res.data.id ? String(res.data.id) : null, null, res.data);
}

/** requireValue re-export — publisher'lar tek yerden env okusun. */
export { requireValue };
