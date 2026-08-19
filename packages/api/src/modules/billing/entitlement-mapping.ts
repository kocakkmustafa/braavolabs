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

  const granting = type === "renewal";
  return {
    source: "stripe",
    streamId: subscription.id,
    sourceEventId: event.id,
    sourceTimestamp: new Date(event.created * 1000),
    type,
    planTier: granting ? plan : null,
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
 * deliberately preserves access until expiresAt) — the "cancel" event
 * already fired earlier, at whatever point cancel_at_period_end was
 * first set, via a subscription.updated delivery; by the time
 * .deleted arrives there is nothing left to preserve. This matches the
 * existing handler's unconditional "downgrade to FREE now, flag early
 * cancellations for manual refund review" behavior exactly (the
 * early-cancel warning log is unrelated ActivityLog bookkeeping, not
 * touched by this mapper).
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
 * "paused" is defensively mapped to `grace` (temporarily-not-renewing,
 * not yet gone) — Apple's own verify/parse logic never actually
 * produces "paused" today (grep-confirmed), this branch exists for
 * exhaustiveness against the shared union and for Google, where a
 * user-initiated Play subscription pause is a real state.
 */
function mobileStatusToEventType(status: VerifiedReceipt["status"]): EntitlementEventType {
  switch (status) {
    case "active":
      return "renewal";
    case "in_grace_period":
      return "grace";
    case "paused":
      return "grace";
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
 * back "here's the current state"). Deriving a stable id from
 * (originalTransactionId, status, expiresAt) means repeat /verify calls
 * for an UNCHANGED subscription dedupe to the same ledger row, while an
 * actual state change (renewal pushing expiresAt forward, a fresh
 * purchase) produces a genuinely new one.
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
    sourceEventId: `verify:${verified.originalTransactionId}:${verified.status}:${verified.expiresAt.getTime()}`,
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
