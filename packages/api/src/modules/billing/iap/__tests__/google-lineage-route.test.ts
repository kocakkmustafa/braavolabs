import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";

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
  activityLogFindMany: vi.fn(),
  googlePurchaseAliasUpdateMany: vi.fn(),
  deliveryCreate: vi.fn(),
  deliveryFindUnique: vi.fn(),
  deliveryUpdateMany: vi.fn(),
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
    iapWebhookDelivery: { create: mocks.deliveryCreate, findUnique: mocks.deliveryFindUnique, updateMany: mocks.deliveryUpdateMany },
    googlePurchaseAlias: { findMany: mocks.googlePurchaseAliasFindMany },
    activityLog: { create: mocks.activityLogCreate, upsert: mocks.activityLogUpsert },
    $transaction: mocks.transaction,
  },
  tenantTx: mocks.tenantTx,
}));
vi.mock("../../../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: mocks.loggerWarn, error: mocks.loggerError },
}));
vi.mock("../../../../config/env", () => ({
  env: { GOOGLE_PURCHASE_LINEAGE_ENABLED: true, NODE_ENV: "test", REVENUECAT_WEBHOOK_SECRET: "", GOOGLE_PLAY_PACKAGE_NAME: "com.braavolabs.mobile", GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: Buffer.from(JSON.stringify({ client_email: "fixture@example.invalid", private_key: "fixture-key" })).toString("base64") },
}));
vi.mock("google-auth-library", () => ({ JWT: class { async getAccessToken() { return { token: "fixture-access" }; } }, OAuth2Client: class {} }));
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
import { iapRouter } from "../router";


const ACTIVE_EXPIRY = new Date("2099-09-01T00:00:00.000Z");

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
  mocks.verifyAppleReceipt.mockResolvedValue({ originalTransactionId: "operator-apple-identity", status: "active", startedAt: new Date(0), expiresAt: ACTIVE_EXPIRY, autoRenew: true });
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
    activityLog: { upsert: mocks.activityLogUpsert, findMany: mocks.activityLogFindMany, create: mocks.activityLogCreate },
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
      updateMany: mocks.googlePurchaseAliasUpdateMany,
    },
  }));
});

async function postVerify(provider: "apple" | "google", productId: string, options: { receipt?: string } = {}) {
  const layer = (iapRouter as any).stack.find((entry: any) => entry.route?.path === "/verify");
  // Execute the actual terminal Express route handler without opening a socket.
  return new Promise<{ status: number; body: any }>((resolveResponse, reject) => {
    let status = 200;
    const res = { status(code: number) { status = code; return this; },
      json(body: unknown) { resolveResponse({ status, body }); } };
    const req = { auth: { tenantId: "tenant-1", userId: "fixture-user", role: "OWNER" },
      body: { provider, productId, receipt: options.receipt ?? "D" } };
    layer.route.stack.at(-1).handle(req, res, (error: any) => {
      if (error) resolveResponse({ status: error.statusCode ?? 500, body: { error: error.message } });
      else reject(new Error("route completed without response"));
    });
  });
}

async function postGoogleNotification(messageId: string) {
  const layer = (iapRouter as any).stack.find((entry: any) => entry.route?.path === "/google/notify");
  return new Promise<{ status: number; body: any }>((resolveResponse, reject) => {
    let status = 200;
    const res = { status(code: number) { status = code; return this; },
      json(body: unknown) { resolveResponse({ status, body }); } };
    Promise.resolve(layer.route.stack.at(-1).handle({ headers: { authorization: "Bearer fixture-oidc" },
      body: { message: { messageId, data: "fixture" } } }, res, reject)).catch(reject);
  });
}

const digest = (token: string) => `google:${crypto.createHash("sha256").update(token).digest("hex")}`;
const PRODUCT = "com.braavolabs.individual.monthly";
let ledgerEffects = 0;

async function installLineageFixture(gone: boolean, options: { unknown?: boolean; newer?: boolean; expired?: boolean } = {}) {
  const { env } = await import("../../../../config/env");
  env.GOOGLE_PURCHASE_LINEAGE_ENABLED = true;
  env.IAP_DELIVERY_RELIABILITY_ENABLED = false;
  const deliveries: any[] = [];
  mocks.deliveryCreate.mockImplementation(async ({ data }) => {
    if (deliveries.some(row => row.provider === data.provider && row.deliveryId === data.deliveryId)) {
      throw Object.assign(new Error("Unique constraint P2002"), { code: "P2002" });
    }
    const row = { id: `fixture-delivery-${deliveries.length}`, ...data, failureCode: null, processedAt: null, createdAt: new Date(), updatedAt: new Date() };
    deliveries.push(row); return row;
  });
  mocks.deliveryFindUnique.mockImplementation(async ({ where }) => deliveries.find(row => row.provider === where.provider_deliveryId.provider && row.deliveryId === where.provider_deliveryId.deliveryId) ?? null);
  mocks.deliveryUpdateMany.mockImplementation(async ({ where, data }) => {
    const row = deliveries.find(row => row.id === where.id && (where.attempts === undefined || row.attempts === where.attempts)
      && (where.status === undefined || typeof where.status === "string" ? where.status === undefined || row.status === where.status : where.status.in.includes(row.status)));
    if (!row) return { count: 0 }; Object.assign(row, data); return { count: 1 };
  });
  const google = await vi.importActual<typeof import("../google")>("../google");
  const ledger = await vi.importActual<typeof import("../../entitlement-ledger.service")>("../../entitlement-ledger.service");
  const root = digest("A");
  const owner = { id: "mobile-sub-1", tenantId: "tenant-1", provider: "google",
    originalTransactionId: root, lastVerifiedAt: new Date(0) };
  const rows = ["A", "B", "C"].map(token => ({ tokenDigest: digest(token), state: "active",
    tenantId: "tenant-1", mobileSubscriptionId: owner.id, provider: "google", canonicalRootIdentity: root,
    lineageState: options.unknown ? "unknown" : token === "A" ? "root" : "edge",
    lineagePredecessorDigest: options.unknown || token === "A" ? null : digest(token === "B" ? "A" : "B"),
    lineageVerifiedAt: options.unknown ? null : new Date(1),
    lineageEvidenceSource: options.unknown ? null : "play-subscriptionsv2-v1" }));
  if (options.newer) rows.push({ ...rows[2]!, tokenDigest: digest("E"), lineagePredecessorDigest: digest("D") });
  mocks.googlePurchaseAliasFindMany.mockImplementation(async ({ where }) => rows.filter(row =>
    where.tokenDigest.in.includes(row.tokenDigest) && (!where.tenantId || row.tenantId === where.tenantId)));
  mocks.googlePurchaseAliasCreateMany.mockImplementation(async ({ data }) => {
    for (const row of data) if (!rows.some(old => old.tokenDigest === row.tokenDigest)) rows.push({ lineageState: "unknown", lineagePredecessorDigest: null, lineageVerifiedAt: null, lineageEvidenceSource: null, ...row });
    return { count: data.length };
  });
  mocks.googlePurchaseAliasFindFirst.mockImplementation(async ({ where }) => rows.find(row =>
    row.tenantId === where.tenantId && row.mobileSubscriptionId === where.mobileSubscriptionId
    && row.canonicalRootIdentity === where.canonicalRootIdentity && row.state === where.state
    && !where.tokenDigest.notIn.includes(row.tokenDigest)) ?? null);
  mocks.googlePurchaseAliasUpdateMany.mockImplementation(async ({ where, data }) => {
    const row = rows.find(row => Object.entries(where).every(([key, value]) => (row as any)[key] === value));
    if (!row) return { count: 0 }; Object.assign(row, data); return { count: 1 };
  });
  const activities: any[] = [];
  mocks.activityLogFindMany.mockImplementation(async ({ where }) => activities.filter(row => row.tenantId === where.tenantId && row.resource === where.resource && (!where.resourceId || row.resourceId === where.resourceId)));
  mocks.activityLogUpsert.mockImplementation(async ({ create }) => {
    if (!activities.some(row => row.id === create.id)) activities.push({ ...create, createdAt: new Date() });
    return create;
  });
  const review = await vi.importActual<typeof import("../manual-review.service")>("../manual-review.service");
  mocks.ensureManualReviewCase.mockImplementation(review.ensureManualReviewCase);
  mocks.mobileSubscriptionFindUnique.mockImplementation(async () => owner);
  mocks.mobileSubscriptionUpdateMany.mockImplementation(async ({ data }) => {
    Object.assign(owner, data); return { count: 1 };
  });
  mocks.queryRaw.mockImplementation(async () => [{ id: owner.id, last_verified_at: owner.lastVerifiedAt }]);
  const transaction = mocks.tenantTx.getMockImplementation()!;
  mocks.tenantTx.mockImplementation(async (fn) => {
    const beforeRows = structuredClone(rows), beforeOwner = structuredClone(owner), beforeActivities = structuredClone(activities);
    try { return await transaction(fn); }
    catch (error) {
      rows.splice(0, rows.length, ...beforeRows);
      for (const key of Object.keys(owner)) if (!(key in beforeOwner)) delete (owner as any)[key];
      Object.assign(owner, beforeOwner);
      activities.splice(0, activities.length, ...beforeActivities);
      throw error;
    }
  });
  ledgerEffects = 0;
  mocks.recordEntitlementEvent.mockImplementation(async (_event, fence) => {
    const result = await ledger.withCurrentGooglePurchase("tenant-1", fence, async () => { ledgerEffects++; });
    return result ? "INDIVIDUAL" : null;
  });
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith("https://androidpublisher.googleapis.com/")) throw new Error("unexpected fixture destination");
    const token = decodeURIComponent(url.split("/tokens/")[1]);
    if (gone && token === "C") return new Response("{}", { status: 410 });
    const predecessor: Record<string, string | undefined> = { D: "C", C: "B", B: "A", A: undefined };
    if (!(token in predecessor)) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify({ lineItems: [{ productId: PRODUCT, expiryTime: ACTIVE_EXPIRY.toISOString(),
      latestSuccessfulOrderId: "GPA.fixture", autoRenewingPlan: { autoRenewEnabled: true } }],
      startTime: "2026-08-01T00:00:00Z", subscriptionState: options.expired ? "SUBSCRIPTION_STATE_EXPIRED" : "SUBSCRIPTION_STATE_ACTIVE",
      acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED", linkedPurchaseToken: predecessor[token] }), { status: 200 });
  }));
  mocks.verifyGoogleReceipt.mockImplementation(google.verifyGoogleReceipt);
  return { google, ledger, owner, rows, activities, deliveries, env };
}

afterAll(() => vi.unstubAllGlobals());


describe("Google directed lineage verifier → ownership → ledger and durable review", () => {
  it("GREEN: D→C410 reuses evidenced C→B→A and reaches the actual ledger fence", async () => {
    const { rows } = await installLineageFixture(true);
    const result = await postVerify("google", PRODUCT, { receipt: "D" });
    expect(result.status).toBe(200); expect(ledgerEffects).toBe(1);
    expect(mocks.ensureManualReviewCase).not.toHaveBeenCalled();
    expect(rows.find(row => row.tokenDigest === digest("D"))).toMatchObject({ lineageState: "edge", lineagePredecessorDigest: digest("C"), lineageEvidenceSource: "play-subscriptionsv2-v1" });
    const fence = mocks.recordEntitlementEvent.mock.calls[0]![1];
    expect(fence.verifiedAliases).toEqual([digest("D"), digest("C"), digest("B"), digest("A")]);
  });
  it.each(["verify", "rtdn"])("missing persisted predecessor stays UNKNOWN with durable review through %s", async (route) => {
    const { owner, rows, activities } = await installLineageFixture(true);
    rows.splice(rows.findIndex(row => row.tokenDigest === digest("B")), 1);
    const before = structuredClone(owner);
    const historical = structuredClone(rows);
    if (route === "rtdn") mocks.parseGoogleRtdnEnvelope.mockReturnValue({ packageName: "com.braavolabs.mobile", kind: "subscription", notificationType: 2, purchaseToken: "D", messageId: "fixture-missing-predecessor", publishTime: new Date() });
    const invoke = () => route === "verify" ? postVerify("google", PRODUCT, { receipt: "D" }) : postGoogleNotification("fixture-missing-predecessor");
    const first = await invoke();
    const second = await invoke();
    expect(first.status).toBe(200); expect(second.status).toBe(200);
    if (route === "verify") {
      expect(first.body).toMatchObject({ outcome: "manual_review", reasonCode: "GOOGLE_LINEAGE_UNKNOWN", receiptTier: null, effectiveTier: "INDIVIDUAL" });
      expect(second.body.reviewCaseId).toBe(first.body.reviewCaseId);
    }
    const pending = activities.filter(row => row.action.endsWith(".pending"));
    expect(pending).toHaveLength(1);
    expect(pending[0].details).toMatchObject({ reviewKind: "google_lineage", reasonCode: "GOOGLE_LINEAGE_UNKNOWN" });
    expect(JSON.stringify(activities)).not.toContain('"receipt"');
    expect(JSON.stringify(activities)).not.toContain('"D"');
    expect(owner).toEqual(before);
    expect(mocks.mobileSubscriptionUpdateMany).not.toHaveBeenCalled();
    expect(mocks.mobileSubscriptionCreate).not.toHaveBeenCalled();
    expect(mocks.recordEntitlementEvent).not.toHaveBeenCalled(); expect(ledgerEffects).toBe(0);
    expect(rows.find(row => row.tokenDigest === digest("B"))).toBeUndefined();
    for (const row of historical) expect(rows.find(current => current.tokenDigest === row.tokenDigest)).toEqual(row);
    expect(rows.find(row => row.tokenDigest === digest("D"))).toMatchObject({ lineageState: "edge", lineagePredecessorDigest: digest("C") });
    expect(mocks.queryRaw).toHaveBeenCalled();
  });
  it("a complete fresh Play chain establishes evidence for legacy UNKNOWN aliases", async () => {
    const { rows } = await installLineageFixture(false, { unknown: true });
    expect((await postVerify("google", PRODUCT, { receipt: "D" })).status).toBe(200);
    expect(ledgerEffects).toBe(1); expect(rows.every(row => row.lineageState !== "unknown")).toBe(true);
  });
  it("a genuinely newer owned E still blocks D even with complete historical evidence", async () => {
    await installLineageFixture(true, { newer: true });
    expect((await postVerify("google", PRODUCT, { receipt: "D" })).status).toBe(409);
    expect(ledgerEffects).toBe(0); expect(mocks.recordEntitlementEvent).not.toHaveBeenCalled();
  });
  it.each([false, true])("UNKNOWN %s opens durable digest-only review without paid state changes", async (expired) => {
    const { owner, rows, activities } = await installLineageFixture(true, { unknown: true, expired });
    const before = { ...owner };
    const first = await postVerify("google", PRODUCT, { receipt: "D" });
    const second = await postVerify("google", PRODUCT, { receipt: "D" });
    expect(first.status).toBe(200); expect(first.body).toMatchObject({ outcome: "manual_review", reasonCode: "GOOGLE_LINEAGE_UNKNOWN", receiptTier: null, effectiveTier: "INDIVIDUAL" });
    expect(second.body.reviewCaseId).toBe(first.body.reviewCaseId);
    expect(activities.filter(row => row.action.endsWith(".pending"))).toHaveLength(1);
    expect(activities.find(row => row.action.endsWith(".pending"))?.details).toMatchObject({ reviewKind: "google_lineage", reasonCode: "GOOGLE_LINEAGE_UNKNOWN" });
    expect(JSON.stringify(activities)).not.toContain('"receipt"');
    expect(JSON.stringify(activities)).not.toContain('"D"');
    expect(owner).toEqual(before); expect(mocks.mobileSubscriptionUpdateMany).not.toHaveBeenCalled();
    expect(mocks.mobileSubscriptionCreate).not.toHaveBeenCalled(); expect(ledgerEffects).toBe(0);
    expect(rows.find(row => row.tokenDigest === digest("A"))?.lineageState).toBe("unknown");
    expect(rows.find(row => row.tokenDigest === digest("D"))?.lineageState).toBe("edge");
  });
  it("UNKNOWN RTDN acknowledges after durable review and retries if the review cannot be recorded", async () => {
    const { owner, activities } = await installLineageFixture(true, { unknown: true });
    mocks.parseGoogleRtdnEnvelope.mockReturnValue({ packageName: "com.braavolabs.mobile", kind: "subscription", notificationType: 2, purchaseToken: "D", messageId: "fixture-rtdn-D", publishTime: new Date() });
    const before = { ...owner };
    expect((await postGoogleNotification("fixture-rtdn-D")).status).toBe(200);
    expect(activities.some(row => row.action.endsWith(".pending"))).toBe(true);
    expect(ledgerEffects).toBe(0); expect(owner).toEqual(before);
    mocks.activityLogUpsert.mockRejectedValueOnce(new Error("local fixture storage unavailable"));
    expect((await postGoogleNotification("fixture-rtdn-D")).status).toBe(503);
    expect(ledgerEffects).toBe(0);
  });
  it("an overlapping replacement after ownership update still blocks the ledger effect", async () => {
    const { rows } = await installLineageFixture(true);
    const actual = mocks.recordEntitlementEvent.getMockImplementation()!;
    mocks.recordEntitlementEvent.mockImplementation(async (...args) => {
      rows.push({ ...rows[2]!, tokenDigest: digest("E"), lineagePredecessorDigest: digest("D") });
      return actual(...args);
    });
    expect((await postVerify("google", PRODUCT, { receipt: "D" })).status).toBe(409);
    expect(ledgerEffects).toBe(0);
  });
  it("durable RTDN seals review before ack, deduplicates, and retries a failed review write", async () => {
    const { env, activities, deliveries } = await installLineageFixture(true, { unknown: true });
    env.IAP_DELIVERY_RELIABILITY_ENABLED = true;
    const note = { packageName: "com.braavolabs.mobile", kind: "subscription", notificationType: 2,
      purchaseToken: "D", messageId: "fixture-durable-rtdn", publishTime: new Date() };
    mocks.parseGoogleRtdnEnvelope.mockReturnValue(note);
    expect((await postGoogleNotification(note.messageId)).status).toBe(200);
    expect(deliveries[0]?.status).toBe("SUCCEEDED");
    const reviewCalls = mocks.ensureManualReviewCase.mock.calls.length;
    expect((await postGoogleNotification(note.messageId)).status).toBe(200);
    expect(mocks.ensureManualReviewCase.mock.calls).toHaveLength(reviewCalls);
    note.messageId = "fixture-retry-rtdn";
    mocks.activityLogUpsert.mockRejectedValueOnce(new Error("fixture review persistence unavailable"));
    expect((await postGoogleNotification(note.messageId)).status).toBe(503);
    expect(deliveries[1]).toMatchObject({ status: "RETRYABLE", failureCode: "GOOGLE_LINEAGE_REVIEW_PERSISTENCE_FAILED" });
    expect((await postGoogleNotification(note.messageId)).status).toBe(200);
    expect(deliveries[1]?.status).toBe("SUCCEEDED");
    expect(activities.filter(row => row.action.endsWith(".pending"))).toHaveLength(1);
    expect(mocks.recordEntitlementEvent).not.toHaveBeenCalled(); expect(ledgerEffects).toBe(0);
  });
  it("rollback disables new evidence queries while preserving historical bytes and the conservative stale fence", async () => {
    const { env, rows } = await installLineageFixture(true);
    env.GOOGLE_PURCHASE_LINEAGE_ENABLED = false;
    const before = structuredClone(rows.slice(0, 3));
    expect((await postVerify("google", PRODUCT, { receipt: "D" })).status).toBe(409);
    expect(mocks.googlePurchaseAliasUpdateMany).not.toHaveBeenCalled();
    expect(rows.slice(0, 3)).toEqual(before); expect(ledgerEffects).toBe(0);
  });
  it("a conflicting fresh edge rolls back the ownership transaction and cannot reach paid updates", async () => {
    const { rows, owner } = await installLineageFixture(false, { unknown: true });
    rows[1]!.lineageState = "root"; rows[1]!.lineageVerifiedAt = new Date(1); rows[1]!.lineageEvidenceSource = "play-subscriptionsv2-v1";
    const before = structuredClone(rows), beforeOwner = structuredClone(owner);
    expect((await postVerify("google", PRODUCT, { receipt: "D" })).status).toBe(409);
    expect(rows).toEqual(before); expect(owner).toEqual(beforeOwner);
    expect(mocks.mobileSubscriptionUpdateMany).not.toHaveBeenCalled(); expect(ledgerEffects).toBe(0);
  });

  it.each([{ unknown: true, newer: false }, { unknown: false, newer: true }])(
    "overlapping RTDN cannot persist evidence before early return (%s)", async (options) => {
      const { owner, rows } = await installLineageFixture(true, options);
      owner.lastVerifiedAt = new Date("2099-01-01T00:00:00Z");
      const before = structuredClone(rows);
      mocks.parseGoogleRtdnEnvelope.mockReturnValue({ packageName: "com.braavolabs.mobile", kind: "subscription",
        notificationType: 2, purchaseToken: "D", messageId: "fixture-overlap-rtdn", publishTime: new Date() });
      expect((await postGoogleNotification("fixture-overlap-rtdn")).status).toBe(503);
      expect(rows).toEqual(before);
      expect(mocks.googlePurchaseAliasCreateMany).not.toHaveBeenCalled();
      expect(mocks.googlePurchaseAliasUpdateMany).not.toHaveBeenCalled();
      expect(mocks.ensureManualReviewCase).not.toHaveBeenCalled();
      expect(ledgerEffects).toBe(0);
    },
  );

});
