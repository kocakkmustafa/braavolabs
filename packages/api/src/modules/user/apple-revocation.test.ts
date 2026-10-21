import { generateKeyPairSync } from "node:crypto";
import { decodeJwt, decodeProtectedHeader } from "jose";
import { describe, expect, it, vi } from "vitest";
import { appleAccessRemovalRequired, revokeAppleAccess } from "./apple-revocation";

// Synthetic P-256 key generated per run; never a real Apple key.
const privateKey = generateKeyPairSync("ec", { namedCurve: "P-256" })
  .privateKey.export({ format: "pem", type: "pkcs8" }).toString();
const config = { clientId: "com.example.synthetic", teamId: "TEAMSYNTH1", keyId: "KEYSYNTH01", privateKey };
const now = new Date("2026-10-21T12:00:00Z");

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("revokeAppleAccess", () => {
  it("does nothing for accounts without an Apple identity", async () => {
    const fetchImpl = vi.fn();
    await expect(revokeAppleAccess({ appleId: null, authorizationCode: "code", config, fetchImpl })).resolves.toBe("NOT_LINKED");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ["missing authorization code", { authorizationCode: undefined, config }],
    ["missing team id", { authorizationCode: "code", config: { ...config, teamId: undefined } }],
    ["missing private key", { authorizationCode: "code", config: { ...config, privateKey: undefined } }],
    ["unusable private key", { authorizationCode: "code", config: { ...config, privateKey: "not a key" } }],
  ])("reports APPLE_PENDING without calling Apple: %s", async (_label, options) => {
    const fetchImpl = vi.fn();
    await expect(revokeAppleAccess({ appleId: "apple-sub", fetchImpl, ...options })).resolves.toBe("APPLE_PENDING");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("exchanges the code, revokes the refresh token, and reports REVOKED", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json(200, { refresh_token: "synthetic-refresh", access_token: "synthetic-access" }))
      .mockResolvedValueOnce(new Response("", { status: 200 }));
    await expect(revokeAppleAccess({ appleId: "apple-sub", authorizationCode: "synthetic-code", config, fetchImpl, now }))
      .resolves.toBe("REVOKED");

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [tokenUrl, tokenInit] = fetchImpl.mock.calls[0];
    const [revokeUrl, revokeInit] = fetchImpl.mock.calls[1];
    expect(tokenUrl).toBe("https://appleid.apple.com/auth/token");
    expect(revokeUrl).toBe("https://appleid.apple.com/auth/revoke");
    for (const init of [tokenInit, revokeInit]) {
      expect(init).toMatchObject({ method: "POST", redirect: "error" });
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
    const tokenBody = new URLSearchParams(tokenInit.body);
    expect(tokenBody.get("grant_type")).toBe("authorization_code");
    expect(tokenBody.get("code")).toBe("synthetic-code");
    const revokeBody = new URLSearchParams(revokeInit.body);
    expect(revokeBody.get("token")).toBe("synthetic-refresh");
    expect(revokeBody.get("token_type_hint")).toBe("refresh_token");
    expect(revokeBody.get("client_id")).toBe(config.clientId);

    const secret = revokeBody.get("client_secret")!;
    expect(decodeProtectedHeader(secret)).toMatchObject({ alg: "ES256", kid: config.keyId });
    const claims = decodeJwt(secret);
    expect(claims).toMatchObject({ iss: config.teamId, sub: config.clientId, aud: "https://appleid.apple.com" });
    expect(claims.exp! - claims.iat!).toBe(300);
  });

  it.each([
    ["rejected code", () => Promise.resolve(json(400, { error: "invalid_grant" }))],
    ["token network failure", () => Promise.reject(new TypeError("fetch failed"))],
    ["response without refresh token", () => Promise.resolve(json(200, { access_token: "only-access" }))],
  ])("reports APPLE_PENDING when no token can be revoked: %s", async (_label, tokenResponse) => {
    const fetchImpl = vi.fn().mockImplementationOnce(tokenResponse);
    await expect(revokeAppleAccess({ appleId: "apple-sub", authorizationCode: "code", config, fetchImpl, now }))
      .resolves.toBe("APPLE_PENDING");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["unexpected status", () => Promise.resolve(new Response("", { status: 503 }))],
    ["timeout", () => Promise.reject(new DOMException("timed out", "TimeoutError"))],
  ])("reports UNKNOWN when the revoke result is not observed: %s", async (_label, revokeResponse) => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json(200, { refresh_token: "synthetic-refresh" }))
      .mockImplementationOnce(revokeResponse);
    await expect(revokeAppleAccess({ appleId: "apple-sub", authorizationCode: "code", config, fetchImpl, now }))
      .resolves.toBe("UNKNOWN");
  });

  it("asks the user to remove Apple access only when revocation was not confirmed", () => {
    expect(appleAccessRemovalRequired("NOT_LINKED")).toBe(false);
    expect(appleAccessRemovalRequired("REVOKED")).toBe(false);
    expect(appleAccessRemovalRequired("APPLE_PENDING")).toBe(true);
    expect(appleAccessRemovalRequired("UNKNOWN")).toBe(true);
  });
});
