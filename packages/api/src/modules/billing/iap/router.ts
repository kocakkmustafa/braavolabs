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
import { rateLimit } from "../../../middleware/rateLimit";
import { prisma } from "../../../lib/db";
import { AppError } from "../../../middleware/error";
import { env } from "../../../config/env";
import { logger } from "../../../lib/logger";
import { verifyAppleReceipt, parseAppleNotification } from "./apple";
import { verifyGoogleReceipt, parseGoogleRtdnEnvelope } from "./google";

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

/**
 * Map Apple/Google product identifiers to internal plan tiers. Operators
 * keep this list in sync with the products configured in App Store
 * Connect / Play Console — see docs/manual-tasks.md.
 *
 * The same productId is used for monthly + yearly variants — the tier
 * the user gets is identical, only the billing cadence differs and
 * Apple/Google handle that internally.
 */
const PRODUCT_TIER_MAP: Record<string, "CREATOR" | "BUSINESS" | "PRO" | "ENTERPRISE"> = {
  "com.braavolabs.creator.monthly":    "CREATOR",
  "com.braavolabs.creator.yearly":     "CREATOR",
  "com.braavolabs.business.monthly":   "BUSINESS",
  "com.braavolabs.business.yearly":    "BUSINESS",
  "com.braavolabs.pro.monthly":        "PRO",
  "com.braavolabs.pro.yearly":         "PRO",
  "com.braavolabs.enterprise.monthly": "ENTERPRISE",
  "com.braavolabs.enterprise.yearly":  "ENTERPRISE",
};

// POST /api/v1/billing/iap/verify — verify a mobile receipt
iapRouter.post("/verify", authMiddleware, iapVerifyRateLimit, async (req, res, next) => {
  try {
    const body = verifySchema.parse(req.body);
    const tenantId = req.auth!.tenantId;

    const planTier = PRODUCT_TIER_MAP[body.productId];
    if (!planTier) {
      throw new AppError(400, `Unknown productId: ${body.productId}`);
    }

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

    // Cross-tenant hijack defense: originalTransactionId is globally unique
    // in the schema, but a plain upsert would let any user POST another
    // tenant's verified receipt and silently upgrade their own row to the
    // paid tier. Refuse when the existing row belongs to a different tenant
    // so the original purchaser keeps the entitlement and the second caller
    // sees a 409. (Apple/Google entitle a single original-transaction to a
    // single account; the legitimate re-verify path always comes from the
    // same authenticated tenant.)
    const existingForTransaction = await prisma.mobileSubscription.findUnique({
      where: { originalTransactionId: verified.originalTransactionId },
    });
    if (existingForTransaction && existingForTransaction.tenantId !== tenantId) {
      logger.warn(
        {
          originalTransactionId: verified.originalTransactionId,
          ownerTenantId: existingForTransaction.tenantId,
          callerTenantId: tenantId,
        },
        "IAP verify rejected — receipt belongs to a different tenant",
      );
      throw new AppError(409, "This subscription is already linked to a different account.");
    }

    // Persist/upsert. originalTransactionId is the natural key — every
    // renewal mutates expiresAt + lastVerifiedAt on the same row.
    const subscription = await prisma.mobileSubscription.upsert({
      where: { originalTransactionId: verified.originalTransactionId },
      create: {
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
      },
      update: {
        latestReceipt: body.receipt,
        status: verified.status,
        expiresAt: verified.expiresAt,
        autoRenew: verified.autoRenew,
        lastVerifiedAt: new Date(),
      },
    });

    // Reflect the plan on the tenant immediately so the next /users/me
    // call from the web mirrors the upgrade. We do NOT downgrade — a
    // future expiry-cron handles that path with proper grace logic.
    if (verified.status === "active" || verified.status === "in_grace_period") {
      await prisma.tenant.update({
        where: { id: tenantId },
        data: { plan: planTier as any },
      });
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
      planTier,
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

    res.json({
      hasActiveMobileSubscription: !!subscription,
      planTier: subscription?.planTier ?? null,
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
iapRouter.post("/apple/notify", iapWebhookRateLimit, async (req, res) => {
  const signedPayload = (req.body as { signedPayload?: string })?.signedPayload;
  if (!signedPayload || typeof signedPayload !== "string") {
    res.status(400).json({ error: "missing signedPayload" });
    return;
  }
  try {
    const note = await parseAppleNotification(signedPayload);
    const updated = await prisma.mobileSubscription.update({
      where: { originalTransactionId: note.originalTransactionId },
      data: {
        status: note.status,
        expiresAt: note.expiresAt,
        autoRenew: note.autoRenew,
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
      // Downgrade the tenant when entitlement is actually gone. Active
      // states leave the existing tenant.plan untouched (the upgrade
      // was already applied at /verify time).
      if (note.status === "expired" || note.status === "revoked") {
        const stillActive = await prisma.mobileSubscription.findFirst({
          where: {
            tenantId: updated.tenantId,
            status: { in: ["active", "in_grace_period"] },
            expiresAt: { gt: new Date() },
          },
        });
        if (!stillActive) {
          await prisma.tenant.update({
            where: { id: updated.tenantId },
            data: { plan: "FREE" },
          });
        }
      }
      await prisma.activityLog.create({
        data: {
          tenantId: updated.tenantId,
          actor: "apple-asn",
          action: "billing.iap.notification",
          resource: "mobile_subscription",
          resourceId: updated.id,
          details: { type: note.notificationType, subtype: note.subtype, status: note.status } as any,
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
iapRouter.post("/google/notify", iapWebhookRateLimit, async (req, res) => {
  try {
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
      if (verified.status === "expired" || verified.status === "revoked") {
        const stillActive = await prisma.mobileSubscription.findFirst({
          where: {
            tenantId: updated.tenantId,
            status: { in: ["active", "in_grace_period"] },
            expiresAt: { gt: new Date() },
          },
        });
        if (!stillActive) {
          await prisma.tenant.update({
            where: { id: updated.tenantId },
            data: { plan: "FREE" },
          });
        }
      }
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
