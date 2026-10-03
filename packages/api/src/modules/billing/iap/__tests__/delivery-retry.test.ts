import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";

const routeMocks = vi.hoisted(() => ({
  prisma: {} as Record<string, unknown>,
  parseAppleNotification: vi.fn(),
  verifyAppleReceipt: vi.fn(),
  parseGoogleRtdnEnvelope: vi.fn(),
  verifyGoogleReceipt: vi.fn(),
  acknowledgeGoogleReceipt: vi.fn(),
  verifyPubSubPushToken: vi.fn(),
  recordEntitlementEvent: vi.fn(),
  getEntitlementProjection: vi.fn(),
  ensureManualReviewCase: vi.fn(),
  getManualReviewCase: vi.fn(),
  hasPendingManualReviewCases: vi.fn().mockResolvedValue(false),
  manualReviewCaseId: vi.fn(() => "iap_review_notification_case"),
  validateManualReviewReason: vi.fn((reason: string) => reason.trim()),
  googlePurchaseAliasFindMany: vi.fn(),
  googlePurchaseAliasFindFirst: vi.fn(),
  googlePurchaseAliasCreateMany: vi.fn(),
  tenantTx: vi.fn(),
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../../../lib/db", () => ({
  prisma: routeMocks.prisma,
  tenantTx: routeMocks.tenantTx,
}));
vi.mock("../../../../lib/logger", () => ({ logger: routeMocks.logger }));
vi.mock("../../../../middleware/rateLimit", () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../../../../middleware/system-scope", () => ({
  systemScope: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../../../../config/env", () => ({
  env: {
    NODE_ENV: "test",
    IAP_DELIVERY_RELIABILITY_ENABLED: true,
    IAP_DELIVERY_MAX_ATTEMPTS: 3,
    GOOGLE_PLAY_PACKAGE_NAME: "com.braavolabs.app",
  },
}));
vi.mock("../apple", () => ({
  parseAppleNotification: routeMocks.parseAppleNotification,
  verifyAppleReceipt: routeMocks.verifyAppleReceipt,
}));
vi.mock("../google", () => ({
  parseGoogleRtdnEnvelope: routeMocks.parseGoogleRtdnEnvelope,
  verifyGoogleReceipt: routeMocks.verifyGoogleReceipt,
  acknowledgeGoogleReceipt: routeMocks.acknowledgeGoogleReceipt,
  verifyPubSubPushToken: routeMocks.verifyPubSubPushToken,
}));
vi.mock("../../entitlement-ledger.service", () => ({
  GOOGLE_OBSERVATION_STALE: "Google verification was superseded; retry",
  recordEntitlementEvent: routeMocks.recordEntitlementEvent,
  getEntitlementProjection: routeMocks.getEntitlementProjection,
}));
vi.mock("../manual-review.service", () => ({
  ensureManualReviewCase: routeMocks.ensureManualReviewCase,
  getManualReviewCase: routeMocks.getManualReviewCase,
  hasPendingManualReviewCases: routeMocks.hasPendingManualReviewCases,
  manualReviewCaseId: routeMocks.manualReviewCaseId,
  transitionManualReviewCase: vi.fn(),
  validateManualReviewReason: routeMocks.validateManualReviewReason,
}));
vi.mock("../../entitlement-mapping", () => ({
  NEW_SALE_IAP_PRODUCT_MAP: {
    "com.braavolabs.individual.monthly": "INDIVIDUAL",
    "com.braavolabs.team.monthly": "TEAM",
  },
  LEGACY_IAP_PRODUCT_MAP: {},
  resolveIapProductPlan: (productId: string) =>
    productId.includes("team") ? "TEAM" : "INDIVIDUAL",
  mapIapVerify: vi.fn(),
  mapAppleNotify: (
    note: { notificationUUID: string },
    verified: { status: string; expiresAt: Date; autoRenew: boolean },
    planTier: string,
  ) => {
    const granting = verified.status === "active" || verified.status === "in_grace_period";
    return {
      source: "apple",
      streamId: "apple-stream",
      sourceEventId: note.notificationUUID,
      sourceTimestamp: new Date("2026-08-25T20:00:00Z"),
      type: verified.status === "active" ? "renewal" : verified.status === "in_grace_period" ? "grace" : "revoke",
      planTier: granting ? planTier : null,
      expiresAt: granting ? verified.expiresAt : null,
      autoRenew: granting ? verified.autoRenew : false,
    };
  },
  mapGoogleNotify: (
    note: { messageId: string },
    verified: { status: string; expiresAt: Date; autoRenew: boolean },
    planTier: string,
  ) => {
    const granting = verified.status === "active" || verified.status === "in_grace_period";
    return {
      source: "google",
      streamId: "google-stream",
      sourceEventId: note.messageId,
      sourceTimestamp: new Date("2026-08-25T20:00:00Z"),
      type: verified.status === "active" ? "renewal" : verified.status === "in_grace_period" ? "grace" : "revoke",
      planTier: granting ? planTier : null,
      expiresAt: granting ? verified.expiresAt : null,
      autoRenew: granting ? verified.autoRenew : false,
    };
  },
}));

import {
  IapPoisonDeliveryError,
  IapTransientDeliveryError,
  deliveryFingerprint,
  processIapDelivery,
  type IapDeliveryStore,
} from "../delivery-ledger";
import { env } from "../../../../config/env";
import { AppError } from "../../../../middleware/error";

type DeliveryRow = {
  id: string;
  provider: string;
  deliveryId: string;
  fingerprint: string;
  status: string;
  attempts: number;
  failureCode: string | null;
  processingStartedAt: Date | null;
  processedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function duplicateError() {
  const error = new Error("Unique constraint failed (P2002)");
  Object.assign(error, { code: "P2002" });
  return error;
}

function memoryStore() {
  const rows = new Map<string, DeliveryRow>();
  const writes: unknown[] = [];
  let failNextTerminalWrite = false;
  const keyOf = (provider: string, deliveryId: string) => `${provider}:${deliveryId}`;

  const store: IapDeliveryStore = {
    async create(args) {
      writes.push(args);
      const key = keyOf(args.data.provider, args.data.deliveryId);
      if (rows.has(key)) throw duplicateError();
      const now = new Date();
      const row: DeliveryRow = {
        id: `delivery-${rows.size + 1}`,
        provider: args.data.provider,
        deliveryId: args.data.deliveryId,
        fingerprint: args.data.fingerprint,
        status: args.data.status,
        attempts: args.data.attempts,
        failureCode: null,
        processingStartedAt: args.data.processingStartedAt,
        processedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      rows.set(key, row);
      return row;
    },
    async findUnique(args) {
      const { provider, deliveryId } = args.where.provider_deliveryId;
      return rows.get(keyOf(provider, deliveryId)) ?? null;
    },
    async updateMany(args) {
      writes.push(args);
      if (failNextTerminalWrite && ["SUCCEEDED", "POISONED"].includes(String(args.data.status))) {
        failNextTerminalWrite = false;
        throw new Error("database temporarily unavailable");
      }
      let count = 0;
      for (const row of rows.values()) {
        const status = args.where.status;
        const statusMatches = Array.isArray(status?.in)
          ? status.in.includes(row.status)
          : status === undefined || row.status === status;
        if (row.id !== args.where.id || !statusMatches) continue;
        if (args.where.attempts !== undefined && row.attempts !== args.where.attempts) continue;
        Object.assign(row, args.data, { updatedAt: new Date() });
        if (args.data.attempts?.increment) row.attempts += args.data.attempts.increment;
        count += 1;
      }
      return { count };
    },
  };

  return {
    store,
    rows,
    writes,
    failTerminalWrite() {
      failNextTerminalWrite = true;
    },
  };
}

const appleDelivery = {
  provider: "apple" as const,
  deliveryId: "notification-uuid-1",
  fingerprint: deliveryFingerprint("signed-payload-secret"),
};

describe("durable IAP delivery reliability", () => {
  it("quarantines permanent poison with a redacted durable record and terminal acknowledgement", async () => {
    const db = memoryStore();
    const result = await processIapDelivery(
      appleDelivery,
      async () => {
        throw new IapPoisonDeliveryError("APPLE_JWS_INVALID");
      },
      db.store,
    );

    expect(result).toEqual({ disposition: "poisoned", httpStatus: 200 });
    expect([...db.rows.values()][0]).toMatchObject({
      status: "POISONED",
      failureCode: "APPLE_JWS_INVALID",
      attempts: 1,
    });
    const persisted = JSON.stringify(db.writes);
    expect(persisted).not.toContain("signed-payload-secret");
    expect(persisted).not.toContain("signedPayload");
  });

  it("returns a retriable failure without a false acknowledgement, then source redelivery succeeds", async () => {
    const db = memoryStore();
    const effect = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new IapTransientDeliveryError("PROVIDER_UNAVAILABLE"))
      .mockResolvedValueOnce(undefined);

    await expect(processIapDelivery(appleDelivery, effect, db.store)).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      httpStatus: 503,
    });
    expect([...db.rows.values()][0]).toMatchObject({ status: "RETRYABLE", attempts: 1 });

    const redelivered = await processIapDelivery(appleDelivery, effect, db.store);
    expect(redelivered).toEqual({ disposition: "processed", httpStatus: 200 });
    expect([...db.rows.values()][0]).toMatchObject({ status: "SUCCEEDED", attempts: 2 });
  });

  it("deduplicates a valid delivery so its business effect occurs once", async () => {
    const db = memoryStore();
    const effect = vi.fn(async () => undefined);

    expect(await processIapDelivery(appleDelivery, effect, db.store)).toMatchObject({
      disposition: "processed",
    });
    expect(await processIapDelivery(appleDelivery, effect, db.store)).toMatchObject({
      disposition: "duplicate",
    });
    expect(effect).toHaveBeenCalledTimes(1);
  });

  it("never acknowledges when the terminal ledger write itself fails", async () => {
    const db = memoryStore();
    db.failTerminalWrite();
    await expect(
      processIapDelivery(appleDelivery, async () => undefined, db.store),
    ).rejects.toMatchObject({ code: "DELIVERY_SUCCESS_UNSEALED", httpStatus: 503 });
    expect([...db.rows.values()][0].status).toBe("RETRYABLE");
  });

  it("never poisons a completed effect when the final-attempt success seal fails", async () => {
    const db = memoryStore();
    const subscriptions = new Map<string, string>();
    const entitlements = new Set<string>();
    const activities = new Set<string>();
    const effect = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new IapTransientDeliveryError("APPLE_PROVIDER_UNAVAILABLE"))
      .mockRejectedValueOnce(new IapTransientDeliveryError("APPLE_PROVIDER_UNAVAILABLE"))
      .mockImplementation(async () => {
        subscriptions.set("apple-stream-final-seal", "active");
        entitlements.add("apple:notification-uuid-1");
        activities.add(`iap_${deliveryFingerprint("apple:notification-uuid-1")}`);
      });

    await expect(processIapDelivery(appleDelivery, effect, db.store, 3)).rejects.toMatchObject({
      httpStatus: 503,
    });
    await expect(processIapDelivery(appleDelivery, effect, db.store, 3)).rejects.toMatchObject({
      httpStatus: 503,
    });
    db.failTerminalWrite();

    await expect(processIapDelivery(appleDelivery, effect, db.store, 3)).rejects.toMatchObject({
      code: "DELIVERY_SUCCESS_UNSEALED",
      httpStatus: 503,
    });
    expect([...db.rows.values()][0]).toMatchObject({
      status: "RETRYABLE",
      attempts: 3,
      failureCode: "DELIVERY_SUCCESS_UNSEALED",
    });

    await expect(processIapDelivery(appleDelivery, effect, db.store, 3)).resolves.toEqual({
      disposition: "processed",
      httpStatus: 200,
    });
    expect([...db.rows.values()][0]).toMatchObject({ status: "SUCCEEDED", attempts: 4 });
    expect(subscriptions.size).toBe(1);
    expect(entitlements.size).toBe(1);
    expect(activities.size).toBe(1);
  });

  it("keeps persistent transient failures retryable after local exhaustion for the external DLQ", async () => {
    const db = memoryStore();
    const effect = vi.fn(async () => {
      throw new IapTransientDeliveryError("APPLE_PROVIDER_UNAVAILABLE");
    });

    await expect(processIapDelivery(appleDelivery, effect, db.store, 3)).rejects.toMatchObject({
      httpStatus: 503,
    });
    await expect(processIapDelivery(appleDelivery, effect, db.store, 3)).rejects.toMatchObject({
      httpStatus: 503,
    });
    await expect(processIapDelivery(appleDelivery, effect, db.store, 3)).rejects.toMatchObject({
      code: "APPLE_PROVIDER_UNAVAILABLE",
      httpStatus: 503,
    });
    expect([...db.rows.values()][0]).toMatchObject({
      status: "RETRYABLE",
      attempts: 3,
      failureCode: "APPLE_PROVIDER_UNAVAILABLE",
    });
    await expect(processIapDelivery(appleDelivery, effect, db.store, 3)).rejects.toMatchObject({ httpStatus: 503 });
    expect([...db.rows.values()][0]).toMatchObject({ status: "RETRYABLE", attempts: 4 });
  });

  it("keeps identity collisions and active leases retriable without running a second effect", async () => {
    const collisionDb = memoryStore();
    await processIapDelivery(appleDelivery, async () => undefined, collisionDb.store);
    await expect(
      processIapDelivery(
        { ...appleDelivery, fingerprint: deliveryFingerprint("different-signed-payload") },
        async () => undefined,
        collisionDb.store,
      ),
    ).rejects.toMatchObject({ code: "DELIVERY_ID_COLLISION", httpStatus: 503 });

    const leaseDb = memoryStore();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const firstEffect = vi.fn(() => held);
    const secondEffect = vi.fn(async () => undefined);
    const first = processIapDelivery(
      { ...appleDelivery, deliveryId: "lease-delivery-1" },
      firstEffect,
      leaseDb.store,
    );
    await vi.waitFor(() => expect(firstEffect).toHaveBeenCalledTimes(1));
    await expect(
      processIapDelivery(
        { ...appleDelivery, deliveryId: "lease-delivery-1" },
        secondEffect,
        leaseDb.store,
      ),
    ).rejects.toMatchObject({ code: "DELIVERY_IN_FLIGHT", httpStatus: 503 });
    expect(secondEffect).not.toHaveBeenCalled();
    release();
    await first;
  });

  it("uses only a one-way digest as the fallback identity for malformed payloads", () => {
    const raw = "purchaseToken=super-secret-token";
    const digest = deliveryFingerprint(raw);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(digest).not.toContain(raw);
    expect(deliveryFingerprint(raw)).toBe(digest);
  });

  it("rejects malformed identity fields before touching persistence", async () => {
    const db = memoryStore();
    await expect(
      processIapDelivery(
        { ...appleDelivery, deliveryId: "" },
        async () => undefined,
        db.store,
      ),
    ).rejects.toMatchObject({ code: "DELIVERY_ID_INVALID" });
    expect(db.writes).toHaveLength(0);
  });
});

describe("IAP delivery HTTP matrix with reliability flag enabled", () => {
  let server: http.Server;
  let baseUrl: string;
  let db: ReturnType<typeof memoryStore>;
  const logicalSubscriptions = new Map<string, unknown>();
  const logicalEntitlements = new Set<string>();
  const logicalActivities = new Map<string, unknown>();

  beforeAll(async () => {
    db = memoryStore();
    Object.assign(routeMocks.prisma, {
      $queryRaw: vi.fn().mockResolvedValue([{
        id: "subscription-1",
        last_verified_at: new Date(0),
      }]),
      iapWebhookDelivery: db.store,
      mobileSubscription: {
        update: vi.fn().mockImplementation(async (args: { where: { originalTransactionId: string }; data: unknown }) => {
          logicalSubscriptions.set(args.where.originalTransactionId, args.data);
          return {
          id: "subscription-1",
          tenantId: "tenant-1",
          planTier: "INDIVIDUAL",
          };
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({
          id: "subscription-1",
          tenantId: "tenant-1",
          planTier: "INDIVIDUAL",
        }),
      },
      googlePurchaseAlias: {
        findMany: routeMocks.googlePurchaseAliasFindMany,
        findFirst: routeMocks.googlePurchaseAliasFindFirst,
        createMany: routeMocks.googlePurchaseAliasCreateMany,
      },
      activityLog: {
        create: vi.fn().mockResolvedValue({ id: "legacy-activity" }),
        upsert: vi.fn().mockImplementation(async (args: { where: { id: string }; create: unknown }) => {
          if (!logicalActivities.has(args.where.id)) logicalActivities.set(args.where.id, args.create);
          return { id: args.where.id };
        }),
      },
    });
    routeMocks.tenantTx.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(routeMocks.prisma));
    routeMocks.recordEntitlementEvent.mockImplementation(async (input: { source: string; sourceEventId: string }) => {
      logicalEntitlements.add(`${input.source}:${input.sourceEventId}`);
      return "INDIVIDUAL";
    });

    const { iapRouter } = await import("../router");
    const app = express();
    app.use(express.json());
    app.use("/api/v1/billing/iap", iapRouter);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  async function post(path: string, body: unknown, authorization?: string) {
    const response = await fetch(`${baseUrl}/api/v1/billing/iap${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authorization ? { Authorization: authorization } : {}),
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Retain the response text so a routing failure is diagnosable.
    }
    return { status: response.status, body: parsed };
  }

  it("terminally acknowledges and durably redacts missing/invalid Apple JWS", async () => {
    const missing = await post("/apple/notify", {});
    expect(missing.status).toBe(200);
    expect(missing.body).toMatchObject({ ok: false });

    routeMocks.parseAppleNotification.mockRejectedValueOnce(new Error("bad signature"));
    const invalid = await post("/apple/notify", { signedPayload: "raw-jws-secret" });
    expect(invalid.status).toBe(200);
    expect(JSON.stringify(db.writes)).not.toContain("raw-jws-secret");
  });

  it("returns 503 for a transient Apple provider failure and does not false-ack", async () => {
    routeMocks.parseAppleNotification.mockResolvedValueOnce({
      notificationUUID: "apple-provider-retry-1",
      originalTransactionId: "apple-stream-1",
      productId: "com.braavolabs.individual.monthly",
      notificationType: "DID_RENEW",
      signedDate: new Date("2026-08-25T20:00:00Z"),
      expiresAt: new Date("2026-09-25T20:00:00Z"),
      status: "active",
      autoRenew: true,
    });
    routeMocks.verifyAppleReceipt.mockRejectedValueOnce(new Error("provider timeout"));
    expect((await post("/apple/notify", { signedPayload: "jws-for-retry" })).status).toBe(503);
  });

  it("terminally poisons an Apple catalog-unknown product without billing effects", async () => {
    const note = {
      notificationUUID: "apple-unknown-delivery-1",
      originalTransactionId: "apple-unknown-stream-1",
      productId: "com.braavolabs.unregistered.monthly",
      notificationType: "DID_RENEW",
      signedDate: new Date("2026-08-25T20:00:00Z"),
      expiresAt: new Date("2026-09-25T20:00:00Z"),
      status: "active",
      autoRenew: true,
    };
    routeMocks.parseAppleNotification.mockResolvedValueOnce(note);
    routeMocks.verifyAppleReceipt.mockResolvedValueOnce({
      originalTransactionId: note.originalTransactionId,
      status: "active",
      startedAt: new Date("2026-08-01T00:00:00Z"),
      expiresAt: note.expiresAt,
      autoRenew: true,
    });
    const subscriptionsBefore = logicalSubscriptions.size;
    const entitlementsBefore = logicalEntitlements.size;
    const activitiesBefore = logicalActivities.size;

    const result = await post("/apple/notify", { signedPayload: "unknown-product-jws" });

    expect(result).toEqual({ status: 200, body: { ok: true, disposition: "poisoned" } });
    expect([...db.rows.values()].find((row) => row.deliveryId === note.notificationUUID)).toMatchObject({
      status: "POISONED",
      failureCode: "APPLE_PRODUCT_UNKNOWN",
    });
    expect(logicalSubscriptions.size).toBe(subscriptionsBefore);
    expect(logicalEntitlements.size).toBe(entitlementsBefore);
    expect(logicalActivities.size).toBe(activitiesBefore);
  });

  it("applies one business effect for a valid duplicate Apple delivery", async () => {
    const note = {
      notificationUUID: "apple-duplicate-1",
      originalTransactionId: "apple-stream-2",
      productId: "com.braavolabs.individual.monthly",
      notificationType: "DID_RENEW",
      signedDate: new Date("2026-08-25T20:00:00Z"),
      expiresAt: new Date("2026-09-25T20:00:00Z"),
      status: "active",
      autoRenew: true,
    };
    routeMocks.parseAppleNotification.mockResolvedValue(note);
    routeMocks.verifyAppleReceipt.mockResolvedValue({
      originalTransactionId: note.originalTransactionId,
      status: "active",
      startedAt: new Date("2026-08-01T00:00:00Z"),
      expiresAt: note.expiresAt,
      autoRenew: true,
    });
    const before = routeMocks.recordEntitlementEvent.mock.calls.length;
    expect((await post("/apple/notify", { signedPayload: "same-jws" })).status).toBe(200);
    expect((await post("/apple/notify", { signedPayload: "same-jws" })).status).toBe(200);
    expect(routeMocks.recordEntitlementEvent.mock.calls.length - before).toBe(1);
  });

  it("provider-relooks up a manual-review notification and updates only its durable case state", async () => {
    const note = {
      notificationUUID: "apple-manual-review-1",
      originalTransactionId: "untrusted-payload-identity",
      productId: "com.braavolabs.business.monthly",
      notificationType: "DID_RENEW",
      signedDate: new Date("2026-09-04T08:00:00Z"),
      expiresAt: new Date("2026-09-05T00:00:00Z"),
      status: "revoked",
      autoRenew: false,
    };
    const providerExpiry = new Date("2026-11-01T00:00:00Z");
    const ledgerBefore = routeMocks.recordEntitlementEvent.mock.calls.length;
    const ackBefore = routeMocks.acknowledgeGoogleReceipt.mock.calls.length;
    routeMocks.parseAppleNotification.mockResolvedValueOnce(note);
    routeMocks.verifyAppleReceipt.mockResolvedValueOnce({
      originalTransactionId: "authoritative-provider-identity",
      status: "active",
      startedAt: new Date("2026-08-01T00:00:00Z"),
      expiresAt: providerExpiry,
      autoRenew: true,
    });
    const update = (routeMocks.prisma.mobileSubscription as { update: ReturnType<typeof vi.fn> }).update;
    update.mockResolvedValueOnce({
      id: "manual-subscription-1",
      tenantId: "tenant-1",
      provider: "apple",
      productId: note.productId,
    });
    routeMocks.ensureManualReviewCase.mockResolvedValueOnce({
      caseId: "iap_review_notification_case",
      state: "pending",
    });

    const result = await post("/apple/notify", { signedPayload: "valid-manual-review-jws" });

    expect(result).toEqual({ status: 200, body: { ok: true, disposition: "processed" } });
    expect(routeMocks.verifyAppleReceipt).toHaveBeenCalledWith(
      note.originalTransactionId,
      note.productId,
    );
    expect(routeMocks.ensureManualReviewCase).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "tenant-1",
      subscriptionId: "manual-subscription-1",
      providerIdentity: "authoritative-provider-identity",
      providerStatus: "active",
      expiresAt: providerExpiry,
      autoRenew: true,
    }));
    expect(routeMocks.recordEntitlementEvent.mock.calls.length).toBe(ledgerBefore);
    expect(routeMocks.acknowledgeGoogleReceipt.mock.calls.length).toBe(ackBefore);
  });

  it("applies an approved Apple manual-review renewal using the operator-mapped tier", async () => {
    const note = {
      notificationUUID: "apple-approved-review-renewal-1",
      originalTransactionId: "apple-approved-review-stream",
      productId: "com.braavolabs.business.monthly",
      notificationType: "DID_RENEW",
      signedDate: new Date("2026-09-04T09:00:00Z"),
      expiresAt: new Date("2026-11-01T00:00:00Z"),
      status: "active",
      autoRenew: true,
    };
    routeMocks.parseAppleNotification.mockResolvedValueOnce(note);
    routeMocks.verifyAppleReceipt.mockResolvedValueOnce({
      originalTransactionId: note.originalTransactionId,
      status: "active",
      startedAt: new Date("2026-08-01T00:00:00Z"),
      expiresAt: note.expiresAt,
      autoRenew: true,
    });
    routeMocks.ensureManualReviewCase.mockResolvedValueOnce({
      caseId: "iap_review_notification_case",
      state: "approved_mapping",
      targetTier: "TEAM",
    });
    const ledgerBefore = routeMocks.recordEntitlementEvent.mock.calls.length;

    const result = await post("/apple/notify", { signedPayload: "approved-renewal-jws" });

    expect(result).toEqual({ status: 200, body: { ok: true, disposition: "processed" } });
    expect(routeMocks.recordEntitlementEvent.mock.calls.length - ledgerBefore).toBe(1);
    expect(routeMocks.recordEntitlementEvent).toHaveBeenLastCalledWith(expect.objectContaining({
      tenantId: "tenant-1",
      source: "apple",
      type: "renewal",
      planTier: "TEAM",
    }));
    expect((routeMocks.prisma.mobileSubscription as { update: ReturnType<typeof vi.fn> }).update
      .mock.invocationCallOrder.at(-1)).toBeLessThan(
      routeMocks.recordEntitlementEvent.mock.invocationCallOrder.at(-1)!,
    );
  });

  it("applies an approved Apple manual-review revocation to the existing mapped stream", async () => {
    const note = {
      notificationUUID: "apple-approved-review-revoke-1",
      originalTransactionId: "apple-approved-review-stream",
      productId: "com.braavolabs.business.monthly",
      notificationType: "REVOKE",
      signedDate: new Date("2026-09-04T10:00:00Z"),
      expiresAt: new Date("2026-09-04T10:00:00Z"),
      status: "revoked",
      autoRenew: false,
    };
    routeMocks.parseAppleNotification.mockResolvedValueOnce(note);
    routeMocks.verifyAppleReceipt.mockResolvedValueOnce({
      originalTransactionId: note.originalTransactionId,
      status: "revoked",
      startedAt: new Date("2026-08-01T00:00:00Z"),
      expiresAt: note.expiresAt,
      autoRenew: false,
    });
    routeMocks.getManualReviewCase.mockResolvedValueOnce({
      caseId: "iap_review_notification_case",
      state: "approved_mapping",
      targetTier: "TEAM",
    });
    routeMocks.ensureManualReviewCase.mockResolvedValueOnce({
      caseId: "iap_review_notification_case",
      state: "approved_mapping",
      targetTier: "TEAM",
    });
    const ledgerBefore = routeMocks.recordEntitlementEvent.mock.calls.length;

    const result = await post("/apple/notify", { signedPayload: "approved-revoke-jws" });

    expect(result).toEqual({ status: 200, body: { ok: true, disposition: "processed" } });
    expect(routeMocks.getManualReviewCase).toHaveBeenCalledWith("tenant-1", "iap_review_notification_case");
    expect(routeMocks.recordEntitlementEvent.mock.calls.length - ledgerBefore).toBe(1);
    expect(routeMocks.recordEntitlementEvent).toHaveBeenLastCalledWith(expect.objectContaining({
      tenantId: "tenant-1",
      source: "apple",
      streamId: "apple-stream",
      type: "revoke",
      planTier: null,
    }));
  });

  it.each(["pending", "rejected", "expired"] as const)(
    "keeps an Apple manual-review case in terminal decision state %s without ledger or acknowledgement",
    async (state) => {
      const note = {
        notificationUUID: `apple-review-${state}-1`,
        originalTransactionId: `apple-review-${state}-stream`,
        productId: "com.braavolabs.business.monthly",
        notificationType: "DID_RENEW",
        signedDate: new Date("2026-09-04T11:00:00Z"),
        expiresAt: new Date("2026-11-01T00:00:00Z"),
        status: "active",
        autoRenew: true,
      };
      routeMocks.parseAppleNotification.mockResolvedValueOnce(note);
      routeMocks.verifyAppleReceipt.mockResolvedValueOnce({
        originalTransactionId: note.originalTransactionId,
        status: "active",
        startedAt: new Date("2026-08-01T00:00:00Z"),
        expiresAt: note.expiresAt,
        autoRenew: true,
      });
      routeMocks.ensureManualReviewCase.mockResolvedValueOnce({
        caseId: "iap_review_notification_case",
        state,
        targetTier: null,
      });
      const ledgerBefore = routeMocks.recordEntitlementEvent.mock.calls.length;
      const ackBefore = routeMocks.acknowledgeGoogleReceipt.mock.calls.length;

      expect((await post("/apple/notify", { signedPayload: `review-${state}-jws` })).status).toBe(200);
      expect(routeMocks.recordEntitlementEvent.mock.calls.length).toBe(ledgerBefore);
      expect(routeMocks.acknowledgeGoogleReceipt.mock.calls.length).toBe(ackBefore);
    },
  );

  it("terminal-write failure followed by real Apple redelivery leaves all logical effects exactly once", async () => {
    const note = {
      notificationUUID: "apple-terminal-redelivery-1",
      originalTransactionId: "apple-terminal-stream-1",
      productId: "com.braavolabs.individual.monthly",
      notificationType: "DID_RENEW",
      signedDate: new Date("2026-08-25T20:00:00Z"),
      expiresAt: new Date("2026-09-25T20:00:00Z"),
      status: "active",
      autoRenew: true,
    };
    routeMocks.parseAppleNotification.mockResolvedValue(note);
    routeMocks.verifyAppleReceipt.mockResolvedValue({
      originalTransactionId: note.originalTransactionId,
      status: "active",
      startedAt: new Date("2026-08-01T00:00:00Z"),
      expiresAt: note.expiresAt,
      autoRenew: true,
    });
    const subscriptionsBefore = logicalSubscriptions.size;
    const entitlementsBefore = logicalEntitlements.size;
    const activitiesBefore = logicalActivities.size;
    db.failTerminalWrite();

    expect((await post("/apple/notify", { signedPayload: "terminal-write-jws" })).status).toBe(503);
    expect((await post("/apple/notify", { signedPayload: "terminal-write-jws" })).status).toBe(200);

    expect(logicalSubscriptions.size - subscriptionsBefore).toBe(1);
    expect(logicalEntitlements.size - entitlementsBefore).toBe(1);
    expect(logicalActivities.size - activitiesBefore).toBe(1);
  });

  it("keeps repeated P2025 persistence failure at 503 for Pub/Sub external retry/DLQ", async () => {
    const note = {
      notificationUUID: "apple-p2025-exhaustion-1",
      originalTransactionId: "apple-missing-stream-1",
      productId: "com.braavolabs.individual.monthly",
      notificationType: "DID_RENEW",
      signedDate: new Date("2026-08-25T20:00:00Z"),
      expiresAt: new Date("2026-09-25T20:00:00Z"),
      status: "active",
      autoRenew: true,
    };
    routeMocks.parseAppleNotification.mockResolvedValue(note);
    routeMocks.verifyAppleReceipt.mockResolvedValue({
      originalTransactionId: note.originalTransactionId,
      status: "active",
      startedAt: new Date("2026-08-01T00:00:00Z"),
      expiresAt: note.expiresAt,
      autoRenew: true,
    });
    const update = (routeMocks.prisma.mobileSubscription as { update: ReturnType<typeof vi.fn> }).update;
    const defaultImplementation = update.getMockImplementation();
    update.mockRejectedValue(Object.assign(new Error("record not found"), { code: "P2025" }));

    expect((await post("/apple/notify", { signedPayload: "p2025-jws" })).status).toBe(503);
    expect((await post("/apple/notify", { signedPayload: "p2025-jws" })).status).toBe(503);
    const exhausted = await post("/apple/notify", { signedPayload: "p2025-jws" });
    expect(exhausted.status).toBe(503);
    expect(JSON.stringify(exhausted.body)).not.toContain("P2025");
    expect([...db.rows.values()].find((row) => row.deliveryId === note.notificationUUID)).toMatchObject({
      status: "RETRYABLE",
      attempts: 3,
      failureCode: "APPLE_PERSISTENCE_FAILED",
    });
    update.mockImplementation(defaultImplementation!);
  });

  it("rejects missing/invalid Google OIDC before envelope or persistence", async () => {
    routeMocks.verifyPubSubPushToken.mockResolvedValueOnce({ ok: false, reason: "missing-bearer-token" });
    const before = db.writes.length;
    expect((await post("/google/notify", {})).status).toBe(401);
    expect(db.writes).toHaveLength(before);
  });

  it("terminally acknowledges a validly authenticated poison Google envelope", async () => {
    routeMocks.verifyPubSubPushToken.mockResolvedValueOnce({ ok: true });
    routeMocks.parseGoogleRtdnEnvelope.mockReturnValueOnce(null);
    const result = await post(
      "/google/notify",
      { message: { messageId: "google-poison-1", data: "not-a-valid-envelope" } },
      "Bearer verified-token",
    );
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: false, reason: "envelope-not-recognised" });
    expect(JSON.stringify(db.writes)).not.toContain("verified-token");
  });

  it("records testNotification as SUCCEEDED without provider, ownership, entitlement or acknowledgement work", async () => {
    const messageId = "google-test-notification-1";
    const verifyBefore = routeMocks.verifyGoogleReceipt.mock.calls.length;
    const ownershipBefore = routeMocks.googlePurchaseAliasFindMany.mock.calls.length;
    const entitlementBefore = routeMocks.recordEntitlementEvent.mock.calls.length;
    const ackBefore = routeMocks.acknowledgeGoogleReceipt.mock.calls.length;
    routeMocks.verifyPubSubPushToken.mockResolvedValue({ ok: true });
    routeMocks.parseGoogleRtdnEnvelope.mockReturnValue({
      kind: "test",
      packageName: "com.braavolabs.app",
      messageId,
      publishTime: new Date("2026-09-04T08:00:00Z"),
      version: "1.0",
    });

    const first = await post(
      "/google/notify",
      { message: { messageId, data: "mocked-by-parser" } },
      "Bearer verified-token",
    );
    const duplicate = await post(
      "/google/notify",
      { message: { messageId, data: "mocked-by-parser" } },
      "Bearer verified-token",
    );

    expect(first).toEqual({ status: 200, body: { ok: true, disposition: "processed" } });
    expect(duplicate).toEqual({ status: 200, body: { ok: true, disposition: "duplicate" } });
    expect([...db.rows.values()].find((row) => row.deliveryId === messageId)).toMatchObject({ status: "SUCCEEDED" });
    expect(routeMocks.verifyGoogleReceipt.mock.calls.length).toBe(verifyBefore);
    expect(routeMocks.googlePurchaseAliasFindMany.mock.calls.length).toBe(ownershipBefore);
    expect(routeMocks.recordEntitlementEvent.mock.calls.length).toBe(entitlementBefore);
    expect(routeMocks.acknowledgeGoogleReceipt.mock.calls.length).toBe(ackBefore);
  });

  it("applies an approved Google manual-review renewal and acknowledges only after ownership and ledger", async () => {
    const rootIdentity = `google:${"9".repeat(64)}`;
    const note = {
      packageName: "com.braavolabs.app",
      kind: "subscription",
      notificationType: 2,
      purchaseToken: "google-approved-review-renewal-token",
      messageId: "google-approved-review-renewal-1",
      publishTime: new Date("2026-09-04T12:00:00Z"),
    };
    routeMocks.verifyPubSubPushToken.mockResolvedValueOnce({ ok: true });
    routeMocks.parseGoogleRtdnEnvelope.mockReturnValueOnce(note);
    routeMocks.verifyGoogleReceipt.mockResolvedValueOnce({
      originalTransactionId: rootIdentity,
      googleCanonicalRootIdentity: rootIdentity,
      googlePurchaseAliases: [rootIdentity],
      googleAcknowledgementPending: true,
      googleProductId: "com.braavolabs.business.monthly",
      googleLatestSuccessfulOrderId: null,
      status: "active",
      startedAt: new Date("2026-08-01T00:00:00Z"),
      expiresAt: new Date("2026-11-01T00:00:00Z"),
      autoRenew: true,
    });
    routeMocks.googlePurchaseAliasFindMany.mockResolvedValueOnce([{
      tokenDigest: rootIdentity,
      state: "active",
      tenantId: "tenant-1",
      mobileSubscriptionId: "subscription-1",
      provider: "google",
      canonicalRootIdentity: rootIdentity,
    }]);
    routeMocks.ensureManualReviewCase.mockResolvedValueOnce({
      caseId: "iap_review_notification_case",
      state: "approved_mapping",
      targetTier: "TEAM",
    });
    const ledgerBefore = routeMocks.recordEntitlementEvent.mock.calls.length;
    const ackBefore = routeMocks.acknowledgeGoogleReceipt.mock.calls.length;

    const result = await post(
      "/google/notify",
      { message: { messageId: note.messageId, data: "mocked-by-parser" } },
      "Bearer verified-token",
    );

    expect(result).toEqual({ status: 200, body: { ok: true, disposition: "processed" } });
    expect(routeMocks.recordEntitlementEvent.mock.calls.length - ledgerBefore).toBe(1);
    expect(routeMocks.recordEntitlementEvent).toHaveBeenLastCalledWith(expect.objectContaining({
      tenantId: "tenant-1",
      source: "google",
      type: "renewal",
      planTier: "TEAM",
    }), expect.objectContaining({ rootIdentity }));
    expect(routeMocks.acknowledgeGoogleReceipt.mock.calls.length - ackBefore).toBe(1);
    expect(routeMocks.googlePurchaseAliasFindMany.mock.invocationCallOrder.at(-1)).toBeLessThan(
      routeMocks.recordEntitlementEvent.mock.invocationCallOrder.at(-1)!,
    );
    expect(routeMocks.recordEntitlementEvent.mock.invocationCallOrder.at(-1)).toBeLessThan(
      routeMocks.acknowledgeGoogleReceipt.mock.invocationCallOrder.at(-1)!,
    );
  });

  it("keeps an approved Google manual-review acknowledgement failure retryable for the external DLQ", async () => {
    const rootIdentity = `google:${"8".repeat(64)}`;
    const note = {
      packageName: "com.braavolabs.app",
      kind: "subscription",
      notificationType: 2,
      purchaseToken: "google-approved-review-ack-failure-token",
      messageId: "google-approved-review-ack-failure-1",
      publishTime: new Date("2026-09-04T12:30:00Z"),
    };
    routeMocks.verifyPubSubPushToken.mockResolvedValueOnce({ ok: true });
    routeMocks.parseGoogleRtdnEnvelope.mockReturnValueOnce(note);
    routeMocks.verifyGoogleReceipt.mockResolvedValueOnce({
      originalTransactionId: rootIdentity,
      googleCanonicalRootIdentity: rootIdentity,
      googlePurchaseAliases: [rootIdentity],
      googleAcknowledgementPending: true,
      googleProductId: "com.braavolabs.business.monthly",
      googleLatestSuccessfulOrderId: null,
      status: "active",
      startedAt: new Date("2026-08-01T00:00:00Z"),
      expiresAt: new Date("2026-11-01T00:00:00Z"),
      autoRenew: true,
    });
    routeMocks.googlePurchaseAliasFindMany.mockResolvedValueOnce([{
      tokenDigest: rootIdentity,
      state: "active",
      tenantId: "tenant-1",
      mobileSubscriptionId: "subscription-1",
      provider: "google",
      canonicalRootIdentity: rootIdentity,
    }]);
    routeMocks.ensureManualReviewCase.mockResolvedValueOnce({
      caseId: "iap_review_notification_case",
      state: "approved_mapping",
      targetTier: "TEAM",
    });
    const acknowledgementCallsBefore = routeMocks.acknowledgeGoogleReceipt.mock.calls.length;
    routeMocks.acknowledgeGoogleReceipt.mockRejectedValueOnce(new Error("provider unavailable"));

    const result = await post(
      "/google/notify",
      { message: { messageId: note.messageId, data: "mocked-by-parser" } },
      "Bearer verified-token",
    );
    const acknowledgementCalls = routeMocks.acknowledgeGoogleReceipt.mock.calls.length
      - acknowledgementCallsBefore;
    routeMocks.acknowledgeGoogleReceipt.mockReset().mockResolvedValue(undefined);

    expect(result).toEqual({ status: 503, body: { ok: false, reason: "retry-required" } });
    expect(acknowledgementCalls).toBe(1);
    expect([...db.rows.values()].find((row) => row.deliveryId === note.messageId)).toMatchObject({
      status: "RETRYABLE",
      failureCode: "GOOGLE_ACKNOWLEDGEMENT_FAILED",
    });
  });

  it.each(["pending", "rejected", "expired"] as const)(
    "keeps a Google manual-review case in decision state %s without grant or acknowledgement",
    async (state) => {
      const rootIdentity = `google:${state === "pending" ? "1" : state === "rejected" ? "2" : "3"}`.padEnd(71, state === "pending" ? "1" : state === "rejected" ? "2" : "3");
      const note = {
        packageName: "com.braavolabs.app",
        kind: "subscription",
        notificationType: 2,
        purchaseToken: `google-review-${state}-token`,
        messageId: `google-review-${state}-1`,
        publishTime: new Date("2026-09-04T13:00:00Z"),
      };
      routeMocks.verifyPubSubPushToken.mockResolvedValueOnce({ ok: true });
      routeMocks.parseGoogleRtdnEnvelope.mockReturnValueOnce(note);
      routeMocks.verifyGoogleReceipt.mockResolvedValueOnce({
        originalTransactionId: rootIdentity,
        googleCanonicalRootIdentity: rootIdentity,
        googlePurchaseAliases: [rootIdentity],
        googleAcknowledgementPending: true,
        googleProductId: "com.braavolabs.business.monthly",
        googleLatestSuccessfulOrderId: null,
        status: "active",
        startedAt: new Date("2026-08-01T00:00:00Z"),
        expiresAt: new Date("2026-11-01T00:00:00Z"),
        autoRenew: true,
      });
      routeMocks.googlePurchaseAliasFindMany.mockResolvedValueOnce([{
        tokenDigest: rootIdentity,
        state: "active",
        tenantId: "tenant-1",
        mobileSubscriptionId: "subscription-1",
        provider: "google",
        canonicalRootIdentity: rootIdentity,
      }]);
      routeMocks.ensureManualReviewCase.mockResolvedValueOnce({
        caseId: "iap_review_notification_case",
        state,
        targetTier: null,
      });
      const ledgerBefore = routeMocks.recordEntitlementEvent.mock.calls.length;
      const ackBefore = routeMocks.acknowledgeGoogleReceipt.mock.calls.length;

      expect((await post(
        "/google/notify",
        { message: { messageId: note.messageId, data: "mocked-by-parser" } },
        "Bearer verified-token",
      )).status).toBe(200);
      expect(routeMocks.recordEntitlementEvent.mock.calls.length).toBe(ledgerBefore);
      expect(routeMocks.acknowledgeGoogleReceipt.mock.calls.length).toBe(ackBefore);
    },
  );

  it("terminally rejects a Google package mismatch before provider or billing work", async () => {
    const verifyBefore = routeMocks.verifyGoogleReceipt.mock.calls.length;
    const subscriptionsBefore = logicalSubscriptions.size;
    routeMocks.verifyPubSubPushToken.mockResolvedValueOnce({ ok: true });
    routeMocks.parseGoogleRtdnEnvelope.mockReturnValueOnce({
      packageName: "com.example.wrong",
      kind: "subscription",
      notificationType: 2,
      purchaseToken: "synthetic-package-mismatch",
      messageId: "google-package-mismatch-1",
      publishTime: new Date("2026-08-25T20:00:00Z"),
    });

    const result = await post(
      "/google/notify",
      { message: { messageId: "google-package-mismatch-1", data: "mocked-by-parser" } },
      "Bearer verified-token",
    );

    expect(result).toEqual({ status: 200, body: { ok: false, reason: "package-mismatch" } });
    expect([...db.rows.values()].find((row) => row.deliveryId === "google-package-mismatch-1")).toMatchObject({
      status: "POISONED",
      failureCode: "GOOGLE_PACKAGE_MISMATCH",
    });
    expect(routeMocks.verifyGoogleReceipt.mock.calls.length).toBe(verifyBefore);
    expect(logicalSubscriptions.size).toBe(subscriptionsBefore);
  });

  it("terminally poisons a Google catalog-unknown product without billing effects", async () => {
    const note = {
      packageName: "com.braavolabs.app",
      kind: "subscription",
      notificationType: 2,
      purchaseToken: "unknown-product-purchase-token",
      messageId: "google-unknown-delivery-1",
      publishTime: new Date("2026-08-25T20:00:00Z"),
    };
    routeMocks.verifyPubSubPushToken.mockResolvedValueOnce({ ok: true });
    routeMocks.parseGoogleRtdnEnvelope.mockReturnValueOnce(note);
    routeMocks.verifyGoogleReceipt.mockResolvedValueOnce({
      originalTransactionId: `google:${"b".repeat(64)}`,
      googleProductId: "com.braavolabs.unregistered.monthly",
      status: "active",
      startedAt: new Date("2026-08-01T00:00:00Z"),
      expiresAt: new Date("2026-09-25T20:00:00Z"),
      autoRenew: true,
    });
    const subscriptionsBefore = logicalSubscriptions.size;
    const entitlementsBefore = logicalEntitlements.size;
    const activitiesBefore = logicalActivities.size;

    const result = await post(
      "/google/notify",
      { message: { messageId: note.messageId, data: "mocked-by-parser" } },
      "Bearer verified-token",
    );

    expect(result).toEqual({ status: 200, body: { ok: true, disposition: "poisoned" } });
    expect([...db.rows.values()].find((row) => row.deliveryId === note.messageId)).toMatchObject({
      status: "POISONED",
      failureCode: "GOOGLE_PRODUCT_UNKNOWN",
    });
    expect(logicalSubscriptions.size).toBe(subscriptionsBefore);
    expect(logicalEntitlements.size).toBe(entitlementsBefore);
    expect(logicalActivities.size).toBe(activitiesBefore);
    expect(JSON.stringify(db.writes)).not.toContain(note.purchaseToken);
  });

  it("terminally blocks a historical raw Google identity without ownership or billing effects", async () => {
    const rawPurchaseToken = "historical-raw-purchase-token";
    const hashedIdentity = `google:${"a".repeat(64)}`;
    routeMocks.verifyPubSubPushToken.mockResolvedValueOnce({ ok: true });
    routeMocks.parseGoogleRtdnEnvelope.mockReturnValueOnce({
      packageName: "com.braavolabs.app",
      kind: "subscription",
      notificationType: 2,
      purchaseToken: rawPurchaseToken,
      messageId: "google-legacy-migration-1",
      publishTime: new Date("2026-08-25T20:00:00Z"),
    });
    routeMocks.verifyGoogleReceipt.mockResolvedValueOnce({
      originalTransactionId: hashedIdentity,
      googleCanonicalRootIdentity: hashedIdentity,
      googlePurchaseAliases: [hashedIdentity],
      googleAcknowledgementPending: true,
      googleProductId: "com.braavolabs.individual.monthly",
      googleLatestSuccessfulOrderId: null,
      status: "active",
      startedAt: new Date("2026-08-01T00:00:00Z"),
      expiresAt: new Date("2026-09-25T20:00:00Z"),
      autoRenew: true,
    });
    routeMocks.googlePurchaseAliasFindMany.mockResolvedValueOnce([{
      tokenDigest: hashedIdentity,
      state: "legacy_blocked",
      tenantId: null,
      mobileSubscriptionId: null,
      provider: null,
      canonicalRootIdentity: null,
    }]);
    const subscriptionsBefore = logicalSubscriptions.size;
    const entitlementsBefore = logicalEntitlements.size;
    const activitiesBefore = logicalActivities.size;

    const encoded = Buffer.from(JSON.stringify({
      packageName: "com.braavolabs.app",
      subscriptionNotification: {
        notificationType: 2,
        purchaseToken: rawPurchaseToken,
      },
    })).toString("base64");
    const result = await post(
      "/google/notify",
      { message: { messageId: "google-legacy-migration-1", data: encoded } },
      "Bearer verified-token",
    );
    expect(result).toEqual({ status: 200, body: { ok: true, disposition: "poisoned" } });
    expect([...db.rows.values()].find((row) => row.deliveryId === "google-legacy-migration-1")).toMatchObject({
      status: "POISONED",
      failureCode: "GOOGLE_OWNERSHIP_UNRESOLVED",
    });
    expect(logicalSubscriptions.size).toBe(subscriptionsBefore);
    expect(logicalEntitlements.size).toBe(entitlementsBefore);
    expect(logicalActivities.size).toBe(activitiesBefore);
    expect(routeMocks.acknowledgeGoogleReceipt).not.toHaveBeenCalled();
    expect(JSON.stringify(db.writes)).not.toContain(rawPurchaseToken);
  });

  it("uses the shared alias resolver for a known reliable RTDN and acknowledges afterward", async () => {
    const rootIdentity = `google:${"6".repeat(64)}`;
    const note = {
      packageName: "com.braavolabs.app",
      kind: "subscription",
      notificationType: 2,
      purchaseToken: "synthetic-known-rtdn",
      messageId: "google-known-owner-1",
      publishTime: new Date("2026-08-25T20:00:00Z"),
    };
    routeMocks.verifyPubSubPushToken.mockResolvedValueOnce({ ok: true });
    routeMocks.parseGoogleRtdnEnvelope.mockReturnValueOnce(note);
    routeMocks.verifyGoogleReceipt.mockResolvedValueOnce({
      originalTransactionId: rootIdentity,
      googleCanonicalRootIdentity: rootIdentity,
      googlePurchaseAliases: [rootIdentity],
      googleAcknowledgementPending: true,
      googleProductId: "com.braavolabs.individual.monthly",
      googleLatestSuccessfulOrderId: null,
      status: "active",
      startedAt: new Date("2026-08-01T00:00:00Z"),
      expiresAt: new Date("2026-09-25T20:00:00Z"),
      autoRenew: true,
    });
    routeMocks.googlePurchaseAliasFindMany.mockResolvedValueOnce([{
      tokenDigest: rootIdentity,
      state: "active",
      tenantId: "tenant-1",
      mobileSubscriptionId: "subscription-1",
      provider: "google",
      canonicalRootIdentity: rootIdentity,
    }]);
    const ackBefore = routeMocks.acknowledgeGoogleReceipt.mock.calls.length;

    const result = await post(
      "/google/notify",
      { message: { messageId: note.messageId, data: "mocked-by-parser" } },
      "Bearer verified-token",
    );

    expect(result).toEqual({ status: 200, body: { ok: true, disposition: "processed" } });
    expect(routeMocks.googlePurchaseAliasFindMany).toHaveBeenCalledWith({
      where: { tokenDigest: { in: [rootIdentity] } },
    });
    expect(routeMocks.acknowledgeGoogleReceipt.mock.calls.length - ackBefore).toBe(1);
  });

  it("retries a Google RTDN when its provider read began before a newer owner update", async () => {
    const rootIdentity = `google:${"6".repeat(64)}`;
    const note = {
      packageName: "com.braavolabs.app",
      kind: "subscription",
      notificationType: 2,
      purchaseToken: "synthetic-stale-rtdn",
      messageId: "google-stale-owner-1",
      publishTime: new Date("2026-08-25T20:00:00Z"),
    };
    routeMocks.verifyPubSubPushToken.mockResolvedValueOnce({ ok: true });
    routeMocks.parseGoogleRtdnEnvelope.mockReturnValueOnce(note);
    routeMocks.verifyGoogleReceipt.mockResolvedValueOnce({
      originalTransactionId: rootIdentity,
      googleCanonicalRootIdentity: rootIdentity,
      googlePurchaseAliases: [rootIdentity],
      googleAcknowledgementPending: false,
      googleProductId: "com.braavolabs.individual.monthly",
      googleLatestSuccessfulOrderId: null,
      status: "active",
      startedAt: new Date("2026-08-01T00:00:00Z"),
      expiresAt: new Date("2026-09-25T20:00:00Z"),
      autoRenew: true,
    });
    routeMocks.googlePurchaseAliasFindMany.mockResolvedValueOnce([{
      tokenDigest: rootIdentity,
      state: "active",
      tenantId: "tenant-1",
      mobileSubscriptionId: "subscription-1",
      provider: "google",
      canonicalRootIdentity: rootIdentity,
    }]);
    (routeMocks.prisma.$queryRaw as ReturnType<typeof vi.fn>).mockResolvedValueOnce([{
      id: "subscription-1",
      last_verified_at: new Date(Date.now() + 60_000),
    }]);
    const ledgerBefore = routeMocks.recordEntitlementEvent.mock.calls.length;
    const acknowledgeBefore = routeMocks.acknowledgeGoogleReceipt.mock.calls.length;

    const result = await post(
      "/google/notify",
      { message: { messageId: note.messageId, data: "mocked-by-parser" } },
      "Bearer verified-token",
    );

    expect(result).toEqual({ status: 503, body: { ok: false, reason: "retry-required" } });
    expect(routeMocks.recordEntitlementEvent.mock.calls.length).toBe(ledgerBefore);
    expect(routeMocks.acknowledgeGoogleReceipt.mock.calls.length).toBe(acknowledgeBefore);
  });

  it("atomically attaches a newly observed replacement alias to an already-owned root", async () => {
    const replacementIdentity = `google:${"7".repeat(64)}`;
    const rootIdentity = `google:${"6".repeat(64)}`;
    const owner = {
      tokenDigest: rootIdentity,
      state: "active",
      tenantId: "tenant-1",
      mobileSubscriptionId: "subscription-1",
      provider: "google",
      canonicalRootIdentity: rootIdentity,
    };
    const replacement = { ...owner, tokenDigest: replacementIdentity };
    routeMocks.verifyPubSubPushToken.mockResolvedValueOnce({ ok: true });
    routeMocks.parseGoogleRtdnEnvelope.mockReturnValueOnce({
      packageName: "com.braavolabs.app",
      kind: "subscription",
      notificationType: 2,
      purchaseToken: "synthetic-unseen-replacement",
      messageId: "google-unseen-replacement-1",
      publishTime: new Date("2026-08-25T20:00:00Z"),
    });
    routeMocks.verifyGoogleReceipt.mockResolvedValueOnce({
      originalTransactionId: rootIdentity,
      googleCanonicalRootIdentity: rootIdentity,
      googlePurchaseAliases: [replacementIdentity, rootIdentity],
      googleAcknowledgementPending: true,
      googleProductId: "com.braavolabs.individual.monthly",
      googleLatestSuccessfulOrderId: null,
      status: "active",
      startedAt: new Date("2026-08-01T00:00:00Z"),
      expiresAt: new Date("2026-09-25T20:00:00Z"),
      autoRenew: true,
    });
    routeMocks.googlePurchaseAliasFindMany
      .mockResolvedValueOnce([owner])
      .mockResolvedValueOnce([replacement, owner]);
    routeMocks.googlePurchaseAliasCreateMany.mockResolvedValueOnce({ count: 1 });
    const ackBefore = routeMocks.acknowledgeGoogleReceipt.mock.calls.length;

    const result = await post(
      "/google/notify",
      { message: { messageId: "google-unseen-replacement-1", data: "mocked-by-parser" } },
      "Bearer verified-token",
    );

    expect(result).toEqual({ status: 200, body: { ok: true, disposition: "processed" } });
    expect(routeMocks.googlePurchaseAliasCreateMany).toHaveBeenCalledWith({
      data: [{
        tokenDigest: replacementIdentity,
        state: "active",
        tenantId: "tenant-1",
        mobileSubscriptionId: "subscription-1",
        provider: "google",
        canonicalRootIdentity: rootIdentity,
      }],
      skipDuplicates: true,
    });
    expect(routeMocks.acknowledgeGoogleReceipt.mock.calls.length - ackBefore).toBe(1);
  });

  it.each(["one-time", "voided-one-time"] as const)(
    "durably classifies %s without touching subscription entitlement",
    async (kind) => {
      const messageId = `google-${kind}-unsupported-1`;
      const purchaseToken = `${kind}-purchase-secret`;
      routeMocks.verifyPubSubPushToken.mockResolvedValueOnce({ ok: true });
      routeMocks.parseGoogleRtdnEnvelope.mockReturnValueOnce({
        kind,
        packageName: "com.braavolabs.app",
        messageId,
        publishTime: new Date("2026-09-04T08:00:00Z"),
        purchaseToken,
        ...(kind === "one-time"
          ? { notificationType: 1, sku: "one-time-sku" }
          : { orderId: "GPA.1111-2222-3333-44444", refundType: 1 }),
      });
      const verifyBefore = routeMocks.verifyGoogleReceipt.mock.calls.length;
      const entitlementBefore = logicalEntitlements.size;

      const result = await post(
        "/google/notify",
        { message: { messageId, data: "mocked-by-parser" } },
        "Bearer verified-token",
      );

      expect(result).toEqual({ status: 200, body: { ok: false, reason: "unsupported-one-time" } });
      expect([...db.rows.values()].find((row) => row.deliveryId === messageId)).toMatchObject({
        status: "POISONED",
        failureCode: kind === "one-time"
          ? "GOOGLE_ONE_TIME_UNSUPPORTED"
          : "GOOGLE_ONE_TIME_VOIDED_UNSUPPORTED",
      });
      expect(routeMocks.verifyGoogleReceipt.mock.calls.length).toBe(verifyBefore);
      expect(logicalEntitlements.size).toBe(entitlementBefore);
      expect(JSON.stringify(db.writes)).not.toContain(purchaseToken);
    },
  );

  it("keeps pending refund review retryable and alerts without persisting its review token", async () => {
    const messageId = "google-refund-review-1";
    const reviewToken = "private-review-token";
    routeMocks.verifyPubSubPushToken.mockResolvedValueOnce({ ok: true });
    routeMocks.parseGoogleRtdnEnvelope.mockReturnValueOnce({
      kind: "pending-refund-review",
      packageName: "com.braavolabs.app",
      messageId,
      publishTime: new Date("2026-09-04T08:00:00Z"),
      refundReason: 7,
    });
    const verifyBefore = routeMocks.verifyGoogleReceipt.mock.calls.length;
    const entitlementBefore = logicalEntitlements.size;

    const result = await post(
      "/google/notify",
      { message: { messageId, data: "mocked-by-parser" } },
      "Bearer verified-token",
    );

    expect(result).toEqual({ status: 503, body: { ok: false, reason: "refund-review-action-required" } });
    expect([...db.rows.values()].find((row) => row.deliveryId === messageId)).toMatchObject({
      status: "RETRYABLE",
      failureCode: "GOOGLE_REFUND_REVIEW_ACTION_REQUIRED",
    });
    expect(routeMocks.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ code: "GOOGLE_REFUND_REVIEW_ACTION_REQUIRED" }),
      expect.any(String),
    );
    expect(routeMocks.verifyGoogleReceipt.mock.calls.length).toBe(verifyBefore);
    expect(logicalEntitlements.size).toBe(entitlementBefore);
    expect(JSON.stringify([db.writes, routeMocks.logger.error.mock.calls])).not.toContain(reviewToken);
  });

  it.each([
    ["current active order", "active", "GPA.1111-2222-3333-44444", true, true, "renewal"],
    ["prior renewal", "active", "GPA.9999-8888-7777-66666", false, false, "renewal"],
    ["provider-expired order", "expired", "GPA.1111-2222-3333-44444", true, false, "revoke"],
  ] as const)("reconciles voided %s using Play state and order identity", async (
    label, status, latestOrderId, currentOrderMatch, reviewRequired, eventType,
  ) => {
    const rootIdentity = `google:${"d".repeat(64)}`;
    const messageId = `google-voided-${label.replaceAll(" ", "-")}-1`;
    const purchaseToken = "voided-subscription-token";
    const orderId = "GPA.1111-2222-3333-44444";
    routeMocks.verifyPubSubPushToken.mockResolvedValueOnce({ ok: true });
    routeMocks.parseGoogleRtdnEnvelope.mockReturnValueOnce({
      kind: "voided-subscription",
      packageName: "com.braavolabs.app",
      purchaseToken,
      orderId,
      refundType: 1,
      messageId,
      publishTime: new Date("2026-09-04T08:00:00Z"),
    });
    routeMocks.verifyGoogleReceipt.mockResolvedValueOnce({
      originalTransactionId: rootIdentity,
      googleCanonicalRootIdentity: rootIdentity,
      googlePurchaseAliases: [rootIdentity],
      googleAcknowledgementPending: true,
      googleProductId: "com.braavolabs.individual.monthly",
      googleLatestSuccessfulOrderId: latestOrderId,
      status,
      startedAt: new Date("2026-08-01T00:00:00Z"),
      expiresAt: new Date("2026-10-01T00:00:00Z"),
      autoRenew: true,
    });
    routeMocks.googlePurchaseAliasFindMany.mockResolvedValueOnce([{
      tokenDigest: rootIdentity,
      state: "active",
      tenantId: "tenant-1",
      mobileSubscriptionId: "subscription-1",
      provider: "google",
      canonicalRootIdentity: rootIdentity,
    }]);
    const ackBefore = routeMocks.acknowledgeGoogleReceipt.mock.calls.length;
    const warnBefore = routeMocks.logger.warn.mock.calls.length;

    const result = await post(
      "/google/notify",
      { message: { messageId, data: "mocked-by-parser" } },
      "Bearer verified-token",
    );

    expect(result).toEqual({ status: 200, body: { ok: true, disposition: "processed" } });
    expect(routeMocks.verifyGoogleReceipt).toHaveBeenLastCalledWith(purchaseToken, undefined, expect.any(Function));
    expect(routeMocks.recordEntitlementEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ source: "google", sourceEventId: messageId, type: eventType }),
      expect.objectContaining({ rootIdentity }),
    );
    const activityLog = (routeMocks.prisma.activityLog as { upsert: ReturnType<typeof vi.fn> }).upsert;
    expect(activityLog).toHaveBeenLastCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        action: "billing.iap.voided_purchase",
        details: expect.objectContaining({
          type: "VOIDED_PURCHASE",
          currentOrderMatch,
          reviewRequired,
        }),
      }),
    }));
    expect(routeMocks.logger.warn.mock.calls.length - warnBefore).toBe(reviewRequired ? 1 : 0);
    if (reviewRequired) {
      expect(routeMocks.logger.warn).toHaveBeenLastCalledWith(
        expect.objectContaining({ code: "GOOGLE_VOIDED_CURRENT_ORDER_REVIEW" }),
        expect.any(String),
      );
    }
    expect(routeMocks.acknowledgeGoogleReceipt.mock.calls.length).toBe(ackBefore);
    expect(JSON.stringify(activityLog.mock.calls.at(-1))).not.toContain(orderId);
    expect(JSON.stringify(db.writes)).not.toContain(purchaseToken);
  });

  it.each(["voided-subscription", "subscription"] as const)(
    "does not revoke a newer verified Google replacement for a late old-token %s",
    async (kind) => {
      const rootIdentity = `google:${"a".repeat(64)}`;
      const newerIdentity = `google:${"b".repeat(64)}`;
      const owner = {
        tokenDigest: rootIdentity,
        state: "active",
        tenantId: "tenant-1",
        mobileSubscriptionId: "subscription-1",
        provider: "google",
        canonicalRootIdentity: rootIdentity,
      };
      const messageId = `google-late-old-${kind}-1`;
      const purchaseToken = `old-${kind}-purchase-token`;
      routeMocks.verifyPubSubPushToken.mockResolvedValueOnce({ ok: true });
      routeMocks.parseGoogleRtdnEnvelope.mockReturnValueOnce({
        kind,
        packageName: "com.braavolabs.app",
        purchaseToken,
        messageId,
        publishTime: new Date("2026-09-22T12:00:00Z"),
        ...(kind === "voided-subscription"
          ? { orderId: "GPA.OLD-ORDER", refundType: 1 }
          : { notificationType: 13 }),
      });
      routeMocks.verifyGoogleReceipt.mockResolvedValueOnce({
        originalTransactionId: rootIdentity,
        googleCanonicalRootIdentity: rootIdentity,
        googlePurchaseAliases: [rootIdentity],
        googleAcknowledgementPending: false,
        googleProductId: "com.braavolabs.individual.monthly",
        googleLatestSuccessfulOrderId: "GPA.OLD-ORDER",
        status: "expired",
        startedAt: new Date("2026-08-01T00:00:00Z"),
        expiresAt: new Date("2026-09-01T00:00:00Z"),
        autoRenew: false,
      });
      routeMocks.googlePurchaseAliasFindMany.mockResolvedValueOnce([owner]);
      routeMocks.googlePurchaseAliasFindFirst.mockResolvedValueOnce({
        tokenDigest: newerIdentity,
      });
      const subscriptionUpdate = (routeMocks.prisma.mobileSubscription as {
        updateMany: ReturnType<typeof vi.fn>;
      }).updateMany;
      const beforeUpdates = subscriptionUpdate.mock.calls.length;
      const beforeEntitlements = routeMocks.recordEntitlementEvent.mock.calls.length;
      const beforeAcks = routeMocks.acknowledgeGoogleReceipt.mock.calls.length;

      const result = await post(
        "/google/notify",
        { message: { messageId, data: "mocked-by-parser" } },
        "Bearer verified-token",
      );

      expect(result).toEqual({ status: 200, body: { ok: true, disposition: "processed" } });
      expect(subscriptionUpdate.mock.calls.length).toBe(beforeUpdates);
      expect(routeMocks.recordEntitlementEvent.mock.calls.length).toBe(beforeEntitlements);
      expect(routeMocks.acknowledgeGoogleReceipt.mock.calls.length).toBe(beforeAcks);
      const activityLog = (routeMocks.prisma.activityLog as { upsert: ReturnType<typeof vi.fn> }).upsert;
      expect(activityLog).toHaveBeenLastCalledWith(expect.objectContaining({
        create: expect.objectContaining({
          resourceId: "subscription-1",
          details: expect.objectContaining({ staleReplacedToken: true }),
        }),
      }));
      expect(JSON.stringify(activityLog.mock.calls.at(-1))).not.toContain(purchaseToken);
      expect(JSON.stringify(activityLog.mock.calls.at(-1))).not.toContain("GPA.OLD-ORDER");
    },
  );

  it("drops an old-token revoke when a replacement is claimed after the subscription update", async () => {
    const rootIdentity = `google:${"e".repeat(64)}`;
    const messageId = "google-old-token-second-fence";
    routeMocks.verifyPubSubPushToken.mockResolvedValueOnce({ ok: true });
    routeMocks.parseGoogleRtdnEnvelope.mockReturnValueOnce({
      kind: "subscription",
      packageName: "com.braavolabs.app",
      purchaseToken: "old-token-before-new-claim",
      messageId,
      notificationType: 13,
      publishTime: new Date("2026-09-22T12:00:00Z"),
    });
    routeMocks.verifyGoogleReceipt.mockResolvedValueOnce({
      originalTransactionId: rootIdentity,
      googleCanonicalRootIdentity: rootIdentity,
      googlePurchaseAliases: [rootIdentity],
      googleAcknowledgementPending: false,
      googleProductId: "com.braavolabs.individual.monthly",
      googleLatestSuccessfulOrderId: null,
      status: "expired",
      startedAt: new Date("2026-08-01T00:00:00Z"),
      expiresAt: new Date("2026-09-01T00:00:00Z"),
      autoRenew: false,
    });
    routeMocks.googlePurchaseAliasFindMany.mockResolvedValueOnce([{
      tokenDigest: rootIdentity,
      state: "active",
      tenantId: "tenant-1",
      mobileSubscriptionId: "subscription-1",
      provider: "google",
      canonicalRootIdentity: rootIdentity,
    }]);
    routeMocks.googlePurchaseAliasFindFirst.mockResolvedValueOnce(null);
    // The ledger's row-locked second check observes a new alias after the
    // earlier subscription transaction completed.
    routeMocks.recordEntitlementEvent.mockResolvedValueOnce(null);
    const logicalBefore = logicalEntitlements.size;
    const ackBefore = routeMocks.acknowledgeGoogleReceipt.mock.calls.length;

    const result = await post(
      "/google/notify",
      { message: { messageId, data: "mocked-by-parser" } },
      "Bearer verified-token",
    );

    expect(result).toEqual({ status: 200, body: { ok: true, disposition: "processed" } });
    expect(logicalEntitlements.size).toBe(logicalBefore);
    expect(routeMocks.acknowledgeGoogleReceipt.mock.calls.length).toBe(ackBefore);
    expect((routeMocks.prisma.activityLog as { upsert: ReturnType<typeof vi.fn> }).upsert)
      .toHaveBeenLastCalledWith(expect.objectContaining({
        create: expect.objectContaining({
          details: expect.objectContaining({ staleReplacedToken: true }),
        }),
      }));
  });

  it("retries a voided subscription whose provider token is no longer queryable", async () => {
    const messageId = "google-voided-lookup-unresolved-1";
    const purchaseToken = "voided-expired-provider-token";
    routeMocks.verifyPubSubPushToken.mockResolvedValueOnce({ ok: true });
    routeMocks.parseGoogleRtdnEnvelope.mockReturnValueOnce({
      kind: "voided-subscription",
      packageName: "com.braavolabs.app",
      purchaseToken,
      orderId: "GPA.1111-2222-3333-44444",
      refundType: 1,
      messageId,
      publishTime: new Date("2026-09-04T08:00:00Z"),
    });
    routeMocks.verifyGoogleReceipt.mockRejectedValueOnce(
      new AppError(400, "Google purchase replacement chain could not be verified"),
    );
    const entitlementBefore = logicalEntitlements.size;

    const result = await post(
      "/google/notify",
      { message: { messageId, data: "mocked-by-parser" } },
      "Bearer verified-token",
    );

    expect(result).toEqual({ status: 503, body: { ok: false, reason: "retry-required" } });
    expect([...db.rows.values()].find((row) => row.deliveryId === messageId)).toMatchObject({
      status: "RETRYABLE",
      failureCode: "GOOGLE_VOIDED_LOOKUP_UNRESOLVED",
    });
    expect(logicalEntitlements.size).toBe(entitlementBefore);
    expect(JSON.stringify(db.writes)).not.toContain(purchaseToken);
  });

  it.each([
    ["unsupported product", "com.braavolabs.unregistered.monthly", "GOOGLE_VOIDED_PRODUCT_UNSUPPORTED"],
    ["unowned token", "com.braavolabs.individual.monthly", "GOOGLE_VOIDED_OWNERSHIP_UNRESOLVED"],
  ] as const)("keeps a voided %s on the retry/DLQ path", async (label, googleProductId, code) => {
    const messageId = `google-voided-${label.replaceAll(" ", "-")}-1`;
    const rootIdentity = `google:${"f".repeat(64)}`;
    routeMocks.verifyPubSubPushToken.mockResolvedValueOnce({ ok: true });
    routeMocks.parseGoogleRtdnEnvelope.mockReturnValueOnce({
      kind: "voided-subscription",
      packageName: "com.braavolabs.app",
      purchaseToken: "voided-unresolved-token",
      orderId: "GPA.1111-2222-3333-44444",
      refundType: 1,
      messageId,
      publishTime: new Date("2026-09-04T08:00:00Z"),
    });
    routeMocks.verifyGoogleReceipt.mockResolvedValueOnce({
      originalTransactionId: rootIdentity,
      googleCanonicalRootIdentity: rootIdentity,
      googlePurchaseAliases: [rootIdentity],
      googleAcknowledgementPending: false,
      googleProductId,
      googleLatestSuccessfulOrderId: null,
      status: "active",
      startedAt: new Date("2026-08-01T00:00:00Z"),
      expiresAt: new Date("2026-10-01T00:00:00Z"),
      autoRenew: true,
    });
    if (label === "unowned token") routeMocks.googlePurchaseAliasFindMany.mockResolvedValueOnce([]);
    const entitlementBefore = logicalEntitlements.size;

    const result = await post(
      "/google/notify",
      { message: { messageId, data: "mocked-by-parser" } },
      "Bearer verified-token",
    );

    expect(result).toEqual({ status: 503, body: { ok: false, reason: "retry-required" } });
    expect([...db.rows.values()].find((row) => row.deliveryId === messageId)).toMatchObject({
      status: "RETRYABLE",
      failureCode: code,
    });
    expect(logicalEntitlements.size).toBe(entitlementBefore);
  });

  it.each(["one-time", "pending-refund-review"] as const)(
    "keeps %s auditable in the production legacy route",
    async (kind) => {
      const messageId = `google-legacy-${kind}-1`;
      routeMocks.verifyPubSubPushToken.mockResolvedValueOnce({ ok: true });
      routeMocks.parseGoogleRtdnEnvelope.mockReturnValueOnce({
        kind,
        packageName: "com.braavolabs.app",
        messageId,
        publishTime: new Date("2026-09-04T08:00:00Z"),
        ...(kind === "one-time"
          ? { purchaseToken: "one-time-secret", sku: "sku", notificationType: 1 }
          : { refundReason: 7 }),
      });
      env.IAP_DELIVERY_RELIABILITY_ENABLED = false;
      try {
        const result = await post(
          "/google/notify",
          { message: { messageId, data: "mocked-by-parser" } },
          "Bearer verified-token",
        );
        expect(result.status).toBe(kind === "one-time" ? 200 : 503);
        expect([...db.rows.values()].find((row) => row.deliveryId === messageId)).toMatchObject({
          status: kind === "one-time" ? "POISONED" : "RETRYABLE",
          failureCode: kind === "one-time"
            ? "GOOGLE_ONE_TIME_UNSUPPORTED"
            : "GOOGLE_REFUND_REVIEW_ACTION_REQUIRED",
        });
      } finally {
        env.IAP_DELIVERY_RELIABILITY_ENABLED = true;
      }
    },
  );

  it("records an authenticated unrecognised envelope in the production legacy route", async () => {
    const messageId = "google-legacy-unrecognised-1";
    const verifyBefore = routeMocks.verifyGoogleReceipt.mock.calls.length;
    routeMocks.verifyPubSubPushToken.mockResolvedValueOnce({ ok: true });
    routeMocks.parseGoogleRtdnEnvelope.mockReturnValueOnce(null);
    env.IAP_DELIVERY_RELIABILITY_ENABLED = false;
    try {
      const result = await post(
        "/google/notify",
        { message: { messageId, data: "unsupported-notification" } },
        "Bearer verified-token",
      );
      expect(result).toEqual({ status: 200, body: { ok: false, reason: "envelope-not-recognised" } });
      expect([...db.rows.values()].find((row) => row.deliveryId === messageId)).toMatchObject({
        status: "POISONED",
        failureCode: "GOOGLE_ENVELOPE_INVALID",
      });
      expect(routeMocks.verifyGoogleReceipt.mock.calls.length).toBe(verifyBefore);
    } finally {
      env.IAP_DELIVERY_RELIABILITY_ENABLED = true;
    }
  });

  it("records a foreign package before provider work in the production legacy route", async () => {
    const messageId = "google-legacy-package-mismatch-1";
    const verifyBefore = routeMocks.verifyGoogleReceipt.mock.calls.length;
    routeMocks.verifyPubSubPushToken.mockResolvedValueOnce({ ok: true });
    routeMocks.parseGoogleRtdnEnvelope.mockReturnValueOnce({
      kind: "subscription",
      packageName: "com.example.other",
      notificationType: 2,
      purchaseToken: "foreign-package-token",
      messageId,
      publishTime: new Date("2026-09-04T08:00:00Z"),
    });
    env.IAP_DELIVERY_RELIABILITY_ENABLED = false;
    try {
      const result = await post(
        "/google/notify",
        { message: { messageId, data: "mocked-by-parser" } },
        "Bearer verified-token",
      );
      expect(result).toEqual({ status: 200, body: { ok: false, reason: "package-mismatch" } });
      expect([...db.rows.values()].find((row) => row.deliveryId === messageId)).toMatchObject({
        status: "POISONED",
        failureCode: "GOOGLE_PACKAGE_MISMATCH",
      });
      expect(routeMocks.verifyGoogleReceipt.mock.calls.length).toBe(verifyBefore);
    } finally {
      env.IAP_DELIVERY_RELIABILITY_ENABLED = true;
    }
  });

  it("uses token-only provider authority in the production legacy subscription route", async () => {
    const rootIdentity = `google:${"c".repeat(64)}`;
    const messageId = "google-legacy-official-subscription-1";
    const purchaseToken = "official-token-no-product-in-rtdn";
    routeMocks.verifyPubSubPushToken.mockResolvedValueOnce({ ok: true });
    routeMocks.parseGoogleRtdnEnvelope.mockReturnValueOnce({
      kind: "subscription",
      packageName: "com.braavolabs.app",
      notificationType: 2,
      purchaseToken,
      messageId,
      publishTime: new Date("2026-09-04T08:00:00Z"),
    });
    routeMocks.verifyGoogleReceipt.mockResolvedValueOnce({
      originalTransactionId: rootIdentity,
      googleCanonicalRootIdentity: rootIdentity,
      googlePurchaseAliases: [rootIdentity],
      googleAcknowledgementPending: false,
      googleProductId: "com.braavolabs.individual.monthly",
      googleLatestSuccessfulOrderId: null,
      status: "active",
      startedAt: new Date("2026-08-01T00:00:00Z"),
      expiresAt: new Date("2026-10-01T00:00:00Z"),
      autoRenew: true,
    });
    routeMocks.googlePurchaseAliasFindMany.mockResolvedValueOnce([{
      tokenDigest: rootIdentity,
      state: "active",
      tenantId: "tenant-1",
      mobileSubscriptionId: "subscription-1",
      provider: "google",
      canonicalRootIdentity: rootIdentity,
    }]);
    env.IAP_DELIVERY_RELIABILITY_ENABLED = false;
    try {
      const result = await post(
        "/google/notify",
        { message: { messageId, data: "mocked-by-parser" } },
        "Bearer verified-token",
      );
      expect(result).toEqual({ status: 200, body: { ok: true } });
      expect(routeMocks.verifyGoogleReceipt).toHaveBeenLastCalledWith(purchaseToken, undefined, expect.any(Function));
      expect(routeMocks.recordEntitlementEvent).toHaveBeenLastCalledWith(
        expect.objectContaining({ source: "google", sourceEventId: messageId }),
        expect.objectContaining({ rootIdentity }),
      );
    } finally {
      env.IAP_DELIVERY_RELIABILITY_ENABLED = true;
    }
  });
});
