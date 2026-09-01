import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const originalEnv = { ...process.env };
const audience = "https://api.braavolabs.com/api/v1/billing/iap/google/notify";
const serviceAccountEmail = "braavolabs-rtdn@example.iam.gserviceaccount.com";

function requiredEnv(nodeEnv: "production" | "test", overrides: Record<string, string | undefined> = {}) {
  return {
    ...originalEnv,
    NODE_ENV: nodeEnv,
    DATABASE_URL: "postgresql://test:test@127.0.0.1:1/test",
    JWT_SECRET: "unit-test-jwt".repeat(6),
    ENCRYPTION_KEY: "unit-test-key".repeat(6),
    APP_URL: nodeEnv === "production" ? "https://app.braavolabs.com" : "http://localhost:3001",
    GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: Buffer.from(JSON.stringify({
      client_email: "play@example.iam.gserviceaccount.com",
      private_key: "test-only",
    })).toString("base64"),
    GOOGLE_PUBSUB_AUDIENCE: audience,
    GOOGLE_PUBSUB_SA_EMAIL: serviceAccountEmail,
    ...overrides,
  };
}

async function importEnv(overrides: Record<string, string | undefined>) {
  process.env = requiredEnv("production", overrides);
  vi.resetModules();
  return import("../../../../config/env");
}

async function importVerifier(overrides: Record<string, string | undefined> = {}) {
  process.env = requiredEnv("test", overrides);
  vi.resetModules();
  return import("../google");
}

function fakeVerifier(payload?: Record<string, unknown>, error?: Error) {
  return {
    verifyIdToken: vi.fn(async () => {
      if (error) throw error;
      return { getPayload: () => payload };
    }),
  };
}

beforeEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
  vi.resetModules();
});

afterAll(() => {
  process.env = originalEnv;
});

describe("Google RTDN production configuration", () => {
  it.each([
    ["audience only", { GOOGLE_PUBSUB_SA_EMAIL: undefined }],
    ["service-account email only", { GOOGLE_PUBSUB_AUDIENCE: undefined }],
    ["neither binding", { GOOGLE_PUBSUB_AUDIENCE: undefined, GOOGLE_PUBSUB_SA_EMAIL: undefined }],
    ["whitespace audience", { GOOGLE_PUBSUB_AUDIENCE: "   " }],
    ["whitespace service-account email", { GOOGLE_PUBSUB_SA_EMAIL: "   " }],
  ])("rejects %s at production startup", async (_label, overrides) => {
    await expect(importEnv(overrides)).rejects.toThrow(/GOOGLE_PUBSUB_AUDIENCE.*GOOGLE_PUBSUB_SA_EMAIL/);
  });

  it("accepts production startup only when both workload bindings are configured", async () => {
    const { env } = await importEnv({});
    expect(env.GOOGLE_PUBSUB_AUDIENCE).toBe(audience);
    expect(env.GOOGLE_PUBSUB_SA_EMAIL).toBe(serviceAccountEmail);
  });
});

describe("verifyPubSubPushToken — dual workload identity", () => {
  it.each([
    ["missing Authorization", undefined, "missing-bearer-token"],
    ["non-Bearer Authorization", "Basic abc123", "missing-bearer-token"],
    ["empty bearer", "Bearer    ", "empty-bearer-token"],
  ])("rejects %s without invoking Google", async (_label, header, reason) => {
    const { verifyPubSubPushToken } = await importVerifier();
    const verifier = fakeVerifier();
    await expect(verifyPubSubPushToken(header, verifier)).resolves.toEqual({ ok: false, reason });
    expect(verifier.verifyIdToken).not.toHaveBeenCalled();
  });

  it.each([
    ["missing audience", { GOOGLE_PUBSUB_AUDIENCE: undefined }],
    ["missing service-account email", { GOOGLE_PUBSUB_SA_EMAIL: undefined }],
    ["missing both bindings", { GOOGLE_PUBSUB_AUDIENCE: undefined, GOOGLE_PUBSUB_SA_EMAIL: undefined }],
  ])("rejects %s before token verification", async (_label, overrides) => {
    const { verifyPubSubPushToken } = await importVerifier(overrides);
    const verifier = fakeVerifier();
    await expect(verifyPubSubPushToken("Bearer signed-token", verifier)).resolves.toEqual({
      ok: false,
      reason: "workload-identity-not-configured",
    });
    expect(verifier.verifyIdToken).not.toHaveBeenCalled();
  });

  it.each([
    ["audience mismatch", new Error("Wrong recipient")],
    ["invalid signature", new Error("Invalid token signature")],
    ["expired token", new Error("Token used too late")],
    ["verifier outage", new Error("certificate endpoint unavailable")],
  ])("rejects %s through google-auth-library verification", async (_label, error) => {
    const { verifyPubSubPushToken } = await importVerifier();
    const verifier = fakeVerifier(undefined, error);
    await expect(verifyPubSubPushToken("Bearer signed-token", verifier)).resolves.toEqual({
      ok: false,
      reason: "token-verification-failed",
    });
    expect(verifier.verifyIdToken).toHaveBeenCalledWith({ idToken: "signed-token", audience });
  });

  it.each([
    ["email mismatch", { email: "other@example.iam.gserviceaccount.com", email_verified: true }, "email-mismatch"],
    ["unverified email", { email: serviceAccountEmail, email_verified: false }, "email-unverified"],
    ["absent email claim", { email_verified: true }, "email-mismatch"],
    ["absent verified claim", { email: serviceAccountEmail }, "email-unverified"],
  ])("rejects %s after cryptographic verification", async (_label, payload, reason) => {
    const { verifyPubSubPushToken } = await importVerifier();
    const verifier = fakeVerifier(payload);
    await expect(verifyPubSubPushToken("Bearer signed-token", verifier)).resolves.toEqual({ ok: false, reason });
  });

  it("rejects a verified ticket without a payload", async () => {
    const { verifyPubSubPushToken } = await importVerifier();
    const verifier = fakeVerifier(undefined);
    await expect(verifyPubSubPushToken("Bearer signed-token", verifier)).resolves.toEqual({
      ok: false,
      reason: "no-payload",
    });
  });

  it("accepts only the configured audience and exact verified service-account email", async () => {
    const { verifyPubSubPushToken } = await importVerifier();
    const verifier = fakeVerifier({
      aud: audience,
      email: serviceAccountEmail,
      email_verified: true,
      iss: "https://accounts.google.com",
      exp: Math.floor(Date.now() / 1000) + 300,
    });

    await expect(verifyPubSubPushToken("Bearer signed-token", verifier)).resolves.toEqual({ ok: true });
    expect(verifier.verifyIdToken).toHaveBeenCalledTimes(1);
    expect(verifier.verifyIdToken).toHaveBeenCalledWith({ idToken: "signed-token", audience });
  });
});
