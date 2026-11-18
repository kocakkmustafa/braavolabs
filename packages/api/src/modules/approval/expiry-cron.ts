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
 * SANDBOX_ESCAPE exception (BRA-P2-02c, KARAR-A3): expiry = escape denied. The
 * approval is REJECTED but the run is NOT cancelled; the agent gets the same
 * "Sandbox escape denied" INPUT steering message as a human reject.
 *
 * Idempotent — re-running this cron twice in the same minute won't
 * double-cancel anything because each transition uses
 * `updateMany({ where: { status: PENDING } })`.
 */

import { prisma } from "../../lib/db";
import { logger } from "../../lib/logger";
import { runWithoutTenant } from "../../lib/tenant-context";
import { transitionRun } from "../run/transition";
import { sandboxEscapeDeniedMessage } from "./sandbox-escape";

const EXPIRY_INTERVAL_MS = 60 * 60 * 1000; // run hourly
const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Exported for unit tests (E3/T3 — B6.1 HANDOFF branch). Not part of the
 * public cron surface; initApprovalExpiryCron drives it on the timer. */
export async function runApprovalExpiry(): Promise<void> {
  // BR-P0-004: a cron sweep spans every tenant by design, so it has no single
  // tenant to bind. Marked here (on the exported entry point rather than the
  // timer) so direct callers — tests, manual invocations — are scoped too.
  return runWithoutTenant("cron:approval-expiry", () => runApprovalExpiryImpl());
}

async function runApprovalExpiryImpl(): Promise<void> {
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
      metadata: true,
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
    // BRA-P0-02c-3: the cancel goes through transitionRun (CAS on status). A
    // finished run (illegal edge, dual write on) or a lost race is left as is —
    // the approval is already REJECTED — and reported in the activity row.
    let runCancelled = false;
    if (approval.type === "SANDBOX_ESCAPE") {
      // KARAR-A3 (BRA-P2-02c): an expired escape request = escape denied. The run is
      // NOT cancelled; the agent is told once (idempotent: same text already queued
      // for this run is not queued again).
      const content = sandboxEscapeDeniedMessage(approval.metadata);
      const dup = await prisma.steeringMessage.findFirst({
        where: { runId: approval.runId, kind: "INPUT", content },
        select: { id: true },
      });
      if (!dup) {
        await prisma.steeringMessage.create({
          data: { runId: approval.runId, kind: "INPUT", content, createdBy: "system:expiry" },
        });
      }
    } else if (approval.type !== "HANDOFF") {
      const o = await transitionRun(prisma, approval.runId, "CANCELLED", {
        tenantId,
        extra: { completedAt: new Date() },
        legacyUnchecked: true,
      });
      runCancelled = o.ok;
      if (!o.ok) {
        logger.warn({ approvalId: approval.id, runId: approval.runId, reason: o.reason }, "Approval expiry: run not cancelled");
      }
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
          runCancelled,
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
