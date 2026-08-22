import { inspect } from "node:util";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({
  parseAppleNotification: vi.fn(),
  verifyAppleReceipt: vi.fn(),
  parseGoogleRtdnEnvelope: vi.fn(),
  verifyGoogleReceipt: vi.fn(),
  verifyPubSubPushToken: vi.fn(),
  mobileSubscriptionUpdate: vi.fn(),
  activityLogCreate: vi.fn(),
  tenantUpdate: vi.fn(),
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  entitlementRows: [] as Array<Record<string, unknown>>,
  deadLetters: new Map<string, string>(),
  redisHsetnx: vi.fn(),
  redisHget: vi.fn(),
}));

vi.mock("../../../../lib/logger", () => ({ logger: testState.logger }));

vi.mock("@ai-company-os/core", () => ({
  normalizePlanForEntitlement: (plan: string | null | undefined) =>
    plan === "INDIVIDUAL" || plan === "TEAM" ? plan : "MANUAL_REVIEW",
}));

vi.mock("../../../../lib/redis", () => ({
  redis: {
    hsetnx: (...args: unknown[]) => testState.redisHsetnx(...args),
    hget: (...args: unknown[]) => testState.redisHget(...args),
  },
}));

vi.mock("../../../../lib/db", () => ({
  prisma: {
    mobileSubscription: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      findFirst: vi.fn(),
      update: (...args: unknown[]) => testState.mobileSubscriptionUpdate(...args),
    },
    activityLog: {
      create: (...args: unknown[]) => testState.activityLogCreate(...args),
    },
    entitlementEvent: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const duplicate = testState.entitlementRows.some(
          (row) => row.source === data.source && row.sourceEventId === data.sourceEventId,
        );
        if (duplicate) throw new Error("P2002 Unique constraint failed");
        const row = { id: `event-${testState.entitlementRows.length + 1}`, ...data };
        testState.entitlementRows.push(row);
        return row;
      }),
    },
  },
  tenantTx: async (fn: (tx: unknown) => unknown) => fn({
    $queryRaw: vi.fn().mockResolvedValue([]),
    entitlementEvent: {
      findMany: vi.fn(async ({ where }: { where: { tenantId: string } }) =>
        testState.entitlementRows.filter((row) => row.tenantId === where.tenantId)),
    },
    tenant: {
      update: (...args: unknown[]) => testState.tenantUpdate(...args),
    },
  }),
}));

vi.mock("../../../../middleware/auth", () => ({
  authMiddleware: (
    req: { auth?: { tenantId: string; userId: string; role: string } },
    _res: unknown,
    next: () => void,
  ) => {
    req.auth = { tenantId: "tenant-1", userId: "user-1", role: "OWNER" };
    next();
  },
}));

vi.mock("../../../../middleware/system-scope", () => ({
  systemScope: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../../../../middleware/rateLimit", () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../../../../config/env", () => ({
  env: {
    NODE_ENV: "production",
    REVENUECAT_WEBHOOK_SECRET: "",
    GOOGLE_PLAY_PACKAGE_NAME: "com.braavolabs.app",
  },
}));

vi.mock("../apple", () => ({
  parseAppleNotification: (...args: unknown[]) => testState.parseAppleNotification(...args),
  verifyAppleReceipt: (...args: unknown[]) => testState.verifyAppleReceipt(...args),
}));

vi.mock("../google", () => ({
  parseGoogleRtdnEnvelope: (...args: unknown[]) => testState.parseGoogleRtdnEnvelope(...args),
  verifyGoogleReceipt: (...args: unknown[]) => testState.verifyGoogleReceipt(...args),
  verifyPubSubPushToken: (...args: unknown[]) => testState.verifyPubSubPushToken(...args),
}));

let server: http.Server | undefined;
let baseUrl: string;

const future = new Date("2099-01-01T00:00:00.000Z");
const sourceTime = new Date("2026-08-22T12:00:00.000Z");

beforeAll(async () => {
  const { iapRouter } = await import("../router");
  const app = express();
  app.use(express.json());
  app.use("/api/v1/billing/iap", iapRouter);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => {
  if (!server) return resolve();
  server.close(() => resolve());
}));

beforeEach(() => {
  vi.clearAllMocks();
  testState.entitlementRows.length = 0;
  testState.deadLetters.clear();

  testState.redisHsetnx.mockImplementation(async (_key: string, field: string, value: string) => {
    if (testState.deadLetters.has(field)) return 0;
    testState.deadLetters.set(field, value);
    return 1;
  });
  testState.redisHget.mockImplementation(async (_key: string, field: string) =>
    testState.deadLetters.get(field) ?? null);

  testState.parseAppleNotification.mockResolvedValue({
    notificationType: "DID_RENEW",
    originalTransactionId: "apple-stream-1",
    productId: "com.braavolabs.individual.monthly",
    expiresAt: future,
    status: "active",
    autoRenew: true,
    notificationUUID: "apple-delivery-1",
    signedDate: sourceTime,
  });
  testState.verifyAppleReceipt.mockResolvedValue({
    originalTransactionId: "apple-stream-1",
    status: "active",
    startedAt: sourceTime,
    expiresAt: future,
    autoRenew: true,
  });
  testState.parseGoogleRtdnEnvelope.mockReturnValue({
    packageName: "com.braavolabs.app",
    notificationType: 2,
    purchaseToken: "google-purchase-token",
    subscriptionId: "com.braavolabs.team.monthly",
    messageId: "google-delivery-1",
    publishTime: sourceTime,
  });
  testState.verifyGoogleReceipt.mockResolvedValue({
    originalTransactionId: "google-stream-1",
    status: "active",
    startedAt: sourceTime,
    expiresAt: future,
    autoRenew: true,
  });
  testState.verifyPubSubPushToken.mockResolvedValue({ ok: true });
  testState.mobileSubscriptionUpdate.mockImplementation(async ({ where }: { where: { originalTransactionId: string } }) => ({
    id: `subscription-${where.originalTransactionId}`,
    tenantId: "tenant-1",
    planTier: where.originalTransactionId.startsWith("apple") ? "INDIVIDUAL" : "TEAM",
  }));
  testState.activityLogCreate.mockResolvedValue({ id: "activity-1" });
  testState.tenantUpdate.mockResolvedValue({ id: "tenant-1" });
});

async function post(path: string, body: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer mocked-google-oidc",
    },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    retryAfter: response.headers.get("retry-after"),
    body: await response.json().catch(() => null),
  };
}

function loggedText(): string {
  return inspect(
    [
      ...testState.logger.debug.mock.calls,
      ...testState.logger.info.mock.calls,
      ...testState.logger.warn.mock.calls,
      ...testState.logger.error.mock.calls,
    ],
    { depth: 12 },
  );
}

describe("IAP webhook delivery HTTP and idempotency contract", () => {
  it("never logs an authenticated verify receipt carried by an unexpected provider error", async () => {
    const receipt = "secret-user-receipt-token";
    testState.verifyAppleReceipt.mockRejectedValueOnce(
      new Error(`provider SDK failed for receipt ${receipt}`),
    );

    const result = await post("/api/v1/billing/iap/verify", {
      provider: "apple",
      receipt,
      productId: "com.braavolabs.individual.monthly",
    });

    expect(result.status).toBe(500);
    expect(loggedText()).not.toContain(receipt);
  });

  it("acks a successful Apple delivery and records one entitlement effect", async () => {
    const result = await post("/api/v1/billing/iap/apple/notify", { signedPayload: "valid-apple-jws" });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true });
    expect(testState.entitlementRows).toHaveLength(1);
  });

  it("acks an exact Apple duplicate while the entitlement effect remains one", async () => {
    const first = await post("/api/v1/billing/iap/apple/notify", { signedPayload: "same-apple-jws" });
    const duplicate = await post("/api/v1/billing/iap/apple/notify", { signedPayload: "same-apple-jws" });

    expect(first.status).toBe(200);
    expect(duplicate.status).toBe(200);
    expect(testState.entitlementRows).toHaveLength(1);
  });

  it("returns retriable 503 when Apple provider verification is transiently unavailable", async () => {
    const { AppError } = await import("../../../../middleware/error");
    testState.verifyAppleReceipt.mockRejectedValueOnce(
      new AppError(503, "provider unavailable secret-provider-diagnostic"),
    );

    const result = await post("/api/v1/billing/iap/apple/notify", { signedPayload: "apple-transient-jws" });

    expect(result.status).toBe(503);
    expect(result.retryAfter).toBe("5");
    expect(result.body).toEqual({
      ok: false,
      disposition: "retry",
      code: "provider-temporary-failure",
    });
    expect(testState.deadLetters).toHaveProperty("size", 0);
    expect(loggedText()).not.toContain("secret-provider-diagnostic");
  });

  it("returns retriable 503 when entitlement persistence fails", async () => {
    testState.mobileSubscriptionUpdate.mockRejectedValueOnce(new Error("database timeout raw-receipt-value"));

    const result = await post("/api/v1/billing/iap/apple/notify", { signedPayload: "apple-persistence-jws" });

    expect(result.status).toBe(503);
    expect(result.retryAfter).toBe("5");
    expect(result.body).toEqual({
      ok: false,
      disposition: "retry",
      code: "persistence-temporary-failure",
    });
    expect(testState.entitlementRows).toHaveLength(0);
    expect(loggedText()).not.toContain("raw-receipt-value");
  });

  it("dead-letters a permanent Apple payload failure without storing or logging the JWS", async () => {
    const secretJws = "header.secret-apple-payload.signature";
    const { AppError } = await import("../../../../middleware/error");
    testState.parseAppleNotification.mockRejectedValueOnce(
      new AppError(401, `invalid signature for ${secretJws}`),
    );

    const result = await post("/api/v1/billing/iap/apple/notify", { signedPayload: secretJws });

    expect(result.status).toBe(202);
    expect(result.body).toEqual({
      ok: false,
      disposition: "dead-lettered",
      code: "invalid-payload",
    });
    expect(testState.deadLetters.size).toBe(1);
    expect([...testState.deadLetters.values()].join("\n")).not.toContain(secretJws);
    expect(loggedText()).not.toContain(secretJws);
  });

  it("dead-letters an invalid nested Apple JWS instead of retrying poison forever", async () => {
    const nestedJws = "header.secret-nested-apple-payload.signature";
    const { JwsVerificationError } = await import("../jws");
    testState.parseAppleNotification.mockRejectedValueOnce(
      new JwsVerificationError(`nested JWS invalid: ${nestedJws}`),
    );

    const result = await post("/api/v1/billing/iap/apple/notify", { signedPayload: nestedJws });

    expect(result.status).toBe(202);
    expect(result.body).toEqual({
      ok: false,
      disposition: "dead-lettered",
      code: "invalid-payload",
    });
    expect(testState.deadLetters.size).toBe(1);
    expect([...testState.deadLetters.values()].join("\n")).not.toContain(nestedJws);
    expect(loggedText()).not.toContain(nestedJws);
  });

  it("dead-letters an unrecognised Google envelope without retaining its purchase token", async () => {
    const purchaseToken = "google-secret-purchase-token";
    testState.parseGoogleRtdnEnvelope.mockReturnValueOnce(null);

    const result = await post("/api/v1/billing/iap/google/notify", {
      message: { data: Buffer.from(JSON.stringify({ purchaseToken })).toString("base64") },
    });

    expect(result.status).toBe(202);
    expect(result.body).toEqual({
      ok: false,
      disposition: "dead-lettered",
      code: "invalid-envelope",
    });
    expect(testState.deadLetters.size).toBe(1);
    expect([...testState.deadLetters.values()].join("\n")).not.toContain(purchaseToken);
    expect(loggedText()).not.toContain(purchaseToken);
  });

  it("returns retriable 503 when Google provider verification is transiently unavailable", async () => {
    const { AppError } = await import("../../../../middleware/error");
    testState.verifyGoogleReceipt.mockRejectedValueOnce(new AppError(502, "google temporarily unavailable"));

    const result = await post("/api/v1/billing/iap/google/notify", { message: { data: "valid" } });

    expect(result.status).toBe(503);
    expect(result.retryAfter).toBe("5");
    expect(result.body).toEqual({
      ok: false,
      disposition: "retry",
      code: "provider-temporary-failure",
    });
    expect(testState.entitlementRows).toHaveLength(0);
  });

  it("returns 503 rather than losing poison when the DLQ store is unavailable", async () => {
    const { AppError } = await import("../../../../middleware/error");
    testState.parseAppleNotification.mockRejectedValueOnce(new AppError(400, "malformed payload"));
    testState.redisHsetnx.mockRejectedValueOnce(new Error("redis unavailable"));

    const result = await post("/api/v1/billing/iap/apple/notify", { signedPayload: "malformed-jws" });

    expect(result.status).toBe(503);
    expect(result.retryAfter).toBe("5");
    expect(result.body).toEqual({
      ok: false,
      disposition: "retry",
      code: "dead-letter-write-failed",
    });
  });
});

describe("redacted DLQ replay", () => {
  it("replays a normalized record through the entitlement reducer twice with one effect and preserves the record", async () => {
    const { appendIapDeadLetter, replayIapDeadLetter } = await import("../delivery-ledger");
    const rawPayload = "raw-jws-must-not-be-persisted";
    const record = await appendIapDeadLetter({
      provider: "apple",
      failureCode: "persistence-rejected",
      rawPayload,
      deliveryId: "apple-replay-delivery",
      entitlementEvent: {
        tenantId: "tenant-1",
        source: "apple",
        streamId: "apple-stream-replay",
        sourceEventId: "apple-delivery-replay",
        sourceTimestamp: sourceTime,
        type: "renewal",
        planTier: "INDIVIDUAL",
        expiresAt: future,
        autoRenew: true,
      },
    });

    const first = await replayIapDeadLetter(record.id);
    const duplicate = await replayIapDeadLetter(record.id);

    expect(first).toEqual({ status: "replayed" });
    expect(duplicate).toEqual({ status: "replayed" });
    expect(testState.entitlementRows).toHaveLength(1);
    expect(testState.deadLetters.has(record.id)).toBe(true);
    expect(testState.deadLetters.get(record.id)).not.toContain(rawPayload);
  });

  it("keeps an invalid-payload poison record but refuses to invent a replayable entitlement", async () => {
    const { appendIapDeadLetter, replayIapDeadLetter } = await import("../delivery-ledger");
    const record = await appendIapDeadLetter({
      provider: "google",
      failureCode: "invalid-envelope",
      rawPayload: "opaque-provider-payload",
    });

    await expect(replayIapDeadLetter(record.id)).resolves.toEqual({ status: "not-replayable" });
    expect(testState.entitlementRows).toHaveLength(0);
    expect(testState.deadLetters.has(record.id)).toBe(true);
  });
});
