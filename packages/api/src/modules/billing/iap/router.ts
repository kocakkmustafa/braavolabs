/**
 * Mobile In-App Purchase (IAP) entitlement bridge.
 *
 * Mobile clients (iOS StoreKit / Android Play Billing) post their receipt
 * here after a successful purchase. This handler:
 *   1. Verifies the receipt with Apple App Store Server API or Google
 *      Play Developer API (or trusts a RevenueCat customer info payload
 *      when REVENUECAT_WEBHOOK_SECRET is set — covers both stores in
 *      one integration).
 *   2. Persists / upserts a `MobileSubscription` row keyed by
 *      `originalTransactionId` so renewals collapse onto the same chain.
 *   3. Returns the resolved plan tier so the mobile UI can show a
 *      success state without a second round-trip.
 *
 * Web login then reads `tenant.mobileSubscriptions[*]` alongside the
 * legacy Stripe path: whichever has the latest non-expired entitlement
 * wins. A user who purchases on iPhone and opens braavolabs.com 30s
 * later sees their plan upgrade live — no Stripe in the loop.
 *
 * The verification calls themselves are intentionally stubbed pending
 * Apple/Google credential setup (App Store Connect Server API key,
 * Google service account JSON). See docs/manual-tasks.md → "Mobile IAP
 * verification credentials" for the operator runbook.
 */

import { Router } from "express";
import { z } from "zod";
import { authMiddleware } from "../../../middleware/auth";
import { systemScope } from "../../../middleware/system-scope";
import { rateLimit } from "../../../middleware/rateLimit";
import { prisma } from "../../../lib/db";
import { AppError } from "../../../middleware/error";
import { env } from "../../../config/env";
import { logger } from "../../../lib/logger";
import { verifyAppleReceipt, parseAppleNotification } from "./apple";
import { verifyGoogleReceipt, parseGoogleRtdnEnvelope, verifyPubSubPushToken } from "./google";
import { recordEntitlementEvent } from "../entitlement-ledger.service";
import { mapIapVerify, mapAppleNotify, mapGoogleNotify } from "../entitlement-mapping";
import {
  getIapProduct,
  internalPlanForProduct,
  verificationResponseTier,
} from "./catalog";
import crypto from "node:crypto";

export const iapRouter = Router();

// Each /verify call hits Apple/Google + writes to the DB; without a cap,
// a compromised or curious token can drain the store-API quota for the
// whole deployment (which then breaks legitimate verifications). 30/min
// per tenant covers normal post-purchase retries + dev testing.
const iapVerifyRateLimit = rateLimit({
  windowMs: 60_000,
  maxRequests: 30,
  keyPrefix: "rl:iap:verify",
});
const iapEntitlementRateLimit = rateLimit({
  windowMs: 60_000,
  maxRequests: 120,
  keyPrefix: "rl:iap:entitlement",
});
// Store webhooks are unauthenticated by design (Apple/Google sign the
// payload) — IP-keyed limit prevents flooding the parse + verify path
// with garbage. Real fan-out from Apple is well under 60/min/tenant.
const iapWebhookRateLimit = rateLimit({
  windowMs: 60_000,
  maxRequests: 120,
  keyPrefix: "rl:iap:webhook",
});

const verifySchema = z.object({
  // Provider the receipt comes from.
  provider: z.enum(["apple", "google", "revenuecat"]),
  // Apple: the base64 receipt blob from `appStoreReceiptURL`.
  // Google: the purchase token returned by `purchases.subscriptions.get`.
  // RevenueCat: the customer info JSON forwarded from the SDK.
  receipt: z.string().min(1).max(40_000),
  // Apple StoreKit2 productId / Google subscriptionId. Used for tier
  // mapping when the receipt itself doesn't carry tier metadata.
  productId: z.string().min(1).max(200),
  // For RevenueCat: app-user-id; for native flows we ignore this and
  // bind to req.auth.tenantId. Surfacing it lets us cross-check that
  // the mobile session matches the entitlement, catching account-mixup
  // bugs that would otherwise let user A's purchase upgrade user B.
  appUserId: z.string().max(200).optional(),
});

function isOriginalTransactionIdUniqueConflict(error: unknown): boolean {
  if (!error || typeof error !== "object" || (error as { code?: unknown }).code !== "P2002") {
    return false;
  }

  const target = (error as { meta?: { target?: unknown } }).meta?.target;
  const targets = Array.isArray(target) ? target : [target];
  return targets.some(
    (candidate) =>
      typeof candidate === "string" &&
      (candidate.includes("originalTransactionId") || candidate.includes("original_transaction_id")),
  );
}

// POST /api/v1/billing/iap/verify — verify a mobile receipt
iapRouter.post("/verify", authMiddleware, iapVerifyRateLimit, async (req, res, next) => {
  try {
    const body = verifySchema.parse(req.body);
    const tenantId = req.auth!.tenantId;

    const catalogProduct = getIapProduct(body.productId);
    if (!catalogProduct) {
      throw new AppError(400, `Unknown productId: ${body.productId}`);
    }
    if (catalogProduct.sale === "manual-review") {
      throw new AppError(409, "This product requires manual review.", {
        reason: "manual-review-required",
      });
    }
    const planTier = catalogProduct.internalPlan;

    // Verify with the relevant provider. Failures here are treated as
    // payment-not-confirmed — we never grant entitlement on an
    // unverified receipt, even at the cost of a slightly slower UX
    // when the provider is rate-limiting us.
    let verified;
    if (body.provider === "apple") {
      verified = await verifyAppleReceipt(body.receipt, body.productId);
    } else if (body.provider === "google") {
      verified = await verifyGoogleReceipt(body.receipt, body.productId);
    } else {
      // RevenueCat path — trust the SDK payload only when the shared
      // webhook secret is configured (mobile sends it in the receipt
      // as a signed envelope). Until that's wired we treat this branch
      // as not-yet-supported rather than an open hole.
      if (!env.REVENUECAT_WEBHOOK_SECRET) {
        throw new AppError(503, "RevenueCat path not configured");
      }
      throw new AppError(501, "RevenueCat verification not yet implemented");
    }

    const rejectDifferentOwner = (): never => {
      logger.warn(
        {
          originalTransactionId: verified.originalTransactionId,
          callerTenantId: tenantId,
        },
        "IAP verify rejected — receipt belongs to a different tenant",
      );
      throw new AppError(409, "This subscription is already linked to a different account.");
    };

    const createData = {
        tenantId,
        provider: body.provider,
        productId: body.productId,
        originalTransactionId: verified.originalTransactionId,
        latestReceipt: body.receipt,
        status: verified.status,
        planTier,
        startedAt: verified.startedAt,
        expiresAt: verified.expiresAt,
        autoRenew: verified.autoRenew,
        lastVerifiedAt: new Date(),
    };
    const updateData = {
        // R2 fix (2026-08-19): productId/planTier were missing here, so a
        // tier UPGRADE via /verify (same originalTransactionId — tier
        // changes reuse the same row) updated status/expiresAt/autoRenew
        // correctly but left planTier frozen at whatever the FIRST
        // purchase set. Harmless before this PR (nothing downstream read
        // the column), but this PR's notify handlers now feed it into
        // entitlement-granting renewal events — the next ROUTINE
        // renewal (no user action) would silently revert the tenant to
        // their pre-upgrade tier. See mapAppleNotify/mapGoogleNotify's
        // own defense-in-depth fix for the same root cause.
        productId: body.productId,
        planTier,
        latestReceipt: body.receipt,
        status: verified.status,
        expiresAt: verified.expiresAt,
        autoRenew: verified.autoRenew,
        lastVerifiedAt: new Date(),
    };

    const updateSameOwner = async () => {
      const updated = await prisma.mobileSubscription.updateMany({
        where: {
          originalTransactionId: verified.originalTransactionId,
          tenantId,
        },
        data: updateData,
      });
      if (updated.count === 0) return null;
      if (updated.count !== 1) throw new Error("IAP guarded update affected multiple rows");

      const subscription = await prisma.mobileSubscription.findUnique({
        where: {
          originalTransactionId: verified.originalTransactionId,
          tenantId,
        },
      });
      if (!subscription || subscription.tenantId !== tenantId) {
        throw new Error("IAP subscription missing after guarded update");
      }
      return subscription;
    };

    // A tenant-guarded update handles the normal renewal fast path without
    // reading another tenant's row. If no owned row exists, create competes on
    // the globally unique originalTransactionId and becomes the atomic claim.
    // After a matching P2002, retrying the guarded update distinguishes a
    // same-owner concurrent retry from a different owner even when RLS hides
    // cross-tenant rows.
    let subscription = await updateSameOwner();
    if (!subscription) {
      try {
        subscription = await prisma.mobileSubscription.create({ data: createData });
      } catch (error) {
        if (!isOriginalTransactionIdUniqueConflict(error)) throw error;

        subscription = await updateSameOwner();
        if (!subscription) rejectDifferentOwner();
      }
    }
    if (!subscription) throw new Error("IAP subscription ownership resolution failed");

    // Entitlement ledger — BR-P0-003. mapIapVerify returns null for
    // exactly the statuses the old code's `if` skipped (anything but
    // active/in_grace_period), so this preserves that behavior exactly
    // while recomputing tenant.plan from the FULL cross-source event
    // history rather than a blind write. body.provider is narrowed
    // explicitly here: the RevenueCat branch above always throws before
    // reaching this point, so `verified` only ever comes from apple/google
    // in practice, but the zod schema's wider union doesn't let TS see that.
    const entitlementSource = body.provider === "apple" ? "apple" : "google";
    const mappedEvent = mapIapVerify(entitlementSource, verified, planTier);
    if (mappedEvent) {
      await recordEntitlementEvent({ tenantId, ...mappedEvent });
    }

    await prisma.activityLog.create({
      data: {
        tenantId,
        actor: req.auth!.userId,
        action: "billing.iap.verified",
        resource: "mobile_subscription",
        resourceId: subscription.id,
        details: {
          provider: body.provider,
          productId: body.productId,
          planTier,
          status: verified.status,
        } as any,
      },
    });

    res.json({
      success: true,
      planTier: verificationResponseTier(catalogProduct),
      status: verified.status,
      expiresAt: verified.expiresAt,
    });
  } catch (err) {
    if (err instanceof AppError) return next(err);
    logger.error({ err }, "IAP verification failed");
    next(new AppError(500, "Receipt verification failed"));
  }
});

// GET /api/v1/billing/iap/entitlement — current mobile entitlement
//
// Mobile reads this on launch to render the right plan badge / decide
// whether to surface the upgrade CTA. Web reads the same row in
// /users/me to drive plan-gating across the app.
iapRouter.get("/entitlement", authMiddleware, iapEntitlementRateLimit, async (req, res, next) => {
  try {
    const subscription = await prisma.mobileSubscription.findFirst({
      where: {
        tenantId: req.auth!.tenantId,
        status: { in: ["active", "in_grace_period"] },
        expiresAt: { gt: new Date() },
      },
      orderBy: { expiresAt: "desc" },
    });

    const catalogProduct = subscription
      ? getIapProduct(subscription.productId)
      : undefined;

    if (subscription && !catalogProduct) {
      logger.warn(
        { productId: subscription.productId, tenantId: req.auth!.tenantId },
        "IAP entitlement row references unknown productId; withholding stale tier",
      );
      res.json({
        hasActiveMobileSubscription: false,
        planTier: null,
        expiresAt: null,
        provider: null,
        autoRenew: null,
      });
      return;
    }

    res.json({
      hasActiveMobileSubscription: !!subscription,
      planTier: catalogProduct ? verificationResponseTier(catalogProduct) : null,
      expiresAt: subscription?.expiresAt ?? null,
      provider: subscription?.provider ?? null,
      autoRenew: subscription?.autoRenew ?? null,
    });
  } catch (err) {
    next(err);
  }
});

// ─── STORE WEBHOOKS ──────────────────────────────────────
//
// Apple App Store Server Notifications V2 + Google Real-Time Developer
// Notifications keep our row current without polling. They share a
// common shape from our perspective: a state change for an existing
// originalTransactionId, propagated to the matching MobileSubscription
// row + tenant.plan downgrade when entitlement expires. Both endpoints
// are unauthenticated by design — Apple/Google sign their payloads;
// our /verify trust comes from the signature, not from a bearer token.

// POST /api/v1/billing/iap/apple/notify
//
// Apple posts a JSON body with `signedPayload` (a JWS). The payload
// signature itself is Apple-signed; integrity comes from HTTPS plus
// the JWS. We re-fetch the canonical subscription state via the
// Server API so a malicious replay (which we'd never accept anyway
// because we only trust the JWS structure for the transactionId) can't
// move our row past what Apple actually says is active.
iapRouter.post("/apple/notify", systemScope("webhook:iap-apple"), iapWebhookRateLimit, async (req, res) => {
  const signedPayload = (req.body as { signedPayload?: string })?.signedPayload;
  if (!signedPayload || typeof signedPayload !== "string") {
    res.status(400).json({ error: "missing signedPayload" });
    return;
  }
  try {
    // parseAppleNotification now VERIFIES the JWS against Apple's x5c chain
    // (anchored to the pinned Apple Root CA - G3) before returning any field —
    // a forged/unsigned payload is rejected with 401 (FINDINGS C1, see
    // ./jws.ts). The server-to-server re-fetch below is therefore now
    // belt-and-suspenders (authoritative subscription state) rather than the
    // sole defense: even a validly-signed-but-replayed notification can't move
    // our row past what Apple's Server API currently reports.
    const note = await parseAppleNotification(signedPayload);
    let verified;
    try {
      verified = await verifyAppleReceipt(note.originalTransactionId, note.productId);
    } catch (err) {
      // Verification failure can be a legit "Apple hasn't fully
      // propagated the transaction yet" race (404 on production +
      // sandbox), or a malicious / malformed payload. Either way,
      // return 200 so Apple stops retrying immediately while the
      // server log captures the diagnostic.
      logger.warn(
        { err: err instanceof Error ? err.message : err, type: note.notificationType, originalTransactionId: note.originalTransactionId },
        "Apple ASN re-verify failed; not mutating subscription",
      );
      res.status(200).json({ ok: false, reason: "verify-failed" });
      return;
    }

    const catalogTier = internalPlanForProduct(note.productId);
    if (!catalogTier) {
      logger.warn(
        { productId: note.productId, type: note.notificationType },
        "Apple notification productId is outside the IAP catalog; acknowledging without mutation",
      );
      res.status(200).json({ ok: false, reason: "unknown-product" });
      return;
    }

    const updated = await prisma.mobileSubscription.update({
      where: { originalTransactionId: verified.originalTransactionId },
      data: {
        // Server-supplied state — guaranteed to match Apple's view of
        // the world rather than whatever the JWS claimed.
        status: verified.status,
        expiresAt: verified.expiresAt,
        autoRenew: verified.autoRenew,
        lastVerifiedAt: new Date(),
      },
    }).catch((err) => {
      // Unknown originalTransactionId — usually a TEST notification
      // before any real purchase has hit our /verify path. Log and
      // ack so Apple doesn't retry.
      logger.warn(
        { err: err instanceof Error ? err.message : err, type: note.notificationType },
        "Apple notification for unknown subscription",
      );
      return null;
    });

    if (updated) {
      // Entitlement ledger — BR-P0-003. Recorded for every status (not
      // just expired/revoked, as the old downgrade-only check did) —
      // the active/grace deliveries matter too, because it's THEIR
      // accurate sourceTimestamp in the ledger that lets a
      // late-arriving but chronologically OLDER "expired" notification
      // be correctly ignored instead of wrongly winning on arrival
      // order. combineStreams still preserves any other active source
      // automatically (Stripe web, or the other store), same as the
      // other 5 call sites — no manual "stillActive" query needed.
      //
      await recordEntitlementEvent({
        tenantId: updated.tenantId,
        ...mapAppleNotify(note, verified, catalogTier),
      });
      await prisma.activityLog.create({
        data: {
          tenantId: updated.tenantId,
          actor: "apple-asn",
          action: "billing.iap.notification",
          resource: "mobile_subscription",
          resourceId: updated.id,
          details: { type: note.notificationType, subtype: note.subtype, status: verified.status } as any,
        },
      });
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    logger.error({ err }, "Failed to process Apple notification");
    // 200 even on parse error — Apple retries 5xx aggressively and we
    // don't want a malformed test notification to flood our queue.
    // Real errors are visible in logs.
    res.status(200).json({ ok: false });
  }
});

// POST /api/v1/billing/iap/google/notify
//
// Google forwards RTDN messages via a Pub/Sub push subscription. The
// envelope wraps a base64-encoded JSON body describing the change.
// We re-fetch authoritative state via verifyGoogleReceipt — the
// notification only carries `purchaseToken + notificationType`, the
// truth is behind the API.
iapRouter.post("/google/notify", systemScope("webhook:iap-google"), iapWebhookRateLimit, async (req, res) => {
  try {
    // FINDINGS C1 — authenticate the sender. Pub/Sub push attaches a
    // Google-signed OIDC bearer token; verifying it stops an attacker from
    // POSTing a crafted purchaseToken that would drive a Server-API
    // re-fetch + tenant plan mutation. Fail CLOSED in production; in
    // dev/test (no real Pub/Sub) log and continue so local flows work.
    const oidc = await verifyPubSubPushToken(req.headers.authorization);
    if (!oidc.ok) {
      if (env.NODE_ENV === "production") {
        logger.warn({ reason: oidc.reason }, "Google RTDN OIDC verification failed — rejecting");
        res.status(401).json({ error: "unauthorized" });
        return;
      }
      logger.warn(
        { reason: oidc.reason },
        "Google RTDN OIDC not verified (non-production) — processing anyway",
      );
    }

    const parsed = parseGoogleRtdnEnvelope(req.body);
    if (!parsed) {
      res.status(200).json({ ok: false, reason: "envelope-not-recognised" });
      return;
    }

    // Re-verify against the API so we're not trusting the
    // notification body (which doesn't carry expiresAt etc).
    let verified;
    try {
      verified = await verifyGoogleReceipt(parsed.purchaseToken, parsed.subscriptionId);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : err, type: parsed.notificationType },
        "Google RTDN re-verify failed",
      );
      res.status(200).json({ ok: false, reason: "verify-failed" });
      return;
    }

    const catalogTier = internalPlanForProduct(parsed.subscriptionId);
    if (!catalogTier) {
      logger.warn(
        { subscriptionId: parsed.subscriptionId, type: parsed.notificationType },
        "Google RTDN subscriptionId is outside the IAP catalog; acknowledging without mutation",
      );
      res.status(200).json({ ok: false, reason: "unknown-product" });
      return;
    }

    const updated = await prisma.mobileSubscription.update({
      where: { originalTransactionId: verified.originalTransactionId },
      data: {
        status: verified.status,
        expiresAt: verified.expiresAt,
        autoRenew: verified.autoRenew,
        lastVerifiedAt: new Date(),
      },
    }).catch((err) => {
      logger.warn(
        { err: err instanceof Error ? err.message : err, type: parsed.notificationType },
        "Google RTDN for unknown subscription",
      );
      return null;
    });

    if (updated) {
      // Entitlement ledger — BR-P0-003. Same reasoning as the Apple
      // notify handler above: recorded for every status, not just
      // expired/revoked, so out-of-order delivery is provably safe
      // rather than merely "usually fine".
      //
      await recordEntitlementEvent({
        tenantId: updated.tenantId,
        ...mapGoogleNotify(parsed, verified, catalogTier),
      });
      await prisma.activityLog.create({
        data: {
          tenantId: updated.tenantId,
          actor: "google-rtdn",
          action: "billing.iap.notification",
          resource: "mobile_subscription",
          resourceId: updated.id,
          details: { type: parsed.notificationType, status: verified.status } as any,
        },
      });
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    logger.error({ err }, "Failed to process Google RTDN");
    res.status(200).json({ ok: false });
  }
});
