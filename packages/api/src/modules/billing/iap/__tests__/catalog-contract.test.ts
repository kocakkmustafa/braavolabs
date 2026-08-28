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
  mobileSubscriptionCreate: vi.fn(),
  mobileSubscriptionUpdateMany: vi.fn(),
  mobileSubscriptionUpsert: vi.fn(),
  mobileSubscriptionFindFirst: vi.fn(),
  mobileSubscriptionUpdate: vi.fn(),
  activityLogCreate: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("../../../../middleware/auth", () => ({
  authMiddleware: (req: any, _res: unknown, next: () => void) => {
    const tenantId = req.headers["x-test-tenant-id"] ?? "tenant-1";
    req.auth = { userId: `user-for-${tenantId}`, tenantId, role: "OWNER" };
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
      create: mocks.mobileSubscriptionCreate,
      updateMany: mocks.mobileSubscriptionUpdateMany,
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
  mocks.mobileSubscriptionCreate.mockImplementation(async ({ data }: any) => ({
    id: "mobile-sub-1",
    ...data,
  }));
  mocks.mobileSubscriptionUpdateMany.mockResolvedValue({ count: 0 });
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

async function postVerify(
  provider: "apple" | "google",
  productId: string,
  options: { tenantId?: string; receipt?: string } = {},
) {
  const response = await fetch(`${baseUrl}/api/v1/billing/iap/verify`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(options.tenantId === undefined ? {} : { "X-Test-Tenant-Id": options.tenantId }),
    },
    body: JSON.stringify({
      provider,
      receipt: options.receipt ?? "store-proof",
      productId,
    }),
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
  expect(mocks.mobileSubscriptionCreate).not.toHaveBeenCalled();
  expect(mocks.mobileSubscriptionUpdateMany).not.toHaveBeenCalled();
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
  it("keeps Individual new-sale while Team waits for active-seat settlement", () => {
    const individual = getIapProduct("com.braavolabs.individual.monthly");
    const teamMonthly = getIapProduct("com.braavolabs.team.monthly");
    const teamYearly = getIapProduct("com.braavolabs.team.yearly");

    expect(individual).toEqual({
      internalPlan: "CREATOR",
      publicTier: "INDIVIDUAL",
      sale: "new-sale",
    });
    expect(teamMonthly).toEqual({
      internalPlan: "PRO",
      publicTier: "TEAM",
      sale: "manual-review",
    });
    expect(teamYearly).toEqual({
      internalPlan: "PRO",
      publicTier: "TEAM",
      sale: "manual-review",
    });
    expect(verificationResponseTier(individual!)).toBe("INDIVIDUAL");
    expect(verificationResponseTier(teamMonthly!)).toBe("PRO");
    expect(verificationResponseTier(teamYearly!)).toBe("PRO");
    expect(isNewSaleProduct("com.braavolabs.individual.monthly")).toBe(true);
    expect(isNewSaleProduct("com.braavolabs.team.monthly")).toBe(false);
    expect(isNewSaleProduct("com.braavolabs.team.yearly")).toBe(false);
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
  it("atomically gives one tenant ownership when two tenants verify the same transaction", async () => {
    const transactionId = "apple-shared-original-transaction";
    mocks.verifyAppleReceipt.mockResolvedValue(verifiedReceipt(transactionId));

    let storedSubscription: Record<string, any> | null = null;
    let emptyReadCount = 0;
    let releaseEmptyReads!: () => void;
    const bothEmptyReads = new Promise<void>((resolveReads) => {
      releaseEmptyReads = resolveReads;
    });

    mocks.mobileSubscriptionFindUnique.mockImplementation(async () => {
      if (storedSubscription) return storedSubscription;
      emptyReadCount += 1;
      if (emptyReadCount === 2) releaseEmptyReads();
      await bothEmptyReads;
      return null;
    });
    mocks.mobileSubscriptionUpsert.mockImplementation(async ({ create, update }: any) => {
      if (!storedSubscription) {
        storedSubscription = { id: "mobile-sub-race", ...create };
      } else {
        storedSubscription = { ...storedSubscription, ...update };
      }
      return storedSubscription;
    });
    mocks.mobileSubscriptionCreate.mockImplementation(async ({ data }: any) => {
      if (storedSubscription) {
        throw { code: "P2002", meta: { target: ["originalTransactionId"] } };
      }
      storedSubscription = { id: "mobile-sub-race", ...data };
      return storedSubscription;
    });
    mocks.mobileSubscriptionUpdateMany.mockImplementation(async ({ where, data }: any) => {
      if (!storedSubscription || storedSubscription.tenantId !== where.tenantId) {
        return { count: 0 };
      }
      storedSubscription = { ...storedSubscription, ...data };
      return { count: 1 };
    });

    const results = await Promise.all([
      postVerify("apple", "com.braavolabs.individual.monthly", {
        tenantId: "tenant-a",
        receipt: "receipt-a",
      }),
      postVerify("apple", "com.braavolabs.individual.monthly", {
        tenantId: "tenant-b",
        receipt: "receipt-b",
      }),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    const winningTenant = storedSubscription!.tenantId;
    const losingTenant = winningTenant === "tenant-a" ? "tenant-b" : "tenant-a";
    expect(storedSubscription).toMatchObject({
      tenantId: winningTenant,
      originalTransactionId: transactionId,
      latestReceipt: winningTenant === "tenant-a" ? "receipt-a" : "receipt-b",
      productId: "com.braavolabs.individual.monthly",
      status: "active",
      planTier: "CREATOR",
      expiresAt: ACTIVE_EXPIRY,
    });
    expect(mocks.recordEntitlementEvent).toHaveBeenCalledTimes(1);
    expect(mocks.recordEntitlementEvent).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: winningTenant }),
    );
    expect(mocks.recordEntitlementEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: losingTenant }),
    );
    expect(mocks.activityLogCreate).toHaveBeenCalledTimes(1);
    expect(mocks.activityLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ tenantId: winningTenant }) }),
    );
    expect(mocks.mobileSubscriptionFindUnique).not.toHaveBeenCalled();
  });

  it.each([
    ["apple", "com.braavolabs.business.monthly"],
    ["google", "com.braavolabs.enterprise.monthly"],
    ["apple", "com.braavolabs.team.monthly"],
    ["google", "com.braavolabs.team.monthly"],
    ["apple", "com.braavolabs.team.yearly"],
    ["google", "com.braavolabs.team.yearly"],
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
    expect(mocks.mobileSubscriptionCreate).not.toHaveBeenCalled();
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
    expect(mocks.mobileSubscriptionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ planTier: "CREATOR" }),
      }),
    );
    expect(mocks.recordEntitlementEvent).toHaveBeenCalledWith(
      expect.objectContaining({ planTier: "CREATOR" }),
    );
    expect(mocks.verifyAppleReceipt.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.mobileSubscriptionCreate.mock.invocationCallOrder[0],
    );
    expect(mocks.mobileSubscriptionCreate.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.recordEntitlementEvent.mock.invocationCallOrder[0],
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
    expect(mocks.mobileSubscriptionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ planTier: "CREATOR" }),
      }),
    );
  });

  it("keeps same-owner reverify successful through a tenant-guarded update", async () => {
    const transactionId = "apple-same-owner-transaction";
    let storedSubscription: Record<string, any> | null = null;
    mocks.verifyAppleReceipt.mockResolvedValue(verifiedReceipt(transactionId));
    mocks.mobileSubscriptionFindUnique.mockImplementation(async () => storedSubscription);
    mocks.mobileSubscriptionCreate.mockImplementation(async ({ data }: any) => {
      storedSubscription = { id: "mobile-sub-same-owner", ...data };
      return storedSubscription;
    });
    mocks.mobileSubscriptionUpdateMany.mockImplementation(async ({ where, data }: any) => {
      if (!storedSubscription || storedSubscription.tenantId !== where.tenantId) {
        return { count: 0 };
      }
      storedSubscription = { ...storedSubscription, ...data };
      return { count: 1 };
    });

    const first = await postVerify("apple", "com.braavolabs.individual.monthly", {
      tenantId: "tenant-owner",
      receipt: "receipt-first",
    });
    const second = await postVerify("apple", "com.braavolabs.individual.monthly", {
      tenantId: "tenant-owner",
      receipt: "receipt-renewal",
    });

    expect([first.status, second.status]).toEqual([200, 200]);
    expect(mocks.mobileSubscriptionCreate).toHaveBeenCalledTimes(1);
    expect(mocks.mobileSubscriptionUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { originalTransactionId: transactionId, tenantId: "tenant-owner" },
        data: expect.objectContaining({ latestReceipt: "receipt-renewal" }),
      }),
    );
    expect(mocks.mobileSubscriptionFindUnique).toHaveBeenCalledWith({
      where: { originalTransactionId: transactionId, tenantId: "tenant-owner" },
    });
    expect(storedSubscription).toMatchObject({
      tenantId: "tenant-owner",
      latestReceipt: "receipt-renewal",
    });
    expect(mocks.recordEntitlementEvent).toHaveBeenCalledTimes(2);
    expect(mocks.activityLogCreate).toHaveBeenCalledTimes(2);
  });

  it("does not mislabel an unrelated database conflict as receipt ownership", async () => {
    mocks.verifyAppleReceipt.mockResolvedValue(
      verifiedReceipt("apple-unrelated-conflict-transaction"),
    );
    mocks.mobileSubscriptionCreate.mockRejectedValue({
      code: "P2002",
      meta: { target: ["someOtherUniqueField"] },
    });

    const result = await postVerify("apple", "com.braavolabs.individual.monthly");

    expect(result).toEqual({ status: 500, body: { error: "Receipt verification failed" } });
    expect(mocks.mobileSubscriptionUpdateMany).toHaveBeenCalledOnce();
    expect(mocks.mobileSubscriptionUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          originalTransactionId: "apple-unrelated-conflict-transaction",
          tenantId: "tenant-1",
        },
      }),
    );
    expect(mocks.recordEntitlementEvent).not.toHaveBeenCalled();
    expect(mocks.activityLogCreate).not.toHaveBeenCalled();
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
