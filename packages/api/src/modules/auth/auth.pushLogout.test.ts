/** Actual router, cookie/CSRF helpers, cleanup and JWT verification. No socket or database is used. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import jwt, { type JwtPayload } from "jsonwebtoken";

const envMock = vi.hoisted(() => ({
  JWT_SECRET: "push-logout-test-secret-at-least-32-characters",
  AUTH_COOKIE_MODE: true, NODE_ENV: "test",
}));
const retire = vi.hoisted(() => vi.fn());
const revokeAll = vi.hoisted(() => vi.fn());
const refreshIdentity = vi.hoisted(() => vi.fn());
vi.mock("../../config/env", () => ({ env: envMock }));
vi.mock("../../lib/pushOwnership", () => ({ retirePushSession: retire }));
vi.mock("../../lib/redis", () => ({ redis: {} }));
vi.mock("../../lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));
vi.mock("../../middleware/auth", () => ({ authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next() }));
vi.mock("../../middleware/rateLimit", () => ({ rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next() }));
vi.mock("./auth.service", () => ({
  revokeAllRefreshTokens: revokeAll,
  userIdFromRefreshToken: refreshIdentity,
  register: vi.fn(), login: vi.fn(), getGoogleAuthUrl: vi.fn(), googleCallback: vi.fn(),
  getGitHubAuthUrl: vi.fn(), githubCallback: vi.fn(), requestPasswordReset: vi.fn(),
  resetPassword: vi.fn(), refreshTokens: vi.fn(), stashOAuthExchange: vi.fn(), redeemOAuthExchange: vi.fn(),
  appleMobileSignIn: vi.fn(), googleMobileSignIn: vi.fn(), googleMobileCodeSignIn: vi.fn(),
  githubMobileSignIn: vi.fn(), verifyEmail: vi.fn(), resendVerifyEmail: vi.fn(),
  getAppleWebAuthUrl: vi.fn(), appleWebCallback: vi.fn(),
}));

import { authRouter } from "./auth.router";
import { currentTenantContext, runWithoutTenant } from "../../lib/tenant-context";

const actorA = { userId: "user-a", tenantId: "tenant-a", pushSessionId: "97035340-20ad-4fbd-8d93-760f817f5b4d" };
const actorB = { userId: "user-b", tenantId: "tenant-b", pushSessionId: "9d1ac129-d26c-413a-a95f-563e413b6ba8" };
function access(actor = actorA, secret = envMock.JWT_SECRET) {
  return jwt.sign({ ...actor, role: "MEMBER" }, secret, { algorithm: "HS256", expiresIn: "1h" });
}
function refresh(actor = actorA) {
  return jwt.sign({ ...actor, role: "MEMBER", typ: "refresh", jti: "synthetic-refresh-id" }, envMock.JWT_SECRET, { algorithm: "HS256", expiresIn: "7d" });
}
function cookies(accessToken?: string, refreshToken?: string) {
  return [accessToken && `bv_access_token=${encodeURIComponent(accessToken)}`,
    refreshToken && `bv_refresh_token=${encodeURIComponent(refreshToken)}`].filter(Boolean).join("; ");
}
const logout = (authRouter as any).stack.find((layer: any) => layer.route?.path === "/logout" && layer.route.methods.post).route.stack.at(-1).handle;
async function invoke(headers: Record<string, string> = {}, body: Record<string, unknown> = {}) {
  const res: any = { statusCode: 200, body: undefined,
    status(code: number) { this.statusCode = code; return this; },
    json(value: unknown) { this.body = value; return this; }, clearCookie: vi.fn() };
  const next = vi.fn();
  // The real route's systemScope establishes this same pre-auth context.
  await runWithoutTenant("route:auth", () => logout({ method: "POST", headers, body }, res, next));
  return { res, next };
}
beforeEach(() => {
  vi.resetAllMocks();
  revokeAll.mockResolvedValue(undefined);
  refreshIdentity.mockImplementation((token: string) => {
    try {
      const payload = jwt.verify(token, envMock.JWT_SECRET, { algorithms: ["HS256"] }) as JwtPayload;
      return payload.typ === "refresh" && payload.jti && typeof payload.userId === "string" ? payload.userId : null;
    } catch { return null; }
  });
  retire.mockImplementation(async (actor: typeof actorA) => {
    expect(currentTenantContext()).toEqual({ kind: "tenant", tenantId: actor.tenantId });
  });
});

describe("logout hands only selected, CSRF-checked proofs to push retirement", () => {
  it("retires the exact signed cookie-access SID and revokes that user's refresh tokens", async () => {
    const { res, next } = await invoke({ cookie: cookies(access()), "x-requested-with": "XMLHttpRequest" }, { ...actorB });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ message: "Logged out successfully." });
    expect(retire).toHaveBeenCalledExactlyOnceWith(actorA);
    expect(revokeAll).toHaveBeenCalledExactlyOnceWith(actorA.userId);
    expect(res.clearCookie).toHaveBeenCalledTimes(2);
    expect(currentTenantContext()).toBeUndefined();
  });

  it("falls back from expired cookie access to the valid cookie refresh proof's own SID", async () => {
    const expired = jwt.sign({ ...actorB, exp: Math.floor(Date.now() / 1000) - 10 }, envMock.JWT_SECRET, { algorithm: "HS256" });
    const proof = refresh(actorA);
    const { res, next } = await invoke({ cookie: cookies(expired, proof), "x-requested-with": "XMLHttpRequest" }, { ...actorB });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(refreshIdentity).toHaveBeenCalledExactlyOnceWith(proof);
    expect(retire).toHaveBeenCalledExactlyOnceWith(actorA);
    expect(revokeAll).toHaveBeenCalledExactlyOnceWith(actorA.userId);
  });

  it.each(["access", "refresh"])("denies cookie-%s logout without CSRF before either revocation", async kind => {
    const { res, next } = await invoke({ cookie: kind === "access" ? cookies(access()) : cookies(undefined, refresh()) });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: "Missing CSRF header for cookie-based auth" });
    expect(retire).not.toHaveBeenCalled();
    expect(revokeAll).not.toHaveBeenCalled();
    expect(res.clearCookie).not.toHaveBeenCalled();
  });

  it.each(["absent", "forged-bearer", "forged-refresh"])("%s proof plus body SID cannot retire or revoke anyone", async kind => {
    const forged = access(actorA, "synthetic-untrusted-secret");
    const { res, next } = await invoke(kind === "forged-bearer" ? { authorization: `Bearer ${forged}` } : {},
      { ...actorB, sid: actorB.pushSessionId, ...(kind === "forged-refresh" ? { refreshToken: forged } : {}) });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ message: "Logged out successfully." });
    expect(retire).not.toHaveBeenCalled();
    expect(revokeAll).not.toHaveBeenCalled();
  });

  it("keeps a captured valid bearer proof ahead of newer cookies and body refresh credentials", async () => {
    const { res, next } = await invoke({ authorization: `Bearer ${access(actorA)}`,
      cookie: cookies(access(actorB), refresh(actorB)) }, { ...actorB, refreshToken: refresh(actorB) });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200); // Bearer proof does not require cookie CSRF.
    expect(refreshIdentity).not.toHaveBeenCalled();
    expect(retire).toHaveBeenCalledExactlyOnceWith(actorA);
    expect(revokeAll).toHaveBeenCalledExactlyOnceWith(actorA.userId);
  });
});
