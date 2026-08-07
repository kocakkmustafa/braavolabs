/**
 * Sosyal yayın orkestratörü — onay kapısının motoru.
 *
 * Python `publish_approved.py`'nin TS portu + Slack raporlaması.
 * Her turda sırayla:
 *   1. Telegram callback'lerini işle (✓ / ❌ / ✏️)
 *   2. Penceresi yaklaşanlara son hatırlatma
 *   3. Penceresi dolan cevapsızları auto_approved yap ("sessizlik = onay")
 *   4. Yayına hazır olanları gerçek API ile yayınla
 *   5. Slack'e anlamlı olayları, Telegram'a özeti bildir
 *
 * ⚠️ Callback formatı edge function ile AYNI (`approve_<id>`): Mac tarafındaki
 * Supabase edge function'ı zaten bu formatı `approval_callbacks` tablosuna
 * yazıyor. Motor aynı tablodan okur — tek callback yolu, tek gerçek kaynağı.
 *
 * ⚠️ Açık RED zaman aşımı kuralının DIŞINDADIR: atlanan post asla yayınlanmaz.
 */

import { logger } from "../../../lib/logger";
import { notifySlack, type SlackEvent, type SlackProject } from "../slack";
import { publishWithRetry } from "./index";
import * as queue from "./queue";
import type { PublishResult, SocialBrand, SocialPost } from "./types";

export interface OrchestratorDeps extends queue.QueueDeps {
  /** Test kancası — gerçek yayın yapmadan sonucu belirler. */
  publishImpl?: (post: SocialPost) => Promise<PublishResult>;
  notifyImpl?: (event: SlackEvent) => Promise<boolean>;
  telegramImpl?: (text: string, replyMarkup?: unknown) => Promise<string | null>;
  dryRun?: boolean;
}

export interface TurnSummary {
  approved: number;
  skipped: number;
  edited: number;
  reminders: number;
  timeouts: number;
  published: Array<{ row: queue.QueueRow; result: PublishResult }>;
  failures: Array<{ row: queue.QueueRow; result: PublishResult }>;
}

function toProject(brand: SocialBrand): SlackProject {
  return brand as SlackProject;
}

function rowToPost(row: queue.QueueRow): SocialPost {
  return {
    brand: row.brand,
    platform: row.platform,
    caption: row.caption,
    mediaUrls: row.media_urls ?? [],
    mediaKind: (row.media_kind ?? "none") as SocialPost["mediaKind"],
    hashtags: row.hashtags ?? [],
    queueId: row.id,
  };
}

async function report(deps: OrchestratorDeps, event: SlackEvent): Promise<void> {
  const impl = deps.notifyImpl ?? ((e: SlackEvent) => notifySlack(e));
  try {
    await impl(event);
  } catch (err) {
    logger.warn({ err, kind: event.kind }, "Slack raporu gönderilemedi (iş devam ediyor)");
  }
}

// ─── 1) Callback'ler ───────────────────────────────────────────────────────

export async function processCallbacks(deps: OrchestratorDeps = {}): Promise<{
  approved: number;
  skipped: number;
  edited: number;
}> {
  const counts = { approved: 0, skipped: 0, edited: 0 };
  const callbacks = await queue.unprocessedCallbacks(deps);

  for (const cb of callbacks) {
    const postId = cb.post_queue_id;
    if (deps.dryRun) {
      logger.info({ cb: cb.id, action: cb.action, postId }, "[dry-run] callback");
      continue;
    }
    try {
      if (cb.action === "approve" && postId) {
        await queue.markApproved(postId, "founder", deps);
        counts.approved += 1;
        await report(deps, {
          kind: "approval.granted",
          project: "holding",
          title: `Yayın onaylandı — post #${postId}`,
          fields: { "post id": postId },
        });
      } else if ((cb.action === "skip" || cb.action === "reject") && postId) {
        await queue.markSkipped(postId, `kurucu ${cb.action}`, deps);
        counts.skipped += 1;
        await report(deps, {
          kind: "approval.rejected",
          project: "holding",
          title: `Yayın atlandı — post #${postId}`,
          fields: { "post id": postId, karar: cb.action },
        });
      } else if (cb.action === "edit" && postId && cb.payload_json?.new_caption) {
        // Düzenleme onay yerine geçer (Python tarafıyla aynı davranış).
        await queue.markApproved(postId, "founder", deps);
        counts.edited += 1;
      } else if (cb.action === "approve_all") {
        for (const p of await queue.pendingPosts(deps)) {
          await queue.markApproved(p.id, "founder", deps);
          counts.approved += 1;
        }
      }
      await queue.markCallbackProcessed(cb.id, deps);
    } catch (err) {
      logger.error({ err, cb: cb.id }, "callback işlenemedi");
    }
  }
  return counts;
}

// ─── 2) Hatırlatma ─────────────────────────────────────────────────────────

export async function sendReminders(deps: OrchestratorDeps = {}): Promise<number> {
  const due = await queue.dueForReminder(deps);
  for (const row of due) {
    if (deps.dryRun) continue;
    const text =
      `⏰ <b>Yayınlanmak üzere</b> — ${row.brand} · <code>${row.platform}</code>\n` +
      `Şimdi müdahale etmezsen otomatik yayınlanacak.\n\n${row.caption.slice(0, 500)}`;
    if (deps.telegramImpl) await deps.telegramImpl(text);
    await queue.markReminderSent(row.id, deps);
  }
  return due.length;
}

// ─── 3) Zaman aşımı → sessizlik onay sayılır ───────────────────────────────

export async function processTimeouts(deps: OrchestratorDeps = {}): Promise<number> {
  const due = await queue.dueForAutoApproval(deps);
  for (const row of due) {
    if (deps.dryRun) continue;
    await queue.markApproved(row.id, "timeout", deps);
    logger.info({ postId: row.id }, "auto-approved (onay penceresi doldu)");
  }
  return due.length;
}

// ─── 4) Yayınla ────────────────────────────────────────────────────────────

export async function publishReady(deps: OrchestratorDeps = {}): Promise<{
  published: Array<{ row: queue.QueueRow; result: PublishResult }>;
  failures: Array<{ row: queue.QueueRow; result: PublishResult }>;
}> {
  const published: Array<{ row: queue.QueueRow; result: PublishResult }> = [];
  const failures: Array<{ row: queue.QueueRow; result: PublishResult }> = [];
  const rows = await queue.readyToPublish(deps);
  const doPublish = deps.publishImpl ?? publishWithRetry;

  for (const row of rows) {
    if (deps.dryRun) {
      logger.info({ postId: row.id, platform: row.platform }, "[dry-run] yayınlanacak");
      continue;
    }
    const result = await doPublish(rowToPost(row));

    if (result.status === "manual_required") {
      await queue.markSkipped(row.id, `manuel platform: ${result.error}`, deps);
      continue;
    }
    if (result.status === "published") {
      await queue.markPublished(row, result.platformPostId ?? null, result.platformUrl ?? null, deps);
      published.push({ row, result });
      await report(deps, {
        kind: "publish.succeeded",
        project: toProject(row.brand),
        title: `${row.brand} · ${row.platform} yayınlandı`,
        fields: {
          onay: row.approved_by === "timeout" ? "sessizlik (pencere doldu)" : "kurucu",
          uyarı: (result.raw?.warning as string) ?? undefined,
        },
        url: result.platformUrl ?? undefined,
        runId: `post_${row.id}`,
      });
    } else {
      await queue.markFailed(row, result.error ?? "bilinmeyen hata", deps);
      failures.push({ row, result });
      await report(deps, {
        kind: "publish.failed",
        project: toProject(row.brand),
        title: `${row.brand} · ${row.platform} YAYINLANAMADI`,
        fields: { hata: (result.error ?? "").slice(0, 280) },
        severity: "SEV2",
        runId: `post_${row.id}`,
      });
    }
  }
  return { published, failures };
}

// ─── Tam tur ───────────────────────────────────────────────────────────────

export async function runTurn(deps: OrchestratorDeps = {}): Promise<TurnSummary> {
  const cb = await processCallbacks(deps);
  const reminders = await sendReminders(deps);
  const timeouts = await processTimeouts(deps);
  const { published, failures } = await publishReady(deps);

  const summary: TurnSummary = {
    approved: cb.approved,
    skipped: cb.skipped,
    edited: cb.edited,
    reminders,
    timeouts,
    published,
    failures,
  };

  logger.info(
    {
      approved: summary.approved,
      skipped: summary.skipped,
      reminders,
      timeouts,
      published: published.length,
      failed: failures.length,
    },
    "sosyal yayın turu tamamlandı",
  );
  return summary;
}

export function renderTurnSummary(s: TurnSummary): string {
  const lines = ["📊 <b>Yayın turu özeti</b>"];
  if (s.approved || s.skipped || s.edited) {
    lines.push(`• Onay: ${s.approved} · Atlandı: ${s.skipped} · Düzenlendi: ${s.edited}`);
  }
  if (s.reminders) lines.push(`• ⏰ ${s.reminders} post için son uyarı`);
  if (s.timeouts) lines.push(`• 🕓 ${s.timeouts} post pencere dolduğu için otomatik onaylandı`);
  lines.push(`• ✅ Yayınlandı: ${s.published.length}`);
  for (const p of s.published.slice(0, 10)) {
    lines.push(`   – ${p.row.brand}/${p.result.platform}: ${p.result.platformUrl ?? p.result.platformPostId ?? "ok"}`);
  }
  if (s.failures.length) {
    lines.push(`• ❌ Başarısız: ${s.failures.length}`);
    for (const f of s.failures.slice(0, 10)) {
      lines.push(`   – ${f.row.brand}/${f.result.platform}: ${(f.result.error ?? "").slice(0, 160)}`);
    }
  }
  return lines.join("\n");
}
