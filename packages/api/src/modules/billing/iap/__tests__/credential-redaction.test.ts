import { describe, expect, it, vi } from "vitest";

const fixtures = vi.hoisted(() => {
  const rawServiceAccount = "service-account-json-private-key-sentinel";
  return {
    rawServiceAccount,
    encodedMalformedCredential: Buffer.from(
      `{\"client_email\":\"play@example.test\",\"private_key\":\"${rawServiceAccount}\"`,
    ).toString("base64"),
    logger: { warn: vi.fn(), error: vi.fn() },
  };
});

vi.mock("../../../../config/env", () => ({
  env: {
    GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: fixtures.encodedMalformedCredential,
    GOOGLE_PLAY_PACKAGE_NAME: "com.braavolabs.app",
  },
}));
vi.mock("../../../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: fixtures.logger.warn, error: fixtures.logger.error },
}));

import { verifyGoogleReceipt } from "../google";

describe("Google credential boundary", () => {
  it("never includes malformed service-account JSON or its parser detail in errors or logs", async () => {
    let failure: unknown;
    try {
      await verifyGoogleReceipt("purchase-token-sentinel", "com.braavolabs.individual.monthly");
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ statusCode: 503, message: "Google Play service account configuration is invalid" });
    expect(JSON.stringify([failure, fixtures.logger.warn.mock.calls, fixtures.logger.error.mock.calls])).not.toContain(fixtures.rawServiceAccount);
    expect(JSON.stringify(failure)).not.toContain("private_key");
  });
});
