import { env } from "../../config/env";
import { logger } from "../../lib/logger";
import { redis } from "../../lib/redis";
import { audit } from "./audit";
import { markCallbackProcessed, unprocessedCallbacks } from "./social/queue";

/**
 * Telegram approval bot v1 (FABLE_PLAN §2 onay UX + §2A güvenlik sınırı).
 *
 * Dormant by design: without HOLDING_ENABLED + bot token + chat id every
 * send is a logged no-op, so this code can ship to main without becoming a
 * live surface.
 *
 * Security boundary (§2A.5): ONLY the founder's fixed Telegram user id may
 * decide approvals. Anyone else's tap is audited and refused — messages
 * from other users are untrusted content, never directives.
 */

const OFFSET_KEY = "holding:tg:offset";

interface TelegramConfig {
  token: string;
  approvalChatId: string;
  founderUserId: string;
}

export function telegramConfig(): TelegramConfig | null {
  if (!env.TELEGRAM_BOT_TOKEN || !env.HOLDING_APPROVAL_CHAT_ID || !env.HOLDING_FOUNDER_TELEGRAM_ID) {
    return null;
  }
  return {
    token: env.TELEGRAM_BOT_TOKEN,
    approvalChatId: env.HOLDING_APPROVAL_CHAT_ID,
    founderUserId: env.HOLDING_FOUNDER_TELEGRAM_ID,
  };
}

async function tg(
  cfg: TelegramConfig,
  method: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<any> {
  const res = await fetch(`https://api.telegram.org/bot${cfg.token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || json?.ok === false) {
    // Telegram error bodies can echo request content — log status only.
    throw new Error(`telegram ${method} failed: HTTP ${res.status}`);
  }
  return json.result;
}

/**
 * Send a one-tap approval request. Returns the Telegram message id, or null
 * when the bot is not configured (caller records the approval regardless —
 * the queue in the DB is the source of truth, Telegram is only transport).
 */
export async function sendApprovalRequest(approval: {
  id: string;
  description: string;
  riskClass: string;
}): Promise<string | null> {
  const cfg = telegramConfig();
  if (!cfg) {
    logger.info({ approvalId: approval.id }, "Telegram not configured — approval waits in DB queue only");
    return null;
  }
  const message = await tg(cfg, "sendMessage", {
    chat_id: cfg.approvalChatId,
    text: `🟡 ONAY BEKLİYOR [${approval.riskClass}]\n\n${approval.description}\n\nid: ${approval.id}`,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ Onayla", callback_data: `holding:approve:${approval.id}` },
          { text: "❌ Reddet", callback_data: `holding:reject:${approval.id}` },
        ],
      ],
    },
  });
  return String(message.message_id);
}

/** SEV0 fan-out — plain alert, no buttons (incident flow is human-driven). */
export async function sendSev0Alert(text: string): Promise<void> {
  const cfg = telegramConfig();
  if (!cfg) return;
  await tg(cfg, "sendMessage", { chat_id: cfg.approvalChatId, text: `🔴 SEV0\n\n${text}` });
}

/**
 * Rapor teslimi — düğmesiz, düz bildirim (kurucu kararı 2026-08-08: raporlar
 * hem Telegram'a hem Slack'e düşsün).
 *
 * `sendApprovalRequest`'ten AYRI tutulur: onay mesajı bir KARAR ister ve
 * callback döngüsüne bağlıdır; rapor yalnız bilgi taşır. İkisini tek fonksiyona
 * sıkıştırmak, bir gün raporun yanına yanlışlıkla onay düğmesi koymayı kolay
 * hale getirirdi.
 *
 * Gönderim başarısızlığı FIRLATMAZ: bir teslim kanalının düşmesi raporu
 * üreten workflow'u başarısız saymamalı (Slack'e gitmiş olabilir).
 */
export async function sendReport(title: string, body: string): Promise<boolean> {
  const cfg = telegramConfig();
  if (!cfg) {
    logger.info({ title }, "Telegram rapor teslimi atlandı (bot yapılandırılmamış)");
    return false;
  }
  try {
    // Telegram mesaj sınırı 4096 karakter; rapor uzunsa kırpılır ve bu
    // kırpma GÖRÜNÜR olur — sessizce yarım rapor göndermek yanıltıcıdır.
    const full = `📋 ${title}\n\n${body}`;
    const text = full.length > 3900 ? `${full.slice(0, 3900)}\n\n… (kırpıldı)` : full;
    await tg(cfg, "sendMessage", { chat_id: cfg.approvalChatId, text });
    return true;
  } catch (err) {
    logger.error({ err, title }, "Telegram rapor teslimi başarısız");
    return false;
  }
}

export interface TelegramDecision {
  approvalId: string;
  decision: "APPROVED" | "REJECTED";
  decidedBy: string;
}

/**
 * Parse + authenticate a callback_query update. Returns a decision only for
 * the verified founder id; every other actor is audited and refused.
 */
export async function authenticateCallback(update: any): Promise<TelegramDecision | null> {
  const cb = update?.callback_query;
  if (!cb?.data || typeof cb.data !== "string") return null;
  const match = cb.data.match(/^holding:(approve|reject):(\S+)$/);
  if (!match) return null;

  const fromId = String(cb.from?.id ?? "");
  const cfg = telegramConfig();
  if (!cfg || fromId !== cfg.founderUserId) {
    await audit({
      actor: `telegram:${fromId || "unknown"}`,
      action: "holding.approval_unauthorized_attempt",
      entity: "holding_approval",
      entityId: match[2],
    });
    logger.warn({ fromId }, "Unauthorized Telegram approval attempt refused");
    return null;
  }
  return {
    approvalId: match[2],
    decision: match[1] === "approve" ? "APPROVED" : "REJECTED",
    decidedBy: `telegram:${fromId}`,
  };
}

/**
 * Authenticate a decision that reached us through the webhook relay (an
 * `approval_callbacks` row written by the Supabase edge function) rather than
 * through getUpdates. The edge function already checks the founder id; this is
 * the second layer — the motor never trusts a table it does not own.
 */
export function authenticateRelayRow(row: {
  callback_data: string;
  user_id: string;
}): TelegramDecision | null {
  const match = row.callback_data?.match(/^holding:(approve|reject):(\S+)$/);
  if (!match) return null;
  const cfg = telegramConfig();
  if (!cfg || String(row.user_id) !== cfg.founderUserId) return null;
  return {
    approvalId: match[2],
    decision: match[1] === "approve" ? "APPROVED" : "REJECTED",
    decidedBy: `telegram:${row.user_id}`,
  };
}

/**
 * Long-poll loop for bot updates. Runs only when the module is enabled AND
 * configured; offset survives restarts via Redis. `handleDecision` is
 * injected (runner.resolveHoldingApproval) to avoid an import cycle.
 *
 * ⚠️ Only valid when NO webhook is registered — Telegram allows a bot exactly
 * one transport and answers getUpdates with 409 while a webhook exists. Use
 * `startTelegramTransport`, which picks the correct one at boot.
 */
export function startTelegramPolling(
  handleDecision: (decision: TelegramDecision) => Promise<void>,
): () => void {
  const cfg = telegramConfig();
  if (!cfg) {
    logger.info("Telegram polling not started (bot not configured)");
    return () => {};
  }

  let stopped = false;
  // Abortable long-poll: without this, shutdown would wait out a 25s
  // getUpdates and then touch an already-closed Redis (30s force-exit race).
  let aborter: AbortController | null = null;

  const loop = async () => {
    while (!stopped) {
      try {
        const offsetRaw = await redis.get(OFFSET_KEY);
        aborter = new AbortController();
        const updates: any[] = await tg(
          cfg,
          "getUpdates",
          {
            timeout: 25,
            offset: offsetRaw ? Number(offsetRaw) + 1 : undefined,
            allowed_updates: ["callback_query"],
          },
          aborter.signal,
        );
        if (stopped) break;
        for (const update of updates) {
          await redis.set(OFFSET_KEY, String(update.update_id));
          const decision = await authenticateCallback(update);
          if (decision) {
            await handleDecision(decision);
            await tg(cfg, "answerCallbackQuery", {
              callback_query_id: update.callback_query.id,
              text: decision.decision === "APPROVED" ? "✅ Onaylandı" : "❌ Reddedildi",
            }).catch(() => {});
          } else if (update.callback_query?.id) {
            await tg(cfg, "answerCallbackQuery", {
              callback_query_id: update.callback_query.id,
              text: "Yetkisiz",
            }).catch(() => {});
          }
        }
      } catch (err) {
        if (stopped) break; // abort on shutdown is expected, not an error
        logger.error({ err }, "Telegram poll cycle failed — backing off");
        await new Promise((r) => setTimeout(r, 10_000));
      }
    }
  };

  void loop();
  return () => {
    stopped = true;
    aborter?.abort();
  };
}

const RELAY_INTERVAL_MS = 5_000;

/**
 * Webhook relay transport: the Supabase edge function receives the tap and
 * writes an `approval_callbacks` row; we consume the holding-shaped rows.
 *
 * Why a relay instead of polling: the social pipeline already owns a webhook
 * on this bot, and a bot may have only one transport. The webhook is also the
 * more durable half — it is serverless and stays up while this process does
 * not, which the "24h silence = approval" rule depends on.
 */
export function startTelegramRelay(
  handleDecision: (decision: TelegramDecision) => Promise<void>,
): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const tick = async () => {
    try {
      const rows = await unprocessedCallbacks();
      for (const row of rows) {
        if (!row.callback_data?.startsWith("holding:")) continue; // sosyal satırlar orkestratörün
        const decision = authenticateRelayRow(row);
        if (decision) {
          await handleDecision(decision);
        } else {
          await audit({
            actor: `telegram:${row.user_id || "unknown"}`,
            action: "holding.approval_unauthorized_attempt",
            entity: "holding_approval",
            entityId: row.callback_data,
          });
        }
        // Yetkisiz satır da işaretlenir; aksi halde her turda yeniden okunup
        // denetim kaydını sonsuza dek şişirirdi.
        await markCallbackProcessed(row.id);
      }
    } catch (err) {
      logger.error({ err }, "Telegram relay cycle failed — retrying next tick");
    } finally {
      if (!stopped) timer = setTimeout(() => void tick(), RELAY_INTERVAL_MS);
    }
  };

  void tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

/**
 * Pick the transport that Telegram will actually allow, then start it.
 *
 * A webhook and getUpdates are mutually exclusive per bot: while a webhook URL
 * is registered, getUpdates returns 409 and the loop never sees a tap. Probing
 * once at boot keeps the same build correct in both deployments — locally
 * (social webhook registered → relay) and on a server with no webhook
 * (→ long polling) — with no extra configuration to keep in sync.
 */
export async function startTelegramTransport(
  handleDecision: (decision: TelegramDecision) => Promise<void>,
): Promise<() => void> {
  const cfg = telegramConfig();
  if (!cfg) {
    logger.info("Telegram transport not started (bot not configured)");
    return () => {};
  }
  let webhookUrl = "";
  try {
    const info = await tg(cfg, "getWebhookInfo", {});
    webhookUrl = String(info?.url ?? "");
  } catch (err) {
    logger.warn({ err }, "getWebhookInfo failed — assuming polling transport");
  }
  if (webhookUrl) {
    logger.info("Telegram transport: webhook relay (approval_callbacks)");
    return startTelegramRelay(handleDecision);
  }
  logger.info("Telegram transport: long polling (no webhook registered)");
  return startTelegramPolling(handleDecision);
}
