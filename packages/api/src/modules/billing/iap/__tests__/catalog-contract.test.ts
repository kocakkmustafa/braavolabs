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
  recordGoogleEntitlementWithDecision: vi.fn(),
  withCurrentGooglePurchase: vi.fn(),
  getEntitlementProjection: vi.fn(),
  acknowledgeGoogleReceipt: vi.fn(),
  ensureManualReviewCase: vi.fn(),
  getManualReviewCase: vi.fn(),
  hasPendingManualReviewCases: vi.fn(),
  manualReviewCaseId: vi.fn(() => "iap_review_provider_case"),
  transitionManualReviewCase: vi.fn(),
  validateManualReviewReason: vi.fn(),
  mobileSubscriptionFindUnique: vi.fn(),
  mobileSubscriptionCreate: vi.fn(),
  mobileSubscriptionUpdateMany: vi.fn(),
  mobileSubscriptionUpsert: vi.fn(),
  mobileSubscriptionFindFirst: vi.fn(),
  mobileSubscriptionUpdate: vi.fn(),
  googlePurchaseAliasFindMany: vi.fn(),
  googlePurchaseAliasFindFirst: vi.fn(),
  googlePurchaseAliasCreateMany: vi.fn(),
  queryRaw: vi.fn(),
  activityLogCreate: vi.fn(),
  activityLogUpsert: vi.fn(),
  transaction: vi.fn(),
  tenantTx: vi.fn(),
  loggerError: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock("../../../../middleware/auth", () => ({
  authMiddleware: (req: any, res: any, next: () => void) => {
    if (req.headers["x-test-no-auth"] === "true") {
      res.status(401).json({ error: "Missing or invalid authorization header" });
      return;
    }
    const tenantId = req.headers["x-test-tenant-id"] ?? "tenant-1";
    req.auth = {
      userId: `user-for-${tenantId}`,
      tenantId,
      role: req.headers["x-test-role"] ?? "OWNER",
    };
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
    activityLog: { create: mocks.activityLogCreate, upsert: mocks.activityLogUpsert },
    $transaction: mocks.transaction,
  },
  tenantTx: mocks.tenantTx,
}));
vi.mock("../../../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: mocks.loggerWarn, error: mocks.loggerError },
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
  acknowledgeGoogleReceipt: mocks.acknowledgeGoogleReceipt,
  parseGoogleRtdnEnvelope: mocks.parseGoogleRtdnEnvelope,
  verifyPubSubPushToken: mocks.verifyPubSubPushToken,
}));
vi.mock("../../entitlement-ledger.service", () => ({
  GOOGLE_OBSERVATION_STALE: "Google verification was superseded; retry",
  recordEntitlementEvent: mocks.recordEntitlementEvent,
  recordGoogleEntitlementWithDecision: mocks.recordGoogleEntitlementWithDecision,
  withCurrentGooglePurchase: mocks.withCurrentGooglePurchase,
  getEntitlementProjection: mocks.getEntitlementProjection,
}));
vi.mock("../manual-review.service", () => ({
  ensureManualReviewCase: mocks.ensureManualReviewCase,
  getManualReviewCase: mocks.getManualReviewCase,
  hasPendingManualReviewCases: mocks.hasPendingManualReviewCases,
  manualReviewCaseId: mocks.manualReviewCaseId,
  transitionManualReviewCase: mocks.transitionManualReviewCase,
  validateManualReviewReason: mocks.validateManualReviewReason,
}));

import {
  iapCredentialDigest,
} from "../../entitlement-mapping";
import { AppError } from "../../../../middleware/error";
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
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
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
    kind: "subscription",
    notificationType: 2,
    purchaseToken: "google-purchase-token",
    messageId: "google-message-1",
    publishTime: new Date("2026-08-28T00:00:00.000Z"),
  });
  mocks.verifyPubSubPushToken.mockResolvedValue({ ok: true });
  mocks.activityLogCreate.mockResolvedValue({ id: "activity-1" });
  mocks.activityLogUpsert.mockResolvedValue({ id: "activity-notification-1" });
  mocks.recordEntitlementEvent.mockResolvedValue("INDIVIDUAL");
  mocks.recordGoogleEntitlementWithDecision.mockImplementation(async (
    _event: unknown, _fence: unknown, decide: (tx: unknown) => Promise<unknown>,
  ) => ({ decision: await decide({}), plan: "TEAM" }));
  mocks.withCurrentGooglePurchase.mockImplementation(async (
    _tenantId: string, _fence: unknown, effect: (tx: unknown) => Promise<unknown>,
  ) => ({ value: await effect({}) }));
  mocks.getEntitlementProjection.mockResolvedValue({
    effectiveTier: "INDIVIDUAL",
    winner: {
      source: "apple",
      streamId: "apple:projected",
      expiresAt: ACTIVE_EXPIRY,
      autoRenew: true,
    },
    hasManualReview: false,
  });
  mocks.acknowledgeGoogleReceipt.mockResolvedValue(undefined);
  mocks.ensureManualReviewCase.mockResolvedValue({
    caseId: "iap_review_pending_case",
    state: "pending",
    targetTier: null,
  });
  mocks.getManualReviewCase.mockResolvedValue({
    caseId: "iap_review_pending_case",
    tenantId: "tenant-1",
    provider: "apple",
    productId: "com.braavolabs.business.monthly",
    internalPlan: "BUSINESS",
    subscriptionId: "mobile-sub-1",
    identityRef: iapCredentialDigest("apple", "operator-apple-identity"),
    state: "pending",
    targetTier: null,
  });
  mocks.hasPendingManualReviewCases.mockResolvedValue(false);
  mocks.manualReviewCaseId.mockReturnValue("iap_review_provider_case");
  mocks.validateManualReviewReason.mockImplementation((reason: string) => reason.trim());
  mocks.verifyAppleReceipt.mockResolvedValue(verifiedReceipt("operator-apple-identity"));
  mocks.transitionManualReviewCase.mockResolvedValue({
    caseId: "iap_review_pending_case",
    state: "approved_mapping",
    targetTier: "TEAM",
  });
  mocks.googlePurchaseAliasFindMany.mockResolvedValue([]);
  mocks.googlePurchaseAliasFindFirst.mockResolvedValue(null);
  mocks.googlePurchaseAliasCreateMany.mockResolvedValue({ count: 0 });
  mocks.queryRaw.mockResolvedValue([{
    id: "mobile-sub-1",
    last_verified_at: new Date(0),
  }]);
  mocks.tenantTx.mockImplementation(async (fn: (tx: any) => Promise<unknown>) => fn({
    $queryRaw: mocks.queryRaw,
    mobileSubscription: {
      findUnique: mocks.mobileSubscriptionFindUnique,
      create: mocks.mobileSubscriptionCreate,
      updateMany: mocks.mobileSubscriptionUpdateMany,
      update: mocks.mobileSubscriptionUpdate,
    },
    googlePurchaseAlias: {
      findMany: mocks.googlePurchaseAliasFindMany,
      findFirst: mocks.googlePurchaseAliasFindFirst,
      createMany: mocks.googlePurchaseAliasCreateMany,
    },
  }));
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

async function postManualReviewDecision(
  role?: "OWNER" | "ADMIN" | "MEMBER" | "UNKNOWN",
  tenantId = "tenant-1",
  body: Record<string, unknown> = {
    state: "approved_mapping",
    targetTier: "TEAM",
    reason: "provider records verified by billing operator",
    receipt: "operator-apple-receipt",
  },
) {
  const response = await fetch(`${baseUrl}/api/v1/billing/iap/manual-reviews/iap_review_pending_case/decide`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Test-Tenant-Id": tenantId,
      ...(role ? { "X-Test-Role": role } : { "X-Test-No-Auth": "true" }),
    },
    body: JSON.stringify(body),
  });
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

async function postGoogleNotification(messageId: string) {
  const response = await fetch(`${baseUrl}/api/v1/billing/iap/google/notify`, {
    method: "POST",
    headers: {
      Authorization: "Bearer google-pubsub-token",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ message: { messageId, data: "mocked-by-parser" } }),
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
  it("keeps exactly one new-sale SKU and classifies canonical Team as restore-only", () => {
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
      sale: "restore-only",
    });
    expect(teamYearly).toEqual({
      internalPlan: "PRO",
      publicTier: "TEAM",
      sale: "restore-only",
    });
    expect(verificationResponseTier(individual!)).toBe("INDIVIDUAL");
    expect(verificationResponseTier(teamMonthly!)).toBe("TEAM");
    expect(verificationResponseTier(teamYearly!)).toBe("TEAM");
    expect(isNewSaleProduct("com.braavolabs.individual.monthly")).toBe(true);
    expect(isNewSaleProduct("com.braavolabs.team.monthly")).toBe(false);
    expect(isNewSaleProduct("com.braavolabs.team.yearly")).toBe(false);
  });

  it("keeps legacy aliases restore-only and retired higher tiers manual-review", () => {
    expect(getIapProduct("com.braavolabs.creator.monthly")?.sale).toBe("restore-only");
    expect(getIapProduct("com.braavolabs.creator.yearly")?.sale).toBe("restore-only");
    expect(getIapProduct("com.braavolabs.pro.monthly")?.sale).toBe("restore-only");
    expect(getIapProduct("com.braavolabs.pro.yearly")?.sale).toBe("restore-only");
    expect(getIapProduct("com.braavolabs.business.monthly")?.sale).toBe("manual-review");
    expect(getIapProduct("com.braavolabs.enterprise.monthly")?.sale).toBe("manual-review");
    expect(isNewSaleProduct("com.braavolabs.business.monthly")).toBe(false);
    expect(isNewSaleProduct("com.braavolabs.enterprise.monthly")).toBe(false);
    expect(verificationResponseTier(getIapProduct("com.braavolabs.creator.monthly")!)).toBe("INDIVIDUAL");
  });

  it("fails closed for unknown products", () => {
    expect(getIapProduct("com.braavolabs.unknown.monthly")).toBeUndefined();
    expect(internalPlanForProduct("com.braavolabs.unknown.monthly")).toBeUndefined();
    expect(isNewSaleProduct("com.braavolabs.unknown.monthly")).toBe(false);
    for (const inheritedKey of ["constructor", "__proto__", "toString"]) {
      expect(getIapProduct(inheritedKey)).toBeUndefined();
      expect(internalPlanForProduct(inheritedKey)).toBeUndefined();
      expect(isNewSaleProduct(inheritedKey)).toBe(false);
    }
  });
});

describe("POST /billing/iap/verify catalog boundary", () => {
  it("claims every verified Google alias transactionally before subscription and entitlement effects", async () => {
    const currentIdentity = `google:${"c".repeat(64)}`;
    const rootIdentity = `google:${"a".repeat(64)}`;
    mocks.verifyGoogleReceipt.mockResolvedValue({
      ...verifiedReceipt(rootIdentity),
      googleCanonicalRootIdentity: rootIdentity,
      googlePurchaseAliases: [currentIdentity, rootIdentity],
    });
    mocks.googlePurchaseAliasFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          tokenDigest: currentIdentity,
          state: "active",
          tenantId: "tenant-1",
          mobileSubscriptionId: "mobile-sub-1",
          provider: "google",
          canonicalRootIdentity: rootIdentity,
        },
        {
          tokenDigest: rootIdentity,
          state: "active",
          tenantId: "tenant-1",
          mobileSubscriptionId: "mobile-sub-1",
          provider: "google",
          canonicalRootIdentity: rootIdentity,
        },
      ]);
    mocks.googlePurchaseAliasCreateMany.mockResolvedValue({ count: 2 });

    const result = await postVerify("google", "com.braavolabs.individual.monthly");

    expect(result.status).toBe(200);
    expect(mocks.tenantTx).toHaveBeenCalledTimes(1);
    expect(mocks.googlePurchaseAliasCreateMany).toHaveBeenCalledWith(expect.objectContaining({
      skipDuplicates: true,
      data: expect.arrayContaining([
        expect.objectContaining({ tokenDigest: currentIdentity }),
        expect.objectContaining({ tokenDigest: rootIdentity }),
      ]),
    }));
    expect(mocks.googlePurchaseAliasCreateMany.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.mobileSubscriptionCreate.mock.invocationCallOrder[0]);
    expect(mocks.mobileSubscriptionCreate.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.recordEntitlementEvent.mock.invocationCallOrder[0]);
  });

  it("rejects an expired old Google token after a newer alias is owned without revoking the shared stream", async () => {
    const rootIdentity = `google:${"a".repeat(64)}`;
    const newerIdentity = `google:${"c".repeat(64)}`;
    mocks.verifyGoogleReceipt.mockResolvedValue({
      ...verifiedReceipt(rootIdentity),
      status: "expired",
      googleCanonicalRootIdentity: rootIdentity,
      googlePurchaseAliases: [rootIdentity],
      googleAcknowledgementPending: false,
    });
    const owner = {
      tokenDigest: rootIdentity,
      state: "active",
      tenantId: "tenant-1",
      mobileSubscriptionId: "mobile-sub-1",
      provider: "google",
      canonicalRootIdentity: rootIdentity,
    };
    mocks.googlePurchaseAliasFindMany.mockResolvedValue([owner]);
    mocks.googlePurchaseAliasFindFirst.mockResolvedValueOnce({ tokenDigest: newerIdentity });
    mocks.mobileSubscriptionUpdateMany.mockResolvedValue({ count: 1 });
    mocks.mobileSubscriptionFindUnique.mockResolvedValue({
      id: "mobile-sub-1", tenantId: "tenant-1", provider: "google", status: "active",
    });

    const result = await postVerify("google", "com.braavolabs.individual.monthly");

    expect(result.status).toBe(409);
    expect(mocks.googlePurchaseAliasFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        tenantId: "tenant-1",
        mobileSubscriptionId: "mobile-sub-1",
        canonicalRootIdentity: rootIdentity,
        tokenDigest: { notIn: [rootIdentity] },
      }),
    }));
    expect(mocks.mobileSubscriptionUpdateMany).not.toHaveBeenCalled();
    expect(mocks.recordEntitlementEvent).not.toHaveBeenCalled();
    expect(mocks.activityLogCreate).not.toHaveBeenCalled();
    expect(mocks.acknowledgeGoogleReceipt).not.toHaveBeenCalled();
  });

  it("still revokes a verified current Google token when no newer alias exists", async () => {
    const rootIdentity = `google:${"a".repeat(64)}`;
    const currentIdentity = `google:${"c".repeat(64)}`;
    mocks.verifyGoogleReceipt.mockResolvedValue({
      ...verifiedReceipt(rootIdentity),
      status: "expired",
      googleCanonicalRootIdentity: rootIdentity,
      googlePurchaseAliases: [currentIdentity, rootIdentity],
      googleAcknowledgementPending: false,
    });
    const owner = (tokenDigest: string) => ({
      tokenDigest,
      state: "active",
      tenantId: "tenant-1",
      mobileSubscriptionId: "mobile-sub-1",
      provider: "google",
      canonicalRootIdentity: rootIdentity,
    });
    mocks.googlePurchaseAliasFindMany.mockResolvedValue([owner(currentIdentity), owner(rootIdentity)]);
    mocks.mobileSubscriptionUpdateMany.mockResolvedValue({ count: 1 });
    mocks.mobileSubscriptionFindUnique.mockResolvedValue({
      id: "mobile-sub-1", tenantId: "tenant-1", provider: "google", status: "expired",
    });

    const result = await postVerify("google", "com.braavolabs.individual.monthly");

    expect(result).toMatchObject({ status: 200, body: { outcome: "inactive" } });
    expect(mocks.mobileSubscriptionUpdateMany).toHaveBeenCalledTimes(1);
    expect(mocks.recordEntitlementEvent).toHaveBeenCalledWith(expect.objectContaining({
      source: "google", type: "revoke", planTier: null,
    }), expect.objectContaining({
      rootIdentity,
      subscriptionId: "mobile-sub-1",
      verifiedAliases: [currentIdentity, rootIdentity],
    }));
    expect(mocks.googlePurchaseAliasFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ tokenDigest: { notIn: [currentIdentity, rootIdentity] } }),
    }));
  });

  it("rejects an old Google verify when a replacement appears before the fenced ledger append", async () => {
    const rootIdentity = `google:${"a".repeat(64)}`;
    mocks.verifyGoogleReceipt.mockResolvedValue({
      ...verifiedReceipt(rootIdentity),
      status: "expired",
      googleCanonicalRootIdentity: rootIdentity,
      googlePurchaseAliases: [rootIdentity],
      googleAcknowledgementPending: false,
    });
    const owner = {
      tokenDigest: rootIdentity,
      state: "active",
      tenantId: "tenant-1",
      mobileSubscriptionId: "mobile-sub-1",
      provider: "google",
      canonicalRootIdentity: rootIdentity,
    };
    mocks.googlePurchaseAliasFindMany.mockResolvedValue([owner]);
    mocks.mobileSubscriptionUpdateMany.mockResolvedValue({ count: 1 });
    mocks.mobileSubscriptionFindUnique.mockResolvedValue({
      id: "mobile-sub-1", tenantId: "tenant-1", provider: "google", status: "expired",
    });
    // A concurrent replacement claims its alias after the earlier ownership
    // transaction, so the ledger's second row-locked check skips the append.
    mocks.recordEntitlementEvent.mockResolvedValueOnce(null);

    const result = await postVerify("google", "com.braavolabs.individual.monthly");

    expect(result.status).toBe(409);
    expect(mocks.recordEntitlementEvent).toHaveBeenCalledWith(
      expect.objectContaining({ source: "google", type: "revoke" }),
      expect.objectContaining({ rootIdentity, verifiedAliases: [rootIdentity] }),
    );
    expect(mocks.activityLogCreate).not.toHaveBeenCalled();
    expect(mocks.acknowledgeGoogleReceipt).not.toHaveBeenCalled();
  });

  it("returns 409 with all downstream effects zero when an alias conflict is hidden by RLS", async () => {
    const currentIdentity = `google:${"d".repeat(64)}`;
    const rootIdentity = `google:${"b".repeat(64)}`;
    mocks.verifyGoogleReceipt.mockResolvedValue({
      ...verifiedReceipt(rootIdentity),
      googleCanonicalRootIdentity: rootIdentity,
      googlePurchaseAliases: [currentIdentity, rootIdentity],
    });
    mocks.googlePurchaseAliasFindMany.mockResolvedValue([]);
    mocks.googlePurchaseAliasCreateMany.mockResolvedValue({ count: 0 });

    const result = await postVerify("google", "com.braavolabs.individual.monthly", {
      tenantId: "tenant-loser",
    });

    expect(result.status).toBe(409);
    expect(mocks.mobileSubscriptionCreate).not.toHaveBeenCalled();
    expect(mocks.mobileSubscriptionUpdateMany).not.toHaveBeenCalled();
    expect(mocks.recordEntitlementEvent).not.toHaveBeenCalled();
    expect(mocks.activityLogCreate).not.toHaveBeenCalled();
  });

  it.each([
    ["tenant", { tenantId: "other-tenant" }],
    ["root", { canonicalRootIdentity: `google:${"f".repeat(64)}` }],
    ["legacy state", {
      state: "legacy_blocked",
      tenantId: null,
      mobileSubscriptionId: null,
      provider: null,
      canonicalRootIdentity: null,
    }],
  ])("fails closed for a visible Google alias %s conflict", async (_label, override) => {
    const currentIdentity = `google:${"d".repeat(64)}`;
    const rootIdentity = `google:${"b".repeat(64)}`;
    mocks.verifyGoogleReceipt.mockResolvedValue({
      ...verifiedReceipt(rootIdentity),
      googleCanonicalRootIdentity: rootIdentity,
      googlePurchaseAliases: [currentIdentity, rootIdentity],
      googleAcknowledgementPending: true,
    });
    mocks.googlePurchaseAliasFindMany.mockResolvedValueOnce([{
      tokenDigest: currentIdentity,
      state: "active",
      tenantId: "tenant-1",
      mobileSubscriptionId: "mobile-sub-owner",
      provider: "google",
      canonicalRootIdentity: rootIdentity,
      ...override,
    }]);

    const result = await postVerify("google", "com.braavolabs.individual.monthly");

    expect(result.status).toBe(409);
    expect(mocks.googlePurchaseAliasCreateMany).not.toHaveBeenCalled();
    expect(mocks.mobileSubscriptionCreate).not.toHaveBeenCalled();
    expect(mocks.mobileSubscriptionUpdateMany).not.toHaveBeenCalled();
    expect(mocks.recordEntitlementEvent).not.toHaveBeenCalled();
    expect(mocks.activityLogCreate).not.toHaveBeenCalled();
  });

  it("fails closed when verified aliases point at different subscription owners", async () => {
    const currentIdentity = `google:${"d".repeat(64)}`;
    const rootIdentity = `google:${"b".repeat(64)}`;
    mocks.verifyGoogleReceipt.mockResolvedValue({
      ...verifiedReceipt(rootIdentity),
      googleCanonicalRootIdentity: rootIdentity,
      googlePurchaseAliases: [currentIdentity, rootIdentity],
      googleAcknowledgementPending: false,
    });
    mocks.googlePurchaseAliasFindMany.mockResolvedValueOnce([
      {
        tokenDigest: currentIdentity,
        state: "active",
        tenantId: "tenant-1",
        mobileSubscriptionId: "owner-one",
        provider: "google",
        canonicalRootIdentity: rootIdentity,
      },
      {
        tokenDigest: rootIdentity,
        state: "active",
        tenantId: "tenant-1",
        mobileSubscriptionId: "owner-two",
        provider: "google",
        canonicalRootIdentity: rootIdentity,
      },
    ]);

    const result = await postVerify("google", "com.braavolabs.individual.monthly");

    expect(result.status).toBe(409);
    expect(mocks.googlePurchaseAliasCreateMany).not.toHaveBeenCalled();
    expect(mocks.mobileSubscriptionCreate).not.toHaveBeenCalled();
    expect(mocks.recordEntitlementEvent).not.toHaveBeenCalled();
    expect(mocks.activityLogCreate).not.toHaveBeenCalled();
  });

  it("keeps a same-owner Google renewal on the existing canonical subscription", async () => {
    const currentIdentity = `google:${"8".repeat(64)}`;
    const rootIdentity = `google:${"7".repeat(64)}`;
    const ownerAliases = [currentIdentity, rootIdentity].map((tokenDigest) => ({
      tokenDigest,
      state: "active",
      tenantId: "tenant-1",
      mobileSubscriptionId: "mobile-sub-owner",
      provider: "google",
      canonicalRootIdentity: rootIdentity,
    }));
    mocks.verifyGoogleReceipt.mockResolvedValue({
      ...verifiedReceipt(rootIdentity),
      googleCanonicalRootIdentity: rootIdentity,
      googlePurchaseAliases: [currentIdentity, rootIdentity],
      googleAcknowledgementPending: false,
    });
    mocks.googlePurchaseAliasFindMany.mockResolvedValue(ownerAliases);
    mocks.googlePurchaseAliasCreateMany.mockResolvedValue({ count: 0 });
    mocks.mobileSubscriptionUpdateMany.mockResolvedValue({ count: 1 });
    mocks.mobileSubscriptionFindUnique.mockResolvedValue({
      id: "mobile-sub-owner",
      tenantId: "tenant-1",
      planTier: "CREATOR",
    });

    const result = await postVerify("google", "com.braavolabs.individual.monthly");

    expect(result.status).toBe(200);
    expect(mocks.mobileSubscriptionCreate).not.toHaveBeenCalled();
    expect(mocks.mobileSubscriptionUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: "mobile-sub-owner",
        tenantId: "tenant-1",
        originalTransactionId: rootIdentity,
      }),
    }));
    expect(mocks.recordEntitlementEvent).toHaveBeenCalledTimes(1);
    expect(mocks.activityLogCreate).toHaveBeenCalledTimes(1);
  });

  it("re-fetches an overlapping Google read and records a newer revocation", async () => {
    const rootIdentity = `google:${"9".repeat(64)}`;
    const active = {
      ...verifiedReceipt(rootIdentity),
      googleCanonicalRootIdentity: rootIdentity,
      googlePurchaseAliases: [rootIdentity],
      googleAcknowledgementPending: false,
    };
    let competingCompletedAt: Date | undefined;
    mocks.verifyGoogleReceipt.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      competingCompletedAt = new Date();
      await new Promise((resolve) => setTimeout(resolve, 10));
      return active;
    });
    mocks.verifyGoogleReceipt.mockResolvedValueOnce({ ...active, status: "revoked" });
    mocks.googlePurchaseAliasFindMany.mockResolvedValue([{
      tokenDigest: rootIdentity,
      state: "active",
      tenantId: "tenant-1",
      mobileSubscriptionId: "mobile-sub-1",
      provider: "google",
      canonicalRootIdentity: rootIdentity,
    }]);
    mocks.queryRaw.mockImplementationOnce(async () => [{
      id: "mobile-sub-1",
      last_verified_at: competingCompletedAt,
    }]);
    mocks.mobileSubscriptionUpdateMany.mockResolvedValue({ count: 1 });
    mocks.mobileSubscriptionFindUnique.mockResolvedValue({
      id: "mobile-sub-1", tenantId: "tenant-1", provider: "google", status: "revoked",
    });

    const result = await postVerify("google", "com.braavolabs.individual.monthly");

    expect(result).toMatchObject({ status: 200, body: { outcome: "inactive" } });
    expect(mocks.verifyGoogleReceipt).toHaveBeenCalledTimes(2);
    expect(mocks.mobileSubscriptionUpdateMany).toHaveBeenCalledTimes(1);
    expect(mocks.recordEntitlementEvent).toHaveBeenCalledWith(expect.objectContaining({
      source: "google", type: "revoke", planTier: null,
    }), expect.objectContaining({ rootIdentity }));
    expect(mocks.acknowledgeGoogleReceipt).not.toHaveBeenCalled();
  });

  it("re-fetches after a second-fence Google conflict and keeps the newer revoke", async () => {
    const rootIdentity = `google:${"9".repeat(64)}`;
    const active = {
      ...verifiedReceipt(rootIdentity),
      googleCanonicalRootIdentity: rootIdentity,
      googlePurchaseAliases: [rootIdentity],
      googleAcknowledgementPending: false,
    };
    mocks.verifyGoogleReceipt.mockResolvedValueOnce(active)
      .mockResolvedValueOnce({ ...active, status: "revoked" });
    mocks.googlePurchaseAliasFindMany.mockResolvedValue([{
      tokenDigest: rootIdentity,
      state: "active",
      tenantId: "tenant-1",
      mobileSubscriptionId: "mobile-sub-1",
      provider: "google",
      canonicalRootIdentity: rootIdentity,
    }]);
    mocks.mobileSubscriptionUpdateMany.mockResolvedValue({ count: 1 });
    mocks.mobileSubscriptionFindUnique.mockResolvedValue({
      id: "mobile-sub-1", tenantId: "tenant-1", provider: "google", status: "revoked",
    });
    mocks.recordEntitlementEvent.mockRejectedValueOnce(
      new AppError(409, "Google verification was superseded; retry"),
    ).mockResolvedValueOnce("MANUAL_REVIEW");

    const result = await postVerify("google", "com.braavolabs.individual.monthly");

    expect(result).toMatchObject({ status: 200, body: { outcome: "inactive" } });
    expect(mocks.verifyGoogleReceipt).toHaveBeenCalledTimes(2);
    expect(mocks.recordEntitlementEvent).toHaveBeenCalledTimes(2);
    expect(mocks.recordEntitlementEvent).toHaveBeenLastCalledWith(expect.objectContaining({
      source: "google", type: "revoke", planTier: null,
    }), expect.objectContaining({ rootIdentity }));
    expect(mocks.acknowledgeGoogleReceipt).not.toHaveBeenCalled();
  });

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
      latestReceipt: null,
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
    ["com.braavolabs.team.monthly", "TEAM", "PRO"],
    ["com.braavolabs.team.yearly", "TEAM", "PRO"],
    ["com.braavolabs.creator.monthly", "INDIVIDUAL", "CREATOR"],
    ["com.braavolabs.pro.yearly", "TEAM", "PRO"],
  ] as const)("provider-verifies restore-only %s and returns public %s", async (productId, receiptTier, internalPlan) => {
    mocks.verifyAppleReceipt.mockResolvedValue(verifiedReceipt(`raw-${productId}`));
    mocks.recordEntitlementEvent.mockResolvedValue(receiptTier);

    const result = await postVerify("apple", productId);

    expect(result).toMatchObject({
      status: 200,
      body: {
        outcome: "granted",
        receiptTier,
        effectiveTier: receiptTier,
        providerStatus: "active",
        expiresAt: ACTIVE_EXPIRY.toISOString(),
      },
    });
    expect(mocks.verifyAppleReceipt).toHaveBeenCalled();
    expect(mocks.recordEntitlementEvent).toHaveBeenCalledWith(expect.objectContaining({ planTier: internalPlan }));
  });

  it.each([
    "com.braavolabs.business.monthly",
    "com.braavolabs.enterprise.yearly",
  ] as const)("provider-verifies %s before returning a durable manual-review case", async (productId) => {
    const raw = `raw-${productId}`;
    mocks.verifyAppleReceipt.mockResolvedValue(verifiedReceipt(raw));

    const result = await postVerify("apple", productId);

    expect(result).toMatchObject({
      status: 200,
      body: {
        outcome: "manual_review",
        receiptTier: null,
        effectiveTier: "INDIVIDUAL",
        providerStatus: "active",
        reviewCaseId: "iap_review_pending_case",
      },
    });
    expect(mocks.verifyAppleReceipt.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.ensureManualReviewCase.mock.invocationCallOrder[0],
    );
    expect(mocks.ensureManualReviewCase).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "tenant-1",
      productId,
      providerIdentity: raw,
    }));
    expect(mocks.recordEntitlementEvent).not.toHaveBeenCalled();
    expect(mocks.acknowledgeGoogleReceipt).not.toHaveBeenCalled();
    expect(JSON.stringify(result.body)).not.toContain(raw);
  });

  it("grants an approved manual mapping only after a fresh Google provider/ownership/ledger/ack chain", async () => {
    const token = "google-approved-review-token";
    const rootIdentity = `google:${"5".repeat(64)}`;
    mocks.verifyGoogleReceipt.mockResolvedValue({
      ...verifiedReceipt(rootIdentity),
      googleCanonicalRootIdentity: rootIdentity,
      googlePurchaseAliases: [rootIdentity],
      googleAcknowledgementPending: true,
    });
    mocks.googlePurchaseAliasFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        tokenDigest: rootIdentity,
        state: "active",
        tenantId: "tenant-1",
        mobileSubscriptionId: "mobile-sub-1",
        provider: "google",
        canonicalRootIdentity: rootIdentity,
      }]);
    mocks.googlePurchaseAliasCreateMany.mockResolvedValue({ count: 1 });
    mocks.ensureManualReviewCase.mockResolvedValue({
      caseId: "iap_review_approved_case",
      state: "approved_mapping",
      targetTier: "TEAM",
    });
    mocks.recordEntitlementEvent.mockResolvedValue("TEAM");

    const result = await postVerify("google", "com.braavolabs.business.monthly", { receipt: token });

    expect(result).toMatchObject({
      status: 200,
      body: {
        outcome: "granted",
        receiptTier: "TEAM",
        effectiveTier: "TEAM",
        providerStatus: "active",
      },
    });
    expect(result.body).not.toHaveProperty("reviewCaseId");
    expect(mocks.verifyGoogleReceipt.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.mobileSubscriptionCreate.mock.invocationCallOrder[0],
    );
    expect(mocks.mobileSubscriptionCreate.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.recordEntitlementEvent.mock.invocationCallOrder[0],
    );
    expect(mocks.recordEntitlementEvent.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.acknowledgeGoogleReceipt.mock.invocationCallOrder[0],
    );
  });

  it.each(["pending", "rejected", "expired"] as const)(
    "keeps a %s manual-review decision non-granting and non-acknowledging",
    async (state) => {
      mocks.verifyAppleReceipt.mockResolvedValue(verifiedReceipt(`apple-review-${state}`));
      mocks.ensureManualReviewCase.mockResolvedValue({
        caseId: `iap_review_${state}`,
        state,
        targetTier: null,
      });

      const result = await postVerify("apple", "com.braavolabs.business.monthly");

      expect(result).toMatchObject({
        status: 200,
        body: {
          outcome: "manual_review",
          receiptTier: null,
          reviewCaseId: `iap_review_${state}`,
        },
      });
      expect(mocks.recordEntitlementEvent).not.toHaveBeenCalled();
      expect(mocks.acknowledgeGoogleReceipt).not.toHaveBeenCalled();
    },
  );

  it("does not open or advance manual review for an inactive provider receipt", async () => {
    mocks.verifyAppleReceipt.mockResolvedValue({
      ...verifiedReceipt("apple-inactive-business"),
      status: "revoked",
    });
    mocks.getManualReviewCase.mockResolvedValue(null);

    const result = await postVerify("apple", "com.braavolabs.business.monthly");

    expect(result).toMatchObject({ status: 200, body: { outcome: "inactive", receiptTier: null } });
    expect(mocks.getManualReviewCase).toHaveBeenCalledWith("tenant-1", "iap_review_provider_case");
    expect(mocks.ensureManualReviewCase).not.toHaveBeenCalled();
    expect(mocks.recordEntitlementEvent).not.toHaveBeenCalled();
    expect(mocks.acknowledgeGoogleReceipt).not.toHaveBeenCalled();
  });

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
      body: {
        outcome: "granted",
        receiptTier: "INDIVIDUAL",
        effectiveTier: "INDIVIDUAL",
        providerStatus: "active",
      },
    });
    expect(mocks.verifyAppleReceipt).toHaveBeenCalledWith(
      "store-proof",
      "com.braavolabs.individual.monthly",
    );
    expect(mocks.mobileSubscriptionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ planTier: "CREATOR", latestReceipt: null }),
      }),
    );
    expect(JSON.stringify(mocks.mobileSubscriptionCreate.mock.calls)).not.toContain("store-proof");
    expect(JSON.stringify(mocks.loggerError.mock.calls)).not.toContain("store-proof");
    expect(JSON.stringify(mocks.loggerWarn.mock.calls)).not.toContain("store-proof");
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
      body: {
        outcome: "granted",
        receiptTier: "INDIVIDUAL",
        effectiveTier: "INDIVIDUAL",
        providerStatus: "active",
      },
    });
    expect(mocks.mobileSubscriptionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ planTier: "CREATOR" }),
      }),
    );
  });

  it("separates an Individual receipt tier from a higher effective Team projection", async () => {
    mocks.verifyAppleReceipt.mockResolvedValue(verifiedReceipt("apple-individual-under-team"));
    mocks.recordEntitlementEvent.mockResolvedValue("TEAM");

    const result = await postVerify("apple", "com.braavolabs.individual.monthly");

    expect(result).toMatchObject({
      status: 200,
      body: {
        outcome: "granted",
        receiptTier: "INDIVIDUAL",
        effectiveTier: "TEAM",
        providerStatus: "active",
      },
    });
  });

  it.each(["expired", "revoked", "paused"] as const)(
    "records provider status %s as a terminal event before returning the shared projection",
    async (status) => {
      mocks.verifyAppleReceipt.mockResolvedValue({
        ...verifiedReceipt(`apple-${status}-credential`),
        status,
      });
      mocks.getEntitlementProjection.mockResolvedValueOnce({
        effectiveTier: null,
        winner: null,
        source: null,
        streamId: null,
        expiresAt: null,
        autoRenew: null,
        hasManualReview: false,
      });

      const result = await postVerify("apple", "com.braavolabs.team.monthly");

      expect(result).toMatchObject({
        status: 200,
        body: {
          outcome: "inactive",
          receiptTier: null,
          effectiveTier: null,
          providerStatus: "inactive",
        },
      });
      expect(mocks.recordEntitlementEvent).toHaveBeenCalledWith(expect.objectContaining({
        tenantId: "tenant-1",
        source: "apple",
        streamId: expect.stringMatching(/^apple:[a-f0-9]{64}$/),
        type: "revoke",
        planTier: null,
        expiresAt: null,
        autoRenew: false,
      }));
      expect(mocks.mobileSubscriptionCreate.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.recordEntitlementEvent.mock.invocationCallOrder[0],
      );
      expect(mocks.recordEntitlementEvent.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.getEntitlementProjection.mock.invocationCallOrder[0],
      );
      expect(mocks.acknowledgeGoogleReceipt).not.toHaveBeenCalled();
    },
  );

  it("closes the same canonical stream that an earlier active verify opened", async () => {
    const identity = "apple-active-then-expired";
    mocks.verifyAppleReceipt
      .mockResolvedValueOnce(verifiedReceipt(identity))
      .mockResolvedValueOnce({ ...verifiedReceipt(identity), status: "expired" });
    mocks.getEntitlementProjection.mockResolvedValueOnce({
      effectiveTier: null,
      winner: null,
      source: null,
      streamId: null,
      expiresAt: null,
      autoRenew: null,
      hasManualReview: false,
    });

    expect((await postVerify("apple", "com.braavolabs.team.monthly")).body.outcome).toBe("granted");
    expect((await postVerify("apple", "com.braavolabs.team.monthly")).body).toMatchObject({
      outcome: "inactive",
      effectiveTier: null,
    });

    const [grant, terminal] = mocks.recordEntitlementEvent.mock.calls.map(([event]) => event);
    expect(terminal).toMatchObject({ streamId: grant.streamId, type: "revoke", planTier: null });
  });

  it.each(["pending", "rejected", "expired"] as const)(
    "keeps an inactive %s manual-review case non-granting and non-acknowledging",
    async (state) => {
      mocks.verifyAppleReceipt.mockResolvedValue({
        ...verifiedReceipt(`apple-inactive-review-${state}`),
        status: "revoked",
      });
      mocks.getManualReviewCase.mockResolvedValue({
        caseId: "iap_review_provider_case",
        state,
        targetTier: null,
      });
      mocks.ensureManualReviewCase.mockResolvedValue({
        caseId: "iap_review_provider_case",
        state,
        targetTier: null,
      });

      const result = await postVerify("apple", "com.braavolabs.business.monthly");

      expect(result).toMatchObject({ status: 200, body: { outcome: "inactive", receiptTier: null } });
      expect(mocks.getManualReviewCase).toHaveBeenCalledWith("tenant-1", "iap_review_provider_case");
      expect(mocks.ensureManualReviewCase).toHaveBeenCalledTimes(1);
      expect(mocks.recordEntitlementEvent).not.toHaveBeenCalled();
      expect(mocks.acknowledgeGoogleReceipt).not.toHaveBeenCalled();
    },
  );

  it("writes an inactive approved mapping to its mapped canonical stream without acknowledgement", async () => {
    mocks.verifyAppleReceipt.mockResolvedValue({
      ...verifiedReceipt("apple-inactive-approved-review"),
      status: "revoked",
    });
    mocks.getManualReviewCase.mockResolvedValue({
      caseId: "iap_review_provider_case",
      state: "approved_mapping",
      targetTier: "TEAM",
    });
    mocks.ensureManualReviewCase.mockResolvedValue({
      caseId: "iap_review_provider_case",
      state: "approved_mapping",
      targetTier: "TEAM",
    });

    const result = await postVerify("apple", "com.braavolabs.business.monthly");

    expect(result).toMatchObject({ status: 200, body: { outcome: "inactive", receiptTier: null } });
    expect(mocks.recordEntitlementEvent).toHaveBeenCalledWith(expect.objectContaining({
      source: "apple",
      type: "revoke",
      planTier: null,
    }));
    expect(mocks.ensureManualReviewCase.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.recordEntitlementEvent.mock.invocationCallOrder[0],
    );
    expect(mocks.acknowledgeGoogleReceipt).not.toHaveBeenCalled();
  });

  it("awaits Google acknowledgement after ownership and ledger, surfacing a redacted 503 on failure", async () => {
    const token = "google-raw-purchase-token-sentinel";
    const rootIdentity = `google:${"6".repeat(64)}`;
    mocks.verifyGoogleReceipt.mockResolvedValue({
      ...verifiedReceipt(rootIdentity),
      googleCanonicalRootIdentity: rootIdentity,
      googlePurchaseAliases: [rootIdentity],
      googleAcknowledgementPending: true,
    });
    mocks.googlePurchaseAliasFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        tokenDigest: rootIdentity,
        state: "active",
        tenantId: "tenant-1",
        mobileSubscriptionId: "mobile-sub-1",
        provider: "google",
        canonicalRootIdentity: rootIdentity,
      }]);
    mocks.googlePurchaseAliasCreateMany.mockResolvedValue({ count: 1 });
    mocks.acknowledgeGoogleReceipt.mockRejectedValue(new Error(`provider failed for ${token}`));

    const result = await postVerify("google", "com.braavolabs.individual.monthly", { receipt: token });

    expect(result).toEqual({ status: 503, body: { error: "Google purchase acknowledgement failed" } });
    expect(mocks.mobileSubscriptionCreate.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.recordEntitlementEvent.mock.invocationCallOrder[0],
    );
    expect(mocks.recordEntitlementEvent.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.acknowledgeGoogleReceipt.mock.invocationCallOrder[0],
    );
    expect(JSON.stringify([result.body, mocks.loggerError.mock.calls, mocks.loggerWarn.mock.calls])).not.toContain(token);
  });

  it("does not acknowledge when entitlement-ledger persistence fails", async () => {
    const rootIdentity = `google:${"4".repeat(64)}`;
    mocks.verifyGoogleReceipt.mockResolvedValue({
      ...verifiedReceipt(rootIdentity),
      googleCanonicalRootIdentity: rootIdentity,
      googlePurchaseAliases: [rootIdentity],
      googleAcknowledgementPending: true,
    });
    mocks.googlePurchaseAliasFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        tokenDigest: rootIdentity,
        state: "active",
        tenantId: "tenant-1",
        mobileSubscriptionId: "mobile-sub-1",
        provider: "google",
        canonicalRootIdentity: rootIdentity,
      }]);
    mocks.googlePurchaseAliasCreateMany.mockResolvedValue({ count: 1 });
    mocks.recordEntitlementEvent.mockRejectedValue(new Error("database unavailable"));

    const result = await postVerify("google", "com.braavolabs.individual.monthly");

    expect(result).toEqual({ status: 503, body: { error: "Entitlement persistence temporarily unavailable" } });
    expect(mocks.acknowledgeGoogleReceipt).not.toHaveBeenCalled();
  });

  it("redacts raw provider failures from logs and public errors", async () => {
    const receipt = "full-apple-receipt-sentinel";
    mocks.verifyAppleReceipt.mockRejectedValue(new Error(`provider leaked ${receipt}`));

    const result = await postVerify("apple", "com.braavolabs.individual.monthly", { receipt });

    expect(result).toEqual({ status: 500, body: { error: "Receipt verification failed" } });
    expect(JSON.stringify([result.body, mocks.loggerError.mock.calls, mocks.loggerWarn.mock.calls])).not.toContain(receipt);
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
        data: expect.objectContaining({ latestReceipt: null }),
      }),
    );
    expect(mocks.mobileSubscriptionFindUnique).toHaveBeenCalledWith({
      where: { originalTransactionId: transactionId, tenantId: "tenant-owner" },
    });
    expect(storedSubscription).toMatchObject({
      tenantId: "tenant-owner",
      latestReceipt: null,
    });
    const persistenceCalls = JSON.stringify([
      mocks.mobileSubscriptionCreate.mock.calls,
      mocks.mobileSubscriptionUpdateMany.mock.calls,
    ]);
    expect(persistenceCalls).not.toContain("receipt-first");
    expect(persistenceCalls).not.toContain("receipt-renewal");
    expect(JSON.stringify(mocks.loggerError.mock.calls)).not.toContain("receipt-renewal");
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
  it("returns the shared all-stream projection instead of the latest mobile row", async () => {
    mocks.getEntitlementProjection.mockResolvedValue({
      effectiveTier: "TEAM",
      winner: {
        source: "google",
        streamId: "google:team",
        expiresAt: ACTIVE_EXPIRY,
        autoRenew: false,
      },
      hasManualReview: true,
    });

    const result = await getEntitlement();

    expect(result).toEqual({
      status: 200,
      body: {
        hasActiveMobileSubscription: true,
        planTier: "TEAM",
        effectiveTier: "TEAM",
        expiresAt: ACTIVE_EXPIRY.toISOString(),
        provider: "google",
        autoRenew: false,
        hasManualReview: true,
      },
    });
    expect(mocks.getEntitlementProjection).toHaveBeenCalledWith("tenant-1");
    expect(mocks.mobileSubscriptionFindFirst).not.toHaveBeenCalled();
  });

  it("returns null paid tier while keeping manual-review visibility", async () => {
    mocks.getEntitlementProjection.mockResolvedValue({
      effectiveTier: null,
      winner: null,
      hasManualReview: true,
    });

    const result = await getEntitlement();

    expect(result).toEqual({
      status: 200,
      body: {
        hasActiveMobileSubscription: false,
        planTier: null,
        effectiveTier: null,
        expiresAt: null,
        provider: null,
        autoRenew: null,
        hasManualReview: true,
      },
    });
  });

  it("adds tenant-scoped pending-case visibility without replacing an active Individual projection", async () => {
    mocks.getEntitlementProjection.mockResolvedValue({
      effectiveTier: "INDIVIDUAL",
      winner: {
        source: "apple",
        streamId: "apple:individual",
        expiresAt: ACTIVE_EXPIRY,
        autoRenew: true,
      },
      hasManualReview: false,
    });
    mocks.hasPendingManualReviewCases.mockResolvedValue(true);

    const result = await getEntitlement();

    expect(result).toMatchObject({
      status: 200,
      body: {
        effectiveTier: "INDIVIDUAL",
        hasActiveMobileSubscription: true,
        hasManualReview: true,
      },
    });
    expect(mocks.hasPendingManualReviewCases).toHaveBeenCalledWith("tenant-1");
  });

  it("fails closed when pending-case visibility cannot be read", async () => {
    mocks.getEntitlementProjection.mockResolvedValue({
      effectiveTier: "INDIVIDUAL",
      winner: null,
      hasManualReview: false,
    });
    mocks.hasPendingManualReviewCases.mockRejectedValue(new Error("activity store unavailable"));

    const result = await getEntitlement();

    expect(result).toEqual({ status: 500, body: { error: "activity store unavailable" } });
  });
});

describe("manual-review operator decision boundary", () => {
  it("rejects an unsafe generic note before case, provider, subscription, ledger or acknowledgement work", async () => {
    const opaqueReason = `gp_${"A1b2C3d4".repeat(8)}`;
    mocks.validateManualReviewReason.mockImplementationOnce(() => {
      throw new AppError(400, "Manual review reason must be a plain human note without credential material");
    });

    const result = await postManualReviewDecision("OWNER", "tenant-1", {
      state: "approved_mapping",
      targetTier: "TEAM",
      reason: opaqueReason,
      receipt: "operator-apple-receipt",
    });

    expect(result.status).toBe(400);
    expect(mocks.validateManualReviewReason).toHaveBeenCalledWith(
      opaqueReason,
      ["operator-apple-receipt"],
    );
    expect(mocks.getManualReviewCase).not.toHaveBeenCalled();
    expect(mocks.verifyAppleReceipt).not.toHaveBeenCalled();
    expect(mocks.verifyGoogleReceipt).not.toHaveBeenCalled();
    expect(mocks.mobileSubscriptionUpdateMany).not.toHaveBeenCalled();
    expect(mocks.transitionManualReviewCase).not.toHaveBeenCalled();
    expect(mocks.recordEntitlementEvent).not.toHaveBeenCalled();
    expect(mocks.acknowledgeGoogleReceipt).not.toHaveBeenCalled();
  });

  it("rechecks the verified provider identity before mutating subscription ownership", async () => {
    const providerIdentity = "owner-stream-id";
    mocks.verifyAppleReceipt.mockResolvedValue(verifiedReceipt(providerIdentity));
    mocks.validateManualReviewReason
      .mockImplementationOnce((reason: string) => reason)
      .mockImplementationOnce(() => {
        throw new AppError(400, "Manual review reason must be a plain human note without credential material");
      });

    const result = await postManualReviewDecision("OWNER", "tenant-1", {
      state: "approved_mapping",
      targetTier: "TEAM",
      reason: providerIdentity,
      receipt: "operator-apple-receipt",
    });

    expect(result.status).toBe(400);
    expect(mocks.verifyAppleReceipt).toHaveBeenCalledOnce();
    expect(mocks.validateManualReviewReason).toHaveBeenNthCalledWith(
      2,
      providerIdentity,
      ["operator-apple-receipt", providerIdentity],
    );
    expect(mocks.mobileSubscriptionUpdateMany).not.toHaveBeenCalled();
    expect(mocks.transitionManualReviewCase).not.toHaveBeenCalled();
    expect(mocks.recordEntitlementEvent).not.toHaveBeenCalled();
    expect(mocks.acknowledgeGoogleReceipt).not.toHaveBeenCalled();
  });

  it.each(["ADMIN", "MEMBER", "UNKNOWN"] as const)(
    "denies %s before body handling or service work",
    async (role) => {
      const denied = await postManualReviewDecision(role);
      expect(denied.status).toBe(403);
      expect(mocks.transitionManualReviewCase).not.toHaveBeenCalled();
    },
  );

  it("requires authentication before body handling or service work", async () => {
    expect((await postManualReviewDecision()).status).toBe(401);
    expect(mocks.transitionManualReviewCase).not.toHaveBeenCalled();
  });

  it("allows OWNER and passes the authenticated tenant to append-only transition", async () => {
    mocks.getManualReviewCase.mockResolvedValue({
      ...(await mocks.getManualReviewCase()),
      tenantId: "tenant-operator",
    });
    mocks.mobileSubscriptionUpdateMany.mockResolvedValue({ count: 1 });
    const allowed = await postManualReviewDecision("OWNER", "tenant-operator");
    expect(allowed).toMatchObject({
      status: 200,
      body: { caseId: "iap_review_pending_case", state: "approved_mapping", targetTier: "TEAM" },
    });
    expect(mocks.transitionManualReviewCase).toHaveBeenCalledWith({
      tenantId: "tenant-operator",
      actor: "user-for-tenant-operator",
      caseId: "iap_review_pending_case",
      state: "approved_mapping",
      targetTier: "TEAM",
      reason: "provider records verified by billing operator",
    });
    expect(mocks.verifyAppleReceipt).toHaveBeenCalledWith(
      "operator-apple-receipt",
      "com.braavolabs.business.monthly",
    );
    expect(mocks.recordEntitlementEvent).toHaveBeenCalledOnce();
    expect(mocks.acknowledgeGoogleReceipt).not.toHaveBeenCalled();
  });

  it("fresh-verifies Google ownership, appends mapping, grants idempotently, then awaits acknowledgement", async () => {
    const token = "operator-google-receipt-sentinel";
    const rootIdentity = `google:${"3".repeat(64)}`;
    mocks.getManualReviewCase.mockResolvedValue({
      caseId: "iap_review_pending_case",
      tenantId: "tenant-1",
      provider: "google",
      productId: "com.braavolabs.business.monthly",
      internalPlan: "BUSINESS",
      subscriptionId: "mobile-sub-google",
      identityRef: iapCredentialDigest("google", rootIdentity),
      state: "pending",
      targetTier: null,
    });
    mocks.verifyGoogleReceipt.mockResolvedValue({
      ...verifiedReceipt(rootIdentity),
      googleCanonicalRootIdentity: rootIdentity,
      googlePurchaseAliases: [rootIdentity],
      googleAcknowledgementPending: true,
    });
    mocks.googlePurchaseAliasFindMany.mockResolvedValue([{
      tokenDigest: rootIdentity,
      state: "active",
      tenantId: "tenant-1",
      mobileSubscriptionId: "mobile-sub-google",
      provider: "google",
      canonicalRootIdentity: rootIdentity,
    }]);
    mocks.mobileSubscriptionUpdateMany.mockResolvedValue({ count: 1 });
    mocks.mobileSubscriptionFindUnique.mockResolvedValue({
      id: "mobile-sub-google",
      tenantId: "tenant-1",
      provider: "google",
      productId: "com.braavolabs.business.monthly",
    });
    mocks.recordEntitlementEvent.mockResolvedValue("TEAM");

    const result = await postManualReviewDecision("OWNER", "tenant-1", {
      state: "approved_mapping",
      targetTier: "TEAM",
      reason: "fresh provider history verified",
      receipt: token,
    });

    expect(result).toMatchObject({
      status: 200,
      body: { state: "approved_mapping", targetTier: "TEAM", effectiveTier: "TEAM" },
    });
    expect(mocks.verifyGoogleReceipt.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.mobileSubscriptionUpdateMany.mock.invocationCallOrder[0]);
    expect(mocks.mobileSubscriptionUpdateMany.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.transitionManualReviewCase.mock.invocationCallOrder[0]);
    expect(mocks.recordGoogleEntitlementWithDecision.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.transitionManualReviewCase.mock.invocationCallOrder[0]);
    expect(mocks.transitionManualReviewCase.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.acknowledgeGoogleReceipt.mock.invocationCallOrder[0]);
    expect(mocks.recordEntitlementEvent).not.toHaveBeenCalled();
    expect(JSON.stringify([result.body, mocks.loggerError.mock.calls, mocks.loggerWarn.mock.calls]))
      .not.toContain(token);
  });

  it.each([
    ["approved_mapping", "active"],
    ["expired", "expired"],
  ] as const)("keeps a late old-token %s review decision pending when a replacement wins the second fence", async (
    decisionState, providerStatus,
  ) => {
    const rootIdentity = `google:${"3".repeat(64)}`;
    mocks.getManualReviewCase.mockResolvedValue({
      caseId: "iap_review_pending_case",
      tenantId: "tenant-1",
      provider: "google",
      productId: "com.braavolabs.business.monthly",
      internalPlan: "BUSINESS",
      subscriptionId: "mobile-sub-google",
      identityRef: iapCredentialDigest("google", rootIdentity),
      state: "pending",
      targetTier: null,
    });
    mocks.verifyGoogleReceipt.mockResolvedValue({
      ...verifiedReceipt(rootIdentity),
      status: providerStatus,
      googleCanonicalRootIdentity: rootIdentity,
      googlePurchaseAliases: [rootIdentity],
      googleAcknowledgementPending: true,
    });
    mocks.googlePurchaseAliasFindMany.mockResolvedValue([{
      tokenDigest: rootIdentity,
      state: "active",
      tenantId: "tenant-1",
      mobileSubscriptionId: "mobile-sub-google",
      provider: "google",
      canonicalRootIdentity: rootIdentity,
    }]);
    mocks.mobileSubscriptionUpdateMany.mockResolvedValue({ count: 1 });
    mocks.mobileSubscriptionFindUnique.mockResolvedValue({
      id: "mobile-sub-google",
      tenantId: "tenant-1",
      provider: "google",
      productId: "com.braavolabs.business.monthly",
    });
    if (decisionState === "expired") {
      mocks.withCurrentGooglePurchase.mockResolvedValueOnce(null);
    } else {
      mocks.recordGoogleEntitlementWithDecision.mockResolvedValueOnce(null);
    }

    const result = await postManualReviewDecision("OWNER", "tenant-1", {
      state: decisionState,
      ...(decisionState === "approved_mapping" ? { targetTier: "TEAM" } : {}),
      reason: "fresh provider history verified",
      receipt: "historical-google-token",
    });

    expect(result.status).toBe(409);
    expect(mocks.mobileSubscriptionUpdateMany).toHaveBeenCalledTimes(1);
    expect(mocks.transitionManualReviewCase).not.toHaveBeenCalled();
    expect(mocks.recordEntitlementEvent).not.toHaveBeenCalled();
    expect(mocks.acknowledgeGoogleReceipt).not.toHaveBeenCalled();
  });

  it("does not approve a historical Google review receipt after a replacement token is owned", async () => {
    const rootIdentity = `google:${"3".repeat(64)}`;
    mocks.getManualReviewCase.mockResolvedValue({
      caseId: "iap_review_pending_case",
      tenantId: "tenant-1",
      provider: "google",
      productId: "com.braavolabs.business.monthly",
      internalPlan: "BUSINESS",
      subscriptionId: "mobile-sub-google",
      identityRef: iapCredentialDigest("google", rootIdentity),
      state: "pending",
      targetTier: null,
    });
    mocks.verifyGoogleReceipt.mockResolvedValue({
      ...verifiedReceipt(rootIdentity),
      googleCanonicalRootIdentity: rootIdentity,
      googlePurchaseAliases: [rootIdentity],
      googleAcknowledgementPending: true,
    });
    mocks.googlePurchaseAliasFindMany.mockResolvedValue([{
      tokenDigest: rootIdentity,
      state: "active",
      tenantId: "tenant-1",
      mobileSubscriptionId: "mobile-sub-google",
      provider: "google",
      canonicalRootIdentity: rootIdentity,
    }]);
    mocks.googlePurchaseAliasFindFirst.mockResolvedValueOnce({
      tokenDigest: `google:${"4".repeat(64)}`,
    });
    mocks.mobileSubscriptionFindUnique.mockResolvedValue({
      id: "mobile-sub-google",
      tenantId: "tenant-1",
      provider: "google",
      productId: "com.braavolabs.business.monthly",
    });

    const result = await postManualReviewDecision("OWNER", "tenant-1", {
      state: "approved_mapping",
      targetTier: "TEAM",
      reason: "fresh provider history verified",
      receipt: "historical-google-token",
    });

    expect(result.status).toBe(409);
    expect(mocks.mobileSubscriptionUpdateMany).not.toHaveBeenCalled();
    expect(mocks.transitionManualReviewCase).not.toHaveBeenCalled();
    expect(mocks.recordEntitlementEvent).not.toHaveBeenCalled();
    expect(mocks.acknowledgeGoogleReceipt).not.toHaveBeenCalled();
  });

  it("does not expose a case from another authenticated tenant", async () => {
    mocks.getManualReviewCase.mockResolvedValue(null);
    const result = await postManualReviewDecision("OWNER", "tenant-other", {
      state: "rejected",
      reason: "not owned by this tenant",
    });
    expect(result.status).toBe(404);
    expect(mocks.getManualReviewCase).toHaveBeenCalledWith("tenant-other", "iap_review_pending_case");
    expect(mocks.transitionManualReviewCase).not.toHaveBeenCalled();
    expect(mocks.verifyAppleReceipt).not.toHaveBeenCalled();
    expect(mocks.verifyGoogleReceipt).not.toHaveBeenCalled();
  });
});

describe("store notification catalog boundary", () => {
  it("does not swallow a transient Google provider failure when reliability flag is disabled", async () => {
    const raw = "google-notification-token-sentinel";
    mocks.parseGoogleRtdnEnvelope.mockReturnValue({
      packageName: "com.braavolabs.mobile",
      kind: "subscription",
      notificationType: 2,
      purchaseToken: raw,
      messageId: "google-transient-message",
      publishTime: new Date("2026-08-28T00:00:00.000Z"),
    });
    mocks.verifyGoogleReceipt.mockRejectedValue(new Error(`provider timeout for ${raw}`));

    const result = await postGoogleNotification("google-transient-message");

    expect(result).toEqual({ status: 503, body: { ok: false, reason: "retry-required" } });
    expect(JSON.stringify([result.body, mocks.loggerError.mock.calls, mocks.loggerWarn.mock.calls])).not.toContain(raw);
    expect(mocks.recordEntitlementEvent).not.toHaveBeenCalled();
  });

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
      kind: "subscription",
      notificationType: 2,
      purchaseToken: "google-unknown-token",
      messageId: "google-unknown-message",
      publishTime: new Date("2026-08-28T00:00:00.000Z"),
    });
    mocks.verifyGoogleReceipt.mockResolvedValue({
      ...verifiedReceipt("google-unknown-transaction"),
      googleProductId: "com.braavolabs.unregistered.monthly",
    });

    const result = await postGoogleNotification("google-unknown-message");

    expect(result).toEqual({ status: 200, body: { ok: false, reason: "unknown-product" } });
    expect(mocks.verifyGoogleReceipt).toHaveBeenCalledWith("google-unknown-token", undefined, expect.any(Function));
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
      const rootIdentity = `google:${"e".repeat(64)}`;
      mocks.parseGoogleRtdnEnvelope.mockReturnValue({
        packageName: "com.braavolabs.mobile",
        kind: "subscription",
        notificationType: 2,
        purchaseToken: "google-known-token",
        messageId: "google-known-message",
        publishTime: new Date("2026-08-28T00:00:00.000Z"),
      });
      mocks.verifyGoogleReceipt.mockResolvedValue({
        ...verifiedReceipt(rootIdentity),
        googleCanonicalRootIdentity: rootIdentity,
        googlePurchaseAliases: [rootIdentity],
        googleAcknowledgementPending: false,
        googleProductId: productId,
        googleLatestSuccessfulOrderId: null,
      });
      mocks.googlePurchaseAliasFindMany.mockResolvedValue([{
        tokenDigest: rootIdentity,
        state: "active",
        tenantId: "tenant-1",
        mobileSubscriptionId: "google-subscription",
        provider: "google",
        canonicalRootIdentity: rootIdentity,
      }]);
      mocks.mobileSubscriptionUpdateMany.mockResolvedValue({ count: 1 });
      mocks.mobileSubscriptionFindUnique.mockResolvedValue({
        id: "google-subscription",
        tenantId: "tenant-1",
        planTier: "ENTERPRISE",
      });
      result = await postGoogleNotification("google-known-message");
    }

    expect(result).toEqual({ status: 200, body: { ok: true } });
    if (provider === "apple") {
      expect(mocks.mobileSubscriptionUpdate).toHaveBeenCalledTimes(1);
    } else {
      expect(mocks.mobileSubscriptionUpdateMany).toHaveBeenCalledTimes(1);
      expect(mocks.mobileSubscriptionUpdate).not.toHaveBeenCalled();
    }
    expect(mocks.recordEntitlementEvent).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "tenant-1", planTier }),
      ...(provider === "google" ? [expect.objectContaining({ rootIdentity: expect.any(String) })] : []),
    );
    expect(mocks.activityLogUpsert).toHaveBeenCalledTimes(1);
  });
});

describe("single catalog authority wiring", () => {
  it("removes the router-local map and feeds both notification paths from the adapter", () => {
    const routerSource = readFileSync(resolve(__dirname, "../router.ts"), "utf8");

    expect(routerSource).not.toContain("PRODUCT_TIER_MAP");
    expect(routerSource).toContain('from "./catalog"');
    expect(routerSource).toContain("getIapProduct(");
  });
});
