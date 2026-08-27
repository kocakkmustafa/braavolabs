import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const mocks = vi.hoisted(() => ({
  verifyAppleReceipt: vi.fn(),
  verifyGoogleReceipt: vi.fn(),
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
  parseAppleNotification: vi.fn(),
}));
vi.mock("../google", () => ({
  verifyGoogleReceipt: mocks.verifyGoogleReceipt,
  parseGoogleRtdnEnvelope: vi.fn(),
  verifyPubSubPushToken: vi.fn().mockResolvedValue({ ok: false, reason: "test" }),
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
});

describe("single catalog authority wiring", () => {
  it("removes the router-local map and feeds both notification paths from the adapter", () => {
    const routerSource = readFileSync(resolve(__dirname, "../router.ts"), "utf8");

    expect(routerSource).not.toContain("PRODUCT_TIER_MAP");
    expect(routerSource).toContain('from "./catalog"');
    expect(routerSource.match(/internalPlanForProduct\(/g)).toHaveLength(2);
  });
});
