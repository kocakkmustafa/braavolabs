/**
 * BR-P0-003 — pure mappers from each of the 6 direct-write call sites'
 * native payload (Stripe event, Apple/Google verified receipt) into the
 * normalized shape entitlement-ledger.service.ts's recordEntitlementEvent
 * accepts. Kept separate from the router handlers so the actual mapping
 * decisions are unit-testable without mocking Express/Prisma/Stripe.
 *
 * Every function here is pure — no I/O, no `new Date()` defaulting except
 * where explicitly noted as the one unavoidable case (IAP /verify, see
 * below). Callers pass in whatever "now" or already-fetched DB row they
 * have; nothing in this file reaches out on its own.
 */
import type { EntitlementEventType, EntitlementSource } from "./entitlement-reducer";
import type { AppendEntitlementEventInput } from "./entitlement-ledger.service";
import type { VerifiedReceipt } from "./iap/apple";

export type EntitlementEventInput = Omit<AppendEntitlementEventInput, "tenantId">;

export type PlanTier = "FREE" | "CREATOR" | "PRO" | "BUSINESS" | "ENTERPRISE";

// ─── Stripe ──────────────────────────────────────────────────────────

interface MinimalStripeEvent {
  id: string;
  created: number; // unix seconds — Stripe's own "when this happened"
}

interface MinimalStripeSubscription {
  id: string;
  status: string;
  current_period_end?: number; // unix seconds
  cancel_at_period_end?: boolean;
}

/**
 * customer.subscription.updated — covers renewals, upgrades/downgrades,
 * and payment-retry states on an EXISTING subscription (first purchase
 * linkage happens via checkout.session.completed, which doesn't touch
 * plan at all — see router.ts).
 *
 * `plan` is whatever the caller already resolved from the price ID
 * (unchanged existing logic, not duplicated here). This function only
 * decides the EVENT TYPE from the subscription's status — in particular
 * mapping Stripe's "past_due" to a `grace` event rather than the old
 * code's blanket FREE: past_due means Stripe is still retrying the
 * card, which is exactly what `grace` semantics exist for (keeps the
 * tenant's current plan granting while foldStream marks the stream
 * in_grace_period). Any other non-active/trialing status (canceled,
 * unpaid, incomplete_expired, paused, incomplete) is an immediate
 * `revoke` — matches the old code's blanket-FREE fallback for "anything
 * else".
 *
 * R2 fix (2026-08-19): `granting` now includes `"grace"`, matching
 * mapAppleNotify/mapGoogleNotify's already-correct pattern — Stripe's
 * version originally only granted on `"renewal"`, which meant a
 * past_due event carried expiresAt:null and (since foldStream's own
 * "grace" case never touches expiresAt either) left the stream's
 * expiresAt frozen at whatever the last successful renewal set it to —
 * which, by definition, is already at-or-before "now" once payment has
 * actually failed. Combined with the reducer no longer wall-clock-gating
 * grace at all (see entitlement-reducer.ts's isEffectivelyGranting),
 * this fixes past_due resolving to FREE almost immediately instead of
 * preserving the plan through Stripe's retry window — planTier stays
 * renewal-only below since foldStream's grace case doesn't read it.
 */
export function mapStripeSubscriptionUpdated(
  event: MinimalStripeEvent,
  subscription: MinimalStripeSubscription,
  plan: PlanTier,
): EntitlementEventInput {
  const type: EntitlementEventType =
    subscription.status === "active" || subscription.status === "trialing"
      ? "renewal"
      : subscription.status === "past_due"
        ? "grace"
        : "revoke";

  const granting = type === "renewal" || type === "grace";
  return {
    source: "stripe",
    streamId: subscription.id,
    sourceEventId: event.id,
    sourceTimestamp: new Date(event.created * 1000),
    type,
    planTier: type === "renewal" ? plan : null,
    expiresAt: granting && subscription.current_period_end
      ? new Date(subscription.current_period_end * 1000)
      : null,
    autoRenew: granting ? !subscription.cancel_at_period_end : false,
  };
}

/**
 * customer.subscription.deleted — Stripe has now fully terminated this
 * subscription (either the scheduled cancel_at_period_end finally
 * landed, or an admin/API cancelled it mid-period). Either way access
 * ends NOW: mapped as `revoke` (immediate, foldStream clears
 * planTier/expiresAt unconditionally) rather than `cancel` (which
 * deliberately preserves access until expiresAt, and by the time
 * .deleted arrives there is nothing left to preserve). This matches the
 * existing handler's unconditional "downgrade to FREE now, flag early
 * cancellations for manual refund review" behavior exactly (the
 * early-cancel warning log is unrelated ActivityLog bookkeeping, not
 * touched by this mapper).
 *
 * Correction (R2, 2026-08-19): none of the 6 real call sites ever emits
 * a literal `type: "cancel"` event — `mapStripeSubscriptionUpdated`
 * carries the CURRENT `autoRenew` value (derived from
 * `cancel_at_period_end`) on every `"renewal"` event instead, which is
 * functionally equivalent (foldStream's own "cancel" case only ever
 * flips `autoRenew`) without needing a dedicated event type. `"cancel"`
 * remains in the reducer's vocabulary for completeness/future sources,
 * but is presently unreached by any of this repo's 6 mappers — this is
 * not a gap, just worth knowing so nobody goes looking for where it
 * fires.
 */
export function mapStripeSubscriptionDeleted(
  event: MinimalStripeEvent,
  subscription: MinimalStripeSubscription,
): EntitlementEventInput {
  return {
    source: "stripe",
    streamId: subscription.id,
    sourceEventId: event.id,
    sourceTimestamp: new Date(event.created * 1000),
    type: "revoke",
    planTier: null,
    expiresAt: null,
    autoRenew: false,
  };
}

/**
 * charge.refunded (fully refunded case only — caller still owns the
 * fullyRefunded/activeMobile-exists gating, this only builds the event
 * once the caller has decided a refund event should be recorded).
 *
 * streamId is NOT derivable from the charge object itself (a Charge
 * doesn't reliably carry its originating subscription id) — the caller
 * must pass the tenant's OWN tracked `stripeSubscriptionId`, the same
 * identifier subscription.updated/.deleted use as streamId. If a tenant
 * has no tracked Stripe subscription id there is no stream to attach a
 * refund to and the caller should skip calling this entirely.
 *
 * KNOWN LIMITATION (R2 finding #5, 2026-08-19, NOT fixed this pass —
 * pre-existing, the old blind-UPDATE code had the same gap in a
 * different shape, and the ledger is a strictly-better failure mode
 * than a silent overwrite): if a tenant churns (subscription A deleted,
 * stripeSubscriptionId cleared) and resubscribes (subscription B) before
 * a LATE refund for an old charge under A arrives, this attaches the
 * refund to B (whatever's currently on the tenant row) instead of A,
 * potentially clearing B's legitimate, currently-paid entitlement. Two
 * possible fixes, neither implemented here: (1) check whether the
 * webhook's charge object has an expandable `invoice.subscription` that
 * more precisely identifies the ORIGINATING subscription (needs
 * confirming that's actually populated on this account's webhook
 * config, or an extra Stripe API call to fetch it), or (2) track
 * refund-eligible charges against their subscription id at charge-time
 * rather than reaching for whatever's on the tenant row later.
 */
export function mapStripeChargeRefunded(
  event: MinimalStripeEvent,
  streamId: string,
): EntitlementEventInput {
  return {
    source: "stripe",
    streamId,
    sourceEventId: event.id,
    sourceTimestamp: new Date(event.created * 1000),
    type: "refund",
    planTier: null,
    expiresAt: null,
    autoRenew: false,
  };
}

// ─── Apple / Google (shared status vocabulary — VerifiedReceipt) ──────

/**
 * Both stores' re-fetched VerifiedReceipt.status collapse to the same 5
 * states (google.ts imports the type from apple.ts). Shared mapping so
 * the two notify handlers can't silently drift from each other.
 *
 * "paused" maps to `revoke` (immediate, no grant) — Apple's own
 * verify/parse logic never actually produces "paused" today
 * (grep-confirmed), this branch exists for exhaustiveness against the
 * shared union and for Google, where a user-initiated Play subscription
 * pause is a real state. R2 correction (2026-08-19): this previously
 * mapped to `grace` (still granting) on the reasoning "temporarily not
 * renewing, not yet gone" — but Play's pause feature is explicitly
 * "stop billing AND access until resumed", not a payment-retry window,
 * so granting access while paused overgrants. Fail-closed default
 * (matches this codebase's existing convention — e.g. the unknown-Stripe-priceId
 * and unrecognized-plan-tier fallbacks elsewhere in this module) until a
 * product decision says otherwise.
 */
function mobileStatusToEventType(status: VerifiedReceipt["status"]): EntitlementEventType {
  switch (status) {
    case "active":
      return "renewal";
    case "in_grace_period":
      return "grace";
    case "paused":
    case "expired":
    case "revoked":
      return "revoke";
  }
}

/**
 * POST /billing/iap/verify — the mobile client's own post-purchase
 * confirmation. Returns null when the receipt doesn't verify as
 * active/in_grace_period, matching the existing handler's exact no-op
 * for any other status (it only ever WROTE tenant.plan in that one
 * condition — see iap/router.ts:183).
 *
 * sourceEventId has no natural source here (unlike a true webhook,
 * /verify carries no server-issued event id — StoreKit/Play just hand
 * back "here's the current state"). Deriving a stable id from every
 * field that actually determines the event's meaning
 * (originalTransactionId, status, expiresAt, planTier, autoRenew) means
 * repeat /verify calls for a TRULY unchanged subscription dedupe to the
 * same ledger row, while any real state change produces a genuinely new
 * one. R2 correction (2026-08-19): the key previously omitted planTier
 * and autoRenew, so (a) a user toggling auto-renew off in platform
 * settings then reopening the app produced the SAME key as their prior
 * verify (status/expiresAt unchanged) and got silently dropped by the
 * unique constraint, and (b) an immediate-upgrade whose proration keeps
 * the same period end likewise collided with the pre-upgrade purchase
 * event. Both are now distinct keys.
 */
export function mapIapVerify(
  source: EntitlementSource,
  verified: VerifiedReceipt,
  planTier: PlanTier,
): EntitlementEventInput | null {
  if (verified.status !== "active" && verified.status !== "in_grace_period") return null;
  return {
    source,
    streamId: verified.originalTransactionId,
    sourceEventId: `verify:${verified.originalTransactionId}:${verified.status}:${verified.expiresAt.getTime()}:${planTier}:${verified.autoRenew}`,
    sourceTimestamp: new Date(),
    type: verified.status === "active" ? "purchase" : "grace",
    planTier: verified.status === "active" ? planTier : null,
    expiresAt: verified.status === "active" ? verified.expiresAt : null,
    autoRenew: verified.autoRenew,
  };
}

/**
 * Apple App Store Server Notification. Always trusts `verified` (the
 * fresh re-fetch from Apple's Server API) over `note` (the parsed JWS's
 * own best-guess status) for anything that decides the event's type or
 * grant — same trust model the surrounding handler already documents:
 * "even a validly-signed-but-replayed notification can't move our row
 * past what Apple's Server API currently reports." `note` supplies only
 * the delivery identity (notificationUUID/signedDate) and planTier
 * fallback, neither of which Apple's re-verify re-derives.
 */
export function mapAppleNotify(
  note: { notificationUUID: string; signedDate: Date; productId: string },
  verified: VerifiedReceipt,
  planTier: PlanTier,
): EntitlementEventInput {
  const type = mobileStatusToEventType(verified.status);
  const granting = type === "renewal" || type === "grace";
  return {
    source: "apple",
    streamId: verified.originalTransactionId,
    sourceEventId: note.notificationUUID,
    sourceTimestamp: note.signedDate,
    type,
    planTier: type === "renewal" ? planTier : null,
    expiresAt: granting ? verified.expiresAt : null,
    autoRenew: granting ? verified.autoRenew : false,
  };
}

/** Google RTDN — same trust model as mapAppleNotify (verified over
 * parsed), Pub/Sub's messageId/publishTime supply delivery identity. */
export function mapGoogleNotify(
  parsed: { messageId: string; publishTime: Date },
  verified: VerifiedReceipt,
  planTier: PlanTier,
): EntitlementEventInput {
  const type = mobileStatusToEventType(verified.status);
  const granting = type === "renewal" || type === "grace";
  return {
    source: "google",
    streamId: verified.originalTransactionId,
    sourceEventId: parsed.messageId,
    sourceTimestamp: parsed.publishTime,
    type,
    planTier: type === "renewal" ? planTier : null,
    expiresAt: granting ? verified.expiresAt : null,
    autoRenew: granting ? verified.autoRenew : false,
  };
}
