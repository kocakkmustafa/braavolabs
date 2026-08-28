import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const mocks = vi.hoisted(() => ({
  verifyAppleReceipt: vi.fn(),
  verifyGoogleReceipt: vi.fn(),
  parseAppleNotification: vi.fn(),
  parseGoogleRtdnEnvelope: vi.fn(),
  verifyPubSubPushToken: vi.fn(),
  recordEntitlementEvent: vi.fn(),
  mobileSubscriptionFindUnique: vi.fn(),
  mobileSubscriptionUpsert: vi.fn(),
  mobileSubscriptionFindFirst: vi.fn(),
  mobileSubscriptionUpdate: vi.fn(),
  activityLogCreate: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("../../../../middleware/auth", () => ({
  authMiddleware: (req: any, _res: unknown, next: () => void) => {
    req.auth = { userId: "user-1", tenantId: "tenant-1", role: "OWNER" };
    next();
  },
}));
vi.mock("../../../../middleware/system-scope", () => ({
  systemScope: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../../../../middleware/rateLimit", () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../../../../lib/db", () => ({
  prisma: {
    mobileSubscription: {
      findUnique: mocks.mobileSubscriptionFindUnique,
      upsert: mocks.mobileSubscriptionUpsert,
      findFirst: mocks.mobileSubscriptionFindFirst,
      update: mocks.mobileSubscriptionUpdate,
    },
    activityLog: { create: mocks.activityLogCreate },
    $transaction: mocks.transaction,
  },
}));
vi.mock("../../../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../../../config/env", () => ({
  env: { NODE_ENV: "test", REVENUECAT_WEBHOOK_SECRET: "" },
}));
vi.mock("../apple", () => ({
  verifyAppleReceipt: mocks.verifyAppleReceipt,
  parseAppleNotification: mocks.parseAppleNotification,
}));
vi.mock("../google", () => ({
  verifyGoogleReceipt: mocks.verifyGoogleReceipt,
  parseGoogleRtdnEnvelope: mocks.parseGoogleRtdnEnvelope,
  verifyPubSubPushToken: mocks.verifyPubSubPushToken,
}));
vi.mock("../../entitlement-ledger.service", () => ({
  recordEntitlementEvent: mocks.recordEntitlementEvent,
}));

import {
  getIapProduct,
  internalPlanForProduct,
  isNewSaleProduct,
  verificationResponseTier,
} from "../catalog";
import { iapRouter } from "../router";

let server: http.Server;
let baseUrl: string;

const ACTIVE_EXPIRY = new Date("2099-09-01T00:00:00.000Z");

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/billing/iap", iapRouter);
  app.use((err: any, _req: unknown, res: any, _next: unknown) => {
    res.status(err?.statusCode ?? 500).json({
      error: err?.message ?? "error",
      ...(err?.details === undefined ? {} : { details: err.details }),
    });
  });

  server = http.createServer(app);
  await new Promise<void>((resolveListen) => server.listen(0, resolveListen));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolveClose) => server.close(() => resolveClose())));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.mobileSubscriptionFindUnique.mockResolvedValue(null);
  mocks.mobileSubscriptionFindFirst.mockResolvedValue(null);
  mocks.mobileSubscriptionUpdate.mockResolvedValue(null);
  mocks.mobileSubscriptionUpsert.mockImplementation(async ({ create }: any) => ({
    id: "mobile-sub-1",
    ...create,
  }));
  mocks.parseAppleNotification.mockResolvedValue({
    notificationType: "DID_RENEW",
    originalTransactionId: "apple-notification-transaction",
    productId: "com.braavolabs.individual.monthly",
    expiresAt: ACTIVE_EXPIRY,
    status: "active",
    autoRenew: true,
    notificationUUID: "apple-notification-1",
    signedDate: new Date("2026-08-28T00:00:00.000Z"),
  });
  mocks.parseGoogleRtdnEnvelope.mockReturnValue({
    packageName: "com.braavolabs.mobile",
    notificationType: 2,
    purchaseToken: "google-purchase-token",
    subscriptionId: "com.braavolabs.team.monthly",
    messageId: "google-message-1",
    publishTime: new Date("2026-08-28T00:00:00.000Z"),
  });
  mocks.verifyPubSubPushToken.mockResolvedValue({ ok: true });
  mocks.activityLogCreate.mockResolvedValue({ id: "activity-1" });
  mocks.recordEntitlementEvent.mockResolvedValue(undefined);
});

async function postVerify(provider: "apple" | "google", productId: string) {
  const response = await fetch(`${baseUrl}/api/v1/billing/iap/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider, receipt: "store-proof", productId }),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function getEntitlement() {
  const response = await fetch(`${baseUrl}/api/v1/billing/iap/entitlement`);
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function postAppleNotification() {
  const response = await fetch(`${baseUrl}/api/v1/billing/iap/apple/notify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ signedPayload: "apple-signed-notification" }),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function postGoogleNotification() {
  const response = await fetch(`${baseUrl}/api/v1/billing/iap/google/notify`, {
    method: "POST",
    headers: {
      Authorization: "Bearer google-pubsub-token",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ message: { data: "mocked-by-parser" } }),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

function expectNoManualReviewSideEffects() {
  expect(mocks.verifyAppleReceipt).not.toHaveBeenCalled();
  expect(mocks.verifyGoogleReceipt).not.toHaveBeenCalled();
  expect(mocks.mobileSubscriptionFindUnique).not.toHaveBeenCalled();
  expect(mocks.mobileSubscriptionUpsert).not.toHaveBeenCalled();
  expect(mocks.mobileSubscriptionFindFirst).not.toHaveBeenCalled();
  expect(mocks.mobileSubscriptionUpdate).not.toHaveBeenCalled();
  expect(mocks.transaction).not.toHaveBeenCalled();
  expect(mocks.recordEntitlementEvent).not.toHaveBeenCalled();
  expect(mocks.activityLogCreate).not.toHaveBeenCalled();
}

function verifiedReceipt(id: string) {
  return {
    originalTransactionId: id,
    status: "active",
    startedAt: new Date("2026-08-26T00:00:00.000Z"),
    expiresAt: ACTIVE_EXPIRY,
    autoRenew: true,
  };
}

describe("canonical IAP catalog", () => {
  it("separates new-sale public tiers from internal entitlement plans", () => {
    const individual = getIapProduct("com.braavolabs.individual.monthly");
    const team = getIapProduct("com.braavolabs.team.monthly");

    expect(individual).toEqual({
      internalPlan: "CREATOR",
      publicTier: "INDIVIDUAL",
      sale: "new-sale",
    });
    expect(team).toEqual({
      internalPlan: "PRO",
      publicTier: "TEAM",
      sale: "new-sale",
    });
    expect(verificationResponseTier(individual!)).toBe("INDIVIDUAL");
    expect(verificationResponseTier(team!)).toBe("TEAM");
  });

  it("keeps legacy aliases restore-only and retired higher tiers manual-review", () => {
    expect(getIapProduct("com.braavolabs.creator.monthly")?.sale).toBe("legacy-restore");
    expect(getIapProduct("com.braavolabs.creator.yearly")?.sale).toBe("legacy-restore");
    expect(getIapProduct("com.braavolabs.pro.monthly")?.sale).toBe("legacy-restore");
    expect(getIapProduct("com.braavolabs.pro.yearly")?.sale).toBe("legacy-restore");
    expect(getIapProduct("com.braavolabs.business.monthly")?.sale).toBe("manual-review");
    expect(getIapProduct("com.braavolabs.enterprise.monthly")?.sale).toBe("manual-review");
    expect(isNewSaleProduct("com.braavolabs.business.monthly")).toBe(false);
    expect(isNewSaleProduct("com.braavolabs.enterprise.monthly")).toBe(false);
    expect(verificationResponseTier(getIapProduct("com.braavolabs.creator.monthly")!)).toBe("CREATOR");
  });

  it("fails closed for unknown products", () => {
    expect(getIapProduct("com.braavolabs.unknown.monthly")).toBeUndefined();
    expect(internalPlanForProduct("com.braavolabs.unknown.monthly")).toBeUndefined();
    expect(isNewSaleProduct("com.braavolabs.unknown.monthly")).toBe(false);
  });
});

describe("POST /billing/iap/verify catalog boundary", () => {
  it.each([
    ["apple", "com.braavolabs.business.monthly"],
    ["google", "com.braavolabs.enterprise.monthly"],
  ] as const)(
    "rejects %s manual-review products before provider or persistence work",
    async (provider, productId) => {
      const result = await postVerify(provider, productId);

      expect(result).toEqual({
        status: 409,
        body: {
          error: "This product requires manual review.",
          details: { reason: "manual-review-required" },
        },
      });
      expectNoManualReviewSideEffects();
    },
  );

  it("rejects an unknown SKU before provider verification or entitlement mutation", async () => {
    const result = await postVerify("apple", "com.braavolabs.unknown.monthly");

    expect(result.status).toBe(400);
    expect(result.body.error).toMatch(/Unknown productId/);
    expect(mocks.verifyAppleReceipt).not.toHaveBeenCalled();
    expect(mocks.mobileSubscriptionUpsert).not.toHaveBeenCalled();
    expect(mocks.recordEntitlementEvent).not.toHaveBeenCalled();
  });

  it("verifies Individual before persisting CREATOR and returns INDIVIDUAL", async () => {
    mocks.verifyAppleReceipt.mockResolvedValue(
      verifiedReceipt("apple-individual-transaction"),
    );

    const result = await postVerify("apple", "com.braavolabs.individual.monthly");

    expect(result).toMatchObject({
      status: 200,
      body: { success: true, planTier: "INDIVIDUAL", status: "active" },
    });
    expect(mocks.verifyAppleReceipt).toHaveBeenCalledWith(
      "store-proof",
      "com.braavolabs.individual.monthly",
    );
    expect(mocks.mobileSubscriptionUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ planTier: "CREATOR" }),
        update: expect.objectContaining({ planTier: "CREATOR" }),
      }),
    );
    expect(mocks.recordEntitlementEvent).toHaveBeenCalledWith(
      expect.objectContaining({ planTier: "CREATOR" }),
    );
    expect(mocks.verifyAppleReceipt.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.mobileSubscriptionUpsert.mock.invocationCallOrder[0],
    );
    expect(mocks.mobileSubscriptionUpsert.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.recordEntitlementEvent.mock.invocationCallOrder[0],
    );
  });

  it("persists Team as PRO and returns TEAM", async () => {
    mocks.verifyGoogleReceipt.mockResolvedValue(
      verifiedReceipt("google-team-transaction"),
    );

    const result = await postVerify("google", "com.braavolabs.team.monthly");

    expect(result).toMatchObject({
      status: 200,
      body: { success: true, planTier: "TEAM", status: "active" },
    });
    expect(mocks.mobileSubscriptionUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ planTier: "PRO" }),
        update: expect.objectContaining({ planTier: "PRO" }),
      }),
    );
    expect(mocks.recordEntitlementEvent).toHaveBeenCalledWith(
      expect.objectContaining({ planTier: "PRO" }),
    );
  });

  it("keeps a legacy Creator restore response fail-closed for mobile manual review", async () => {
    mocks.verifyAppleReceipt.mockResolvedValue(
      verifiedReceipt("apple-legacy-creator-transaction"),
    );

    const result = await postVerify("apple", "com.braavolabs.creator.monthly");

    expect(result).toMatchObject({
      status: 200,
      body: { success: true, planTier: "CREATOR", status: "active" },
    });
    expect(mocks.mobileSubscriptionUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ planTier: "CREATOR" }),
      }),
    );
  });
});

describe("GET /billing/iap/entitlement catalog boundary", () => {
  it("returns the public tier for a current-sale Individual row", async () => {
    mocks.mobileSubscriptionFindFirst.mockResolvedValue({
      planTier: "CREATOR",
      productId: "com.braavolabs.individual.monthly",
      expiresAt: ACTIVE_EXPIRY,
      provider: "apple",
      autoRenew: true,
    });

    const result = await getEntitlement();

    expect(result).toMatchObject({
      status: 200,
      body: { hasActiveMobileSubscription: true, planTier: "INDIVIDUAL" },
    });
  });

  it("keeps a legacy Creator row fail-closed as its internal tier", async () => {
    mocks.mobileSubscriptionFindFirst.mockResolvedValue({
      planTier: "CREATOR",
      productId: "com.braavolabs.creator.monthly",
      expiresAt: ACTIVE_EXPIRY,
      provider: "apple",
      autoRenew: false,
    });

    const result = await getEntitlement();

    expect(result).toMatchObject({
      status: 200,
      body: { hasActiveMobileSubscription: true, planTier: "CREATOR" },
    });
  });

  it("does not expose a stale tier from an active catalog-unknown row", async () => {
    mocks.mobileSubscriptionFindFirst.mockResolvedValue({
      planTier: "ENTERPRISE",
      productId: "com.braavolabs.unregistered.monthly",
      expiresAt: ACTIVE_EXPIRY,
      provider: "apple",
      autoRenew: true,
    });

    const result = await getEntitlement();

    expect(result).toEqual({
      status: 200,
      body: {
        hasActiveMobileSubscription: false,
        planTier: null,
        expiresAt: null,
        provider: null,
        autoRenew: null,
      },
    });
  });
});

describe("store notification catalog boundary", () => {
  it("acknowledges an Apple unknown product after verification without billing mutation", async () => {
    mocks.parseAppleNotification.mockResolvedValue({
      notificationType: "DID_RENEW",
      originalTransactionId: "apple-unknown-transaction",
      productId: "com.braavolabs.unregistered.monthly",
      expiresAt: ACTIVE_EXPIRY,
      status: "active",
      autoRenew: true,
      notificationUUID: "apple-unknown-notification",
      signedDate: new Date("2026-08-28T00:00:00.000Z"),
    });
    mocks.verifyAppleReceipt.mockResolvedValue(verifiedReceipt("apple-unknown-transaction"));

    const result = await postAppleNotification();

    expect(result).toEqual({ status: 200, body: { ok: false, reason: "unknown-product" } });
    expect(mocks.verifyAppleReceipt).toHaveBeenCalledWith(
      "apple-unknown-transaction",
      "com.braavolabs.unregistered.monthly",
    );
    expect(mocks.mobileSubscriptionUpdate).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.recordEntitlementEvent).not.toHaveBeenCalled();
    expect(mocks.activityLogCreate).not.toHaveBeenCalled();
  });

  it("acknowledges a Google unknown product after verification without billing mutation", async () => {
    mocks.parseGoogleRtdnEnvelope.mockReturnValue({
      packageName: "com.braavolabs.mobile",
      notificationType: 2,
      purchaseToken: "google-unknown-token",
      subscriptionId: "com.braavolabs.unregistered.monthly",
      messageId: "google-unknown-message",
      publishTime: new Date("2026-08-28T00:00:00.000Z"),
    });
    mocks.verifyGoogleReceipt.mockResolvedValue(verifiedReceipt("google-unknown-transaction"));

    const result = await postGoogleNotification();

    expect(result).toEqual({ status: 200, body: { ok: false, reason: "unknown-product" } });
    expect(mocks.verifyGoogleReceipt).toHaveBeenCalledWith(
      "google-unknown-token",
      "com.braavolabs.unregistered.monthly",
    );
    expect(mocks.mobileSubscriptionUpdate).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.recordEntitlementEvent).not.toHaveBeenCalled();
    expect(mocks.activityLogCreate).not.toHaveBeenCalled();
  });

  it.each([
    ["apple", "com.braavolabs.individual.monthly", "CREATOR"],
    ["google", "com.braavolabs.team.monthly", "PRO"],
  ] as const)("preserves known %s renewal mapping", async (provider, productId, planTier) => {
    mocks.mobileSubscriptionUpdate.mockResolvedValue({
      id: `${provider}-subscription`,
      tenantId: "tenant-1",
      planTier: "ENTERPRISE",
    });

    let result;
    if (provider === "apple") {
      mocks.parseAppleNotification.mockResolvedValue({
        notificationType: "DID_RENEW",
        originalTransactionId: "apple-known-transaction",
        productId,
        expiresAt: ACTIVE_EXPIRY,
        status: "active",
        autoRenew: true,
        notificationUUID: "apple-known-notification",
        signedDate: new Date("2026-08-28T00:00:00.000Z"),
      });
      mocks.verifyAppleReceipt.mockResolvedValue(verifiedReceipt("apple-known-transaction"));
      result = await postAppleNotification();
    } else {
      mocks.parseGoogleRtdnEnvelope.mockReturnValue({
        packageName: "com.braavolabs.mobile",
        notificationType: 2,
        purchaseToken: "google-known-token",
        subscriptionId: productId,
        messageId: "google-known-message",
        publishTime: new Date("2026-08-28T00:00:00.000Z"),
      });
      mocks.verifyGoogleReceipt.mockResolvedValue(verifiedReceipt("google-known-transaction"));
      result = await postGoogleNotification();
    }

    expect(result).toEqual({ status: 200, body: { ok: true } });
    expect(mocks.mobileSubscriptionUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.recordEntitlementEvent).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "tenant-1", planTier }),
    );
    expect(mocks.activityLogCreate).toHaveBeenCalledTimes(1);
  });
});

describe("single catalog authority wiring", () => {
  it("removes the router-local map and feeds both notification paths from the adapter", () => {
    const routerSource = readFileSync(resolve(__dirname, "../router.ts"), "utf8");

    expect(routerSource).not.toContain("PRODUCT_TIER_MAP");
    expect(routerSource).toContain('from "./catalog"');
    expect(routerSource.match(/internalPlanForProduct\(/g)).toHaveLength(2);
  });
});
