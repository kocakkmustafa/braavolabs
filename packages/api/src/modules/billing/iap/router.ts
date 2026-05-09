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
import { prisma } from "../../../lib/db";
import { AppError } from "../../../middleware/error";
import { env } from "../../../config/env";
import { logger } from "../../../lib/logger";
import { verifyAppleReceipt } from "./apple";
import { verifyGoogleReceipt } from "./google";

export const iapRouter = Router();

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
iapRouter.post("/verify", authMiddleware, async (req, res, next) => {
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
iapRouter.get("/entitlement", authMiddleware, async (req, res, next) => {
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
