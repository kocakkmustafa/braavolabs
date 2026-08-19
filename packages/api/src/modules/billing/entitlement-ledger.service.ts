/**
 * BR-P0-003 — persistence layer over entitlement-reducer.ts. This is the
 * module every Stripe/Apple/Google write site should call INSTEAD of
 * writing `tenant.plan` (or `MobileSubscription`) directly.
 *
 * Two operations, deliberately separate:
 *   - appendEntitlementEvent: idempotent insert into the append-only
 *     `entitlement_events` table. Mirrors stripe_webhook_events' own
 *     proven unique-constraint-catches-P2002 pattern (billing/router.ts's
 *     claimWebhookEvent) — but simpler, because appending IS the entire
 *     side effect here. There's no Stripe-style "claimed but the
 *     multi-step handler crashed partway" state to reclaim: either the
 *     row landed or it didn't, and reprojectEntitlement always
 *     re-derives from the complete history rather than trusting "what
 *     just happened", so it's safe to call after a duplicate-skip too.
 *   - reprojectEntitlement: recompute a tenant's current entitlement
 *     from its FULL event history and write the projection
 *     (tenant.plan). Pure recomputation — safe to call repeatedly, after
 *     a crash, or redundantly for a duplicate event, because it doesn't
 *     increment anything; it re-derives the whole answer from scratch
 *     every time. This is what actually makes "duplicate event → single
 *     ledger EFFECT" true: the ledger (event table) might technically
 *     receive a rejected duplicate insert, but the OBSERVABLE effect
 *     (tenant.plan) is recomputed from the same history either way.
 */

import type { Plan } from "@prisma/client";
import { prisma } from "../../lib/db";
import { logger } from "../../lib/logger";
import {
  foldStream,
  combineStreams,
  resolveEntitlement,
  PLAN_RANK,
  type EntitlementEvent,
  type EntitlementSource,
  type EntitlementEventType,
} from "./entitlement-reducer";

export interface AppendEntitlementEventInput {
  tenantId: string;
  source: EntitlementSource;
  streamId: string;
  /** The SOURCE's own event/notification id — the dedup key. */
  sourceEventId: string;
  sourceTimestamp: Date;
  type: EntitlementEventType;
  planTier: string | null;
  expiresAt: Date | null;
  autoRenew: boolean;
}

/**
 * Append one entitlement event, idempotently. Returns `true` when this
 * call actually inserted a new row, `false` when it was a duplicate
 * (same source + sourceEventId already recorded by an earlier
 * delivery) — informational only. The caller should call
 * reprojectEntitlement() either way; it's a safe no-op-equivalent on a
 * duplicate since the event history it reads from didn't change.
 */
export async function appendEntitlementEvent(
  input: AppendEntitlementEventInput,
): Promise<boolean> {
  try {
    await prisma.entitlementEvent.create({
      data: {
        tenantId: input.tenantId,
        source: input.source,
        streamId: input.streamId,
        sourceEventId: input.sourceEventId,
        sourceTimestamp: input.sourceTimestamp,
        type: input.type,
        planTier: input.planTier,
        expiresAt: input.expiresAt,
        autoRenew: input.autoRenew,
      },
    });
    return true;
  } catch (err) {
    const isDuplicate = err instanceof Error && /P2002|Unique constraint/.test(err.message);
    if (isDuplicate) {
      logger.info(
        { tenantId: input.tenantId, source: input.source, sourceEventId: input.sourceEventId },
        "Entitlement event duplicate — already recorded, skipping append (still reprojecting)",
      );
      return false;
    }
    throw err;
  }
}

/** Fallback plan when a tenant somehow isn't found — should never
 * happen in practice (the FK guarantees the tenant existed at insert
 * time), but reprojectEntitlement must not throw into a webhook 500
 * over a race with tenant deletion. */
const FALLBACK_PLAN: Plan = "FREE";

function isKnownPlan(value: string): value is Plan {
  return value in PLAN_RANK;
}

/**
 * Recompute a tenant's current entitlement from its FULL event history
 * (all sources, all streams) and write the projection to tenant.plan.
 * Safe to call repeatedly, after a crash, or redundantly on a duplicate
 * event — it never trusts "what the last write said", only what the
 * complete ledger says right now.
 *
 * R2 fix (2026-08-19): the read (findMany) and write (tenant.update)
 * used to be two separate round trips with no lock between them. Proven
 * exploit against a real DB: request A reads before request B's
 * concurrent event exists, B fully completes (read+write) with the
 * correct, complete picture, then A's write — computed from a STALE,
 * incomplete event set — lands last and silently overwrites B's correct
 * result. Only self-heals if some future event happens to arrive for
 * this tenant; otherwise the wrong plan sticks indefinitely. Fixed by
 * locking the tenant row for the duration of the read-modify-write, so
 * two concurrent reprojections for the SAME tenant serialize (different
 * tenants lock different rows — this doesn't serialize unrelated
 * traffic). `SELECT ... FOR UPDATE` rather than bumping the whole
 * transaction's isolation level: locks exactly the one row this
 * function is about to write, nothing broader.
 */
export async function reprojectEntitlement(tenantId: string): Promise<Plan> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM tenants WHERE id = ${tenantId} FOR UPDATE`;

    const rows = await tx.entitlementEvent.findMany({ where: { tenantId } });

    const byStream = new Map<string, EntitlementEvent[]>();
    for (const row of rows) {
      const event: EntitlementEvent = {
        id: row.id,
        source: row.source as EntitlementSource,
        streamId: row.streamId,
        sourceTimestamp: row.sourceTimestamp,
        type: row.type as EntitlementEventType,
        planTier: row.planTier,
        expiresAt: row.expiresAt,
        autoRenew: row.autoRenew,
      };
      const list = byStream.get(row.streamId);
      if (list) list.push(event);
      else byStream.set(row.streamId, [event]);
    }

    const streamStates = [...byStream.values()]
      .map((events) => foldStream(events))
      .filter((s): s is NonNullable<typeof s> => s !== null);

    const now = new Date();
    const best = combineStreams(streamStates, now);
    const resolved = resolveEntitlement(best, now);
    const plan: Plan = isKnownPlan(resolved) ? resolved : FALLBACK_PLAN;

    if (!isKnownPlan(resolved)) {
      // Defensive — should be unreachable: resolveEntitlement only ever
      // returns "FREE" or a planTier some event actually carried, and
      // every write site is expected to pass a real catalog tier. Fail
      // closed (FREE) rather than write a plan string the Plan enum
      // doesn't recognize (which Prisma would reject anyway).
      logger.warn({ tenantId, resolved }, "reprojectEntitlement: reducer returned an unrecognized plan tier — falling back to FREE");
    }

    await tx.tenant.update({ where: { id: tenantId }, data: { plan } });
    return plan;
  });
}

/**
 * Convenience wrapper every webhook/verify handler should call instead
 * of writing tenant.plan directly: append the event, then recompute and
 * persist the projection from the full history.
 */
export async function recordEntitlementEvent(input: AppendEntitlementEventInput): Promise<Plan> {
  await appendEntitlementEvent(input);
  return reprojectEntitlement(input.tenantId);
}
