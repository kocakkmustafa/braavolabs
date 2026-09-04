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

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { authMiddleware } from "../../../middleware/auth";
import { requirePermission } from "../../../middleware/require-permission";
import { systemScope } from "../../../middleware/system-scope";
import { rateLimit } from "../../../middleware/rateLimit";
import { prisma, tenantTx } from "../../../lib/db";
import { AppError } from "../../../middleware/error";
import { env } from "../../../config/env";
import { logger } from "../../../lib/logger";
import { verifyAppleReceipt, parseAppleNotification, type VerifiedReceipt } from "./apple";
import {
  acknowledgeGoogleReceipt,
  verifyGoogleReceipt,
  parseGoogleRtdnEnvelope,
  verifyPubSubPushToken,
  type GoogleSubscriptionNotification,
  type VerifiedGoogleReceipt,
} from "./google";
import { getEntitlementProjection, recordEntitlementEvent } from "../entitlement-ledger.service";
import {
  iapCredentialDigest,
  iapCredentialReference,
  mapIapVerify,
  mapAppleNotify,
  mapGoogleNotify,
} from "../entitlement-mapping";
import {
  getIapProduct,
  verificationResponseTier,
  type MobilePublicTier,
} from "./catalog";
import crypto from "node:crypto";
import {
  IapPoisonDeliveryError,
  IapTransientDeliveryError,
  deliveryFingerprint,
  processIapDelivery,
} from "./delivery-ledger";
import {
  ensureManualReviewCase,
  getManualReviewCase,
  hasPendingManualReviewCases,
  manualReviewCaseId,
  transitionManualReviewCase,
  validateManualReviewReason,
} from "./manual-review.service";

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

const manualReviewDecisionSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("approved_mapping"),
    targetTier: z.enum(["INDIVIDUAL", "TEAM"]),
    reason: z.string().trim().min(1).max(500),
    receipt: z.string().min(1).max(40_000),
  }).strict(),
  z.object({
    state: z.literal("rejected"),
    reason: z.string().trim().min(1).max(500),
  }).strict(),
  z.object({
    state: z.literal("expired"),
    reason: z.string().trim().min(1).max(500),
    receipt: z.string().min(1).max(40_000),
  }).strict(),
]);

type NativeIapProvider = "apple" | "google";

function isGrantingStatus(status: VerifiedReceipt["status"]): boolean {
  return status === "active" || status === "in_grace_period";
}

function publicProviderStatus(
  status: VerifiedReceipt["status"],
): "active" | "in_grace_period" | "inactive" {
  if (status === "active" || status === "in_grace_period") return status;
  return "inactive";
}

function effectiveTierFromPlan(plan: unknown): MobilePublicTier | null {
  return plan === "INDIVIDUAL" || plan === "TEAM" ? plan : null;
}

async function verifyNativeReceipt(
  provider: NativeIapProvider,
  receipt: string,
  productId: string,
): Promise<VerifiedReceipt | VerifiedGoogleReceipt> {
  return provider === "apple"
    ? verifyAppleReceipt(receipt, productId)
    : verifyGoogleReceipt(receipt, productId);
}

function safeVerificationFailure(provider: string, productId: string): void {
  logger.error(
    { provider, productId, code: "IAP_VERIFICATION_FAILED" },
    "IAP verification failed",
  );
}

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

function iapActivityId(provider: "apple" | "google", deliveryId: string): string {
  return `iap_${deliveryFingerprint(`${provider}:${deliveryId}`)}`;
}

function retainInternalCatalogTier<T extends { planTier: string | null }>(
  event: T,
  internalTier: string,
): T {
  return {
    ...event,
    planTier: event.planTier === null ? null : internalTier,
  };
}

type ManualReviewObservationInput = Parameters<typeof ensureManualReviewCase>[0];

/**
 * Granting observations may open a review case. Terminal provider states may
 * only update a case that already exists: a revoked/refunded receipt must not
 * manufacture a new operator workflow merely by being replayed.
 */
async function observeManualReviewCase(
  input: ManualReviewObservationInput,
  allowCreate: boolean,
) {
  if (!allowCreate) {
    const caseId = manualReviewCaseId(input);
    if (!await getManualReviewCase(input.tenantId, caseId)) return null;
  }
  return ensureManualReviewCase(input);
}

const GOOGLE_PURCHASE_IDENTITY = /^google:[0-9a-f]{64}$/;

function normalizedGoogleAliases(verified: VerifiedGoogleReceipt): string[] {
  const aliases = [...new Set(verified.googlePurchaseAliases)];
  if (
    aliases.length === 0
    || aliases.length !== verified.googlePurchaseAliases.length
    || verified.googleCanonicalRootIdentity !== verified.originalTransactionId
    || aliases.at(-1) !== verified.googleCanonicalRootIdentity
    || aliases.some((identity) => !GOOGLE_PURCHASE_IDENTITY.test(identity))
  ) {
    throw new AppError(400, "Google purchase ownership metadata is invalid");
  }
  return aliases;
}

function googleOwnershipConflict(): AppError {
  return new AppError(409, "This subscription is already linked to a different account.");
}

function activeAliasMatches(
  alias: {
    state: string;
    tenantId: string | null;
    mobileSubscriptionId: string | null;
    provider: string | null;
    canonicalRootIdentity: string | null;
  },
  tenantId: string,
  rootIdentity: string,
  subscriptionId?: string,
): boolean {
  return alias.state === "active"
    && alias.tenantId === tenantId
    && alias.provider === "google"
    && alias.canonicalRootIdentity === rootIdentity
    && alias.mobileSubscriptionId !== null
    && (subscriptionId === undefined || alias.mobileSubscriptionId === subscriptionId);
}

async function claimGooglePurchaseOwnership(
  tenantId: string,
  verified: VerifiedGoogleReceipt,
  createData: Prisma.MobileSubscriptionUncheckedCreateInput,
  updateData: Prisma.MobileSubscriptionUpdateManyMutationInput,
) {
  const aliases = normalizedGoogleAliases(verified);
  const rootIdentity = verified.googleCanonicalRootIdentity;

  try {
    return await tenantTx(async (tx) => {
      const visibleBefore = await tx.googlePurchaseAlias.findMany({
        where: { tokenDigest: { in: aliases } },
      });
      if (visibleBefore.some((alias) => !activeAliasMatches(alias, tenantId, rootIdentity))) {
        throw googleOwnershipConflict();
      }

      const visibleOwnerIds = [...new Set(
        visibleBefore.map((alias) => alias.mobileSubscriptionId).filter((id): id is string => !!id),
      )];
      if (visibleOwnerIds.length > 1) throw googleOwnershipConflict();
      const proposedSubscriptionId = visibleOwnerIds[0] ?? crypto.randomUUID();

      await tx.googlePurchaseAlias.createMany({
        data: aliases.map((tokenDigest) => ({
          tokenDigest,
          state: "active",
          tenantId,
          mobileSubscriptionId: proposedSubscriptionId,
          provider: "google",
          canonicalRootIdentity: rootIdentity,
        })),
        skipDuplicates: true,
      });

      // A global unique conflict against an RLS-hidden row is intentionally
      // indistinguishable from an absent insert. Re-reading the COMPLETE set on
      // this tenant-bound connection turns either case into deterministic 409.
      const claimed = await tx.googlePurchaseAlias.findMany({
        where: { tokenDigest: { in: aliases } },
      });
      if (
        claimed.length !== aliases.length
        || claimed.some((alias) => !activeAliasMatches(
          alias,
          tenantId,
          rootIdentity,
          claimed[0]?.mobileSubscriptionId ?? undefined,
        ))
      ) {
        throw googleOwnershipConflict();
      }
      const subscriptionId = claimed[0]!.mobileSubscriptionId!;

      const updated = await tx.mobileSubscription.updateMany({
        where: {
          id: subscriptionId,
          tenantId,
          provider: "google",
          originalTransactionId: rootIdentity,
        },
        data: updateData,
      });
      if (updated.count > 1) throw new Error("Google ownership update affected multiple rows");
      if (updated.count === 0) {
        return tx.mobileSubscription.create({
          data: { ...createData, id: subscriptionId },
        });
      }
      const subscription = await tx.mobileSubscription.findUnique({ where: { id: subscriptionId } });
      if (!subscription || subscription.tenantId !== tenantId) throw googleOwnershipConflict();
      return subscription;
    });
  } catch (error) {
    // Covers a rolling-deploy race where an older process creates the global
    // canonical subscription key without its alias rows. The transaction has
    // already rolled back; translate only that exact uniqueness target to the
    // same deterministic ownership response.
    if (isOriginalTransactionIdUniqueConflict(error)) throw googleOwnershipConflict();
    throw error;
  }
}

async function updateGoogleOwnedSubscription(
  verified: VerifiedGoogleReceipt,
  updateData: Prisma.MobileSubscriptionUpdateManyMutationInput,
) {
  const aliases = normalizedGoogleAliases(verified);
  const rootIdentity = verified.googleCanonicalRootIdentity;

  return tenantTx(async (tx) => {
    const visibleBefore = await tx.googlePurchaseAlias.findMany({
      where: { tokenDigest: { in: aliases } },
    });
    const rootOwner = visibleBefore.find((alias) => alias.tokenDigest === rootIdentity);
    if (
      !rootOwner?.tenantId
      || !rootOwner.mobileSubscriptionId
      || !activeAliasMatches(rootOwner, rootOwner.tenantId, rootIdentity, rootOwner.mobileSubscriptionId)
      || visibleBefore.some((alias) => !activeAliasMatches(
        alias,
        rootOwner.tenantId!,
        rootIdentity,
        rootOwner.mobileSubscriptionId!,
      ))
    ) {
      throw googleOwnershipConflict();
    }

    const visibleDigests = new Set(visibleBefore.map((alias) => alias.tokenDigest));
    const missingAliases = aliases.filter((tokenDigest) => !visibleDigests.has(tokenDigest));
    if (missingAliases.length > 0) {
      await tx.googlePurchaseAlias.createMany({
        data: missingAliases.map((tokenDigest) => ({
          tokenDigest,
          state: "active",
          tenantId: rootOwner.tenantId!,
          mobileSubscriptionId: rootOwner.mobileSubscriptionId!,
          provider: "google",
          canonicalRootIdentity: rootIdentity,
        })),
        skipDuplicates: true,
      });
    }

    // The root owner must pre-exist, so an RTDN can extend an established
    // replacement chain but can never bootstrap ownership. Re-reading the
    // complete set catches a concurrent or RLS-hidden conflicting alias.
    const claimed = missingAliases.length === 0
      ? visibleBefore
      : await tx.googlePurchaseAlias.findMany({
          where: { tokenDigest: { in: aliases } },
        });
    if (
      claimed.length !== aliases.length
      || claimed.some((alias) => !activeAliasMatches(
        alias,
        rootOwner.tenantId!,
        rootIdentity,
        rootOwner.mobileSubscriptionId!,
      ))
    ) {
      throw googleOwnershipConflict();
    }

    const updated = await tx.mobileSubscription.updateMany({
      where: {
        id: rootOwner.mobileSubscriptionId,
        tenantId: rootOwner.tenantId,
        provider: "google",
        originalTransactionId: rootIdentity,
      },
      data: updateData,
    });
    if (updated.count !== 1) throw googleOwnershipConflict();
    const subscription = await tx.mobileSubscription.findUnique({
      where: { id: rootOwner.mobileSubscriptionId },
    });
    if (!subscription || subscription.tenantId !== rootOwner.tenantId) {
      throw googleOwnershipConflict();
    }
    return subscription;
  });
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
    const planTier = catalogProduct.internalPlan;

    if (body.provider === "revenuecat") {
      // RevenueCat path — trust the SDK payload only when the shared
      // webhook secret is configured (mobile sends it in the receipt
      // as a signed envelope). Until that's wired we treat this branch
      // as not-yet-supported rather than an open hole.
      if (!env.REVENUECAT_WEBHOOK_SECRET) {
        throw new AppError(503, "RevenueCat path not configured");
      }
      throw new AppError(501, "RevenueCat verification not yet implemented");
    }
    const provider: NativeIapProvider = body.provider;
    const verified = await verifyNativeReceipt(provider, body.receipt, body.productId);

    const rejectDifferentOwner = (): never => {
      logger.warn(
        {
          identityRef: iapCredentialReference(provider, verified.originalTransactionId),
          callerTenantId: tenantId,
        },
        "IAP verify rejected — receipt belongs to a different tenant",
      );
      throw new AppError(409, "This subscription is already linked to a different account.");
    };

    const createData = {
        tenantId,
        provider,
        productId: body.productId,
        originalTransactionId: verified.originalTransactionId,
        latestReceipt: null,
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
        latestReceipt: null,
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
    let subscription;
    if (provider === "google") {
      subscription = await claimGooglePurchaseOwnership(
        tenantId,
        verified as VerifiedGoogleReceipt,
        createData,
        updateData,
      );
    } else {
      subscription = await updateSameOwner();
      if (!subscription) {
        try {
          subscription = await prisma.mobileSubscription.create({ data: createData });
        } catch (error) {
          if (!isOriginalTransactionIdUniqueConflict(error)) throw error;

          subscription = await updateSameOwner();
          if (!subscription) rejectDifferentOwner();
        }
      }
    }
    if (!subscription) throw new Error("IAP subscription ownership resolution failed");

    const providerStatus = publicProviderStatus(verified.status);
    const granting = isGrantingStatus(verified.status);
    let receiptTier = verificationResponseTier(catalogProduct);
    let reviewCaseId: string | undefined;
    if (catalogProduct.sale === "manual-review") {
      const review = await observeManualReviewCase({
        tenantId,
        actor: req.auth!.userId,
        provider,
        productId: body.productId,
        internalPlan: planTier,
        subscriptionId: subscription.id,
        providerIdentity: verified.originalTransactionId,
        providerStatus,
        expiresAt: verified.expiresAt,
        autoRenew: verified.autoRenew,
      }, granting);
      reviewCaseId = review?.caseId;
      if (review?.state !== "approved_mapping" || !review.targetTier) {
        receiptTier = null;
        if (granting) {
          if (!reviewCaseId) throw new Error("Manual review case was not persisted");
          const projection = await getEntitlementProjection(tenantId);
          res.json({
            outcome: "manual_review",
            receiptTier: null,
            effectiveTier: projection.effectiveTier,
            providerStatus,
            expiresAt: verified.expiresAt,
            reviewCaseId,
          });
          return;
        }
      } else {
        receiptTier = review.targetTier;
      }
    }

    if (!granting) {
      const terminalTier = catalogProduct.sale === "manual-review" ? receiptTier : planTier;
      if (terminalTier) {
        const terminalEvent = mapIapVerify(provider, verified, terminalTier);
        try {
          await recordEntitlementEvent({
            tenantId,
            ...(catalogProduct.sale === "manual-review"
              ? terminalEvent
              : retainInternalCatalogTier(terminalEvent, planTier)),
          });
        } catch {
          throw new AppError(503, "Entitlement persistence temporarily unavailable");
        }
      }

      const projection = await getEntitlementProjection(tenantId);
      await prisma.activityLog.create({
        data: {
          tenantId,
          actor: req.auth!.userId,
          action: "billing.iap.verified",
          resource: "mobile_subscription",
          resourceId: subscription.id,
          details: {
            provider,
            productId: body.productId,
            planTier,
            status: providerStatus,
            identityRef: iapCredentialReference(provider, verified.originalTransactionId),
          } as any,
        },
      });
      res.json({
        outcome: "inactive",
        receiptTier: null,
        effectiveTier: projection.effectiveTier,
        providerStatus,
        expiresAt: verified.expiresAt,
      });
      return;
    }

    if (!receiptTier) {
      throw new AppError(409, "Verified receipt is not eligible for entitlement");
    }

    const mappedEvent = mapIapVerify(provider, verified, receiptTier);

    let projectedPlan;
    try {
      projectedPlan = await recordEntitlementEvent({
        tenantId,
        ...(catalogProduct.sale === "manual-review"
          ? mappedEvent
          : retainInternalCatalogTier(mappedEvent, planTier)),
      });
    } catch {
      throw new AppError(503, "Entitlement persistence temporarily unavailable");
    }

    const googleVerified = provider === "google"
      ? verified as VerifiedGoogleReceipt
      : null;
    if (googleVerified?.googleAcknowledgementPending) {
      try {
        await acknowledgeGoogleReceipt(body.receipt, body.productId);
      } catch {
        throw new AppError(503, "Google purchase acknowledgement failed");
      }
    }

    await prisma.activityLog.create({
      data: {
        tenantId,
        actor: req.auth!.userId,
        action: "billing.iap.verified",
        resource: "mobile_subscription",
        resourceId: subscription.id,
        details: {
          provider,
          productId: body.productId,
          planTier,
          status: providerStatus,
          identityRef: iapCredentialReference(provider, verified.originalTransactionId),
        } as any,
      },
    });

    res.json({
      outcome: "granted",
      receiptTier,
      effectiveTier: effectiveTierFromPlan(projectedPlan),
      providerStatus,
      expiresAt: verified.expiresAt,
    });
  } catch (err) {
    if (err instanceof AppError) return next(err);
    const provider = typeof req.body?.provider === "string" ? req.body.provider : "unknown";
    const productId = typeof req.body?.productId === "string" ? req.body.productId : "unknown";
    safeVerificationFailure(provider, productId);
    next(new AppError(500, "Receipt verification failed"));
  }
});

// Mapping a historical receipt can directly grant paid access, so the
// dedicated OWNER permission executes before body parsing or service work.
iapRouter.post(
  "/manual-reviews/:caseId/decide",
  authMiddleware,
  requirePermission("billing:iap-review"),
  async (req, res, next) => {
    try {
      const body = manualReviewDecisionSchema.parse(req.body);
      const reason = validateManualReviewReason(
        body.reason,
        "receipt" in body ? [body.receipt] : [],
      );
      const tenantId = req.auth!.tenantId;
      const actor = req.auth!.userId;
      const current = await getManualReviewCase(tenantId, req.params.caseId);
      if (!current) throw new AppError(404, "Manual review case not found");

      if (body.state === "rejected") {
        const decided = await transitionManualReviewCase({
          tenantId,
          actor,
          caseId: req.params.caseId,
          state: body.state,
          reason,
        });
        res.json({ caseId: decided.caseId, state: decided.state, targetTier: decided.targetTier });
        return;
      }

      // approved_mapping and expired both require a fresh provider read. The
      // receipt stays ephemeral and is never forwarded to the review store.
      const verified = await verifyNativeReceipt(current.provider, body.receipt, current.productId);
      validateManualReviewReason(reason, [body.receipt, verified.originalTransactionId]);
      if (
        iapCredentialDigest(current.provider, verified.originalTransactionId)
        !== current.identityRef
      ) {
        throw new AppError(409, "Verified receipt does not match the review case");
      }

      if (current.provider === "google") {
        const subscription = await updateGoogleOwnedSubscription(
          verified as VerifiedGoogleReceipt,
          {
            productId: current.productId,
            planTier: current.internalPlan,
            latestReceipt: null,
            status: verified.status,
            expiresAt: verified.expiresAt,
            autoRenew: verified.autoRenew,
            lastVerifiedAt: new Date(),
          },
        );
        if (
          subscription.id !== current.subscriptionId
          || subscription.tenantId !== tenantId
          || subscription.provider !== current.provider
          || subscription.productId !== current.productId
        ) {
          throw new AppError(409, "Verified receipt ownership does not match the review case");
        }
      } else {
        const updated = await prisma.mobileSubscription.updateMany({
          where: {
            id: current.subscriptionId,
            tenantId,
            provider: current.provider,
            productId: current.productId,
            originalTransactionId: verified.originalTransactionId,
          },
          data: {
            latestReceipt: null,
            status: verified.status,
            expiresAt: verified.expiresAt,
            autoRenew: verified.autoRenew,
            lastVerifiedAt: new Date(),
          },
        });
        if (updated.count !== 1) {
          throw new AppError(409, "Verified receipt ownership does not match the review case");
        }
      }

      if (body.state === "expired") {
        if (isGrantingStatus(verified.status)) {
          throw new AppError(409, "Provider still reports an active entitlement");
        }
        const decided = await transitionManualReviewCase({
          tenantId,
          actor,
          caseId: req.params.caseId,
          state: body.state,
          reason,
        });
        res.json({ caseId: decided.caseId, state: decided.state, targetTier: decided.targetTier });
        return;
      }

      if (!isGrantingStatus(verified.status)) {
        throw new AppError(409, "Provider does not report an active entitlement");
      }

      const decided = await transitionManualReviewCase({
        tenantId,
        actor,
        caseId: req.params.caseId,
        state: body.state,
        targetTier: body.targetTier,
        reason,
      });
      const mappedEvent = mapIapVerify(current.provider, verified, body.targetTier);
      if (!mappedEvent) throw new AppError(409, "Verified receipt is not eligible for entitlement");

      let projectedPlan;
      try {
        projectedPlan = await recordEntitlementEvent({ tenantId, ...mappedEvent });
      } catch {
        throw new AppError(503, "Entitlement persistence temporarily unavailable");
      }

      if (
        current.provider === "google"
        && (verified as VerifiedGoogleReceipt).googleAcknowledgementPending
      ) {
        try {
          await acknowledgeGoogleReceipt(body.receipt, current.productId);
        } catch {
          throw new AppError(503, "Google purchase acknowledgement failed");
        }
      }

      res.json({
        caseId: decided.caseId,
        state: decided.state,
        targetTier: decided.targetTier,
        effectiveTier: effectiveTierFromPlan(projectedPlan),
      });
    } catch (err) {
      if (err instanceof AppError) return next(err);
      safeVerificationFailure("manual-review", req.params.caseId ?? "unknown");
      next(new AppError(500, "Manual review decision failed"));
    }
  },
);

// GET /api/v1/billing/iap/entitlement — current mobile entitlement
//
// Mobile reads this on launch to render the right plan badge / decide
// whether to surface the upgrade CTA. Web reads the same row in
// /users/me to drive plan-gating across the app.
iapRouter.get("/entitlement", authMiddleware, iapEntitlementRateLimit, async (req, res, next) => {
  try {
    const tenantId = req.auth!.tenantId;
    const [projection, hasPendingManualReview] = await Promise.all([
      getEntitlementProjection(tenantId),
      hasPendingManualReviewCases(tenantId),
    ]);

    res.json({
      hasActiveMobileSubscription: projection.effectiveTier !== null,
      planTier: projection.effectiveTier,
      effectiveTier: projection.effectiveTier,
      expiresAt: projection.expiresAt ?? projection.winner?.expiresAt ?? null,
      provider: projection.source ?? projection.winner?.source ?? null,
      autoRenew: projection.autoRenew ?? projection.winner?.autoRenew ?? null,
      hasManualReview: projection.hasManualReview || hasPendingManualReview,
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
type AppleNotification = Awaited<ReturnType<typeof parseAppleNotification>>;
type GoogleNotification = GoogleSubscriptionNotification;

function providerFailure(error: unknown, provider: "APPLE" | "GOOGLE"): never {
  if (error instanceof AppError && (error.statusCode === 400 || error.statusCode === 401)) {
    throw new IapPoisonDeliveryError(`${provider}_PROVIDER_REJECTED`);
  }
  throw new IapTransientDeliveryError(`${provider}_PROVIDER_UNAVAILABLE`);
}

async function applyAppleReliable(note: AppleNotification): Promise<void> {
  let verified: Awaited<ReturnType<typeof verifyAppleReceipt>>;
  try {
    verified = await verifyAppleReceipt(note.originalTransactionId, note.productId);
  } catch (error) {
    providerFailure(error, "APPLE");
  }

  const catalogProduct = getIapProduct(note.productId);
  if (!catalogProduct) {
    throw new IapPoisonDeliveryError("APPLE_PRODUCT_UNKNOWN");
  }
  const catalogTier = catalogProduct.internalPlan;

  let updated;
  try {
    updated = await prisma.mobileSubscription.update({
      where: { originalTransactionId: verified.originalTransactionId },
      data: {
        latestReceipt: null,
        status: verified.status,
        expiresAt: verified.expiresAt,
        autoRenew: verified.autoRenew,
        lastVerifiedAt: new Date(),
      },
    });
  } catch {
    throw new IapTransientDeliveryError("APPLE_PERSISTENCE_FAILED");
  }

  if (catalogProduct.sale === "manual-review") {
    const reviewInput = {
      tenantId: updated.tenantId,
      actor: "apple-asn",
      provider: "apple" as const,
      productId: note.productId,
      internalPlan: catalogTier,
      subscriptionId: updated.id,
      providerIdentity: verified.originalTransactionId,
      providerStatus: publicProviderStatus(verified.status),
      expiresAt: verified.expiresAt,
      autoRenew: verified.autoRenew,
    };
    const review = await observeManualReviewCase(
      reviewInput,
      isGrantingStatus(verified.status),
    );
    if (review?.state !== "approved_mapping" || !review.targetTier) return;

    try {
      await recordEntitlementEvent({
        tenantId: updated.tenantId,
        ...mapAppleNotify(note, verified, review.targetTier),
      });
      const activityId = iapActivityId("apple", note.notificationUUID);
      await prisma.activityLog.upsert({
        where: { id: activityId },
        create: {
          id: activityId,
          tenantId: updated.tenantId,
          actor: "apple-asn",
          action: "billing.iap.notification",
          resource: "mobile_subscription",
          resourceId: updated.id,
          details: {
            type: note.notificationType,
            subtype: note.subtype,
            status: verified.status,
          } as any,
        },
        update: {},
      });
    } catch {
      throw new IapTransientDeliveryError("APPLE_PERSISTENCE_FAILED");
    }
    return;
  }

  try {
    await recordEntitlementEvent({
      tenantId: updated.tenantId,
      ...retainInternalCatalogTier(mapAppleNotify(note, verified, catalogTier), catalogTier),
    });
    const activityId = iapActivityId("apple", note.notificationUUID);
    await prisma.activityLog.upsert({
      where: { id: activityId },
      create: {
        id: activityId,
        tenantId: updated.tenantId,
        actor: "apple-asn",
        action: "billing.iap.notification",
        resource: "mobile_subscription",
        resourceId: updated.id,
        details: {
          type: note.notificationType,
          subtype: note.subtype,
          status: verified.status,
        } as any,
      },
      update: {},
    });
  } catch {
    throw new IapTransientDeliveryError("APPLE_PERSISTENCE_FAILED");
  }
}

async function handleAppleReliable(req: Request, res: Response): Promise<void> {
  const signedPayload = (req.body as { signedPayload?: string })?.signedPayload;
  const rawForDigest = typeof signedPayload === "string"
    ? signedPayload
    : "apple:missing-signed-payload";
  const fingerprint = deliveryFingerprint(rawForDigest);
  let note: AppleNotification;

  try {
    if (!signedPayload || typeof signedPayload !== "string") {
      throw new IapPoisonDeliveryError("APPLE_SIGNED_PAYLOAD_MISSING");
    }
    note = await parseAppleNotification(signedPayload);
    if (!note.notificationUUID) {
      throw new IapPoisonDeliveryError("APPLE_NOTIFICATION_ID_MISSING");
    }
  } catch (error) {
    const code = error instanceof IapPoisonDeliveryError
      ? error.code
      : "APPLE_JWS_INVALID";
    const result = await processIapDelivery(
      { provider: "apple", deliveryId: `poison:${fingerprint}`, fingerprint },
      async () => {
        throw new IapPoisonDeliveryError(code);
      },
    );
    res.status(result.httpStatus).json({ ok: false, reason: code.toLowerCase() });
    return;
  }

  try {
    const identityFingerprint = deliveryFingerprint(`apple:${note.notificationUUID}`);
    const result = await processIapDelivery(
      {
        provider: "apple",
        deliveryId: note.notificationUUID,
        fingerprint: identityFingerprint,
      },
      () => applyAppleReliable(note),
      undefined,
      env.IAP_DELIVERY_MAX_ATTEMPTS,
    );
    res.status(result.httpStatus).json({ ok: true, disposition: result.disposition });
  } catch (error) {
    const code = error instanceof IapTransientDeliveryError
      ? error.code
      : "DELIVERY_RETRY_REQUIRED";
    logger.warn({ provider: "apple", code }, "IAP delivery scheduled for provider retry");
    res.status(503).json({ ok: false, reason: "retry-required" });
  }
}

iapRouter.post("/apple/notify", systemScope("webhook:iap-apple"), iapWebhookRateLimit, async (req, res) => {
  if (env.IAP_DELIVERY_RELIABILITY_ENABLED) {
    try {
      await handleAppleReliable(req, res);
    } catch {
      logger.warn(
        { provider: "apple", code: "DELIVERY_LEDGER_UNAVAILABLE" },
        "IAP delivery admission failed",
      );
      res.status(503).json({ ok: false, reason: "retry-required" });
    }
    return;
  }
  const signedPayload = (req.body as { signedPayload?: string })?.signedPayload;
  if (!signedPayload || typeof signedPayload !== "string") {
    res.status(400).json({ error: "missing signedPayload" });
    return;
  }
  let note: AppleNotification;
  try {
    // This verifies the JWS chain before any provider or database work.
    note = await parseAppleNotification(signedPayload);
  } catch {
    logger.warn({ provider: "apple", code: "APPLE_JWS_INVALID" }, "Apple notification rejected");
    res.status(200).json({ ok: false, reason: "invalid-signature" });
    return;
  }
  try {
    await applyAppleReliable(note);
    res.status(200).json({ ok: true });
  } catch (error) {
    if (error instanceof IapPoisonDeliveryError) {
      res.status(200).json({
        ok: false,
        reason: error.code === "APPLE_PRODUCT_UNKNOWN" ? "unknown-product" : "provider-rejected",
      });
      return;
    }
    const code = error instanceof IapTransientDeliveryError
      ? error.code
      : "APPLE_NOTIFICATION_PROCESSING_FAILED";
    logger.warn({ provider: "apple", code }, "Apple notification retry required");
    res.status(503).json({ ok: false, reason: "retry-required" });
  }
});

// POST /api/v1/billing/iap/google/notify
//
// Google forwards RTDN messages via a Pub/Sub push subscription. The
// envelope wraps a base64-encoded JSON body describing the change.
// We re-fetch authoritative state via verifyGoogleReceipt — the
// notification only carries `purchaseToken + notificationType`, the
// truth is behind the API.
async function applyGoogleReliable(note: GoogleNotification): Promise<void> {
  let verified: Awaited<ReturnType<typeof verifyGoogleReceipt>>;
  try {
    verified = await verifyGoogleReceipt(note.purchaseToken, note.subscriptionId);
  } catch (error) {
    providerFailure(error, "GOOGLE");
  }

  const catalogProduct = getIapProduct(note.subscriptionId);
  if (!catalogProduct) {
    throw new IapPoisonDeliveryError("GOOGLE_PRODUCT_UNKNOWN");
  }
  const catalogTier = catalogProduct.internalPlan;

  let updated;
  try {
    updated = await updateGoogleOwnedSubscription(verified, {
      latestReceipt: null,
      status: verified.status,
      expiresAt: verified.expiresAt,
      autoRenew: verified.autoRenew,
      lastVerifiedAt: new Date(),
    });
  } catch (error) {
    if (error instanceof AppError && error.statusCode === 409) {
      throw new IapPoisonDeliveryError("GOOGLE_OWNERSHIP_UNRESOLVED");
    }
    throw new IapTransientDeliveryError("GOOGLE_PERSISTENCE_FAILED");
  }

  if (catalogProduct.sale === "manual-review") {
    const reviewInput = {
      tenantId: updated.tenantId,
      actor: "google-rtdn",
      provider: "google" as const,
      productId: note.subscriptionId,
      internalPlan: catalogTier,
      subscriptionId: updated.id,
      providerIdentity: verified.originalTransactionId,
      providerStatus: publicProviderStatus(verified.status),
      expiresAt: verified.expiresAt,
      autoRenew: verified.autoRenew,
    };
    const review = await observeManualReviewCase(
      reviewInput,
      isGrantingStatus(verified.status),
    );
    if (review?.state !== "approved_mapping" || !review.targetTier) return;

    try {
      await recordEntitlementEvent({
        tenantId: updated.tenantId,
        ...mapGoogleNotify(note, verified, review.targetTier),
      });
      const activityId = iapActivityId("google", note.messageId);
      await prisma.activityLog.upsert({
        where: { id: activityId },
        create: {
          id: activityId,
          tenantId: updated.tenantId,
          actor: "google-rtdn",
          action: "billing.iap.notification",
          resource: "mobile_subscription",
          resourceId: updated.id,
          details: { type: note.notificationType, status: verified.status } as any,
        },
        update: {},
      });
    } catch {
      throw new IapTransientDeliveryError("GOOGLE_PERSISTENCE_FAILED");
    }
    if (verified.googleAcknowledgementPending) {
      try {
        await acknowledgeGoogleReceipt(note.purchaseToken, note.subscriptionId);
      } catch {
        throw new IapTransientDeliveryError("GOOGLE_ACKNOWLEDGEMENT_FAILED");
      }
    }
    return;
  }

  try {
    await recordEntitlementEvent({
      tenantId: updated.tenantId,
      ...retainInternalCatalogTier(mapGoogleNotify(note, verified, catalogTier), catalogTier),
    });
    const activityId = iapActivityId("google", note.messageId);
    await prisma.activityLog.upsert({
      where: { id: activityId },
      create: {
        id: activityId,
        tenantId: updated.tenantId,
        actor: "google-rtdn",
        action: "billing.iap.notification",
        resource: "mobile_subscription",
        resourceId: updated.id,
        details: { type: note.notificationType, status: verified.status } as any,
      },
      update: {},
    });
  } catch {
    throw new IapTransientDeliveryError("GOOGLE_PERSISTENCE_FAILED");
  }
  if (verified.googleAcknowledgementPending) {
    try {
      await acknowledgeGoogleReceipt(note.purchaseToken, note.subscriptionId);
    } catch {
      throw new IapTransientDeliveryError("GOOGLE_ACKNOWLEDGEMENT_FAILED");
    }
  }
}

function googleEnvelopeMessageId(body: unknown): string | null {
  const value = (body as { message?: { messageId?: unknown } })?.message?.messageId;
  return typeof value === "string" && value.length > 0 && value.length <= 256
    ? value
    : null;
}

async function handleGoogleReliable(req: Request, res: Response): Promise<void> {
  const rawForDigest = JSON.stringify(req.body ?? null);
  const fingerprint = deliveryFingerprint(rawForDigest);
  const parsed = parseGoogleRtdnEnvelope(req.body);
  const sourceMessageId = googleEnvelopeMessageId(req.body);
  const sourceFingerprint = sourceMessageId
    ? deliveryFingerprint(`google:${sourceMessageId}`)
    : fingerprint;

  if (!parsed || !sourceMessageId) {
    const result = await processIapDelivery(
      {
        provider: "google",
        deliveryId: sourceMessageId ?? `poison:${fingerprint}`,
        fingerprint: sourceFingerprint,
      },
      async () => {
        throw new IapPoisonDeliveryError(
          parsed ? "GOOGLE_MESSAGE_ID_MISSING" : "GOOGLE_ENVELOPE_INVALID",
        );
      },
    );
    res.status(result.httpStatus).json({ ok: false, reason: "envelope-not-recognised" });
    return;
  }

  if (env.GOOGLE_PLAY_PACKAGE_NAME && parsed.packageName !== env.GOOGLE_PLAY_PACKAGE_NAME) {
    const result = await processIapDelivery(
      { provider: "google", deliveryId: sourceMessageId, fingerprint: sourceFingerprint },
      async () => {
        throw new IapPoisonDeliveryError("GOOGLE_PACKAGE_MISMATCH");
      },
    );
    res.status(result.httpStatus).json({ ok: false, reason: "package-mismatch" });
    return;
  }

  if (parsed.kind === "test") {
    try {
      const result = await processIapDelivery(
        {
          provider: "google",
          deliveryId: parsed.messageId,
          fingerprint: deliveryFingerprint(`google:${parsed.messageId}`),
        },
        async () => undefined,
        undefined,
        env.IAP_DELIVERY_MAX_ATTEMPTS,
      );
      res.status(result.httpStatus).json({ ok: true, disposition: result.disposition });
    } catch {
      res.status(503).json({ ok: false, reason: "retry-required" });
    }
    return;
  }

  try {
    const identityFingerprint = deliveryFingerprint(`google:${parsed.messageId}`);
    const result = await processIapDelivery(
      {
        provider: "google",
        deliveryId: parsed.messageId,
        fingerprint: identityFingerprint,
      },
      () => applyGoogleReliable(parsed),
      undefined,
      env.IAP_DELIVERY_MAX_ATTEMPTS,
    );
    res.status(result.httpStatus).json({ ok: true, disposition: result.disposition });
  } catch (error) {
    const code = error instanceof IapTransientDeliveryError
      ? error.code
      : "DELIVERY_RETRY_REQUIRED";
    logger.warn({ provider: "google", code }, "IAP delivery scheduled for provider retry");
    res.status(503).json({ ok: false, reason: "retry-required" });
  }
}

iapRouter.post("/google/notify", systemScope("webhook:iap-google"), iapWebhookRateLimit, async (req, res) => {
  // Authenticate once, before the delivery-mode branch. Both the legacy and
  // durable-ledger paths therefore share the same fail-closed boundary and no
  // envelope, provider or persistence work can run after an OIDC rejection.
  const oidc = await verifyPubSubPushToken(req.headers.authorization);
  if (!oidc.ok) {
    logger.warn({ provider: "google", code: oidc.reason }, "Google RTDN OIDC rejected");
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  if (env.IAP_DELIVERY_RELIABILITY_ENABLED) {
    try {
      await handleGoogleReliable(req, res);
    } catch {
      logger.warn(
        { provider: "google", code: "DELIVERY_LEDGER_UNAVAILABLE" },
        "IAP delivery admission failed",
      );
      res.status(503).json({ ok: false, reason: "retry-required" });
    }
    return;
  }
  let parsed;
  try {
    parsed = parseGoogleRtdnEnvelope(req.body);
  } catch {
    parsed = null;
  }
  if (!parsed) {
    res.status(200).json({ ok: false, reason: "envelope-not-recognised" });
    return;
  }
  if (parsed.kind === "test") {
    res.status(200).json({ ok: true, disposition: "test" });
    return;
  }
  try {
    await applyGoogleReliable(parsed);
    res.status(200).json({ ok: true });
  } catch (error) {
    if (error instanceof IapPoisonDeliveryError) {
      res.status(200).json({
        ok: false,
        reason: error.code === "GOOGLE_PRODUCT_UNKNOWN"
          ? "unknown-product"
          : "ownership-unresolved",
      });
      return;
    }
    const code = error instanceof IapTransientDeliveryError
      ? error.code
      : "GOOGLE_NOTIFICATION_PROCESSING_FAILED";
    logger.warn({ provider: "google", code }, "Google notification retry required");
    res.status(503).json({ ok: false, reason: "retry-required" });
  }
});
