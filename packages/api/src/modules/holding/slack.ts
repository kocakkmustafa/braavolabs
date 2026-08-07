/**
 * Slack raporlama katmanı (kurucu kararı 2026-08-07).
 *
 * Kurucunun istediği model: **anlamlı olaylar + günlük özet**.
 * Her tekil adım DEĞİL — workflow başlangıcı/bitişi, onay istekleri ve
 * kararları, yayınlar, hatalar, sentinel olayları ve maliyet alarmları.
 * Gün sonunda kanal başına özet. Amaç okunabilir kalmak: günde yüzlerce
 * mesaj kimse tarafından okunmaz, önemli olan kaybolur.
 *
 * Yönlendirme: her olay bir PROJE anahtarı taşır (yulalab | braavolabs |
 * burunfarki | lifeos | holding). Proje kanalı tanımlıysa oraya, değilse
 * holding kanalına düşer — sessizce kaybolmaz.
 *
 * Dormant by design (telegram.ts ile aynı sözleşme): HOLDING_ENABLED yoksa
 * veya webhook tanımlı değilse her gönderim loglanmış bir no-op olur, bu
 * yüzden kod main'e uyuyan hâlde gidebilir.
 *
 * ⚠️ Slack webhook'u TEK YÖNLÜDÜR: buradan bildirim gider, KARAR GELMEZ.
 * Onay akışı yalnız Telegram'dadır (telegram.ts, §2A güvenlik sınırı) —
 * Slack'e düşen bir mesaj asla direktif olarak yorumlanmaz.
 */

import { env } from "../../config/env";
import { logger } from "../../lib/logger";
import { audit } from "./audit";
import type { HoldingSeverityStr } from "./types";

/** Raporlanan projeler — holding = çapraz/kurumsal olaylar. */
export const SLACK_PROJECTS = [
  "yulalab",
  "braavolabs",
  "burunfarki",
  "lifeos",
  "holding",
] as const;
export type SlackProject = (typeof SLACK_PROJECTS)[number];

/**
 * Anlamlı olay tipleri. Bu liste KAPALIDIR — yeni bir olay tipi eklemek
 * bilinçli bir karar olmalı, yoksa "her adım" gürültüsüne geri döneriz.
 */
export type SlackEventKind =
  | "workflow.started"
  | "workflow.completed"
  | "workflow.failed"
  | "approval.requested"
  | "approval.granted"
  | "approval.rejected"
  | "publish.succeeded"
  | "publish.failed"
  | "publish.queued"
  | "sentinel.event"
  | "cost.alarm"
  | "story.captured"
  | "decision.recorded";

const KIND_ICON: Record<SlackEventKind, string> = {
  "workflow.started": "▶️",
  "workflow.completed": "✅",
  "workflow.failed": "❌",
  "approval.requested": "🔔",
  "approval.granted": "👍",
  "approval.rejected": "🚫",
  "publish.succeeded": "📣",
  "publish.failed": "⚠️",
  "publish.queued": "📝",
  "sentinel.event": "🛡️",
  "cost.alarm": "💸",
  "story.captured": "📚",
  "decision.recorded": "⚖️",
};

export interface SlackEvent {
  kind: SlackEventKind;
  project: SlackProject;
  /** Tek satırlık başlık — kanalda bu görünür. */
  title: string;
  /** İsteğe bağlı alan/değer çiftleri (kısa tutulur). */
  fields?: Record<string, string | number | null | undefined>;
  /** İlgili bağlantı (yayın URL'i, run id, PR…). */
  url?: string;
  severity?: HoldingSeverityStr;
  /** Denetim izini bu run'a bağlar. */
  runId?: string;
}

export interface SlackConfig {
  webhooks: Partial<Record<SlackProject, string>>;
  fallback?: string;
}

/**
 * Webhook'ları env'den topla. Marka anahtarları Mac tarafındaki yayın
 * hattıyla AYNI isimleri kullanır (SLACK_WEBHOOK_*) ki tek bir .env iki
 * tarafı birden beslesin — "braavo" kısaltması tarihsel, korunuyor.
 */
export function loadSlackConfig(source: NodeJS.ProcessEnv = process.env): SlackConfig {
  const webhooks: Partial<Record<SlackProject, string>> = {};
  const map: Record<SlackProject, string[]> = {
    yulalab: ["SLACK_WEBHOOK_YULALAB"],
    braavolabs: ["SLACK_WEBHOOK_BRAAVO", "SLACK_WEBHOOK_BRAAVOLABS"],
    burunfarki: ["SLACK_WEBHOOK_BURUNFARKI"],
    lifeos: ["SLACK_WEBHOOK_LIFEOS"],
    holding: ["SLACK_WEBHOOK_HOLDING"],
  };
  for (const project of SLACK_PROJECTS) {
    for (const key of map[project]) {
      const value = source[key]?.trim();
      if (value) {
        webhooks[project] = value;
        break;
      }
    }
  }
  return { webhooks, fallback: webhooks.holding ?? webhooks.yulalab };
}

function resolveWebhook(cfg: SlackConfig, project: SlackProject): string | null {
  return cfg.webhooks[project] ?? cfg.fallback ?? null;
}

function renderBlocks(event: SlackEvent): unknown[] {
  const icon = KIND_ICON[event.kind] ?? "•";
  const blocks: unknown[] = [
    {
      type: "section",
      text: { type: "mrkdwn", text: `${icon} *${event.title}*` },
    },
  ];

  const entries = Object.entries(event.fields ?? {}).filter(
    ([, v]) => v !== undefined && v !== null && `${v}`.trim() !== "",
  );
  if (entries.length > 0) {
    blocks.push({
      type: "section",
      fields: entries.slice(0, 10).map(([k, v]) => ({
        type: "mrkdwn",
        text: `*${k}:*\n${`${v}`.slice(0, 300)}`,
      })),
    });
  }

  const context: string[] = [`\`${event.kind}\``, `proje: ${event.project}`];
  if (event.severity) context.push(`sev: ${event.severity}`);
  if (event.runId) context.push(`run: \`${event.runId}\``);
  if (event.url) context.push(`<${event.url}|bağlantı>`);
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: context.join(" · ") }],
  });

  return blocks;
}

export interface SlackDeps {
  fetchImpl?: typeof fetch;
  config?: SlackConfig;
  /** Test kancası — HOLDING_ENABLED'ı atlar. */
  force?: boolean;
}

/**
 * Tek bir anlamlı olayı Slack'e bildir.
 *
 * ASLA fırlatmaz: Slack'in düşmesi holding işini durdurmamalı. Başarısızlık
 * loglanır ve denetim defterine yazılır (olay kaybolmaz, sadece Slack'e
 * ulaşmamış olur).
 */
export async function notifySlack(event: SlackEvent, deps: SlackDeps = {}): Promise<boolean> {
  const enabled = deps.force || env.HOLDING_ENABLED;
  if (!enabled) {
    logger.info({ kind: event.kind, project: event.project }, "Slack DORMANT (HOLDING_ENABLED != true)");
    return false;
  }

  const cfg = deps.config ?? loadSlackConfig();
  const webhook = resolveWebhook(cfg, event.project);
  if (!webhook) {
    logger.warn({ kind: event.kind, project: event.project }, "Slack webhook tanımlı değil — olay gönderilmedi");
    return false;
  }

  const doFetch = deps.fetchImpl ?? fetch;
  const payload = {
    text: `${KIND_ICON[event.kind] ?? "•"} ${event.title}`,
    blocks: renderBlocks(event),
  };

  try {
    const res = await doFetch(webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      logger.warn({ status: res.status, kind: event.kind }, "Slack webhook reddetti");
      return false;
    }
  } catch (err) {
    logger.warn({ err, kind: event.kind }, "Slack gönderimi başarısız (iş devam ediyor)");
    return false;
  }

  try {
    await audit({
      actor: "holding-motor",
      action: `slack.${event.kind}`,
      entity: "slack_notification",
      entityId: event.project,
      runId: event.runId,
      payload: { title: event.title, severity: event.severity ?? "INFO", url: event.url ?? null },
    });
  } catch (err) {
    logger.debug({ err }, "slack audit yazılamadı (bildirim gitti)");
  }
  return true;
}

// ─── Günlük özet ────────────────────────────────────────────────────────────

export interface DailyDigestInput {
  project: SlackProject;
  /** Gün içinde biriken olaylar (çağıran toplar — bu modül state tutmaz). */
  events: SlackEvent[];
  /** Özetin kapsadığı gün, YYYY-MM-DD. */
  day: string;
}

/**
 * Gün sonu özeti: kanal başına tek mesaj. Sayımlar + öne çıkanlar.
 *
 * Neden state tutmuyoruz: motor zaten her olayı denetim defterine yazıyor;
 * özet o defterden türetilir. Burada ikinci bir gerçek kaynağı yaratmak
 * ikisinin ayrışması demek olurdu.
 */
export function renderDailyDigest(input: DailyDigestInput): { text: string; blocks: unknown[] } {
  const counts = new Map<SlackEventKind, number>();
  for (const e of input.events) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);

  const published = input.events.filter((e) => e.kind === "publish.succeeded");
  const failures = input.events.filter(
    (e) => e.kind === "workflow.failed" || e.kind === "publish.failed",
  );
  const pendingApprovals = input.events.filter((e) => e.kind === "approval.requested").length;
  const decided = input.events.filter(
    (e) => e.kind === "approval.granted" || e.kind === "approval.rejected",
  ).length;

  const lines: string[] = [];
  lines.push(`*${input.day} — ${input.project} günlük özeti*`);
  lines.push(
    `• İş: ${counts.get("workflow.completed") ?? 0} tamamlandı · ${counts.get("workflow.failed") ?? 0} başarısız`,
  );
  lines.push(`• Yayın: ${published.length} yayınlandı · ${counts.get("publish.failed") ?? 0} başarısız`);
  lines.push(`• Onay: ${pendingApprovals} istendi · ${decided} karara bağlandı`);
  if ((counts.get("story.captured") ?? 0) > 0) {
    lines.push(`• Öğrenme: ${counts.get("story.captured")} hikâye adayı yakalandı`);
  }
  if ((counts.get("cost.alarm") ?? 0) > 0) {
    lines.push(`• 💸 ${counts.get("cost.alarm")} maliyet alarmı`);
  }

  if (published.length > 0) {
    lines.push("");
    lines.push("*Yayınlananlar:*");
    for (const p of published.slice(0, 10)) {
      lines.push(`  · ${p.title}${p.url ? ` — <${p.url}|bak>` : ""}`);
    }
  }
  if (failures.length > 0) {
    lines.push("");
    lines.push("*İlgi bekleyenler:*");
    for (const f of failures.slice(0, 10)) lines.push(`  · ${f.title}`);
  }
  if (input.events.length === 0) {
    lines.push("_Bugün kayda değer bir olay yok._");
  }

  const text = lines.join("\n");
  return {
    text,
    blocks: [{ type: "section", text: { type: "mrkdwn", text } }],
  };
}

export async function sendDailyDigest(
  input: DailyDigestInput,
  deps: SlackDeps = {},
): Promise<boolean> {
  const enabled = deps.force || env.HOLDING_ENABLED;
  if (!enabled) {
    logger.info({ project: input.project }, "Slack digest DORMANT");
    return false;
  }
  const cfg = deps.config ?? loadSlackConfig();
  const webhook = resolveWebhook(cfg, input.project);
  if (!webhook) return false;

  const { text, blocks } = renderDailyDigest(input);
  const doFetch = deps.fetchImpl ?? fetch;
  try {
    const res = await doFetch(webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: `${input.day} — ${input.project} özeti`, blocks }),
    });
    return res.ok;
  } catch (err) {
    logger.warn({ err, project: input.project }, "günlük özet gönderilemedi");
    return false;
  }
}
