/**
 * Approval Expiry Cron — auto-rejects approvals that have been pending
 * for too long. Without this, a forgotten approval pins a run in
 * WAITING_APPROVAL forever, which on the Free plan permanently consumes
 * one of the tenant's 10/month run quotas (since claimQuota() at the
 * enqueue site is what burns the slot).
 *
 * Behaviour:
 *   1. Find approvals where status=PENDING and createdAt < now - 24h.
 *   2. Atomically flip them to REJECTED with a synthetic actor.
 *   3. Cancel the linked run.
 *   4. Log the auto-action so the user sees it in their activity feed.
 *
 * HANDOFF exception (E3 §2.5 — B6.1): a HANDOFF approval is a devir PROPOSAL,
 * not the run itself. Expiring it flips the approval to REJECTED but does NOT
 * touch the run (it stays FAILED) and does NOT cancel the ledger — the ledger
 * stays OPEN so the operator can still claim it from web/CLI indefinitely. The
 * generic "run → CANCELLED" branch would otherwise strand the ledger on a
 * CANCELLED run that manual handoff can never re-open.
 *
 * Idempotent — re-running this cron twice in the same minute won't
 * double-cancel anything because each transition uses
 * `updateMany({ where: { status: PENDING } })`.
 */

import { prisma } from "../../lib/db";
import { logger } from "../../lib/logger";

const EXPIRY_INTERVAL_MS = 60 * 60 * 1000; // run hourly
const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Exported for unit tests (E3/T3 — B6.1 HANDOFF branch). Not part of the
 * public cron surface; initApprovalExpiryCron drives it on the timer. */
export async function runApprovalExpiry(): Promise<void> {
  const cutoff = new Date(Date.now() - APPROVAL_TTL_MS);

  // Pull stale approvals — keep the include shallow so we have what we
  // need to update the linked run + write the activity log without a
  // second round trip per row.
  const stale = await prisma.approval.findMany({
    where: {
      status: "PENDING",
      createdAt: { lt: cutoff },
    },
    select: {
      id: true,
      runId: true,
      type: true,
      run: {
        select: {
          pipeline: { select: { company: { select: { tenantId: true } } } },
        },
      },
    },
    take: 200, // bound the per-tick blast radius
  });

  if (stale.length === 0) {
    return;
  }

  let rejected = 0;
  for (const approval of stale) {
    const tenantId = approval.run.pipeline.company.tenantId;

    // Atomic state transition — only the row that's still PENDING wins.
    // If a human admin decided in the last few seconds, we lose this
    // race cleanly and skip the run.update.
    const claim = await prisma.approval.updateMany({
      where: { id: approval.id, status: "PENDING" },
      data: {
        status: "REJECTED",
        decidedBy: "system:expiry",
        decidedAt: new Date(),
      },
    });

    if (claim.count !== 1) {
      continue;
    }

    // HANDOFF exception (B6.1): the approval is REJECTED but the run is LEFT
    // ALONE (stays FAILED) and the ledger is LEFT OPEN — the operator can still
    // claim the handoff from web/CLI. Only NON-handoff approvals cancel the run.
    if (approval.type !== "HANDOFF") {
      await prisma.run.update({
        where: { id: approval.runId },
        data: { status: "CANCELLED", completedAt: new Date() },
      });
    }

    await prisma.activityLog.create({
      data: {
        tenantId,
        actor: "system",
        action: "approval.expired",
        resource: "approval",
        resourceId: approval.id,
        details: {
          runId: approval.runId,
          ttlHours: 24,
          type: approval.type,
          // Make the "run untouched, ledger stays OPEN" decision auditable.
          runCancelled: approval.type !== "HANDOFF",
        },
      },
    });

    rejected += 1;
  }

  logger.info({ scanned: stale.length, rejected }, "Approval expiry cron tick");
}

let expiryTimer: NodeJS.Timeout | null = null;

export function initApprovalExpiryCron(): void {
  // Run once on startup (after 5 minutes — gives the API time to settle).
  setTimeout(() => {
    runApprovalExpiry().catch((err) =>
      logger.error({ err }, "Initial approval expiry tick failed"),
    );
  }, 5 * 60_000);

  expiryTimer = setInterval(() => {
    runApprovalExpiry().catch((err) =>
      logger.error({ err }, "Approval expiry tick failed"),
    );
  }, EXPIRY_INTERVAL_MS);

  logger.info("Approval expiry cron initialized (hourly tick, 24h TTL)");
}

export function stopApprovalExpiryCron(): void {
  if (expiryTimer) {
    clearInterval(expiryTimer);
    expiryTimer = null;
  }
}
