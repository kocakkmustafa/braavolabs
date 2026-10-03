import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  getAccessToken: vi.fn(async (): Promise<{ token: string | null | undefined }> => ({ token: "test-access-token" })),
}));

vi.mock("google-auth-library", () => ({
  JWT: class {
    getAccessToken = authMocks.getAccessToken;
  },
  OAuth2Client: class {},
}));

vi.mock("../../../../config/env", () => ({
  env: {
    GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: Buffer.from(JSON.stringify({
      client_email: "local-test@example.invalid",
      private_key: "local-test-key",
    })).toString("base64"),
    GOOGLE_PLAY_PACKAGE_NAME: "com.braavolabs.mobile",
    GOOGLE_PUBSUB_AUDIENCE: "",
    GOOGLE_PUBSUB_SA_EMAIL: "",
  },
}));

const loggerMocks = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../../../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), error: loggerMocks.error, warn: loggerMocks.warn },
}));

import { acknowledgeGoogleReceipt, verifyGoogleReceipt } from "../google";
import { env } from "../../../../config/env";

const PRODUCT = "com.braavolabs.individual.monthly";
const ACTIVE_EXPIRY = "2099-09-01T00:00:00.000Z";

function identity(token: string): string {
  return `google:${crypto.createHash("sha256").update(token, "utf8").digest("hex")}`;
}

function subscription(
  productId: string,
  linkedPurchaseToken?: string,
  acknowledgementState: "ACKNOWLEDGEMENT_STATE_PENDING" | "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED" =
    "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED",
) {
  return {
    lineItems: [{
      productId,
      expiryTime: ACTIVE_EXPIRY,
      latestSuccessfulOrderId: "GPA.1111-2222-3333-44444",
      autoRenewingPlan: { autoRenewEnabled: true },
    }],
    startTime: "2026-08-01T00:00:00.000Z",
    subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
    acknowledgementState,
    ...(linkedPurchaseToken === undefined ? {} : { linkedPurchaseToken }),
  };
}

function tokenFromUrl(url: string): string {
  const match = url.match(/\/tokens\/([^/:]+)(?::acknowledge)?$/);
  if (!match) throw new Error(`unexpected local-test URL class: ${url}`);
  return decodeURIComponent(match[1]);
}

function installGoogleApiStub(
  rows: Record<string, ReturnType<typeof subscription> | { status: number }>,
) {
  const calls: Array<{ method: string; token: string }> = [];
  const stub = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const token = tokenFromUrl(url);
    const method = init?.method ?? "GET";
    calls.push({ method, token });
    if (method === "POST") return new Response("{}", { status: 200 });
    const row = rows[token];
    if (!row) return new Response("{}", { status: 404 });
    if ("status" in row) return new Response("{}", { status: row.status });
    return new Response(JSON.stringify(row), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", stub);
  return { calls, stub };
}

beforeEach(() => {
  vi.restoreAllMocks();
  authMocks.getAccessToken.mockResolvedValue({ token: "test-access-token" });
});

describe("Google replacement-chain ownership identity", () => {
  it("uses the library's token value for lookup and acknowledgement Authorization", async () => {
    const { stub } = installGoogleApiStub({ current: subscription(PRODUCT) });

    await verifyGoogleReceipt("current", PRODUCT);
    await acknowledgeGoogleReceipt("current", PRODUCT);

    expect(stub).toHaveBeenCalledTimes(2);
    for (const [, init] of stub.mock.calls) {
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-access-token");
    }
  });

  it.each([null, undefined, "", "   "])("fails closed before a provider call for access token %s", async (token) => {
    authMocks.getAccessToken.mockResolvedValue({ token });
    const { stub } = installGoogleApiStub({ current: subscription(PRODUCT) });

    await expect(verifyGoogleReceipt("current", PRODUCT)).rejects.toMatchObject({ statusCode: 503 });
    await expect(acknowledgeGoogleReceipt("current", PRODUCT)).rejects.toMatchObject({ statusCode: 503 });
    expect(stub).not.toHaveBeenCalled();
  });

  it("derives the product and latest paid order from Google for an RTDN token-only lookup", async () => {
    installGoogleApiStub({ current: subscription(PRODUCT) });

    await expect(verifyGoogleReceipt("current")).resolves.toMatchObject({
      googleProductId: PRODUCT,
      googleLatestSuccessfulOrderId: "GPA.1111-2222-3333-44444",
      originalTransactionId: identity("current"),
    });
    await expect(verifyGoogleReceipt("current", "com.braavolabs.team.monthly"))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it("retries an ambiguous multi-product subscription without guessing its catalog tier", async () => {
    const row = subscription(PRODUCT);
    row.lineItems.push({ ...row.lineItems[0], productId: "com.braavolabs.team.monthly" });
    const { calls } = installGoogleApiStub({ current: row });

    await expect(verifyGoogleReceipt("current")).rejects.toMatchObject({ statusCode: 503 });
    expect(calls).toEqual([{ method: "GET", token: "current" }]);
  });

  it("resolves A→B→C to one root and returns only verified hashed aliases", async () => {
    const { calls } = installGoogleApiStub({
      C: subscription(PRODUCT, "B"),
      B: subscription(PRODUCT, "A"),
      A: subscription(PRODUCT),
    });

    const verified = await verifyGoogleReceipt("C", PRODUCT);

    expect(verified).toMatchObject({
      originalTransactionId: identity("A"),
      googleCanonicalRootIdentity: identity("A"),
      googlePurchaseAliases: [identity("C"), identity("B"), identity("A")],
    });
    expect(calls).toEqual([
      { method: "GET", token: "C" },
      { method: "GET", token: "B" },
      { method: "GET", token: "A" },
    ]);
    expect(JSON.stringify(verified)).not.toMatch(/"[ABC]"/);
  });

  it.each([
    ["self link", { A: subscription(PRODUCT, "A") }],
    ["cycle", { C: subscription(PRODUCT, "B"), B: subscription(PRODUCT, "C") }],
  ])("fails closed for %s without acknowledging", async (_label, rows) => {
    const { calls } = installGoogleApiStub(rows);

    await expect(verifyGoogleReceipt(Object.keys(rows)[0], PRODUCT)).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it.each([
    ["missing ancestor", { C: subscription(PRODUCT, "missing") }],
    ["superseded ancestor", { C: subscription(PRODUCT, "gone"), gone: { status: 410 } }],
  ])("fails closed for %s and exposes no token in the error", async (_label, rows) => {
    installGoogleApiStub(rows as Record<string, ReturnType<typeof subscription> | { status: number }>);

    const error = await verifyGoogleReceipt("C", PRODUCT).catch((caught) => caught as Error);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain("missing");
    expect(String(error)).not.toContain("gone");
  });

  it("reuses a previously owned root after Google's ancestor token lifetime expires", async () => {
    const { calls } = installGoogleApiStub({ C: subscription(PRODUCT, "A"), A: { status: 410 } });
    const resolveKnownAncestor = vi.fn().mockResolvedValue({ canonicalRootIdentity: identity("A") });

    const verified = await verifyGoogleReceipt("C", PRODUCT, resolveKnownAncestor);

    expect(verified).toMatchObject({
      status: "active",
      originalTransactionId: identity("A"),
      googlePurchaseAliases: [identity("C"), identity("A")],
    });
    expect(resolveKnownAncestor).toHaveBeenCalledWith(identity("A"));
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("uses an owned intermediate's canonical root without inventing the rest of its suffix", async () => {
    installGoogleApiStub({ C: subscription(PRODUCT, "B"), B: { status: 410 } });
    const resolveKnownAncestor = vi.fn().mockResolvedValue({ canonicalRootIdentity: identity("A") });

    await expect(verifyGoogleReceipt("C", PRODUCT, resolveKnownAncestor)).resolves.toMatchObject({
      googleCanonicalRootIdentity: identity("A"),
      googlePurchaseAliases: [identity("C"), identity("B"), identity("A")],
    });
  });

  it("retains the current Google status when the persisted ancestor had granted access", async () => {
    const current = subscription(PRODUCT, "A");
    current.subscriptionState = "SUBSCRIPTION_STATE_EXPIRED";
    installGoogleApiStub({ C: current, A: { status: 410 } });
    const resolveKnownAncestor = vi.fn().mockResolvedValue({ canonicalRootIdentity: identity("A") });

    await expect(verifyGoogleReceipt("C", PRODUCT, resolveKnownAncestor)).resolves.toMatchObject({ status: "expired" });
  });

  it.each([
    ["current receipt is gone", "A", { A: { status: 410 } }],
    ["ancestor is unknown", "C", { C: subscription(PRODUCT, "A"), A: { status: 404 } }],
  ])("does not use persisted history when %s", async (_label, currentToken, rows) => {
    installGoogleApiStub(rows as Record<string, ReturnType<typeof subscription> | { status: number }>);
    const resolveKnownAncestor = vi.fn().mockResolvedValue({ canonicalRootIdentity: identity("A") });

    await expect(verifyGoogleReceipt(currentToken, PRODUCT, resolveKnownAncestor)).rejects.toMatchObject({ statusCode: 400 });
    expect(resolveKnownAncestor).not.toHaveBeenCalled();
  });

  it("keeps an unowned expired ancestor fail-closed without raw identity leakage", async () => {
    installGoogleApiStub({ C: subscription(PRODUCT, "unknown-ancestor-secret"), "unknown-ancestor-secret": { status: 410 } });
    const resolveKnownAncestor = vi.fn().mockResolvedValue(null);

    const error = await verifyGoogleReceipt("C", PRODUCT, resolveKnownAncestor).catch((caught) => caught);
    expect(error).toMatchObject({ statusCode: 400 });
    expect(String(error)).not.toContain("unknown-ancestor-secret");
  });

  it("rejects a persisted root pointing back into the freshly verified prefix", async () => {
    installGoogleApiStub({ C: subscription(PRODUCT, "B"), B: { status: 410 } });
    const resolveKnownAncestor = vi.fn().mockResolvedValue({ canonicalRootIdentity: identity("C") });

    await expect(verifyGoogleReceipt("C", PRODUCT, resolveKnownAncestor)).rejects.toMatchObject({ statusCode: 400 });
  });

  it("keeps the hop bound when adding a persisted root to a long prefix", async () => {
    const rows: Record<string, ReturnType<typeof subscription> | { status: number }> = {};
    for (let index = 0; index < 7; index += 1) rows[`T${index}`] = subscription(PRODUCT, `T${index + 1}`);
    rows.T7 = { status: 410 };
    installGoogleApiStub(rows);
    const resolveKnownAncestor = vi.fn().mockResolvedValue({ canonicalRootIdentity: identity("root") });

    await expect(verifyGoogleReceipt("T0", PRODUCT, resolveKnownAncestor)).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects a chain beyond the bounded maximum before acknowledgement", async () => {
    const rows: Record<string, ReturnType<typeof subscription>> = {};
    for (let index = 0; index < 9; index += 1) {
      rows[`T${index}`] = subscription(PRODUCT, index === 8 ? undefined : `T${index + 1}`);
    }
    const { calls } = installGoogleApiStub(rows);

    await expect(verifyGoogleReceipt("T0", PRODUCT)).rejects.toMatchObject({ statusCode: 400 });
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("rejects an unregistered ancestor product while preserving current product authority", async () => {
    const { calls } = installGoogleApiStub({
      C: subscription(PRODUCT, "B", "ACKNOWLEDGEMENT_STATE_PENDING"),
      B: subscription("com.braavolabs.unregistered.monthly"),
    });

    await expect(verifyGoogleReceipt("C", PRODUCT)).rejects.toMatchObject({ statusCode: 400 });
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("defers acknowledgement and exposes a separate current-token-only effect", async () => {
    const { calls } = installGoogleApiStub({
      C: subscription(PRODUCT, "B", "ACKNOWLEDGEMENT_STATE_PENDING"),
      B: subscription(PRODUCT, "A", "ACKNOWLEDGEMENT_STATE_PENDING"),
      A: subscription(PRODUCT, undefined, "ACKNOWLEDGEMENT_STATE_PENDING"),
    });

    const verified = await verifyGoogleReceipt("C", PRODUCT);
    expect(verified.googleAcknowledgementPending).toBe(true);
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);

    await acknowledgeGoogleReceipt("C", PRODUCT);
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
    expect(calls.at(-1)).toEqual({ method: "POST", token: "C" });
  });

  it.each([
    ["SUBSCRIPTION_STATE_EXPIRED", "expired"],
    ["SUBSCRIPTION_STATE_ON_HOLD", "expired"],
    ["SUBSCRIPTION_STATE_IN_GRACE_PERIOD", "in_grace_period"],
  ] as const)("maps Google %s to the fail-closed provider status %s", async (subscriptionState, status) => {
    const row = subscription(PRODUCT);
    row.subscriptionState = subscriptionState;
    installGoogleApiStub({ current: row });

    await expect(verifyGoogleReceipt("current", PRODUCT)).resolves.toMatchObject({ status });
  });

  it("preserves a canceled purchase only through its paid expiry and never reports auto-renew", async () => {
    const row = subscription(PRODUCT);
    row.subscriptionState = "SUBSCRIPTION_STATE_CANCELED";
    row.lineItems[0].autoRenewingPlan = { autoRenewEnabled: false };
    installGoogleApiStub({ current: row });

    await expect(verifyGoogleReceipt("current", PRODUCT)).resolves.toMatchObject({
      status: "active",
      expiresAt: new Date(ACTIVE_EXPIRY),
      autoRenew: false,
    });
  });

  it("redacts a network failure whose native cause contains the purchase token URL", async () => {
    const secretToken = "raw-secret-token-that-must-not-escape";
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      throw new Error(`connect failed for ${String(input)}`);
    }));

    const error = await verifyGoogleReceipt(secretToken, PRODUCT).catch((caught) => caught as Error);

    expect(error).toMatchObject({ statusCode: 502 });
    expect(String(error)).not.toContain(secretToken);
    expect(JSON.stringify(loggerMocks.error.mock.calls)).not.toContain(secretToken);
    expect(JSON.stringify(loggerMocks.warn.mock.calls)).not.toContain(secretToken);
  });
});


describe("Google directed lineage metadata", () => {
  it("records only successful response edges and evidenced ROOT", async () => {
    env.GOOGLE_PURCHASE_LINEAGE_ENABLED = true;
    try {
      installGoogleApiStub({ C: subscription(PRODUCT, "B"), B: subscription(PRODUCT, "A"), A: subscription(PRODUCT) });
      const verified = await verifyGoogleReceipt("C", PRODUCT);
      expect(verified.googleLineageComplete).toBe(true);
      expect(verified.googleLineageObservations).toEqual([
        { tokenDigest: identity("C"), state: "edge", predecessorDigest: identity("B") },
        { tokenDigest: identity("B"), state: "edge", predecessorDigest: identity("A") },
        { tokenDigest: identity("A"), state: "root", predecessorDigest: null },
      ]);
    } finally { env.GOOGLE_PURCHASE_LINEAGE_ENABLED = false; }
  });
  it("reconstructs persisted suffix but never emits fresh observations for HTTP410", async () => {
    env.GOOGLE_PURCHASE_LINEAGE_ENABLED = true;
    try {
      installGoogleApiStub({ D: subscription(PRODUCT, "C"), C: { status: 410 } });
      const resolve = vi.fn().mockResolvedValue({ canonicalRootIdentity: identity("A"), aliases: [identity("C"), identity("B"), identity("A")], complete: true });
      const verified = await verifyGoogleReceipt("D", PRODUCT, resolve);
      expect(verified.googlePurchaseAliases).toEqual([identity("D"), identity("C"), identity("B"), identity("A")]);
      expect(verified.googleLineageObservations).toEqual([{tokenDigest:identity("D"),state:"edge",predecessorDigest:identity("C")}]);
      expect(verified.googleLineageComplete).toBe(true);
      resolve.mockResolvedValue({canonicalRootIdentity:identity("A"),complete:false});
      expect((await verifyGoogleReceipt("D", PRODUCT, resolve)).googleLineageComplete).toBe(false);
    } finally { env.GOOGLE_PURCHASE_LINEAGE_ENABLED = false; }
  });
});
