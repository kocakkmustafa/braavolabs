import { env } from "../../config/env";
import { logger } from "../../lib/logger";
import { checkHeartbeats } from "./sentinel";
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

let heartbeatTimer: NodeJS.Timeout | null = null;
let stopTelegram: (() => void) | null = null;
let worker: ReturnType<typeof initHoldingWorker> | null = null;

export function initHoldingModule(): void {
  if (!env.HOLDING_ENABLED) {
    logger.info("Holding module DORMANT (HOLDING_ENABLED != true)");
    return;
  }
  worker = initHoldingWorker();
  // Orphan guard: re-enqueue runs stranded by a crash between the DB write
  // and the Redis enqueue (idempotent jobIds make this safe to repeat).
  reconcileOrphanHoldingRuns()
    .then((n) => n > 0 && logger.warn({ count: n }, "holding orphan reconciliation re-enqueued runs"))
    .catch((err) => logger.error({ err }, "holding orphan reconciliation failed"));
  heartbeatTimer = setInterval(() => {
    checkHeartbeats().catch((err) => logger.error({ err }, "heartbeat sweep failed"));
  }, HEARTBEAT_SWEEP_MS);
  // unref: a sweep timer must never keep a dying process alive.
  heartbeatTimer.unref?.();
  stopTelegram = startTelegramPolling((decision) => resolveHoldingApproval(decision).then(() => undefined));
  logger.info("Holding module STARTED (worker + heartbeat sweep + telegram)");
}

export async function stopHoldingModule(): Promise<void> {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  stopTelegram?.();
  stopTelegram = null;
  await worker?.close();
  worker = null;
}
