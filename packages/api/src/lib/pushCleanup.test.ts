/** Actual signed cleanup proof verification; retirement is observed without a database or network. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import jwt from "jsonwebtoken";

const envMock = vi.hoisted(() => ({ JWT_SECRET: "push-cleanup-test-secret-at-least-32-characters" }));
const retire = vi.hoisted(() => vi.fn());
vi.mock("../config/env", () => ({ env: envMock }));
vi.mock("./pushOwnership", () => ({ retirePushSession: retire }));

import { cleanupPushSession, isPushSessionId } from "./pushCleanup";
import { currentTenantContext } from "./tenant-context";

const actorA = { userId: "user-a", tenantId: "tenant-a", pushSessionId: "97035340-20ad-4fbd-8d93-760f817f5b4d" };
const actorB = { userId: "user-b", tenantId: "tenant-b", pushSessionId: "9d1ac129-d26c-413a-a95f-563e413b6ba8" };
function sign(payload: Record<string, unknown>, secret = envMock.JWT_SECRET, algorithm: jwt.Algorithm = "HS256") {
  return jwt.sign(payload, secret, { algorithm, expiresIn: "1h" });
}
function refresh(actor = actorA) { return sign({ ...actor, typ: "refresh", jti: "captured-refresh" }); }
function expiredAccess() {
  return jwt.sign({ ...actorA, exp: Math.floor(Date.now() / 1000) - 10 }, envMock.JWT_SECRET, { algorithm: "HS256" });
}
beforeEach(() => {
  vi.resetAllMocks();
  retire.mockImplementation(async (actor: typeof actorA) => {
    expect(currentTenantContext()).toEqual({ kind: "tenant", tenantId: actor.tenantId });
  });
});

describe("server-issued push SID shape", () => {
  it("accepts UUIDv4 including uppercase and rejects another version, variant, or client-shaped value", () => {
    expect(isPushSessionId(actorA.pushSessionId)).toBe(true);
    expect(isPushSessionId(actorA.pushSessionId.toUpperCase())).toBe(true);
    for (const input of [undefined, null, 1, {}, "", "client-sid", ` ${actorA.pushSessionId}`,
      "97035340-20ad-1fbd-8d93-760f817f5b4d", "97035340-20ad-4fbd-7d93-760f817f5b4d"]) {
      expect(isPushSessionId(input)).toBe(false);
    }
  });
});

describe("revocation-only proof and identity binding", () => {
  it("uses only signed access identity and SID, ignoring body identity, SID and token fields", async () => {
    await cleanupPushSession({ headers: { authorization: `Bearer ${sign(actorA)}` },
      body: { ...actorB, sid: actorB.pushSessionId, accessToken: sign(actorB), token: sign(actorB) } });
    expect(retire).toHaveBeenCalledExactlyOnceWith(actorA);
    expect(currentTenantContext()).toBeUndefined();
  });

  it("prefers a valid access proof over another user's body refresh proof", async () => {
    await cleanupPushSession({ headers: { authorization: `Bearer ${sign(actorA)}` }, body: { refreshToken: refresh(actorB) } });
    expect(retire).toHaveBeenCalledExactlyOnceWith(actorA);
  });

  it.each(["expired", "malformed", "missing", "legacy-access"])(
    "falls back from %s access to the body refresh proof's own user and tenant", async kind => {
      const token = kind === "expired" ? expiredAccess() : kind === "malformed" ? "synthetic-invalid-jwt"
        : kind === "legacy-access" ? sign({ userId: "legacy-user", tenantId: "legacy-tenant" }) : null;
      await cleanupPushSession({ headers: token ? { authorization: `Bearer ${token}` } : {},
        body: { ...actorB, refreshToken: refresh(actorA) } });
      expect(retire).toHaveBeenCalledExactlyOnceWith(actorA);
    },
  );

  it("an expired old access proof cannot borrow a new account's cookie or body bearer credentials", async () => {
    await expect(cleanupPushSession({ headers: { authorization: `Bearer ${expiredAccess()}`,
      cookie: `bv_access_token=${sign(actorB)}; bv_refresh_token=${refresh(actorB)}` },
      body: { ...actorB, sid: actorB.pushSessionId, accessToken: sign(actorB), token: sign(actorB) } })).resolves.toBeUndefined();
    expect(retire).not.toHaveBeenCalled();
  });

  it("ignores cookie-only proofs even when their signature and SID are valid", async () => {
    await cleanupPushSession({ headers: { cookie: `bv_access_token=${sign(actorB)}; bv_refresh_token=${refresh(actorB)}` }, body: {} });
    expect(retire).not.toHaveBeenCalled();
  });

  it("does not use a refresh JWT in the access slot or an access JWT in the refresh slot", async () => {
    await cleanupPushSession({ headers: { authorization: `Bearer ${refresh()}` }, body: { refreshToken: sign(actorB) } });
    expect(retire).not.toHaveBeenCalled();
    await cleanupPushSession({ headers: { authorization: `Bearer ${refresh(actorB)}` }, body: { refreshToken: refresh(actorA) } });
    expect(retire).toHaveBeenCalledExactlyOnceWith(actorA);
  });

  it.each([
    { ...actorA, pushSessionId: "client-session" },
    { ...actorA, pushSessionId: "97035340-20ad-1fbd-8d93-760f817f5b4d" },
    { ...actorA, userId: " " },
    { ...actorA, tenantId: "" },
    { ...actorA, userId: 42 },
    { ...actorA, tenantId: null },
  ])("refuses signed but incomplete or malformed authority %#", async payload => {
    await cleanupPushSession({ headers: { authorization: `Bearer ${sign(payload)}` }, body: { ...actorB } });
    expect(retire).not.toHaveBeenCalled();
  });

  it.each(["wrong-signature", "wrong-algorithm", "expired-refresh", "absent"])(
    "invalid proof %s is an indistinguishable no-op", async kind => {
      const token = kind === "wrong-signature" ? sign(actorA, "another-test-secret")
        : kind === "wrong-algorithm" ? sign(actorA, envMock.JWT_SECRET, "HS384")
        : kind === "expired-refresh" ? jwt.sign({ ...actorA, typ: "refresh", exp: 1 }, envMock.JWT_SECRET) : null;
      await expect(cleanupPushSession({ headers: kind === "wrong-signature" || kind === "wrong-algorithm"
        ? { authorization: `Bearer ${token}` } : {}, body: kind === "expired-refresh" ? { refreshToken: token } : {} })).resolves.toBeUndefined();
      expect(retire).not.toHaveBeenCalled();
    },
  );

  it("propagates a retirement failure without trying another user's valid credentials", async () => {
    const failure = new Error("synthetic retirement unavailable");
    retire.mockRejectedValueOnce(failure);
    await expect(cleanupPushSession({ headers: { authorization: `Bearer ${sign(actorA)}` }, body: { refreshToken: refresh(actorB) } })).rejects.toBe(failure);
    expect(retire).toHaveBeenCalledExactlyOnceWith(actorA);
  });
});
