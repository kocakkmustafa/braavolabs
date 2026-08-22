/**
 * Apple App Store Server API receipt verification.
 *
 * StoreKit 2 path (recommended). The mobile app obtains a transactionId
 * from `Transaction.currentEntitlements`, posts it to
 * /api/v1/billing/iap/verify with `provider: "apple"`, and we call:
 *
 *   GET https://api.storekit.itunes.apple.com/inApps/v1/transactions/{transactionId}
 *
 * with a JWT signed by the App Store Connect API key. The response is a
 * JWS (JSON Web Signature) blob whose payload contains the canonical
 * transaction record. We DO NOT trust the mobile-supplied receipt body —
 * only the JWS payload matters; the receipt parameter is what we got
 * from RevenueCat / native StoreKit2 on the client and we treat it as
 * the transactionId.
 *
 * The legacy /verifyReceipt path (pre-StoreKit2 builds, APPLE_SHARED_SECRET)
 * is kept as a fallback when APPLE_ISSUER_ID is missing — that endpoint
 * is officially deprecated but still serves apps not yet migrated.
 */

import jwt from "jsonwebtoken";
import { AppError } from "../../../middleware/error";
import { env } from "../../../config/env";
import { logger } from "../../../lib/logger";
import { verifyAppleJws, JwsVerificationError, type VerifyJwsOptions } from "./jws";
import { PermanentIapDeliveryError } from "./delivery-ledger";

export interface VerifiedReceipt {
  originalTransactionId: string;
  status: "active" | "in_grace_period" | "expired" | "revoked" | "paused";
  startedAt: Date;
  expiresAt: Date;
  autoRenew: boolean;
}

const PRODUCTION_BASE = "https://api.storekit.itunes.apple.com";
const SANDBOX_BASE = "https://api.storekit-sandbox.itunes.apple.com";

/**
 * Sign a short-lived ES256 JWT for the App Store Server API.
 * Apple caps `exp` at 60 minutes from `iat`; we use 5 minutes so a
 * leaked token is useless almost immediately. The kid header points at
 * the API key and `bid` claim binds the token to our bundleId.
 *
 * Key TYPE matters: APPLE_PRIVATE_KEY/APPLE_KEY_ID must be an
 * In-App Purchase key (App Store Connect → Users and Access →
 * Integrations → In-App Purchase). A general App Store Connect API
 * key is a different key type — the App Store Server API answers
 * it with 401 Unauthorized even though the JWT itself is valid.
 */
function signAppStoreJwt(): string {
  if (!env.APPLE_ISSUER_ID || !env.APPLE_KEY_ID || !env.APPLE_PRIVATE_KEY || !env.APPLE_BUNDLE_ID) {
    throw new AppError(503, "Apple App Store Server API not configured");
  }
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      iss: env.APPLE_ISSUER_ID,
      iat: now,
      exp: now + 300,
      aud: "appstoreconnect-v1",
      bid: env.APPLE_BUNDLE_ID,
    },
    env.APPLE_PRIVATE_KEY,
    {
      algorithm: "ES256",
      header: { alg: "ES256", kid: env.APPLE_KEY_ID, typ: "JWT" },
    },
  );
}

/**
 * Apple JWS payloads come back as `header.payload.signature` strings.
 * For verification of trust we'd validate the signature against Apple's
 * x5c chain; for read-only consumption of our OWN transaction lookup
 * we parse the payload directly — it's signed by Apple, the integrity
 * of the response we made is what HTTPS already guarantees.
 *
 * Returning unknown so the caller can pull strongly-typed fields out.
 */
function decodeJws(jws: string): Record<string, unknown> {
  const parts = jws.split(".");
  if (parts.length !== 3) throw new Error("Invalid JWS shape");
  const payloadB64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const padding = payloadB64.length % 4 === 0 ? "" : "=".repeat(4 - (payloadB64.length % 4));
  const json = Buffer.from(payloadB64 + padding, "base64").toString("utf8");
  return JSON.parse(json) as Record<string, unknown>;
}

/**
 * Apple's subscription status enum (lastTransactions[0].status):
 *   1 = Active
 *   2 = Expired
 *   3 = In Billing Retry Period   (treated as in_grace_period — user
 *                                   still has access while Apple retries)
 *   4 = In Billing Grace Period
 *   5 = Revoked                    (refund / family-share removal)
 */
function mapAppleStatus(code: number, expiresAt: Date): VerifiedReceipt["status"] {
  if (code === 5) return "revoked";
  if (code === 1) return "active";
  if (code === 3 || code === 4) return "in_grace_period";
  if (expiresAt.getTime() < Date.now()) return "expired";
  return "expired";
}

interface AppleSubscriptionResponse {
  data?: Array<{
    subscriptionGroupIdentifier: string;
    lastTransactions: Array<{
      originalTransactionId: string;
      status: number;
      signedTransactionInfo: string;
      signedRenewalInfo: string;
    }>;
  }>;
}

interface AppleTransactionPayload {
  originalTransactionId: string;
  productId: string;
  purchaseDate: number;
  originalPurchaseDate: number;
  expiresDate?: number;
  type?: string;
  environment?: "Production" | "Sandbox";
}

interface AppleRenewalPayload {
  autoRenewStatus?: 0 | 1;
  expirationIntent?: number;
  recentSubscriptionStartDate?: number;
}

async function callAppleSubscriptionApi(
  transactionId: string,
  base: string,
): Promise<AppleSubscriptionResponse | null> {
  const token = signAppStoreJwt();
  const res = await fetch(`${base}/inApps/v1/subscriptions/${encodeURIComponent(transactionId)}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
  // 404 in production usually means the receipt belongs to sandbox —
  // caller retries against sandbox base.
  if (res.status === 404) return null;
  if (!res.ok) {
    // Provider response bodies may contain signed transaction material. Keep
    // them out of logs; status + environment is sufficient for operations.
    logger.error(
      { status: res.status, environment: base === SANDBOX_BASE ? "sandbox" : "production" },
      "Apple subscription lookup failed",
    );
    throw new AppError(502, `Apple subscription lookup failed: ${res.status}`);
  }
  return res.json() as Promise<AppleSubscriptionResponse>;
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

  if (hasServerApi) {
    // The "receipt" parameter is the StoreKit2 transactionId (or the
    // RevenueCat-forwarded equivalent). Apple recommends production
    // first, then sandbox on 404 — sandbox transactions live on the
    // sandbox base, and we don't always know which environment the
    // mobile build pointed at.
    let resp = await callAppleSubscriptionApi(receipt, PRODUCTION_BASE);
    if (!resp) {
      resp = await callAppleSubscriptionApi(receipt, SANDBOX_BASE);
    }
    if (!resp || !resp.data || resp.data.length === 0) {
      throw new AppError(404, "Apple did not return a subscription record for that transaction");
    }

    // The mobile app could in theory ship a transactionId from a
    // different productId — verify the response actually matches the
    // tier the caller is requesting.
    const group = resp.data[0];
    const last = group.lastTransactions?.[0];
    if (!last) throw new AppError(404, "Apple subscription has no recent transactions");

    const tx = decodeJws(last.signedTransactionInfo) as unknown as AppleTransactionPayload;
    const renewal = decodeJws(last.signedRenewalInfo) as unknown as AppleRenewalPayload;

    if (tx.productId !== productId) {
      throw new PermanentIapDeliveryError(
        "provider-rejected-payload",
        "Apple receipt product does not match the requested product",
      );
    }

    const expiresAt = new Date(tx.expiresDate ?? Date.now());
    const startedAt = new Date(tx.originalPurchaseDate);
    return {
      originalTransactionId: tx.originalTransactionId,
      status: mapAppleStatus(last.status, expiresAt),
      startedAt,
      expiresAt,
      autoRenew: renewal.autoRenewStatus === 1,
    };
  }

  // Legacy /verifyReceipt path. The "receipt" parameter is a base64
  // receipt blob from `Bundle.main.appStoreReceiptURL`. Apple wants
  // production tried first, then sandbox on status 21007.
  const verify = async (base: string) => {
    const res = await fetch(`${base}/verifyReceipt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        "receipt-data": receipt,
        password: env.APPLE_SHARED_SECRET,
        "exclude-old-transactions": true,
      }),
    });
    return res.json() as Promise<{
      status: number;
      latest_receipt_info?: Array<{
        original_transaction_id: string;
        product_id: string;
        purchase_date_ms: string;
        expires_date_ms: string;
      }>;
      pending_renewal_info?: Array<{ auto_renew_status: string }>;
    }>;
  };

  let body = await verify("https://buy.itunes.apple.com");
  if (body.status === 21007) {
    body = await verify("https://sandbox.itunes.apple.com");
  }
  if (body.status !== 0 || !body.latest_receipt_info?.length) {
    throw new PermanentIapDeliveryError(
      "provider-rejected-payload",
      `Apple rejected the receipt with status ${body.status}`,
    );
  }
  const latest = body.latest_receipt_info[body.latest_receipt_info.length - 1];
  if (latest.product_id !== productId) {
    throw new PermanentIapDeliveryError(
      "provider-rejected-payload",
      "Apple receipt product does not match the requested product",
    );
  }
  const expiresAt = new Date(parseInt(latest.expires_date_ms, 10));
  const startedAt = new Date(parseInt(latest.purchase_date_ms, 10));
  const autoRenew = body.pending_renewal_info?.[0]?.auto_renew_status === "1";
  return {
    originalTransactionId: latest.original_transaction_id,
    status: expiresAt.getTime() > Date.now() ? "active" : "expired",
    startedAt,
    expiresAt,
    autoRenew,
  };
}

/**
 * Verify an App Store Server Notifications V2 webhook payload. Apple
 * POSTs a signed JWS to our notify endpoint on every renewal /
 * cancellation / refund. The JWS structure mirrors the one returned by
 * the Server API, so we reuse decodeJws.
 *
 * Returns the canonicalised subscription state for the upsert path.
 */
export async function parseAppleNotification(
  signedPayload: string,
  opts?: VerifyJwsOptions,
): Promise<{
  notificationType: string;
  subtype?: string;
  originalTransactionId: string;
  productId: string;
  expiresAt: Date;
  status: VerifiedReceipt["status"];
  autoRenew: boolean;
  /** Apple's own per-delivery id (top-level `notificationUUID` in the
   * decoded payload) — the entitlement ledger's dedup key. NOT the same
   * thing as originalTransactionId (which identifies the SUBSCRIPTION,
   * not this delivery) — a redelivery of the same notification carries
   * the same notificationUUID, which is exactly what makes it dedupe. */
  notificationUUID: string;
  /** When Apple signed this notification — the ledger's ordering key.
   * Distinct from "when we received it", same principle as Stripe's
   * event.created. */
  signedDate: Date;
}> {
  // FINDINGS C1 — this payload arrives at the UNAUTHENTICATED notify
  // endpoint, so we MUST verify Apple's signature (x5c chain → Apple Root
  // CA - G3) before trusting any field. Verify the outer JWS and each
  // nested signed blob; reject forged/replayed payloads with a 401.
  let payload: Record<string, unknown> & {
    notificationType?: string;
    subtype?: string;
    notificationUUID?: string;
    signedDate?: number;
    data?: { signedTransactionInfo?: string; signedRenewalInfo?: string };
  };
  try {
    payload = await verifyAppleJws(signedPayload, opts);
  } catch (err) {
    if (err instanceof JwsVerificationError) {
      throw new PermanentIapDeliveryError(
        "invalid-payload",
        "Apple notification signature is invalid",
        401,
      );
    }
    throw err;
  }
  const tx = payload.data?.signedTransactionInfo
    ? ((await verifyAppleJws(payload.data.signedTransactionInfo, opts)) as unknown as AppleTransactionPayload)
    : null;
  const renewal = payload.data?.signedRenewalInfo
    ? ((await verifyAppleJws(payload.data.signedRenewalInfo, opts)) as unknown as AppleRenewalPayload)
    : null;
  if (!tx) {
    throw new PermanentIapDeliveryError(
      "invalid-payload",
      "Apple notification is missing its transaction payload",
    );
  }
  if (
    !tx.originalTransactionId
    || !tx.productId
    || typeof payload.notificationUUID !== "string"
    || payload.notificationUUID.length === 0
    || typeof payload.signedDate !== "number"
    || !Number.isFinite(payload.signedDate)
  ) {
    throw new PermanentIapDeliveryError(
      "invalid-payload",
      "Apple notification is missing required delivery identity fields",
    );
  }

  const expiresAt = new Date(tx.expiresDate ?? Date.now());
  const signedDate = new Date(payload.signedDate);
  if (!Number.isFinite(expiresAt.getTime()) || !Number.isFinite(signedDate.getTime())) {
    throw new PermanentIapDeliveryError(
      "invalid-payload",
      "Apple notification contains an invalid timestamp",
    );
  }
  const notificationType = String(payload.notificationType ?? "UNKNOWN");
  let status: VerifiedReceipt["status"] = "active";
  if (notificationType === "EXPIRED" || notificationType === "GRACE_PERIOD_EXPIRED") status = "expired";
  else if (notificationType === "REFUND" || notificationType === "REVOKE") status = "revoked";
  else if (notificationType === "GRACE_PERIOD") status = "in_grace_period";

  return {
    notificationType,
    subtype: payload.subtype as string | undefined,
    originalTransactionId: tx.originalTransactionId,
    productId: tx.productId,
    expiresAt,
    status,
    autoRenew: renewal?.autoRenewStatus === 1,
    notificationUUID: payload.notificationUUID,
    signedDate,
  };
}
