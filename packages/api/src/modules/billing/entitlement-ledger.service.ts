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

import type { Plan, Prisma } from "@prisma/client";
import { normalizePlanForEntitlement } from "@ai-company-os/core";
import { prisma, tenantTx } from "../../lib/db";
import { logger } from "../../lib/logger";
import { AppError } from "../../middleware/error";
import { env } from "../../config/env";
import { assertGoogleLineage, googleLineageStore } from "./iap/google-lineage";
import {
  foldStream,
  combineStreams,
  resolveEntitlement,
  PLAN_RANK,
  type EntitlementEvent,
  type EntitlementSource,
  type EntitlementEventType,
  type StreamState,
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

/** Digest-only proof of which Google replacement chain was provider-verified. */
export interface GoogleEntitlementFence {
  subscriptionId: string;
  rootIdentity: string;
  verifiedAliases: string[];
  /** Persisted provider-read completion time; detects an intervening write. */
  readCompletedAt: Date;
  requireDirectedLineage?: boolean;
}

export const GOOGLE_OBSERVATION_STALE = "Google verification was superseded; retry";

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
const FALLBACK_PLAN = "MANUAL_REVIEW" as Plan;

function isKnownPlan(value: string): boolean {
  return value in PLAN_RANK;
}

type EntitlementRow = {
  id: string;
  source: string;
  streamId: string;
  sourceTimestamp: Date;
  type: string;
  planTier: string | null;
  expiresAt: Date | null;
  autoRenew: boolean;
};

export interface EntitlementProjection {
  effectiveTier: "INDIVIDUAL" | "TEAM" | null;
  winner: StreamState | null;
  source: EntitlementSource | null;
  streamId: string | null;
  expiresAt: Date | null;
  autoRenew: boolean | null;
  hasManualReview: boolean;
}

function projectRows(rows: EntitlementRow[], now: Date): EntitlementProjection {
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
    const key = `${event.source}\0${event.streamId}`;
    const list = byStream.get(key);
    if (list) list.push(event);
    else byStream.set(key, [event]);
  }

  const streamStates = [...byStream.values()]
    .map((events) => foldStream(events))
    .filter((state): state is StreamState => state !== null);
  const winner = combineStreams(streamStates, now);
  const resolved = resolveEntitlement(winner, now);
  const effectiveTier = resolved === "INDIVIDUAL" || resolved === "TEAM" ? resolved : null;

  return {
    effectiveTier,
    winner,
    source: winner?.source ?? null,
    streamId: winner?.streamId ?? null,
    expiresAt: winner?.expiresAt ?? null,
    autoRenew: winner?.autoRenew ?? null,
    hasManualReview: streamStates.some((state) => state.planTier === "MANUAL_REVIEW"),
  };
}

/** Read-only view used by the IAP API; no tenant.plan write is performed. */
export async function getEntitlementProjection(
  tenantId: string,
  now = new Date(),
): Promise<EntitlementProjection> {
  const rows = await prisma.entitlementEvent.findMany({ where: { tenantId } });
  return projectRows(rows, now);
}

/**
 * Paid gates must evaluate expiry even when no new provider event arrives.
 * Existing ledger history is authoritative; tenant.plan is only the baseline
 * for tenants that predate the ledger. An optional unextended transaction
 * client keeps callers holding the tenant lock on the same RLS connection.
 */
export async function getEffectivePlan(
  tenantId: string,
  persistedPlan: unknown,
  options: {
    now?: Date;
    client?: Pick<Prisma.TransactionClient, "entitlementEvent">;
  } = {},
): Promise<ReturnType<typeof normalizePlanForEntitlement>> {
  const rows = await (options.client ?? prisma).entitlementEvent.findMany({ where: { tenantId } });
  if (rows.length === 0) return normalizePlanForEntitlement(typeof persistedPlan === "string" ? persistedPlan : null);
  return projectRows(rows, options.now ?? new Date()).effectiveTier ?? "MANUAL_REVIEW";
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
  // MUST be tenantTx, NOT prisma.$transaction. The `tx` handed to a
  // $transaction callback on the EXTENDED client is itself extended, so every
  // model op inside re-enters the RLS wrapper in lib/db.ts. With a tenant
  // context that wrapper opens a SEPARATE interactive transaction on a
  // DIFFERENT pooled connection — whose `tenants` UPDATE then blocks forever on
  // the FOR UPDATE lock the OUTER transaction still holds. Postgres sees no
  // cycle (the outer transaction is waiting on the app, not on the database),
  // so it never breaks the deadlock, and each hung request pins two pooled
  // connections until the pool is exhausted and every query in the process
  // fails. Reproduced against real Postgres: unextended control 16ms,
  // system-scoped passthrough 3ms, tenant-bound path never returned.
  //
  // tenantTx runs on the UN-extended `base` client, so its `tx` cannot
  // re-enter, every statement shares one connection, and the FOR UPDATE below
  // actually serializes the read-modify-write it was added for.
  return tenantTx(async (tx) => {
    await tx.$queryRaw`SELECT id FROM tenants WHERE id = ${tenantId} FOR UPDATE`;

    const rows = await tx.entitlementEvent.findMany({ where: { tenantId } });

    const projection = projectRows(rows, new Date());
    const resolved = projection.effectiveTier ?? "MANUAL_REVIEW";
    const plan = (isKnownPlan(resolved) ? resolved : FALLBACK_PLAN) as Plan;

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

/** Run a digest-only Google purchase effect under its root ownership lock. */
export async function withCurrentGooglePurchase<T>(
  tenantId: string,
  googleFence: GoogleEntitlementFence,
  effect: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<{ value: T } | null> {
  if (googleFence.verifiedAliases.length === 0) {
    throw new Error("Google entitlement fence requires verified aliases");
  }
  // Google purchase tokens are replaced in a backwards-linked chain, while
  // every replacement shares one root entitlement stream. Claim/update paths
  // lock this subscription row BEFORE adding an alias. Checking the aliases
  // and running the effect under the SAME row lock prevents a late old-token
  // event or manual-review decision after a newer replacement is claimed.
  return tenantTx(async (tx) => {
    const owner = await tx.$queryRaw<Array<{ id: string; last_verified_at: Date }>>`
      SELECT id, last_verified_at FROM mobile_subscriptions
      WHERE id = ${googleFence.subscriptionId}
        AND tenant_id = ${tenantId}
        AND provider = 'google'
        AND original_transaction_id = ${googleFence.rootIdentity}
      FOR UPDATE
    `;
    if (owner.length !== 1) throw new Error("Google entitlement owner is unavailable");
    // A later provider read may have committed between ownership update and
    // this effect. The alias chain can be unchanged for a revoke/reactivation,
    // so it cannot serve as the only freshness fence.
    if (owner[0]!.last_verified_at.getTime() !== googleFence.readCompletedAt.getTime()) {
      throw new AppError(409, GOOGLE_OBSERVATION_STALE);
    }

    // Global enabled state cannot be bypassed by a caller omitting a flag.
    if (env.GOOGLE_PURCHASE_LINEAGE_ENABLED || googleFence.requireDirectedLineage) {
      if (!await assertGoogleLineage(googleLineageStore(tx.googlePurchaseAlias), {
        tenantId, subscriptionId: googleFence.subscriptionId, rootIdentity: googleFence.rootIdentity,
        aliases: googleFence.verifiedAliases,
      })) return null;
    }

    const newerAlias = await tx.googlePurchaseAlias.findFirst({
      where: {
        tenantId,
        mobileSubscriptionId: googleFence.subscriptionId,
        provider: "google",
        canonicalRootIdentity: googleFence.rootIdentity,
        state: "active",
        tokenDigest: { notIn: googleFence.verifiedAliases },
      },
      select: { tokenDigest: true },
    });
    if (newerAlias) return null;
    return { value: await effect(tx) };
  });
}

async function appendCurrentGoogleEvent(
  tx: Prisma.TransactionClient,
  input: AppendEntitlementEventInput,
): Promise<void> {
  if (input.source !== "google") {
    throw new Error("Google entitlement fence requires a Google event");
  }
  // The reducer orders by sourceTimestamp, not insertion order. A Google
  // RTDN for an old token may carry a publishTime later than a replacement
  // /verify. Since we re-fetch current provider state before each write,
  // preserve provider order unless it would put this freshly verified state
  // behind a previously committed event on this Google root. In that case,
  // bump one millisecond past it under the same lock.
  const latest = await tx.entitlementEvent.findFirst({
    where: { tenantId: input.tenantId, source: "google", streamId: input.streamId },
    orderBy: [{ sourceTimestamp: "desc" }, { id: "desc" }],
    select: { id: true, sourceTimestamp: true, type: true, sourceEventId: true },
  });
  const previousTime = latest?.sourceTimestamp.getTime() ?? Number.NEGATIVE_INFINITY;
  const nextTime = Math.max(input.sourceTimestamp.getTime(), previousTime + 1);
  if (!Number.isFinite(nextTime) || nextTime > 8_640_000_000_000_000) {
    throw new Error("Google entitlement event ordering exhausted");
  }
  // /verify has no provider-issued event id. Its deterministic identity can
  // recur when the same token reactivates after a revoke without changing its
  // expiry or tier. Under the root lock, bind that recovery to the terminal
  // row so repeat verification stays idempotent while a real reactivation
  // becomes a new grant after the terminal event.
  let sourceEventId = input.sourceEventId;
  if (latest && (latest.type === "revoke" || latest.type === "refund")
    && (input.type === "purchase" || input.type === "renewal"
      || input.type === "restore" || input.type === "grace")) {
    const existing = await tx.entitlementEvent.findFirst({
      where: { source: "google", sourceEventId: input.sourceEventId },
      select: { id: true, streamId: true },
    });
    if (existing?.streamId && existing.streamId !== input.streamId) {
      throw new Error("Google entitlement event identity crossed streams");
    }
    if (existing) sourceEventId = `${input.sourceEventId}:after:${latest.id}`;
  }
  await tx.entitlementEvent.createMany({
    data: [{ ...input, sourceEventId, sourceTimestamp: new Date(nextTime) }],
    skipDuplicates: true,
  });
}

/** Append an event and reproject the tenant from its complete history. */
export function recordEntitlementEvent(input: AppendEntitlementEventInput): Promise<Plan>;
export function recordEntitlementEvent(
  input: AppendEntitlementEventInput,
  googleFence: GoogleEntitlementFence,
): Promise<Plan | null>;
export async function recordEntitlementEvent(
  input: AppendEntitlementEventInput,
  googleFence?: GoogleEntitlementFence,
): Promise<Plan | null> {
  if (!googleFence) {
    await appendEntitlementEvent(input);
    return reprojectEntitlement(input.tenantId);
  }
  if (input.source !== "google") {
    throw new Error("Google entitlement fence requires a Google event");
  }
  const current = await withCurrentGooglePurchase(input.tenantId, googleFence, (tx) =>
    appendCurrentGoogleEvent(tx, input));
  if (!current) return null;
  return reprojectEntitlement(input.tenantId);
}

/** Commit an operator decision and its Google grant as one fenced unit. */
export async function recordGoogleEntitlementWithDecision<T>(
  input: AppendEntitlementEventInput,
  googleFence: GoogleEntitlementFence,
  decide: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<{ decision: T; plan: Plan } | null> {
  if (input.source !== "google") {
    throw new Error("Google decision fence requires a Google event");
  }
  const current = await withCurrentGooglePurchase(input.tenantId, googleFence, async (tx) => {
    const decision = await decide(tx);
    await appendCurrentGoogleEvent(tx, input);
    return decision;
  });
  if (!current) return null;
  return { decision: current.value, plan: await reprojectEntitlement(input.tenantId) };
}
