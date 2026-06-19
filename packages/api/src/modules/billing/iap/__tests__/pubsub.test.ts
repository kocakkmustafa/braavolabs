import { describe, it, expect } from "vitest";
import { verifyPubSubPushToken } from "../google";

// Synchronous guard branches only — verifying a real Google-signed token
// requires a network fetch of Google's certs, which we don't do in unit
// tests. These cover the fail-closed paths an attacker would hit.
describe("verifyPubSubPushToken — guards", () => {
  it("rejects a missing Authorization header", async () => {
    const r = await verifyPubSubPushToken(undefined);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("missing-bearer-token");
  });

  it("rejects a non-Bearer Authorization header", async () => {
    const r = await verifyPubSubPushToken("Basic abc123");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("missing-bearer-token");
  });

  it("rejects an empty bearer token", async () => {
    const r = await verifyPubSubPushToken("Bearer    ");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("empty-bearer-token");
  });
});
