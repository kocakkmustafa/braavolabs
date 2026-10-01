import { env } from "../../config/env";
import { logger } from "../../lib/logger";
import { checkHeartbeats } from "./sentinel";
import { prisma } from "../../lib/db";
import { sweepSentinelSensors } from "./sensors";
import { initHoldingWorker, resolveHoldingApproval, reconcileOrphanHoldingRuns, createHoldingRun } from "./runner";
import { startTelegramTransport } from "./telegram";

/**
 * Holding module bootstrap. DORMANT BY DEFAULT: unless HOLDING_ENABLED=true
 * nothing here starts — no worker, no timer, no Telegram traffic. This is
 * the MOTOR-KICKOFF sert kural #4 in code: the motor may ship to prod but
 * cannot become live before the founder flips the flag (which itself waits
 * on the K2 provider spend-caps).
 */

const HEARTBEAT_SWEEP_MS = 5 * 60_000;

/**
 * Sosyal yayın turu aralığı (D5, 2026-08-07).
 *
 * Mac tarafında zamanlayıcı kurulmamıştı (DEFTER H-016) — bu, "sessizlik =
 * onay" modelinin fiilen çalışmaması demekti: pencere dolsa bile kimse
 * yayınlamıyordu. Motor sürekli çalışan bir servis olduğu için o boşluk
 * burada kapanır: onaylar en geç 15 dakikada işlenir, penceresi dolanlar
 * yayınlanır, hatırlatmalar zamanında gider.
 */
const SOCIAL_TURN_MS = 15 * 60_000;
/** Günlük özet taraması — saat başı bakılır, gün değişince gönderilir. */
const DIGEST_CHECK_MS = 60 * 60_000;
/** Brief/SEV1 turu: 5 dakika. SEV1 için yeterince sık, brief için gün-bazlı
 *  kilit zaten tekrarı engelliyor. */
const BRIEF_CHECK_MS = 5 * 60_000;
/** Sabah brief'inin erken sınırı (yerel saat). */
const BRIEF_HOUR = 8;

let heartbeatTimer: NodeJS.Timeout | null = null;
let socialTimer: NodeJS.Timeout | null = null;
let digestTimer: NodeJS.Timeout | null = null;
let briefTimer: NodeJS.Timeout | null = null;
let lastBriefDay = "";
/** Duyurulmuş acil olaylar — aynı SEV1 her 5 dakikada bir bildirilmesin.
 *  Süreç ömrüyle sınırlı: yeniden başlatmada tekrar duyurulur, bu KASITLI —
 *  motor çöküp kalktıysa acil sinyal yeniden görünmelidir. */
const duyurulanAcil = new Set<string>();
let lastDigestDay: string | null = null;
let stopTelegram: (() => void) | null = null;
let worker: ReturnType<typeof initHoldingWorker> | null = null;

export function initHoldingModule(): void {
  if (!env.HOLDING_ENABLED) {
    logger.info("Holding module DORMANT (HOLDING_ENABLED != true)");
    return;
  }
  worker = initHoldingWorker();
  // D4 bootstrap: YULA tenant + governance workflow catalog (idempotent).
  void (async () => {
    const { ensureYulaTenant } = await import("./tenant");
    const { seedHoldingDefinitions } = await import("./seeds");
    await ensureYulaTenant();
    const seeded = await seedHoldingDefinitions();
    logger.info(seeded, "holding D4 bootstrap complete (tenant + seeds)");
  })().catch((err) => logger.error({ err }, "holding D4 bootstrap failed"));
  // Orphan guard: re-enqueue runs stranded by a crash between the DB write
  // and the Redis enqueue (idempotent jobIds make this safe to repeat).
  reconcileOrphanHoldingRuns()
    .then((n) => n > 0 && logger.warn({ count: n }, "holding orphan reconciliation re-enqueued runs"))
    .catch((err) => logger.error({ err }, "holding orphan reconciliation failed"));
  heartbeatTimer = setInterval(() => {
    // Order matters: sensors first (they refresh their own heartbeat), then
    // the dead-man's sweep judges everyone's freshness.
    sweepSentinelSensors()
      .catch((err) => logger.error({ err }, "sensor sweep failed"))
      .finally(() => {
        checkHeartbeats().catch((err) => logger.error({ err }, "heartbeat sweep failed"));
      });
  }, HEARTBEAT_SWEEP_MS);
  // unref: a sweep timer must never keep a dying process alive.
  heartbeatTimer.unref?.();
  // Transport seçimi async (getWebhookInfo sorgusu) ama init senkron kalmalı.
  // Durdurucu çözülünce bağlanır; kapanış yarışı kazanırsa hemen durdurulur —
  // aksi halde relay zamanlayıcısı modülden uzun yaşardı.
  let telegramCancelled = false;
  stopTelegram = () => {
    telegramCancelled = true;
  };
  void startTelegramTransport((decision) => resolveHoldingApproval(decision).then(() => undefined))
    .then((stop) => {
      if (telegramCancelled) stop();
      else stopTelegram = stop;
    })
    .catch((err) => logger.error({ err }, "Telegram transport başlatılamadı"));

  // ── D5: sosyal yayın turu (H-016'nın motor tarafındaki çözümü) ──
  socialTimer = setInterval(() => {
    void (async () => {
      const { runTurn } = await import("./social/orchestrator");
      const summary = await runTurn();
      if (summary.published.length || summary.failures.length || summary.timeouts) {
        logger.info(
          { published: summary.published.length, failed: summary.failures.length, timeouts: summary.timeouts },
          "sosyal yayın turu",
        );
      }
    })().catch((err) => logger.error({ err }, "sosyal yayın turu başarısız"));
  }, SOCIAL_TURN_MS);
  socialTimer.unref?.();

  // ── D5: günlük Slack özeti (gün değiştiğinde bir kez) ──
  digestTimer = setInterval(() => {
    void (async () => {
      const now = new Date();
      const today = now.toISOString().slice(0, 10);
      if (lastDigestDay === today) return;
      // Gün başında bir ÖNCEKİ günün özetini gönder (o gün kapanmıştır).
      const yesterday = new Date(now.getTime() - 24 * 3600_000);
      const day = yesterday.toISOString().slice(0, 10);
      const { collectDailyDigest, renderBrandDigest } = await import("./social/digest");
      const { notifySlack } = await import("./slack");
      const digests = await collectDailyDigest(yesterday);
      for (const d of digests) {
        await notifySlack({
          kind: "workflow.completed",
          project: d.brand as never,
          title: renderBrandDigest(d, day),
          fields: {
            yayınlanan: d.published.length,
            başarısız: d.failed.length,
            "onay bekleyen": d.pendingApproval,
          },
        });
      }
      lastDigestDay = today;
    })().catch((err) => logger.error({ err }, "günlük özet başarısız"));
  }, DIGEST_CHECK_MS);
  digestTimer.unref?.();

  // ── Günlük brief + SEV1 tetiği (kurucu kararı 2026-08-08) ──
  //
  // İki mekanizma bilinçli olarak ayrı: TAKVİM ritmi kurar (her sabah bir
  // brief), OLAY ise ritmi beklemez (SEV1 gece 03:00'te gelirse sabaha kadar
  // oturmamalı). Tek mekanizmayla ikisi de yapılamaz — zamanlayıcıyı
  // sıklaştırmak brief'i gürültüye çevirir, olay tetiğini seyreltmek acili
  // geciktirir.
  briefTimer = setInterval(() => {
    void (async () => {
      const now = new Date();
      const today = now.toISOString().slice(0, 10);

      // (a) Sabah brief'i — gün başına bir kez, BRIEF_HOUR'dan sonra.
      if (lastBriefDay !== today && now.getHours() >= BRIEF_HOUR) {
        lastBriefDay = today; // önce işaretle: hata olsa bile gün içinde tekrarlamasın
        await createHoldingRun({
          definitionKey: "gunluk-brief",
          charter: {
            goal: "Günlük holding brief'i — sinyal, motor sağlığı, defter durumu",
            successCriteria: ["tüm adımlar SUCCEEDED (hata sayısı = 0)"],
            constraints: ["yalnız okuma", "yerel model — harcama 0 USD"],
            riskClass: "R2",
            sources: ["doc:holding/plans/MOTOR-KICKOFF-2026-07-26.md"],
            estCostUsd: 0,
          },
          trustLevel: "TRUSTED",
          venture: "holding",
          trigger: `gunluk-brief|${today}`,
        }).catch((err) => logger.error({ err }, "günlük brief tetiklenemedi"));
      }

      // (b) SEV1 tetiği — işlenmemiş SEV0/SEV1 varsa brief'i BEKLEMEDEN duyur.
      // Yalnız haber verir, workflow başlatmaz: acil sinyalde doğru ilk adım
      // kurucunun görmesidir, motorun kendi kendine iş açması değil.
      const acil = await prisma.holdingSentinelEvent.findMany({
        where: { status: "NEW", severity: { in: ["SEV0", "SEV1"] } },
        take: 5,
        orderBy: { createdAt: "asc" },
      });
      const yeni = acil.filter((e) => !duyurulanAcil.has(e.id));
      if (yeni.length > 0) {
        const { sendReport } = await import("./telegram");
        await sendReport(
          `⚠️ ${yeni.length} acil sinyal (SEV0/SEV1)`,
          yeni.map((e) => {
            // venture bir KOLON değil, payload alanıdır — sentinel şeması
            // kaynağa göre değişen alanları payload'da tutar.
            const v = (e.payload as Record<string, unknown> | null)?.venture;
            return `• [${e.severity}] ${e.kind} — ${typeof v === "string" ? v : "holding"}`;
          }).join("\n"),
        );
        yeni.forEach((e) => duyurulanAcil.add(e.id));
      }
    })().catch((err) => logger.error({ err }, "brief/SEV1 turu başarısız"));
  }, BRIEF_CHECK_MS);
  briefTimer.unref?.();

  logger.info("Holding module STARTED (worker + heartbeat + telegram + sosyal yayın + günlük özet + brief/SEV1)");
  void (async () => {
    const { notifySlack } = await import("./slack");
    await notifySlack({
      kind: "workflow.started",
      project: "holding",
      title: "Holding motoru başladı",
      fields: {
        "yayın turu": `${SOCIAL_TURN_MS / 60000} dk`,
        "heartbeat": `${HEARTBEAT_SWEEP_MS / 60000} dk`,
      },
    });
  })().catch(() => undefined);
}

export async function stopHoldingModule(): Promise<void> {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  if (socialTimer) clearInterval(socialTimer);
  socialTimer = null;
  if (digestTimer) clearInterval(digestTimer);
  digestTimer = null;
  if (briefTimer) { clearInterval(briefTimer); briefTimer = null; }
  stopTelegram?.();
  stopTelegram = null;
  await worker?.close();
  worker = null;
}
