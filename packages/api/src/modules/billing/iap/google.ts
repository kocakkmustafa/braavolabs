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

import { JWT, OAuth2Client } from "google-auth-library";
import { AppError } from "../../../middleware/error";
import { env } from "../../../config/env";
import { logger } from "../../../lib/logger";
import type { VerifiedReceipt } from "./apple";
import crypto from "node:crypto";
import { getIapProduct } from "./catalog";

/**
 * FINDINGS C1 — verify the OIDC bearer token Google Pub/Sub attaches to
 * an RTDN push delivery. A push subscription configured with a service
 * account signs each delivery with a Google-issued ID token; verifying it
 * proves the request actually came from Pub/Sub (not an attacker POSTing a
 * crafted `purchaseToken`). Returns `{ ok }` plus a reason for logging.
 */
let pubsubOidcClient: OAuth2Client | null = null;

export interface PubSubOidcVerifier {
  verifyIdToken(options: { idToken: string; audience: string }): Promise<{
    getPayload(): { email?: string; email_verified?: boolean } | undefined;
  }>;
}

function getPubSubOidcVerifier(): PubSubOidcVerifier {
  pubsubOidcClient ??= new OAuth2Client();
  return pubsubOidcClient;
}

export async function verifyPubSubPushToken(
  authHeader: string | undefined,
  verifier?: PubSubOidcVerifier,
): Promise<{ ok: boolean; reason?: string }> {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return { ok: false, reason: "missing-bearer-token" };
  }
  const token = authHeader.slice(7).trim();
  if (!token) return { ok: false, reason: "empty-bearer-token" };

  const audience = env.GOOGLE_PUBSUB_AUDIENCE;
  const serviceAccountEmail = env.GOOGLE_PUBSUB_SA_EMAIL;
  if (!audience || !serviceAccountEmail) {
    return { ok: false, reason: "workload-identity-not-configured" };
  }

  try {
    const ticket = await (verifier ?? getPubSubOidcVerifier()).verifyIdToken({
      idToken: token,
      // google-auth-library validates issuer, signature, expiry and the exact
      // configured audience before returning a payload.
      audience,
    });
    const payload = ticket.getPayload();
    if (!payload) return { ok: false, reason: "no-payload" };
    if (payload.email !== serviceAccountEmail) return { ok: false, reason: "email-mismatch" };
    if (payload.email_verified !== true) return { ok: false, reason: "email-unverified" };
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: "token-verification-failed" };
  }
}

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
const MAX_GOOGLE_REPLACEMENT_HOPS = 8;

export type VerifiedGoogleReceipt = VerifiedReceipt & {
  /** Digest-only identities for every record verified in the replacement chain. */
  googlePurchaseAliases: string[];
  /** Digest of the oldest verified token in the bounded chain. */
  googleCanonicalRootIdentity: string;
  /** The current receipt may be acknowledged only after ownership commits. */
  googleAcknowledgementPending: boolean;
};

function googlePurchaseIdentity(token: string): string {
  return `google:${crypto.createHash("sha256").update(token, "utf8").digest("hex")}`;
}

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
  let credentials: { client_email?: unknown; private_key?: unknown };
  try {
    const decoded = Buffer.from(env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON, "base64").toString("utf8");
    credentials = JSON.parse(decoded);
  } catch {
    throw new AppError(503, "Google Play service account configuration is invalid");
  }
  if (
    typeof credentials.client_email !== "string"
    || credentials.client_email.length === 0
    || typeof credentials.private_key !== "string"
    || credentials.private_key.length === 0
  ) {
    throw new AppError(503, "Google Play service account configuration is invalid");
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
 * Grace retains access. Account hold and explicit expiry do not. A canceled
 * subscription remains paid only through its provider-reported period end.
 */
function mapGoogleStatus(state: string | undefined, expiresAt: Date): VerifiedReceipt["status"] {
  if (state === "SUBSCRIPTION_STATE_ACTIVE") return "active";
  if (state === "SUBSCRIPTION_STATE_IN_GRACE_PERIOD") return "in_grace_period";
  if (state === "SUBSCRIPTION_STATE_ON_HOLD") return "expired";
  if (state === "SUBSCRIPTION_STATE_PAUSED") return "paused";
  if (state === "SUBSCRIPTION_STATE_CANCELED") {
    return expiresAt.getTime() > Date.now() ? "active" : "expired";
  }
  if (state === "SUBSCRIPTION_STATE_EXPIRED") return "expired";
  return "expired";
}

async function callGoogleApi(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const auth = getAuth();
  const accessToken = await auth.getAccessToken();
  if (!accessToken) throw new AppError(503, "Could not obtain Google API access token");
  try {
    return await fetch(`${GOOGLE_API_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
  } catch {
    // Native fetch errors commonly include the complete URL. That URL embeds
    // the purchase token, so replace it at this boundary rather than letting a
    // caller log the raw cause.
    throw new AppError(502, "Google subscription service is unavailable");
  }
}

export async function verifyGoogleReceipt(
  purchaseToken: string,
  productId: string,
): Promise<VerifiedGoogleReceipt> {
  if (!env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON || !env.GOOGLE_PLAY_PACKAGE_NAME) {
    throw new AppError(
      503,
      "Google Play receipt verification not configured. See docs/manual-tasks.md → Mobile IAP credentials.",
    );
  }

  const aliases: string[] = [];
  const seen = new Set<string>();
  let token = purchaseToken;
  let currentAuthority: {
    status: VerifiedReceipt["status"];
    startedAt: Date;
    expiresAt: Date;
    autoRenew: boolean;
    acknowledgementPending: boolean;
  } | null = null;

  for (let depth = 0; depth < MAX_GOOGLE_REPLACEMENT_HOPS; depth += 1) {
    if (!token || token.length > 40_000 || seen.has(token)) {
      throw new AppError(400, "Google purchase replacement chain is invalid");
    }
    seen.add(token);

    const path = `/applications/${encodeURIComponent(env.GOOGLE_PLAY_PACKAGE_NAME)}/purchases/subscriptionsv2/tokens/${encodeURIComponent(token)}`;
    const res = await callGoogleApi(path);
    if (!res.ok) {
      await res.text().catch(() => "");
      logger.error({ status: res.status }, "Google subscription chain lookup failed");
      if (res.status === 404 || res.status === 410) {
        throw new AppError(400, "Google purchase replacement chain could not be verified");
      }
      throw new AppError(502, `Google subscription lookup failed: ${res.status}`);
    }

    const sub = (await res.json()) as GoogleSubscriptionV2;
    const item = sub.lineItems?.[0];
    if (!item) throw new AppError(400, "Google subscription chain has no line items");

    if (depth === 0) {
      if (item.productId !== productId) {
        throw new AppError(
          400,
          `Receipt productId (${item.productId}) does not match requested productId (${productId})`,
        );
      }
      const expiresAt = new Date(item.expiryTime);
      currentAuthority = {
        status: mapGoogleStatus(sub.subscriptionState, expiresAt),
        startedAt: sub.startTime ? new Date(sub.startTime) : new Date(),
        expiresAt,
        autoRenew: !!item.autoRenewingPlan?.autoRenewEnabled,
        acknowledgementPending:
          sub.acknowledgementState === "ACKNOWLEDGEMENT_STATE_PENDING",
      };
    } else if (!getIapProduct(item.productId)) {
      throw new AppError(400, "Google purchase replacement chain contains an unknown product");
    }

    aliases.push(googlePurchaseIdentity(token));
    const previousToken = sub.linkedPurchaseToken;
    if (previousToken === undefined) break;
    if (!previousToken || previousToken.length > 40_000 || seen.has(previousToken)) {
      throw new AppError(400, "Google purchase replacement chain is invalid");
    }
    if (depth === MAX_GOOGLE_REPLACEMENT_HOPS - 1) {
      throw new AppError(400, "Google purchase replacement chain exceeds the supported depth");
    }
    token = previousToken;
  }

  if (!currentAuthority || aliases.length === 0) {
    throw new AppError(400, "Google purchase replacement chain is invalid");
  }
  const canonicalRootIdentity = aliases.at(-1)!;
  return {
    originalTransactionId: canonicalRootIdentity,
    status: currentAuthority.status,
    startedAt: currentAuthority.startedAt,
    expiresAt: currentAuthority.expiresAt,
    autoRenew: currentAuthority.autoRenew,
    googlePurchaseAliases: aliases,
    googleCanonicalRootIdentity: canonicalRootIdentity,
    googleAcknowledgementPending: currentAuthority.acknowledgementPending,
  };
}

/**
 * Acknowledgement is deliberately separate from verification. Callers invoke
 * it only after the alias ownership transaction succeeds, so a rejected or
 * cross-tenant receipt cannot consume the store-side acknowledgement effect.
 */
export async function acknowledgeGoogleReceipt(
  purchaseToken: string,
  productId: string,
): Promise<void> {
  try {
    const packageName = env.GOOGLE_PLAY_PACKAGE_NAME;
    if (!packageName) throw new Error("Google Play package is not configured");
    const res = await callGoogleApi(
      `/applications/${encodeURIComponent(packageName)}/purchases/subscriptions/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}:acknowledge`,
      { method: "POST", body: JSON.stringify({}) },
    );
    if (!res.ok) throw new Error("acknowledgement rejected");
  } catch {
    logger.warn({ code: "GOOGLE_ACK_FAILED" }, "Google ack failed");
    throw new AppError(503, "Google purchase acknowledgement failed");
  }
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
export type GoogleSubscriptionNotification = {
  kind: "subscription";
  packageName: string;
  notificationType: number;
  purchaseToken: string;
  subscriptionId: string;
  /** Pub/Sub's own per-delivery message id — the entitlement ledger's
   * dedup key. A redelivery of the same publish carries the same
   * messageId, same principle as Apple's notificationUUID. */
  messageId: string;
  /** When Pub/Sub published this message — the ledger's ordering key. */
  publishTime: Date;
};

export type GoogleTestNotification = {
  kind: "test";
  packageName: string;
  messageId: string;
  publishTime: Date;
  version: string;
};

export type GoogleRtdnNotification = GoogleSubscriptionNotification | GoogleTestNotification;

export function parseGoogleRtdnEnvelope(envelope: unknown): GoogleRtdnNotification | null {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return null;
  const msg = (envelope as { message?: unknown }).message;
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return null;
  const rawMessage = msg as Record<string, unknown>;
  if (
    typeof rawMessage.data !== "string"
    || typeof rawMessage.messageId !== "string"
    || rawMessage.messageId.length < 1
    || rawMessage.messageId.length > 256
    || typeof rawMessage.publishTime !== "string"
  ) return null;
  let parsed: Record<string, unknown>;
  try {
    const decoded = JSON.parse(Buffer.from(rawMessage.data, "base64").toString("utf8"));
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return null;
    parsed = decoded as Record<string, unknown>;
  } catch {
    return null;
  }
  const publishTime = new Date(rawMessage.publishTime);
  if (Number.isNaN(publishTime.getTime())) return null;
  const packageName = parsed.packageName === undefined
    ? env.GOOGLE_PLAY_PACKAGE_NAME ?? ""
    : typeof parsed.packageName === "string"
      ? parsed.packageName
      : null;
  if (packageName === null) return null;

  if (parsed.testNotification !== undefined) {
    if (
      !parsed.testNotification
      || typeof parsed.testNotification !== "object"
      || Array.isArray(parsed.testNotification)
    ) return null;
    const version = (parsed.testNotification as Record<string, unknown>).version;
    if (version !== undefined && typeof version !== "string") return null;
    return {
      kind: "test",
      packageName,
      messageId: rawMessage.messageId,
      publishTime,
      version: version ?? "",
    };
  }
  if (
    !parsed.subscriptionNotification
    || typeof parsed.subscriptionNotification !== "object"
    || Array.isArray(parsed.subscriptionNotification)
  ) return null;
  const { notificationType, purchaseToken, subscriptionId } =
    parsed.subscriptionNotification as Record<string, unknown>;
  if (
    typeof purchaseToken !== "string"
    || purchaseToken.length < 1
    || purchaseToken.length > 40_000
    || typeof subscriptionId !== "string"
    || subscriptionId.length < 1
    || subscriptionId.length > 200
    || typeof notificationType !== "number"
    || !Number.isInteger(notificationType)
    || notificationType < 0
  ) return null;
  return {
    kind: "subscription",
    packageName,
    notificationType,
    purchaseToken,
    subscriptionId,
    messageId: rawMessage.messageId,
    publishTime,
  };
}
