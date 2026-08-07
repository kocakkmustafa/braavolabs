import { env } from "../../config/env";
import { logger } from "../../lib/logger";
import { checkHeartbeats } from "./sentinel";
import { sweepSentinelSensors } from "./sensors";
import { initHoldingWorker, resolveHoldingApproval, reconcileOrphanHoldingRuns } from "./runner";
import { startTelegramPolling } from "./telegram";

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

let heartbeatTimer: NodeJS.Timeout | null = null;
let socialTimer: NodeJS.Timeout | null = null;
let digestTimer: NodeJS.Timeout | null = null;
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
  stopTelegram = startTelegramPolling((decision) => resolveHoldingApproval(decision).then(() => undefined));

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

  logger.info("Holding module STARTED (worker + heartbeat + telegram + sosyal yayın + günlük özet)");
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
  stopTelegram?.();
  stopTelegram = null;
  await worker?.close();
  worker = null;
}
