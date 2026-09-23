/**
 * BR-P0-003 — the single entitlement reducer Stripe, Apple and Google
 * events all fold through.
 *
 * Today (pre-this-module) each of the 3 payment sources writes
 * `tenant.plan` / `MobileSubscription` directly, in 6 separate call
 * sites, with no ordering guard: an older, delayed webhook can silently
 * overwrite a newer one because the write is a blind `UPDATE`, not a
 * fold over history. This module is the fix — PURE functions with no
 * I/O, so "same events, any arrival order → same final entitlement" is
 * something a unit test can prove outright, not something you have to
 * trust the calling code got right.
 *
 * Three stages, deliberately kept separate:
 *   1. foldStream    — one subscription's event history -> its state.
 *   2. combineStreams — a tenant's several concurrent streams (e.g. a
 *      Stripe web sub AND a mobile IAP sub) -> the one entitlement that
 *      actually governs the tenant (never silently downgrades below
 *      whatever else is still active — generalizes the "don't downgrade
 *      if another active subscription exists" check that today is
 *      duplicated near-verbatim across billing/router.ts and
 *      billing/iap/router.ts).
 *   3. resolveEntitlement — the ONLY place wall-clock time enters: a
 *      stream can be event-wise "active" yet past its expiresAt, which
 *      is a fact about time, not an event nobody ever sends a webhook
 *      for. Takes `now` as an explicit parameter so it stays pure and
 *      testable without mocking Date.
 *
 * Ordering key: (sourceTimestamp ASC, id ASC). sourceTimestamp normally
 * comes from the payment source (Stripe's `created`, Apple/Google's
 * notification time), so a delayed webhook does not jump the queue.
 * Google replacement-chain events are the exception: the persistence
 * service may raise their timestamp by 1 ms past the previous event on
 * the same root, under its ownership lock. That keeps a freshly verified
 * replacement grant after an old-token revoke whose Pub/Sub publish time
 * happens to be later. `id` is the event row's own unique id, used only as a
 * deterministic, stable tie-break when two events share a timestamp —
 * it does not claim to recover true sub-millisecond ordering, only to
 * make the fold's result reproducible given the same event set.
 */

import { normalizePlanForEntitlement } from "@ai-company-os/core";

export type EntitlementSource = "stripe" | "apple" | "google";

export type EntitlementEventType =
  | "purchase"
  | "renewal"
  | "cancel"
  | "grace"
  | "refund"
  | "revoke"
  | "restore";

export interface EntitlementEvent {
  /** Unique id of this event row — also the deterministic tie-break for
   * same-`sourceTimestamp` ordering. NOT the source's own event id (that's
   * the dedup key at the persistence layer, one level below this module). */
  id: string;
  source: EntitlementSource;
  /** Groups events belonging to the same subscription — a Stripe
   * subscription id, or an Apple/Google originalTransactionId. */
  streamId: string;
  /** When the event happened per the SOURCE, not when we received it. */
  sourceTimestamp: Date;
  type: EntitlementEventType;
  /** Plan tier this event grants. null for events that never grant a
   * plan on their own (cancel, grace, refund, revoke carry no tier —
   * refund/revoke actively clear whatever tier was active). */
  planTier: string | null;
  expiresAt: Date | null;
  autoRenew: boolean;
}

export type StreamStatus =
  | "active"
  | "in_grace_period"
  | "refunded"
  | "revoked";

export interface StreamState {
  streamId: string;
  source: EntitlementSource;
  status: StreamStatus;
  planTier: string | null;
  expiresAt: Date | null;
  autoRenew: boolean;
}

function sortKey(e: EntitlementEvent): [number, string] {
  return [e.sourceTimestamp.getTime(), e.id];
}

function compareEvents(a: EntitlementEvent, b: EntitlementEvent): number {
  const [at, aid] = sortKey(a);
  const [bt, bid] = sortKey(b);
  if (at !== bt) return at - bt;
  return aid < bid ? -1 : aid > bid ? 1 : 0;
}

/**
 * Fold one subscription stream's full event history into its current
 * state. Order-independent and duplicate-safe: every event handler below
 * SETS fields rather than incrementing them, so applying the same event
 * twice (e.g. persistence-layer dedup somehow failed) reaches the same
 * state as applying it once — the sort is what makes ordering-independence
 * hold, the set-not-increment shape is what makes duplication-independence
 * hold.
 */
export function foldStream(events: EntitlementEvent[]): StreamState | null {
  if (events.length === 0) return null;

  const streamId = events[0]!.streamId;
  const source = events[0]!.source;
  for (const e of events) {
    if (e.streamId !== streamId) {
      throw new Error(
        `foldStream: mixed streamId in input (expected "${streamId}", got "${e.streamId}") — ` +
          `caller must pre-filter to one stream; the reducer refuses to silently merge two subscriptions' histories.`,
      );
    }
  }

  const sorted = [...events].sort(compareEvents);

  let status: StreamStatus = "active";
  let planTier: string | null = null;
  let expiresAt: Date | null = null;
  let autoRenew = true;

  for (const e of sorted) {
    switch (e.type) {
      case "purchase":
      case "renewal":
      case "restore":
        status = "active";
        planTier = normalizePlanForEntitlement(e.planTier);
        expiresAt = e.expiresAt;
        autoRenew = e.autoRenew;
        break;
      case "cancel":
        // Auto-renew turns off but the tenant keeps what they paid for
        // until expiresAt — cancelling is not an immediate downgrade.
        autoRenew = false;
        break;
      case "grace":
        status = "in_grace_period";
        // A restore can discover a subscription for the first time while the
        // provider already has it in grace. Carry verified tier/expiry when
        // present so that first-seen stream remains provisionally entitled.
        if (e.planTier !== null) planTier = normalizePlanForEntitlement(e.planTier);
        if (e.expiresAt !== null) expiresAt = e.expiresAt;
        autoRenew = e.autoRenew;
        break;
      case "refund":
        status = "refunded";
        planTier = null;
        expiresAt = null;
        autoRenew = false;
        break;
      case "revoke":
        status = "revoked";
        planTier = null;
        expiresAt = null;
        autoRenew = false;
        break;
    }
  }

  return { streamId, source, status, planTier, expiresAt, autoRenew };
}

/**
 * Plan tier ranking for combineStreams' "never silently downgrade" rule.
 * Sourced from the same tiers packages/core/src/constants/plans.ts
 * defines (PLAN_ORDER) — kept as a local literal rather than importing
 * @ai-company-os/core to keep this module dependency-free and trivially
 * unit-testable; the "covers every tier" test below is the regression
 * guard against the two drifting.
 */
export const PLAN_RANK: Record<string, number> = {
  MANUAL_REVIEW: 0,
  INDIVIDUAL: 1,
  TEAM: 2,
};

function isCurrentlyGranting(status: StreamStatus): boolean {
  return status === "active" || status === "in_grace_period";
}

/**
 * Whether a stream's grant should actually be trusted right now — the
 * shared wall-clock check used by BOTH combineStreams (to pick the right
 * winner) and resolveEntitlement (to gate the winner's final answer).
 *
 * Only "active" streams are checked against their own expiresAt: nothing
 * sends a webhook at the exact moment a subscription's paid period
 * silently lapses, so that fact has to be checked at read time. "grace"
 * streams are deliberately NEVER wall-clock-gated — none of the 3 sources
 * hand us a fully reliable "grace truly ends at X" timestamp (Stripe's
 * past_due in particular carries no such field at all; its
 * current_period_end is simply the already-past-or-current period that
 * failed to renew, not a retry deadline). Grace is trusted until the
 * SOURCE sends an explicit follow-up event — back to active, or revoked
 * — which all 3 sources reliably eventually do; this is event-driven
 * trust, not time-driven, by design.
 *
 * R2 finding (2026-08-19): the previous split — combineStreams ranking
 * purely by status+tier with no time check, resolveEntitlement checking
 * expiresAt only on the single already-picked winner — let a stale
 * "active" high-tier stream (its own expiry-notifying webhook lost or
 * delayed) shadow a genuinely-active lower-tier one during selection,
 * AND (combined with Stripe's grace mapping unconditionally excluding
 * itself from "granting") made every Stripe past_due event resolve to
 * FREE almost immediately instead of preserving the plan during
 * Stripe's retry window. Unifying the check here, used identically by
 * both selection and resolution, closes both.
 */
function isEffectivelyGranting(s: StreamState, now: Date): boolean {
  if (!isCurrentlyGranting(s.status)) return false;
  if (normalizePlanForEntitlement(s.planTier) === "MANUAL_REVIEW") return false;
  if (s.status === "active" && s.expiresAt && s.expiresAt.getTime() <= now.getTime()) return false;
  return true;
}

/**
 * Combine a tenant's concurrent subscription streams into the ONE that
 * actually governs their entitlement — the highest-tier stream that is
 * still effectively granting access (status-wise AND, for active
 * streams, not yet expired). Returns null when nothing qualifies (every
 * stream expired/refunded/revoked, or there were no streams).
 *
 * This is the generalization of the "don't downgrade if another active
 * mobile subscription exists" check duplicated today across
 * billing/router.ts:738-744, billing/iap/router.ts:322-329 and :423-430
 * — one rule, one place, works across all 3 sources instead of only
 * guarding the mobile-vs-mobile case.
 */
export function combineStreams(streams: StreamState[], now: Date): StreamState | null {
  let best: StreamState | null = null;
  for (const s of streams) {
    if (!isEffectivelyGranting(s, now)) continue;
    if (!best || compareStreamPriority(s, best) > 0) best = s;
  }
  return best;
}

function compareStreamPriority(a: StreamState, b: StreamState): number {
  const rankDelta = PLAN_RANK[normalizePlanForEntitlement(a.planTier)]
    - PLAN_RANK[normalizePlanForEntitlement(b.planTier)];
  if (rankDelta !== 0) return rankDelta;

  const statusDelta = (a.status === "active" ? 1 : 0) - (b.status === "active" ? 1 : 0);
  if (statusDelta !== 0) return statusDelta;

  const expiryDelta = (a.expiresAt?.getTime() ?? Number.NEGATIVE_INFINITY)
    - (b.expiresAt?.getTime() ?? Number.NEGATIVE_INFINITY);
  if (expiryDelta !== 0) return expiryDelta;

  const aKey = `${a.source}:${a.streamId}`;
  const bKey = `${b.source}:${b.streamId}`;
  // Lexically smaller is the deterministic final winner.
  return aKey < bKey ? 1 : aKey > bKey ? -1 : 0;
}

/**
 * The final read-time gate on whatever combineStreams picked. Kept as a
 * separate step (rather than folding this into combineStreams' return)
 * so a single already-selected stream can still be re-checked against a
 * DIFFERENT `now` than selection used, and so callers with just one
 * stream (no combineStreams call at all) get the same guarantee.
 */
export function resolveEntitlement(stream: StreamState | null, now: Date): string {
  if (!stream) return "MANUAL_REVIEW";
  if (!isEffectivelyGranting(stream, now)) return "MANUAL_REVIEW";
  return normalizePlanForEntitlement(stream.planTier);
}
