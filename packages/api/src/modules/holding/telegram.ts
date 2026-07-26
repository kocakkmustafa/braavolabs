import { env } from "../../config/env";
import { logger } from "../../lib/logger";
import { redis } from "../../lib/redis";
import { audit } from "./audit";

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

async function tg(cfg: TelegramConfig, method: string, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(`https://api.telegram.org/bot${cfg.token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
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
 * Long-poll loop for bot updates. Runs only when the module is enabled AND
 * configured; offset survives restarts via Redis. `handleDecision` is
 * injected (runner.resolveHoldingApproval) to avoid an import cycle.
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

  const loop = async () => {
    while (!stopped) {
      try {
        const offsetRaw = await redis.get(OFFSET_KEY);
        const updates: any[] = await tg(cfg, "getUpdates", {
          timeout: 25,
          offset: offsetRaw ? Number(offsetRaw) + 1 : undefined,
          allowed_updates: ["callback_query"],
        });
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
        logger.error({ err }, "Telegram poll cycle failed — backing off");
        await new Promise((r) => setTimeout(r, 10_000));
      }
    }
  };

  void loop();
  return () => {
    stopped = true;
  };
}
