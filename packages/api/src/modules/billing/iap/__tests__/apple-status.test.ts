import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("jsonwebtoken", () => ({ default: { sign: vi.fn(() => "local-server-api-jwt") } }));
vi.mock("../../../../config/env", () => ({
  env: {
    APPLE_ISSUER_ID: "local-issuer",
    APPLE_KEY_ID: "local-key",
    APPLE_PRIVATE_KEY: "local-test-key",
    APPLE_BUNDLE_ID: "com.braavolabs.mobile",
    APPLE_SHARED_SECRET: "",
  },
}));
vi.mock("../../../../lib/logger", () => ({ logger: { error: vi.fn() } }));

import { verifyAppleReceipt } from "../apple";
import { mapAppleNotify, mapIapVerify } from "../../entitlement-mapping";
import { combineStreams, foldStream, resolveEntitlement, type EntitlementEvent } from "../../entitlement-reducer";

const PRODUCT = "com.braavolabs.individual.monthly";
const NOW = new Date("2026-10-01T00:00:00.000Z");
const EXPIRED = new Date("2026-09-30T00:00:00.000Z");
const FUTURE = new Date("2026-11-01T00:00:00.000Z");

function jws(payload: object): string {
  return `e30.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.local-test-signature`;
}

function serverResponse(status: number, expiresAt: Date) {
  return {
    data: [{
      subscriptionGroupIdentifier: "local-group",
      lastTransactions: [{
        originalTransactionId: "local-original-transaction",
        status,
        signedTransactionInfo: jws({
          originalTransactionId: "local-original-transaction",
          productId: PRODUCT,
          originalPurchaseDate: new Date("2026-08-01T00:00:00Z").getTime(),
          purchaseDate: new Date("2026-09-01T00:00:00Z").getTime(),
          expiresDate: expiresAt.getTime(),
        }),
        signedRenewalInfo: jws({ autoRenewStatus: 1 }),
      }],
    }],
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Apple Server API status → receipt → ledger entitlement", () => {
  it.each([
    [1, FUTURE, "active", "INDIVIDUAL"],
    [2, EXPIRED, "expired", "MANUAL_REVIEW"],
    [3, EXPIRED, "expired", "MANUAL_REVIEW"],
    [4, EXPIRED, "in_grace_period", "INDIVIDUAL"],
    [5, FUTURE, "revoked", "MANUAL_REVIEW"],
  ] as const)("maps Apple status %i through receipt verification and both event mappers", async (code, expiresAt, expectedStatus, expectedPlan) => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(serverResponse(code, expiresAt)), {
      status: 200, headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const receipt = await verifyAppleReceipt("local-transaction", PRODUCT);
    expect(receipt.status).toBe(expectedStatus);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.storekit.itunes.apple.com/inApps/v1/subscriptions/local-transaction",
      { method: "GET", headers: { Authorization: "Bearer local-server-api-jwt" } },
    );

    const events = [
      mapIapVerify("apple", receipt, "INDIVIDUAL"),
      mapAppleNotify({ notificationUUID: "local-notification", signedDate: NOW, productId: PRODUCT }, receipt, "INDIVIDUAL"),
    ];
    for (const event of events) {
      const state = foldStream([{ ...event, id: event.sourceEventId } as EntitlementEvent]);
      const winner = combineStreams(state ? [state] : [], NOW);
      expect(resolveEntitlement(winner, NOW)).toBe(expectedPlan);
      if (code === 3) expect(event).toMatchObject({ type: "revoke", planTier: null, expiresAt: null, autoRenew: false });
      if (code === 4) expect(event).toMatchObject({ type: "grace", planTier: "INDIVIDUAL", expiresAt: EXPIRED });
    }
  });
});
