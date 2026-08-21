/**
 * Enforce an audit-retention window (BR-P1-005 #4).
 *
 * WHAT WAS MEASURED BEFORE WRITING THIS
 *
 *   - `auditRetentionDays` carries the roadmap's tiers (7/90/365/730, -1 for
 *     contract) and no production code reads it. (One test does: it asserts
 *     the tiers increase monotonically.)
 *   - There was not one `activityLog.delete` or `deleteMany` in the API.
 *
 * ⚠️ TWO PUBLISHED STATEMENTS CONTRADICT EACH OTHER, AND ONE IS LEGAL.
 *
 *   - The roadmap's plan table says Free 7 days, Creator 90, Pro 365,
 *     Business 730. This is NOT rendered anywhere in the product: the pricing
 *     page shows "full audit trail" identically on every tier and never a
 *     window.
 *   - `ui/app/gdpr/page.tsx` says, to a supervisory authority: "Audit logs and
 *     run history are kept for 12 months." Flat, for everyone. That is the
 *     only retention statement the product actually publishes.
 *
 * Today nothing deletes, so the 12-month promise is trivially kept. Enforcing
 * the tiers as written would BREAK it — Free would delete at 7 days against a
 * 12-month representation.
 *
 * So the window here is `max(plan window, RETENTION_FLOOR_DAYS)`, floor 365.
 * The tiers may only ever EXTEND past the published promise, never undercut
 * it. Which of the two statements is authoritative is a legal decision and a
 * founder gate; this defaults to the more conservative one rather than
 * silently picking a side by deleting.
 *
 * ⚠️ THE REAL DESTRUCTION HAZARD IS PLAN DOWNGRADE, not flooding.
 *
 * An earlier version of this comment argued that slice B's unbounded denial
 * writer would let an attacker "roll real events out of the window". THAT IS
 * FALSE and it is worth stating plainly rather than quietly deleting: a
 * time-anchored window is not a ring buffer. The predicate is
 * `createdAt < now - N days`, so rows die by AGE, never by count or table
 * pressure. Four million rows on Monday do not delete Tuesday's real login
 * one second sooner. (Independent review also measured that a 1.96M-row
 * DELETE does not block concurrent inserts: 0.7-2.3 ms throughout.)
 *
 * The blockers that actually gate ENABLING this in production are therefore:
 * the GDPR/tier contradiction above (legal, founder gate), and the downgrade
 * rule below. NOT the collapse design in `lib/audit-writer.ts` — naming that
 * as the prerequisite pointed at the wrong thing.
 *
 * The hazard that IS real: `mapStripeSubscriptionDeleted` -> revoke ->
 * FALLBACK_PLAN -> `tenant.update({ plan: "FREE" })`. A Business tenant whose
 * CARD MERELY FAILS drops from a 730-day window to a 7-day one, and the next
 * sweep would permanently destroy ~723 days of history — reachable by anyone
 * with billing access and by a payment processor's retry logic.
 *
 * The floor BOUNDS this; it does not close it. A downgraded Business tenant
 * still loses 365 days, permanently, on the next sweep. 723 -> 365 is a real
 * improvement and it is not a fix, and no rail here catches it: the loss is
 * half the trail, nowhere near any threshold. Closing it properly needs a
 * grace period on shrinking transitions, or an export before one.
 */
import { PLAN_LIMITS } from "@ai-company-os/core";
import { prisma } from "../../lib/db";
import { runWithoutTenant } from "../../lib/tenant-context";
import { logger } from "../../lib/logger";
import { env } from "../../config/env";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Never delete anything younger than this, whatever the plan says.
 * 365 days is the 12-month figure the GDPR page publishes — approximately:
 * 365 days is not 12 calendar months in a leap year. The direction of that
 * rounding is to delete slightly SOONER than the promise in one year out of
 * four, which is part of what the founder gate has to settle.
 */
export const RETENTION_FLOOR_DAYS = 365;

/** Rows per statement. Bounded because the sweep is not batched by Prisma. */
export const PURGE_BATCH = 10_000;

/**
 * Ceiling per TENANT per sweep. On its own this does NOT bound the run —
 * N tenants x 200k is still unbounded as N grows, which is why
 * PURGE_MAX_PER_SWEEP exists alongside it.
 */
export const PURGE_MAX_PER_TENANT = 200_000;

/**
 * Refuse if the clock has advanced further than this since the last recorded
 * sweep.
 *
 * 7 days, not 30. Thirty was wrong in both directions: it ACCEPTS a 30-day
 * jump (over-deleting a month of trail, and stamping a poisoned baseline that
 * the following NTP correction then locks out), while treating a 31-day gap
 * as a hard stop. Seven days against a 6-hour interval keeps the blast radius
 * tight, and a long outage is survivable because a refusal now records its
 * own baseline — see `recordSweep`.
 */
export const MAX_SWEEP_ADVANCE_MS = 7 * DAY_MS;

/** Ceiling for one SWEEP across all tenants, not just per tenant. */
export const PURGE_MAX_PER_SWEEP = 1_000_000;

/** Belt-and-braces: a batch loop must not spin even if deleteMany returns 0. */
const MAX_BATCH_ITERATIONS = 1_000;

export interface PurgeOptions {
  now: Date;
  enabled: boolean;
  dryRun: boolean;
  /**
   * Bounds, overridable so a test can make them BIND at small scale.
   * With production constants a fixture would need 200k rows before the
   * ceiling is ever consulted, which is why removing it survived a full
   * suite: the code path was never reached.
   */
  batchSize?: number;
  maxPerTenant?: number;
  maxPerSweep?: number;
}

export interface PurgeReport {
  skipped: boolean;
  deleted: number;
  wouldDelete: number;
  /** Tenants left untouched — never silently. */
  skippedTenants: string[];
  /** Tenants whose sweep threw. The rest still run. */
  failedTenants: string[];
}

/** The window actually applied: the plan's, but never below the floor. */
export function effectiveRetentionDays(plan: string): number | null {
  const limits = Object.prototype.hasOwnProperty.call(PLAN_LIMITS, plan)
    ? PLAN_LIMITS[plan as keyof typeof PLAN_LIMITS]
    : undefined;
  if (!limits) return null;

  const days = limits.auditRetentionDays;
  // `days <= 0`, not `days < 0`. A catalog entry of 0 would make the cutoff
  // equal to `now` and annihilate the tenant's entire trail, and a missing
  // field yields NaN, whose cutoff is an Invalid Date that Prisma rejects —
  // while the tenant is reported as swept. Both are unreachable under
  // today's catalog; the guard is one line and this function's whole job is
  // to never over-delete.
  if (!Number.isFinite(days) || days <= 0) return null;

  return Math.max(days, RETENTION_FLOOR_DAYS);
}

/**
 * Delete audit rows past each tenant's own window.
 *
 * Per-tenant rather than one global cutoff, because the number comes from the
 * same catalog the rest of the product reads, so there is no second source of
 * truth to drift.
 *
 * Note it is only weakly a paid differentiator once the floor applies: FREE,
 * CREATOR and PRO all collapse to 365. Only BUSINESS (730) and ENTERPRISE
 * (never) differ. The per-tenant loop is still the right shape — it is the
 * marketing story that the floor flattens, not the mechanism.
 */
/**
 * Lay down a sweep record — on EVERY outcome, including refusals.
 *
 * This is what stops the rail from being a watchdog that can deadlock. The
 * only thing that advances the baseline is a sweep record, and the rail
 * blocks sweeps; when refusals returned without recording, a stale baseline
 * could never be replaced. The documented rescue (run a dry pass) tripped the
 * same rail and returned before the same write, so a founder gate lasting
 * longer than the tolerance bricked retention permanently, with nothing in
 * the logs saying the fix was manual DB surgery.
 *
 * Recording a refusal keeps the rail's meaning — THIS sweep still does not
 * run — while letting the next tick see a fresh baseline and proceed.
 */
async function recordSweep(
  report: PurgeReport,
  result: "allowed" | "dry-run" | "refused",
  reason?: string,
): Promise<void> {
  await prisma.retentionSweep
    .create({
      data: {
        result,
        reason: reason ?? null,
        deleted: report.deleted,
        wouldDelete: report.wouldDelete,
        skippedCount: report.skippedTenants.length,
        failedCount: report.failedTenants.length,
      },
    })
    .catch((err: unknown) => logger.error({ err, result }, "failed to record the retention sweep"));
}

export async function purgeExpiredAuditRows(opts: PurgeOptions): Promise<PurgeReport> {
  const report: PurgeReport = {
    skipped: false,
    deleted: 0,
    wouldDelete: 0,
    skippedTenants: [],
    failedTenants: [],
  };

  if (!opts.enabled) {
    // Said out loud: an operator who believes retention is running and learns
    // later that it never was has been misled by silence.
    logger.info({}, "audit retention is disabled; no rows examined");
    report.skipped = true;
    return report;
  }

  // Deliberate system scope, declared rather than implied — the BR-P0-004
  // marker exists so this is distinguishable from a request that lost its
  // tenant context. Verified against real Postgres with the tenant_rls policy
  // and a non-superuser role: the cross-tenant delete works here and cannot
  // reach across tenants when a tenant IS bound.
  const batchSize = opts.batchSize ?? PURGE_BATCH;
  const maxPerTenant = opts.maxPerTenant ?? PURGE_MAX_PER_TENANT;
  const maxPerSweep = opts.maxPerSweep ?? PURGE_MAX_PER_SWEEP;

  return runWithoutTenant("audit-retention-sweep", async () => {
    const tenants = await prisma.tenant.findMany({ select: { id: true, plan: true } });

    // MONOTONICITY RAIL — against a STORED value, not a live clock.
    //
    // Four attempts, and the first three all looked right:
    //
    //   1. `cutoff < now` is true by construction (cutoff IS now - days), so
    //      it can never fire: it validates a number against itself.
    //   2. "refuse if >95% of a tenant's trail would go" is a PERMANENT
    //      exemption for a dormant tenant (the ratio never improves) and is
    //      DEFEATED BY WRITING ROWS — 100 expired rows trips it, 20 fresh
    //      ones drop the ratio under the threshold and all 100 go. Anyone who
    //      can write audit rows could disable the guard.
    //   3. Comparing against the DATABASE clock is attempt 1 one indirection
    //      out. `aicos-api` and `aicos-postgres` are sibling containers on one
    //      host; containers share CLOCK_REALTIME, so `SELECT now()` and
    //      `new Date()` read the SAME clock. Measured: a 3000-day host error
    //      passed the rail and cleared the trail. The instrument is sound —
    //      the topology is not. (It would work against RDS/Neon.)
    //
    // So: compare against when we LAST swept, which is stored. A stored value
    // is not a second reading of the live clock, so a shared kernel cannot
    // defeat it; it needs no audit traffic, so a quiet system is fine; and no
    // caller can move it.
    // `lte: now` matters, and it is also why there is no "clock is behind the
    // baseline" branch below: this predicate makes one unreachable. An
    // earlier version had that check, and after adding eligibility it became
    // dead code that still READ as a safety rail — the exact shape this
    // codebase keeps removing. Two mutations "survived" precisely because
    // deleting an unreachable branch changes nothing.
    //
    // Appending a refusal row unsticks a FORWARD jump,
    // because that row is then the newest — but it cannot unstick a BACKWARD
    // one: a baseline poisoned with a future stamp permanently dominates
    // every later row written at the correct, earlier time, so the rail would
    // refuse forever. A baseline in the future is itself evidence of a bad
    // stamp, so it is not eligible to BE the baseline.
    const lastSweep = await prisma.retentionSweep.findFirst({
      where: { createdAt: { lte: opts.now } },
      select: { createdAt: true },
      orderBy: { createdAt: "desc" },
    });

    if (!lastSweep) {
      // No baseline yet. A destructive first sweep would have nothing to
      // check itself against, so require a dry run to lay one down first.
      if (!opts.dryRun) {
        // NOT recorded, unlike the other two refusals — and the difference
        // matters. A row written here would BE the baseline the next
        // destructive run looks for, so the second attempt would sail through
        // and delete: recording would defeat the guard instead of unsticking
        // it. Nor is this a deadlock, because DRY_RUN defaults to true, so an
        // operator's first `ENABLED=true` is already the dry pass that lays a
        // legitimate baseline.
        // Distinguish "never swept" from "swept, but every row is stamped
        // later than now". Both take this path, and the remedy is the same,
        // but an operator who reads "no prior sweep recorded" and then finds
        // rows in retention_sweep will reasonably conclude the log is lying.
        const anySweeps = await prisma.retentionSweep.count();
        logger.error(
          { sweepRows: anySweeps },
          anySweeps === 0
            ? "no prior retention sweep recorded; run once in dry-run to establish a baseline"
            : "every recorded sweep is stamped later than now (bad clock when they were written); run once in dry-run to lay a valid baseline",
        );
        report.skipped = true;
        return report;
      }
    } else {
      const advanced = opts.now.getTime() - lastSweep.createdAt.getTime();
      if (advanced > MAX_SWEEP_ADVANCE_MS) {
        logger.error(
          { now: opts.now, lastSweep: lastSweep.createdAt, advancedMs: advanced },
          "clock has advanced far more than one sweep interval; refusing to sweep",
        );
        report.skipped = true;
        // Records a baseline, so this refusal is not permanent.
        await recordSweep(report, "refused", "clock-jumped-forward");
        return report;
      }
    }

    for (const tenant of tenants) {
      try {
        const days = effectiveRetentionDays(tenant.plan);
        if (days === null) {
          // Unknown plan or a non-positive window: guessing would either
          // over-delete or hoard forever, and both are wrong answers about
          // someone else's audit trail.
          logger.warn({ tenantId: tenant.id, plan: tenant.plan }, "no usable retention window; tenant skipped");
          report.skippedTenants.push(tenant.id);
          continue;
        }

        const cutoff = new Date(opts.now.getTime() - days * DAY_MS);

        const where = { tenantId: tenant.id, createdAt: { lt: cutoff } };

        if (opts.dryRun) {
          // Exactly what would go: the same predicate as the delete.
          report.wouldDelete += await prisma.activityLog.count({ where });
          continue;
        }

        // Batched. Measured on real Postgres: 1.96M rows in one statement
        // produced ~325 MB of WAL and reclaimed no disk until vacuum. The
        // schema projects ~180M rows/year, so a first-enable sweep in one
        // statement would be ~17 GB of WAL in a single transaction on a
        // 1.9 GB host — and there is no statement_timeout anywhere in this
        // repo to stop it, so a failure would roll the whole thing back and
        // retry forever without converging.
        let removed = 0;
        let iterations = 0;
        for (;;) {
          if (++iterations > MAX_BATCH_ITERATIONS) {
            // The ceiling below bounds DELETIONS, not iterations: `removed`
            // only advances when count > 0, so a deleteMany returning 0
            // against a non-empty findMany would spin forever.
            logger.error({ tenantId: tenant.id, removed }, "retention batch loop hit its iteration cap");
            break;
          }
          const batch = await prisma.activityLog.findMany({
            where,
            select: { id: true },
            // DELIBERATELY UNORDERED, against the obvious instinct.
            //
            // Adding `orderBy: { createdAt: "asc" }` does make the planner
            // index-bound (Index Scan Backward, no Sort node) — and it is 5x
            // SLOWER. Head-to-head on 1M rows, same tenant, same cutoff,
            // batch 10k, autovacuum ON (the production default): unordered
            // 921 ms across 55 iterations (terminal 30.7 ms), ordered
            // 4,654 ms (terminal 128.5 ms). With autovacuum off the figures
            // are 909/30.8 vs 4,698/127.9 — same conclusion either way. The
            // index scan walks past every dead index entry from prior batches
            // and does random heap access, where the seq scan reads
            // sequentially and takes the first 10k matches it finds.
            //
            // Ordering would be worth it with a KEYSET cursor — carry the
            // previous batch's (createdAt, id) forward so each batch starts
            // where the last ended instead of re-walking from the front.
            // Not done here: it is unmeasured on this box, and shipping an
            // unmeasured optimisation is the thing this file keeps refusing.
            take: batchSize,
          });
          if (batch.length === 0) break;

          const { count } = await prisma.activityLog.deleteMany({
            where: { tenantId: tenant.id, id: { in: batch.map((r) => r.id) } },
          });
          removed += count;

          if (removed >= maxPerTenant || report.deleted + removed >= maxPerSweep) {
            logger.warn(
              { tenantId: tenant.id, removed, sweepTotal: report.deleted + removed },
              "retention ceiling reached; remainder deferred to the next sweep",
            );
            break;
          }
        }
        report.deleted += removed;
        if (report.deleted >= maxPerSweep) {
          // Per-tenant alone is not a bound on the RUN: N tenants x 200k is
          // still an unbounded job as N grows.
          logger.warn({ sweepTotal: report.deleted }, "sweep budget exhausted; remaining tenants deferred");
          break;
        }
      } catch (err) {
        // Per tenant. Without this, one tenant's error rejects the whole
        // sweep and every tenant after it is silently never swept — while
        // the ones before it have already been deleted, with nothing
        // recording where it stopped.
        logger.error({ err, tenantId: tenant.id }, "retention sweep failed for tenant");
        report.failedTenants.push(tenant.id);
      }
    }

    await recordSweep(report, opts.dryRun ? "dry-run" : "allowed");

    logger.info(
      {
        deleted: report.deleted,
        wouldDelete: report.wouldDelete,
        skipped: report.skippedTenants.length,
        failed: report.failedTenants.length,
        dryRun: opts.dryRun,
      },
      "audit retention sweep complete",
    );
    return report;
  });
}

const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const SWEEP_STARTUP_DELAY_MS = 10 * 60_000;

let retentionTimer: NodeJS.Timeout | null = null;
let startupTimer: NodeJS.Timeout | null = null;

/**
 * One tick. Exported so a test can prove the ENV reaches the purge — the
 * flags are the entire safety story, and an earlier version had six passing
 * tests while nothing asserted the cron passed them through at all.
 */
export function auditRetentionTick(
  purge: (o: PurgeOptions) => Promise<PurgeReport> = purgeExpiredAuditRows,
): void {
  purge({
    now: new Date(),
    enabled: env.AUDIT_RETENTION_ENABLED,
    dryRun: env.AUDIT_RETENTION_DRY_RUN,
  }).catch((err) => logger.error({ err }, "audit retention sweep failed"));
}

/**
 * Registered unconditionally, so "is retention running?" is answerable from
 * the logs either way: the purge reports the disabled case rather than the
 * process quietly never scheduling anything. A feature whose absence is
 * indistinguishable from its presence is what this task exists to stop.
 */
export function initAuditRetentionCron(): void {
  stopAuditRetentionCron();
  startupTimer = setTimeout(() => auditRetentionTick(), SWEEP_STARTUP_DELAY_MS);
  retentionTimer = setInterval(() => auditRetentionTick(), SWEEP_INTERVAL_MS);
  logger.info(
    { enabled: env.AUDIT_RETENTION_ENABLED, dryRun: env.AUDIT_RETENTION_DRY_RUN, floorDays: RETENTION_FLOOR_DAYS },
    "audit retention cron initialized",
  );
}

export function stopAuditRetentionCron(): void {
  // Both handles. Clearing only the interval left the 10-minute startup
  // timeout armed, so `stop()` did not stop.
  if (retentionTimer) {
    clearInterval(retentionTimer);
    retentionTimer = null;
  }
  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }
}
