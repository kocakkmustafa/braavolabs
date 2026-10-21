/** Real login/rotation and JWT signing; push persistence, Redis and password adapters are local stubs. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import jwt, { type JwtPayload } from "jsonwebtoken";

const envMock = vi.hoisted(() => ({
  JWT_SECRET: "push-auth-test-secret-at-least-32-characters",
  JWT_EXPIRES_IN: "1h", JWT_REFRESH_EXPIRES_IN: "7d",
}));
const db = vi.hoisted(() => ({ user: { findUnique: vi.fn() }, activityLog: { create: vi.fn() } }));
const redisMock = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), call: vi.fn(), del: vi.fn() }));
const push = vi.hoisted(() => ({ createPushSession: vi.fn(), renewPushSession: vi.fn(), retirePushSession: vi.fn() }));
const comparePassword = vi.hoisted(() => vi.fn());
const warn = vi.hoisted(() => vi.fn());
vi.mock("../../config/env", () => ({ env: envMock }));
vi.mock("../../lib/db", () => ({ prisma: db, tenantTx: vi.fn() }));
vi.mock("../../lib/redis", () => ({ redis: redisMock }));
vi.mock("../../lib/pushOwnership", () => push);
vi.mock("../../lib/logger", () => ({ logger: { warn } }));
vi.mock("../../integrations/email-templates", () => ({ sendWelcomeEmail: vi.fn(), sendPasswordResetEmail: vi.fn(), sendVerifyEmail: vi.fn() }));
vi.mock("bcryptjs", () => ({ default: { hashSync: () => "synthetic-dummy-hash", compare: comparePassword } }));
vi.mock("google-auth-library", () => ({ OAuth2Client: class {} }));
vi.mock("jose", () => ({ createRemoteJWKSet: vi.fn(), jwtVerify: vi.fn() }));

import { issueTokenPair, login, refreshTokens } from "./auth.service";
import { isPushSessionId } from "../../lib/pushCleanup";

const identity = { userId: "user-a", tenantId: "tenant-a", role: "OWNER" };
const sid = "97035340-20ad-4fbd-8d93-760f817f5b4d";
let keys: Map<string, string>;
let user: {
  id: string; tenantId: string; role: string; email: string; name: string;
  passwordHash: string; tenant: { id: string; name: string; slug: string; plan: string };
};
function decode(token: string): JwtPayload {
  return jwt.verify(token, envMock.JWT_SECRET, { algorithms: ["HS256"] }) as JwtPayload;
}
function readPair(pair: { token: string; refreshToken: string }) {
  const access = decode(pair.token), refresh = decode(pair.refreshToken);
  expect(access.typ).toBeUndefined();
  expect(refresh.typ).toBe("refresh");
  expect(refresh.jti).toEqual(expect.any(String));
  expect(keys.get(`refresh:${refresh.userId}:${refresh.jti}`)).toBe("1");
  return { access, refresh };
}
function legacyRefresh(extra: Record<string, unknown> = {}) {
  const jti = "synthetic-legacy-refresh";
  keys.set(`refresh:${identity.userId}:${jti}`, "1");
  return jwt.sign({ ...identity, typ: "refresh", jti, ...extra }, envMock.JWT_SECRET, {
    algorithm: "HS256", expiresIn: "7d",
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  keys = new Map();
  user = { id: identity.userId, tenantId: identity.tenantId, role: identity.role,
    email: "owner@example.invalid", name: "Owner", passwordHash: "synthetic-password-hash",
    tenant: { id: identity.tenantId, name: "Tenant", slug: "tenant", plan: "FREE" } };
  db.user.findUnique.mockImplementation(async () => ({ ...user, tenant: { ...user.tenant } }));
  db.activityLog.create.mockResolvedValue({ id: "audit" });
  comparePassword.mockResolvedValue(true);
  redisMock.get.mockResolvedValue(null);
  redisMock.set.mockImplementation(async (key: string, value: string) => { keys.set(key, value); return "OK"; });
  redisMock.del.mockResolvedValue(1);
  redisMock.call.mockImplementation(async (command: string, key: string) => {
    expect(command).toBe("GETDEL");
    const value = keys.get(key) ?? null;
    keys.delete(key);
    return value;
  });
  push.createPushSession.mockResolvedValue(true);
  push.renewPushSession.mockResolvedValue(true);
});

describe("push authority across actual auth token issuance and rotation", () => {
  it("fresh password login signs one fresh UUID SID into both tokens and persists the longest signed expiry", async () => {
    const result = await login({ email: " Owner@Example.Invalid ", password: "synthetic-password" }, "192.0.2.1");
    const { access, refresh } = readPair(result);
    expect(db.user.findUnique).toHaveBeenCalledWith({ where: { email: "owner@example.invalid" }, include: { tenant: true } });
    expect(comparePassword).toHaveBeenCalledWith("synthetic-password", user.passwordHash);
    expect(access).toMatchObject(identity);
    expect(isPushSessionId(access.pushSessionId)).toBe(true);
    expect(refresh.pushSessionId).toBe(access.pushSessionId);
    expect(push.createPushSession).toHaveBeenCalledExactlyOnceWith(identity, access.pushSessionId,
      new Date(Math.max(access.exp!, refresh.exp!) * 1000));
    expect(push.renewPushSession).not.toHaveBeenCalled();
    expect(result.user.id).toBe(identity.userId);
  });

  it("never adopts a supplied payload SID as new-login authority", async () => {
    const first = readPair(await issueTokenPair({ ...identity, pushSessionId: sid }));
    const second = readPair(await issueTokenPair({ ...identity, pushSessionId: sid }));
    expect(first.access.pushSessionId).not.toBe(sid);
    expect(second.access.pushSessionId).not.toBe(first.access.pushSessionId);
    expect(push.createPushSession).toHaveBeenCalledTimes(2);
  });

  it("persists through the access expiry when it is longer than the refresh expiry", async () => {
    const previous = envMock.JWT_EXPIRES_IN;
    envMock.JWT_EXPIRES_IN = "9d";
    try {
      const { access, refresh } = readPair(await issueTokenPair(identity));
      expect(access.exp!).toBeGreaterThan(refresh.exp!);
      expect(push.createPushSession).toHaveBeenCalledExactlyOnceWith(identity, access.pushSessionId,
        new Date(access.exp! * 1000));
    } finally { envMock.JWT_EXPIRES_IN = previous; }
  });

  it("renews the original SID on refresh, uses fresh membership, and consumes the old token once", async () => {
    const original = await issueTokenPair(identity);
    const originalSid = decode(original.token).pushSessionId;
    push.createPushSession.mockClear();
    user.role = "MEMBER";
    const result = await refreshTokens(original.refreshToken);
    const { access, refresh } = readPair(result);
    expect(access).toMatchObject({ ...identity, role: "MEMBER", pushSessionId: originalSid });
    expect(refresh.pushSessionId).toBe(originalSid);
    expect(push.renewPushSession).toHaveBeenCalledExactlyOnceWith({ ...identity, role: "MEMBER" }, originalSid,
      new Date(Math.max(access.exp!, refresh.exp!) * 1000));
    expect(push.createPushSession).not.toHaveBeenCalled();
    await expect(refreshTokens(original.refreshToken)).rejects.toMatchObject({ statusCode: 401 });
  });

  it.each([undefined, "client-session", "97035340-20ad-1fbd-8d93-760f817f5b4d", 42])(
    "legacy/invalid SID %s stays ordinary auth through repeated refreshes", async pushSessionId => {
      let token = legacyRefresh(pushSessionId === undefined ? {} : { pushSessionId });
      for (let rotation = 0; rotation < 2; rotation++) {
        const result = await refreshTokens(token);
        const { access, refresh } = readPair(result);
        expect(access).toMatchObject(identity);
        expect(access).not.toHaveProperty("pushSessionId");
        expect(refresh).not.toHaveProperty("pushSessionId");
        token = result.refreshToken;
      }
      expect(push.createPushSession).not.toHaveBeenCalled();
      expect(push.renewPushSession).not.toHaveBeenCalled();
    },
  );

  it("a retired SID is stripped from both rotated tokens while ordinary refresh and later fresh login remain available", async () => {
    push.renewPushSession.mockResolvedValue(false);
    const result = await refreshTokens(legacyRefresh({ pushSessionId: sid }));
    const rotated = readPair(result);
    expect(rotated.access).not.toHaveProperty("pushSessionId");
    expect(rotated.refresh).not.toHaveProperty("pushSessionId");
    expect(push.createPushSession).not.toHaveBeenCalled();
    const ordinary = readPair(await refreshTokens(result.refreshToken));
    expect(ordinary.access).toMatchObject(identity);
    expect(ordinary.access).not.toHaveProperty("pushSessionId");
    expect(push.renewPushSession).toHaveBeenCalledOnce();
    const newLogin = readPair(await login({ email: user.email, password: "synthetic-password" }));
    expect(isPushSessionId(newLogin.access.pushSessionId)).toBe(true);
    expect(newLogin.access.pushSessionId).not.toBe(sid);
  });

  it("a push persistence failure leaves signed login tokens and their rotated refresh token usable without SID", async () => {
    push.createPushSession.mockRejectedValueOnce(new Error("synthetic push schema unavailable"));
    const result = await login({ email: user.email, password: "synthetic-password" });
    const { access, refresh } = readPair(result);
    expect(access).toMatchObject(identity);
    expect(access).not.toHaveProperty("pushSessionId");
    expect(refresh).not.toHaveProperty("pushSessionId");
    const rotated = readPair(await refreshTokens(result.refreshToken));
    expect(rotated.access).toMatchObject(identity);
    expect(rotated.access).not.toHaveProperty("pushSessionId");
    expect(push.renewPushSession).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("a failed push renewal strips SID without closing ordinary refresh", async () => {
    push.renewPushSession.mockRejectedValueOnce(new Error("synthetic push database unavailable"));
    const result = await refreshTokens(legacyRefresh({ pushSessionId: sid }));
    const { access, refresh } = readPair(result);
    expect(access).toMatchObject(identity);
    expect(access).not.toHaveProperty("pushSessionId");
    expect(refresh).not.toHaveProperty("pushSessionId");
    expect(push.createPushSession).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("keeps the existing fail-closed Redis auth gate before creating push authority", async () => {
    redisMock.set.mockRejectedValueOnce(new Error("synthetic Redis unavailable"));
    await expect(issueTokenPair(identity)).rejects.toMatchObject({ statusCode: 503 });
    expect(push.createPushSession).not.toHaveBeenCalled();
    expect(push.renewPushSession).not.toHaveBeenCalled();
  });
});
