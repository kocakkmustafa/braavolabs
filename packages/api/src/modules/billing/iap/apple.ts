/**
 * Apple App Store receipt verification.
 *
 * Two paths the operator can wire:
 *   1. App Store Server API (recommended, JWT auth) — set
 *      APPLE_ISSUER_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY (PEM), and
 *      APPLE_BUNDLE_ID. Endpoint: api.storekit.itunes.apple.com.
 *   2. Legacy verifyReceipt endpoint — set APPLE_SHARED_SECRET. Apple
 *      has signalled deprecation (post-iOS 17) but it still works for
 *      apps not yet on StoreKit2 — fine as a fallback.
 *
 * Until the credentials land we return a 501 from the caller; this file
 * exposes the contract so the call site stays stable.
 *
 * IMPORTANT: never grant an entitlement on a receipt this verifier
 * couldn't confirm. The mobile app cannot distinguish a real verified
 * response from a fake one — only a signed entitlement from the server
 * counts.
 */

import { AppError } from "../../../middleware/error";
import { env } from "../../../config/env";

export interface VerifiedReceipt {
  originalTransactionId: string;
  status: "active" | "in_grace_period" | "expired" | "revoked" | "paused";
  startedAt: Date;
  expiresAt: Date;
  autoRenew: boolean;
}

export async function verifyAppleReceipt(
  receipt: string,
  productId: string,
): Promise<VerifiedReceipt> {
  const hasServerApi =
    !!env.APPLE_ISSUER_ID && !!env.APPLE_KEY_ID && !!env.APPLE_PRIVATE_KEY && !!env.APPLE_BUNDLE_ID;
  const hasLegacy = !!env.APPLE_SHARED_SECRET;

  if (!hasServerApi && !hasLegacy) {
    throw new AppError(
      503,
      "Apple receipt verification not configured. See docs/manual-tasks.md → Mobile IAP credentials.",
    );
  }

  // TODO(IAP-2): wire the real verification call.
  //   Server API: POST https://api.storekit.itunes.apple.com/inApps/v1/transactions/{transactionId}
  //               with `Authorization: Bearer <signed JWT>` (ES256 signed with APPLE_PRIVATE_KEY,
  //               iss=APPLE_ISSUER_ID, kid=APPLE_KEY_ID, aud=appstoreconnect-v1, exp=now+5min).
  //   Legacy:   POST https://buy.itunes.apple.com/verifyReceipt with `{password: APPLE_SHARED_SECRET, "receipt-data": receipt}`,
  //             then fall back to https://sandbox.itunes.apple.com/verifyReceipt on status 21007.
  //   Must also subscribe to App Store Server Notifications V2 to receive renewals/cancellations
  //   without polling (webhook → /api/v1/billing/iap/apple/notify, parses signedPayload JWT).
  //
  // The unused parameters silence the linter until the implementation
  // lands; they're already in the contract callers depend on.
  void receipt;
  void productId;
  throw new AppError(501, "Apple receipt verification implementation pending");
}
