/**
 * IAP webhook reachability — regression guard for a routing bug that silently
 * killed both store ingresses in production.
 *
 * `src/index.ts` mounts `api.use("/billing", billingRouter)` and
 * `api.use("/billing/iap", iapRouter)`. Express matches mounts in order, and
 * `billingRouter` contains a PATHLESS `billingRouter.use(authedRouter)` whose
 * `authedRouter.use(authMiddleware)` therefore matches EVERY `/billing/**`
 * path — including `/billing/iap/**`. With `/billing` mounted first, Apple's
 * App Store Server Notifications V2 and Google Play's RTDN Pub/Sub push both
 * got 401 and never reached the handlers: renewals, cancellations, refunds and
 * grace-period transitions never updated MobileSubscription, so entitlement
 * only ever moved on the client-driven /verify call.
 *
 * Found by the BR-P0-004 independent review — the tenant-marking pass forced
 * an audit of every webhook route, and these two turned out to be unreachable.
 *
 * These tests drive the REAL routers through a REAL express app in the REAL
 * mount order, so they fail if anyone reorders the mounts again or makes
 * `authedRouter` pathless-greedy over a sibling.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";

const routeEnv = vi.hoisted(() => ({
  JWT_SECRET: "test-secret-for-mount-order",
  AUTH_COOKIE_MODE: false,
  NODE_ENV: "test",
  STRIPE_SECRET_KEY: "",
  STRIPE_WEBHOOK_SECRET: "",
  APPLE_IAP_SHARED_SECRET: "",
  GOOGLE_PLAY_PACKAGE_NAME: "",
  GOOGLE_PUBSUB_AUDIENCE: "https://api.braavolabs.com/api/v1/billing/iap/google/notify",
  GOOGLE_PUBSUB_SA_EMAIL: "rtdn@example.iam.gserviceaccount.com",
  IAP_DELIVERY_RELIABILITY_ENABLED: false,
  IAP_DELIVERY_MAX_ATTEMPTS: 3,
  REVENUECAT_WEBHOOK_SECRET: "",
}));

const routeMocks = vi.hoisted(() => ({
  verifyPubSubPushToken: vi.fn(),
  parseGoogleRtdnEnvelope: vi.fn(),
  verifyGoogleReceipt: vi.fn(),
  acknowledgeGoogleReceipt: vi.fn(),
  processIapDelivery: vi.fn(),
  recordEntitlementEvent: vi.fn(),
  activityLogCreate: vi.fn(),
  mobileSubscriptionFindUnique: vi.fn(),
  mobileSubscriptionCreate: vi.fn(),
  mobileSubscriptionUpdate: vi.fn(),
  mobileSubscriptionUpdateMany: vi.fn(),
  transaction: vi.fn(),
  tenantTx: vi.fn(),
}));

vi.mock("../../../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../../../lib/db", () => ({
  prisma: {
    activityLog: { create: routeMocks.activityLogCreate },
    mobileSubscription: {
      findUnique: routeMocks.mobileSubscriptionFindUnique,
      create: routeMocks.mobileSubscriptionCreate,
      update: routeMocks.mobileSubscriptionUpdate,
      updateMany: routeMocks.mobileSubscriptionUpdateMany,
    },
    $transaction: routeMocks.transaction,
  },
  tenantTx: routeMocks.tenantTx,
}));
vi.mock("../../../../middleware/rateLimit", () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
// Auth is REAL — the shadowing bug lives in how it is mounted, so mocking it
// away would mock away the very thing under test. Only the secret is stubbed.
vi.mock("../../../../config/env", () => ({
  env: routeEnv,
}));
vi.mock("../google", () => ({
  verifyPubSubPushToken: routeMocks.verifyPubSubPushToken,
  parseGoogleRtdnEnvelope: routeMocks.parseGoogleRtdnEnvelope,
  verifyGoogleReceipt: routeMocks.verifyGoogleReceipt,
  acknowledgeGoogleReceipt: routeMocks.acknowledgeGoogleReceipt,
}));
vi.mock("../delivery-ledger", () => ({
  IapPoisonDeliveryError: class IapPoisonDeliveryError extends Error {},
  IapTransientDeliveryError: class IapTransientDeliveryError extends Error {},
  deliveryFingerprint: vi.fn(() => "test-fingerprint"),
  processIapDelivery: routeMocks.processIapDelivery,
}));
vi.mock("../../entitlement-ledger.service", () => ({
  GOOGLE_OBSERVATION_STALE: "Google verification was superseded; retry",
  recordEntitlementEvent: routeMocks.recordEntitlementEvent,
}));

let server: http.Server;
let baseUrl: string;
let token: string;

beforeAll(async () => {
  const jwt = (await import("jsonwebtoken")).default;
  token = jwt.sign(
    { userId: "u1", tenantId: "tenant-A", role: "OWNER" },
    "test-secret-for-mount-order",
    { expiresIn: "1h" },
  );

  const { billingRouter } = await import("../../router");
  const { iapRouter } = await import("../router");

  const app = express();
  app.use(express.json());
  const api = express.Router();
  // ── the exact ordering contract under test ──
  api.use("/billing/iap", iapRouter);
  api.use("/billing", billingRouter);
  app.use("/api/v1", api);
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err?.statusCode ?? err?.status ?? 500).json({ error: err?.message ?? "error" });
  });

  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

beforeEach(() => {
  vi.clearAllMocks();
  routeEnv.IAP_DELIVERY_RELIABILITY_ENABLED = false;
  routeMocks.verifyPubSubPushToken.mockResolvedValue({ ok: false, reason: "missing-bearer-token" });
});

async function post(path: string, body: unknown, auth?: string) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe("IAP store webhooks are reachable (mount-order regression)", () => {
  it("Apple ASSN V2 posts UNAUTHENTICATED and reaches the handler, not a 401", async () => {
    const r = await post("/api/v1/billing/iap/apple/notify", {});
    // 400 "missing signedPayload" means the handler RAN. 401 means
    // billingRouter's authMiddleware shadowed the route and Apple is talking
    // to a wall.
    expect(r.status).not.toBe(401);
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: "missing signedPayload" });
  });

  it.each([
    ["legacy", false],
    ["reliable", true],
  ])("Google RTDN %s mode reaches iapRouter and fails closed before downstream work", async (_mode, reliable) => {
    routeEnv.IAP_DELIVERY_RELIABILITY_ENABLED = reliable;
    const r = await post("/api/v1/billing/iap/google/notify", {});
    expect(r).toEqual({ status: 401, body: { error: "unauthorized" } });
    expect(routeMocks.verifyPubSubPushToken).toHaveBeenCalledTimes(1);
    expect(routeMocks.parseGoogleRtdnEnvelope).not.toHaveBeenCalled();
    expect(routeMocks.verifyGoogleReceipt).not.toHaveBeenCalled();
    expect(routeMocks.acknowledgeGoogleReceipt).not.toHaveBeenCalled();
    expect(routeMocks.processIapDelivery).not.toHaveBeenCalled();
    expect(routeMocks.recordEntitlementEvent).not.toHaveBeenCalled();
    expect(routeMocks.activityLogCreate).not.toHaveBeenCalled();
    expect(routeMocks.mobileSubscriptionFindUnique).not.toHaveBeenCalled();
    expect(routeMocks.mobileSubscriptionCreate).not.toHaveBeenCalled();
    expect(routeMocks.mobileSubscriptionUpdate).not.toHaveBeenCalled();
    expect(routeMocks.mobileSubscriptionUpdateMany).not.toHaveBeenCalled();
    expect(routeMocks.transaction).not.toHaveBeenCalled();
    expect(routeMocks.tenantTx).not.toHaveBeenCalled();
  });

  it("an AUTHENTICATED post to the webhook does not 500 on the tenant-context guard", async () => {
    // BR-P0-004 marks the notify routes system-scoped. If authMiddleware still
    // shadows them, runWithTenant wraps the request first and the system-scope
    // marker (which refuses to nest inside a tenant context) throws — turning a
    // 400 into a 500. This asserts the two mechanisms do not collide.
    const r = await post("/api/v1/billing/iap/apple/notify", {}, token);
    expect(r.status).not.toBe(500);
    expect(r.status).toBe(400);
  });

  it("still requires auth on the authenticated IAP routes (no over-correction)", async () => {
    const r = await post("/api/v1/billing/iap/verify", { platform: "ios" });
    expect(r.status).toBe(401);
  });

  it("does not break sibling /billing routes that DO require auth", async () => {
    const r = await post("/api/v1/billing/checkout", {});
    expect(r.status).toBe(401);
  });

  it("does not expose an unauthenticated webhook replay endpoint", async () => {
    const r = await post("/api/v1/billing/iap/replay", {}, token);
    expect(r.status).toBe(404);
  });
});
