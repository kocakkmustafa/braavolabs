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
  googlePurchaseAliasFindMany: vi.fn(),
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
  recordEntitlementEvent: routeMocks.recordEntitlementEvent,
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
  mapAppleNotify: (note: { notificationUUID: string }) => ({
    source: "apple",
    streamId: "apple-stream",
    sourceEventId: note.notificationUUID,
    sourceTimestamp: new Date("2026-08-25T20:00:00Z"),
    type: "renewal",
    planTier: "INDIVIDUAL",
    expiresAt: new Date("2026-09-25T20:00:00Z"),
    autoRenew: true,
  }),
  mapGoogleNotify: (note: { messageId: string }) => ({
    source: "google",
    streamId: "google-stream",
    sourceEventId: note.messageId,
    sourceTimestamp: new Date("2026-08-25T20:00:00Z"),
    type: "renewal",
    planTier: "INDIVIDUAL",
    expiresAt: new Date("2026-09-25T20:00:00Z"),
    autoRenew: true,
  }),
}));

import {
  IapPoisonDeliveryError,
  IapTransientDeliveryError,
  deliveryFingerprint,
  processIapDelivery,
  type IapDeliveryStore,
} from "../delivery-ledger";

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

  it("bounds persistent provider failure and terminally poisons the final source delivery", async () => {
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
    await expect(processIapDelivery(appleDelivery, effect, db.store, 3)).resolves.toEqual({
      disposition: "poisoned",
      httpStatus: 200,
    });
    expect([...db.rows.values()][0]).toMatchObject({
      status: "POISONED",
      attempts: 3,
      failureCode: "DELIVERY_RETRY_EXHAUSTED",
    });
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

  it("bounds repeated P2025 persistence failure and returns terminal redacted 200", async () => {
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
    const terminal = await post("/apple/notify", { signedPayload: "p2025-jws" });
    expect(terminal.status).toBe(200);
    expect(JSON.stringify(terminal.body)).not.toContain("P2025");
    expect([...db.rows.values()].find((row) => row.deliveryId === note.notificationUUID)).toMatchObject({
      status: "POISONED",
      attempts: 3,
      failureCode: "DELIVERY_RETRY_EXHAUSTED",
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

  it("terminally rejects a Google package mismatch before provider or billing work", async () => {
    const verifyBefore = routeMocks.verifyGoogleReceipt.mock.calls.length;
    const subscriptionsBefore = logicalSubscriptions.size;
    routeMocks.verifyPubSubPushToken.mockResolvedValueOnce({ ok: true });
    routeMocks.parseGoogleRtdnEnvelope.mockReturnValueOnce({
      packageName: "com.example.wrong",
      notificationType: 2,
      purchaseToken: "synthetic-package-mismatch",
      subscriptionId: "com.braavolabs.individual.monthly",
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
      notificationType: 2,
      purchaseToken: "unknown-product-purchase-token",
      subscriptionId: "com.braavolabs.unregistered.monthly",
      messageId: "google-unknown-delivery-1",
      publishTime: new Date("2026-08-25T20:00:00Z"),
    };
    routeMocks.verifyPubSubPushToken.mockResolvedValueOnce({ ok: true });
    routeMocks.parseGoogleRtdnEnvelope.mockReturnValueOnce(note);
    routeMocks.verifyGoogleReceipt.mockResolvedValueOnce({
      originalTransactionId: `google:${"b".repeat(64)}`,
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
      notificationType: 2,
      purchaseToken: rawPurchaseToken,
      subscriptionId: "com.braavolabs.individual.monthly",
      messageId: "google-legacy-migration-1",
      publishTime: new Date("2026-08-25T20:00:00Z"),
    });
    routeMocks.verifyGoogleReceipt.mockResolvedValueOnce({
      originalTransactionId: hashedIdentity,
      googleCanonicalRootIdentity: hashedIdentity,
      googlePurchaseAliases: [hashedIdentity],
      googleAcknowledgementPending: true,
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
        subscriptionId: "com.braavolabs.individual.monthly",
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
      notificationType: 2,
      purchaseToken: "synthetic-known-rtdn",
      subscriptionId: "com.braavolabs.individual.monthly",
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
      notificationType: 2,
      purchaseToken: "synthetic-unseen-replacement",
      subscriptionId: "com.braavolabs.individual.monthly",
      messageId: "google-unseen-replacement-1",
      publishTime: new Date("2026-08-25T20:00:00Z"),
    });
    routeMocks.verifyGoogleReceipt.mockResolvedValueOnce({
      originalTransactionId: rootIdentity,
      googleCanonicalRootIdentity: rootIdentity,
      googlePurchaseAliases: [replacementIdentity, rootIdentity],
      googleAcknowledgementPending: true,
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
});
