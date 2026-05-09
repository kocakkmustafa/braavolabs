/**
 * Google Play Developer API subscription verification.
 *
 * Operator wires GOOGLE_PLAY_SERVICE_ACCOUNT_JSON (base64-encoded service
 * account credentials) and GOOGLE_PLAY_PACKAGE_NAME. The service account
 * needs the "View financial data" + "Manage orders and subscriptions"
 * roles in Play Console. The verifier then calls:
 *
 *   GET https://androidpublisher.googleapis.com/androidpublisher/v3/applications/{packageName}/purchases/subscriptionsv2/tokens/{token}
 *
 * Real-time renewals come via Google's Real-Time Developer Notifications
 * (RTDN) — Pub/Sub messages forwarded to /api/v1/billing/iap/google/notify.
 *
 * Until credentials are configured the function 503s rather than
 * silently returning fabricated entitlement; the caller surfaces the
 * status so the mobile UI shows "purchase pending verification" copy
 * instead of upgrading the user prematurely.
 */

import { AppError } from "../../../middleware/error";
import { env } from "../../../config/env";
import type { VerifiedReceipt } from "./apple";

export async function verifyGoogleReceipt(
  purchaseToken: string,
  productId: string,
): Promise<VerifiedReceipt> {
  if (!env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON || !env.GOOGLE_PLAY_PACKAGE_NAME) {
    throw new AppError(
      503,
      "Google Play receipt verification not configured. See docs/manual-tasks.md → Mobile IAP credentials.",
    );
  }

  // TODO(IAP-3): wire the real verification call.
  //   1. Decode base64 service account JSON, exchange for an OAuth2 access token
  //      (https://oauth2.googleapis.com/token, scope:
  //       https://www.googleapis.com/auth/androidpublisher).
  //   2. GET subscriptionsv2/tokens/{purchaseToken} — response contains
  //      lineItems[].productId, lineItems[].expiryTime, autoRenewingPlan,
  //      subscriptionState ("SUBSCRIPTION_STATE_ACTIVE" / "_IN_GRACE_PERIOD" / "_EXPIRED" / etc).
  //   3. Map to the VerifiedReceipt contract:
  //        originalTransactionId  ← linkedPurchaseToken (or token if first)
  //        status                 ← case-folded subscriptionState
  //        startedAt              ← startTime
  //        expiresAt              ← lineItems[0].expiryTime
  //        autoRenew              ← autoRenewingPlan != null
  //   4. Acknowledge the purchase if `acknowledgementState !== ACKNOWLEDGED`
  //      (otherwise Play voids the purchase after 3 days).
  void purchaseToken;
  void productId;
  throw new AppError(501, "Google Play receipt verification implementation pending");
}
