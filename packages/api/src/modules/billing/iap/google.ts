/**
 * Google Play Developer API subscription verification.
 *
 * The mobile app posts the purchase token (returned by the StoreKit2
 * equivalent on Android: BillingClient → Purchase.purchaseToken) to
 * /api/v1/billing/iap/verify with `provider: "google"`. We exchange
 * the service-account credentials for an OAuth2 access token and call:
 *
 *   GET https://androidpublisher.googleapis.com/androidpublisher/v3/applications/{packageName}/purchases/subscriptionsv2/tokens/{token}
 *
 * subscriptionsV2 is the modern endpoint — the legacy /subscriptions
 * path is in long-term maintenance. The response describes the entire
 * subscription chain (acknowledgementState, lineItems with expiry,
 * autoRenewingPlan, subscriptionState).
 *
 * If acknowledgementState !== ACKNOWLEDGED we acknowledge the purchase
 * here — Play voids unacknowledged purchases after 3 days. The client
 * already does this for normal flows, but our backend acknowledging
 * is defence-in-depth (and required when the mobile path involves
 * RevenueCat which doesn't always touch Play directly).
 */

import { JWT } from "google-auth-library";
import { AppError } from "../../../middleware/error";
import { env } from "../../../config/env";
import { logger } from "../../../lib/logger";
import type { VerifiedReceipt } from "./apple";

interface GoogleSubscriptionV2 {
  kind?: string;
  regionCode?: string;
  lineItems?: Array<{
    productId: string;
    expiryTime: string;
    autoRenewingPlan?: { autoRenewEnabled?: boolean };
    prepaidPlan?: unknown;
    offerDetails?: { basePlanId?: string; offerId?: string };
  }>;
  startTime?: string;
  subscriptionState?: string;
  linkedPurchaseToken?: string;
  acknowledgementState?: "ACKNOWLEDGEMENT_STATE_PENDING" | "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED";
  pausedStateContext?: { autoResumeTime: string };
  canceledStateContext?: unknown;
  externalAccountIdentifiers?: { obfuscatedExternalAccountId?: string };
}

const GOOGLE_API_BASE = "https://androidpublisher.googleapis.com/androidpublisher/v3";

/**
 * Cache the JWT auth client across requests — instantiating a new one
 * per /verify call wasted ~80ms generating the OAuth2 round-trip.
 * google-auth-library handles refresh internally so a single client
 * survives until the access token's natural expiry.
 */
let cachedAuth: JWT | null = null;

function getAuth(): JWT {
  if (cachedAuth) return cachedAuth;
  if (!env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON) {
    throw new AppError(503, "Google Play service account not configured");
  }
  let credentials: { client_email: string; private_key: string };
  try {
    const decoded = Buffer.from(env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON, "base64").toString("utf8");
    credentials = JSON.parse(decoded);
  } catch (err) {
    throw new AppError(
      503,
      `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON could not be decoded: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  cachedAuth = new JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ["https://www.googleapis.com/auth/androidpublisher"],
  });
  return cachedAuth;
}

/**
 * Map Google's subscriptionState enum to our internal status enum.
 * SUBSCRIPTION_STATE_ON_HOLD is treated like in_grace_period because
 * Play continues to consider the user "having access" while it
 * retries billing.
 */
function mapGoogleStatus(state: string | undefined, expiresAt: Date): VerifiedReceipt["status"] {
  if (state === "SUBSCRIPTION_STATE_ACTIVE") return "active";
  if (state === "SUBSCRIPTION_STATE_IN_GRACE_PERIOD" || state === "SUBSCRIPTION_STATE_ON_HOLD")
    return "in_grace_period";
  if (state === "SUBSCRIPTION_STATE_PAUSED") return "paused";
  if (state === "SUBSCRIPTION_STATE_CANCELED" || state === "SUBSCRIPTION_STATE_EXPIRED") {
    return expiresAt.getTime() > Date.now() ? "active" : "expired";
  }
  return "expired";
}

async function callGoogleApi(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const auth = getAuth();
  const accessToken = await auth.getAccessToken();
  if (!accessToken) throw new AppError(503, "Could not obtain Google API access token");
  return fetch(`${GOOGLE_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
}

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

  const path = `/applications/${encodeURIComponent(env.GOOGLE_PLAY_PACKAGE_NAME)}/purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`;
  const res = await callGoogleApi(path);

  if (res.status === 410) {
    // Token has been replaced by a renewal — Play wants us to follow
    // linkedPurchaseToken on the previous record. Surface as expired
    // for now; the upsert keys on originalTransactionId so a separate
    // /verify call with the new token will heal the row.
    throw new AppError(410, "Purchase token has been superseded by a renewal");
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    logger.error({ status: res.status, body }, "Google subscription lookup failed");
    throw new AppError(502, `Google subscription lookup failed: ${res.status}`);
  }

  const sub = (await res.json()) as GoogleSubscriptionV2;
  const item = sub.lineItems?.[0];
  if (!item) throw new AppError(404, "Google subscription has no line items");

  if (item.productId !== productId) {
    throw new AppError(
      400,
      `Receipt productId (${item.productId}) does not match requested productId (${productId})`,
    );
  }

  const expiresAt = new Date(item.expiryTime);
  const startedAt = sub.startTime ? new Date(sub.startTime) : new Date();
  const autoRenew = !!item.autoRenewingPlan?.autoRenewEnabled;
  const status = mapGoogleStatus(sub.subscriptionState, expiresAt);

  // Acknowledge if Play still considers it pending acknowledgement.
  // Failure here is non-fatal — we already captured entitlement; the
  // background job can retry later.
  if (sub.acknowledgementState === "ACKNOWLEDGEMENT_STATE_PENDING") {
    void callGoogleApi(
      `/applications/${encodeURIComponent(env.GOOGLE_PLAY_PACKAGE_NAME)}/purchases/subscriptions/${encodeURIComponent(item.productId)}/tokens/${encodeURIComponent(purchaseToken)}:acknowledge`,
      { method: "POST", body: JSON.stringify({}) },
    ).catch((err) => logger.warn({ err: err instanceof Error ? err.message : err }, "Google ack failed"));
  }

  // linkedPurchaseToken is the previous token in the renewal chain;
  // when present we return it as the "original" so the upsert key is
  // stable across renewals. When absent, the current purchaseToken IS
  // the chain root.
  return {
    originalTransactionId: sub.linkedPurchaseToken ?? purchaseToken,
    status,
    startedAt,
    expiresAt,
    autoRenew,
  };
}

/**
 * Parse a Google Real-Time Developer Notification (RTDN) message.
 * Pub/Sub forwards JSON like:
 *   {
 *     "message": {
 *       "data": "<base64-encoded JSON>",
 *       "messageId": "...",
 *       "publishTime": "..."
 *     }
 *   }
 *
 * The decoded `data` describes the subscription notification (or a
 * test/oneTimeProduct/voidedPurchase variant). We re-fetch the full
 * subscription state via verifyGoogleReceipt rather than trusting the
 * notification body, because the body only carries a minimal envelope
 * and the actual state lives behind the API.
 */
export function parseGoogleRtdnEnvelope(envelope: unknown): {
  packageName: string;
  notificationType: number;
  purchaseToken: string;
  subscriptionId: string;
} | null {
  const msg = (envelope as { message?: { data?: string } })?.message;
  if (!msg?.data) return null;
  let parsed: {
    packageName?: string;
    subscriptionNotification?: {
      notificationType?: number;
      purchaseToken?: string;
      subscriptionId?: string;
    };
  };
  try {
    parsed = JSON.parse(Buffer.from(msg.data, "base64").toString("utf8"));
  } catch {
    return null;
  }
  if (!parsed.subscriptionNotification) return null;
  const { notificationType, purchaseToken, subscriptionId } = parsed.subscriptionNotification;
  if (!purchaseToken || !subscriptionId || notificationType === undefined) return null;
  return {
    packageName: parsed.packageName ?? env.GOOGLE_PLAY_PACKAGE_NAME ?? "",
    notificationType,
    purchaseToken,
    subscriptionId,
  };
}
