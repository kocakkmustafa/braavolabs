/**
 * D-007 / E9 — dual-mode web auth cookies: helpers + middleware.
 *
 * Two concerns proven here with a zero-network harness:
 *   1. lib/authCookies pure helpers — cookie attributes (httpOnly / secure /
 *      samesite / path / maxAge), the AUTH_COOKIE_MODE no-op gate, clearing,
 *      the hand-rolled reader, and the CSRF custom-header rule.
 *   2. middleware/auth in BOTH modes — bearer priority, cookie fallback only
 *      when the flag is on, CSRF rejection of cookie-authed mutations, and the
 *      unchanged 401 contract.
 *
 * env + prisma are mocked; JWTs are real (signed with the mock secret) so the
 * verify path is exercised, not stubbed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import jwt from "jsonwebtoken";

const JWT_SECRET = "test_jwt_secret_test_jwt_secret_0123456789";

// Mutable env mock — flip AUTH_COOKIE_MODE / NODE_ENV per test. authCookies
// and middleware/auth both import this same module id ("../../config/env").
const envMock = vi.hoisted(() => ({
  NODE_ENV: "development" as string,
  JWT_SECRET: "test_jwt_secret_test_jwt_secret_0123456789",
  AUTH_COOKIE_MODE: false,
  JWT_EXPIRES_IN: "1h",
  JWT_REFRESH_EXPIRES_IN: "7d",
}));
vi.mock("../../config/env", () => ({ env: envMock }));

const executeRawMock = vi.hoisted(() => vi.fn().mockResolvedValue(1));
vi.mock("../../lib/db", () => ({
  prisma: { $executeRaw: (...a: unknown[]) => executeRawMock(...a) },
}));

import { authMiddleware } from "../auth";
import {
  durationToMs,
  setAuthCookies,
  clearAuthCookies,
  readCookie,
  getCookieAccessToken,
  csrfOkForCookieAuth,
  ACCESS_COOKIE_NAME,
  REFRESH_COOKIE_NAME,
} from "../../lib/authCookies";

// ── Fake res that records cookie() / clearCookie() / status().json() ──
function mockRes() {
  const res: any = {
    statusCode: 200,
    body: undefined as unknown,
    cookies: [] as Array<{ name: string; value: string; options: any }>,
    cleared: [] as Array<{ name: string; options: any }>,
    _finishCbs: [] as Array<() => void>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    cookie(name: string, value: string, options: any) {
      this.cookies.push({ name, value, options });
      return this;
    },
    clearCookie(name: string, options: any) {
      this.cleared.push({ name, options });
      return this;
    },
    on(event: string, cb: () => void) {
      if (event === "finish") this._finishCbs.push(cb);
      return this;
    },
  };
  return res;
}

function tokenFor(payload: object) {
  return jwt.sign(payload, JWT_SECRET, { algorithm: "HS256", expiresIn: "1h" });
}

async function runMiddleware(req: any) {
  const res = mockRes();
  let nexted = false;
  await authMiddleware(
    { headers: {}, method: "GET", ...req },
    res,
    () => {
      nexted = true;
    },
  );
  return { res, nexted };
}

const AUTH = { userId: "u1", tenantId: "t1", role: "admin" };

beforeEach(() => {
  vi.clearAllMocks();
  envMock.NODE_ENV = "development";
  envMock.AUTH_COOKIE_MODE = false;
  envMock.JWT_EXPIRES_IN = "1h";
  envMock.JWT_REFRESH_EXPIRES_IN = "7d";
});

// ─────────────────────────── durationToMs ───────────────────────────
describe("durationToMs", () => {
  it("parses suffixed durations", () => {
    expect(durationToMs("300ms", 0)).toBe(300);
    expect(durationToMs("45s", 0)).toBe(45_000);
    expect(durationToMs("30m", 0)).toBe(1_800_000);
    expect(durationToMs("1h", 0)).toBe(3_600_000);
    expect(durationToMs("7d", 0)).toBe(604_800_000);
  });
  it("treats a bare number as seconds (jsonwebtoken semantics)", () => {
    expect(durationToMs("3600", 0)).toBe(3_600_000);
  });
  it("returns the fallback on an unparseable value (never NaN)", () => {
    expect(durationToMs("garbage", 999)).toBe(999);
    expect(durationToMs("", 999)).toBe(999);
  });
});

// ─────────────────────────── readCookie ─────────────────────────────
describe("readCookie", () => {
  it("extracts a named cookie and url-decodes the value", () => {
    const req: any = { headers: { cookie: "a=1; bv_access_token=ab%20cd; z=9" } };
    expect(readCookie(req, ACCESS_COOKIE_NAME)).toBe("ab cd");
  });
  it("returns null when the header or cookie is absent", () => {
    expect(readCookie({ headers: {} } as any, ACCESS_COOKIE_NAME)).toBeNull();
    expect(
      readCookie({ headers: { cookie: "other=1" } } as any, ACCESS_COOKIE_NAME),
    ).toBeNull();
  });
});

// ──────────────────── setAuthCookies / attributes ───────────────────
describe("setAuthCookies", () => {
  it("is a no-op while AUTH_COOKIE_MODE is off (bearer-only mode untouched)", () => {
    envMock.AUTH_COOKIE_MODE = false;
    const res = mockRes();
    setAuthCookies(res, { token: "acc", refreshToken: "ref" });
    expect(res.cookies).toHaveLength(0);
  });

  it("sets httpOnly + SameSite=Strict access & refresh cookies when on", () => {
    envMock.AUTH_COOKIE_MODE = true;
    const res = mockRes();
    setAuthCookies(res, { token: "acc", refreshToken: "ref" });

    const access = res.cookies.find((c: any) => c.name === ACCESS_COOKIE_NAME);
    const refresh = res.cookies.find((c: any) => c.name === REFRESH_COOKIE_NAME);
    expect(access.value).toBe("acc");
    expect(refresh.value).toBe("ref");

    // httpOnly + SameSite=Strict on both — the CSRF/xss posture.
    for (const c of [access, refresh]) {
      expect(c.options.httpOnly).toBe(true);
      expect(c.options.sameSite).toBe("strict");
    }
    // Access cookie rides every request; refresh is scoped to the auth path.
    expect(access.options.path).toBe("/");
    expect(refresh.options.path).toBe("/api/v1/auth");
    // maxAge derives from the configured token TTLs.
    expect(access.options.maxAge).toBe(3_600_000); // 1h
    expect(refresh.options.maxAge).toBe(604_800_000); // 7d
  });

  it("omits Secure in dev but sets it in production", () => {
    envMock.AUTH_COOKIE_MODE = true;

    envMock.NODE_ENV = "development";
    const dev = mockRes();
    setAuthCookies(dev, { token: "a", refreshToken: "r" });
    expect(dev.cookies.every((c: any) => c.options.secure === false)).toBe(true);

    envMock.NODE_ENV = "production";
    const prod = mockRes();
    setAuthCookies(prod, { token: "a", refreshToken: "r" });
    expect(prod.cookies.every((c: any) => c.options.secure === true)).toBe(true);
  });
});

describe("clearAuthCookies", () => {
  it("clears both cookies on their exact paths even with the flag off", () => {
    envMock.AUTH_COOKIE_MODE = false; // rollback-safe: still clears
    const res = mockRes();
    clearAuthCookies(res);
    const acc = res.cleared.find((c: any) => c.name === ACCESS_COOKIE_NAME);
    const ref = res.cleared.find((c: any) => c.name === REFRESH_COOKIE_NAME);
    expect(acc.options.path).toBe("/");
    expect(ref.options.path).toBe("/api/v1/auth");
  });
});

// ─────────────────────────── CSRF rule ──────────────────────────────
describe("csrfOkForCookieAuth", () => {
  it("allows safe (non-mutating) methods with no header", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      expect(csrfOkForCookieAuth({ method, headers: {} } as any)).toBe(true);
    }
  });
  it("rejects a state-changing method without the custom header", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(csrfOkForCookieAuth({ method, headers: {} } as any)).toBe(false);
    }
  });
  it("accepts a state-changing method carrying X-Requested-With", () => {
    expect(
      csrfOkForCookieAuth({
        method: "POST",
        headers: { "x-requested-with": "XMLHttpRequest" },
      } as any),
    ).toBe(true);
  });
});

// ─────────────────── getCookieAccessToken gate ──────────────────────
describe("getCookieAccessToken", () => {
  const req: any = { headers: { cookie: `${ACCESS_COOKIE_NAME}=tok` }, method: "GET" };
  it("returns null when AUTH_COOKIE_MODE is off", () => {
    envMock.AUTH_COOKIE_MODE = false;
    expect(getCookieAccessToken(req)).toBeNull();
  });
  it("returns the cookie value when on", () => {
    envMock.AUTH_COOKIE_MODE = true;
    expect(getCookieAccessToken(req)).toBe("tok");
  });
});

// ───────────────────────── authMiddleware ───────────────────────────
describe("authMiddleware — bearer mode (flag off)", () => {
  it("authenticates a valid Bearer token", async () => {
    const { res, nexted } = await runMiddleware({
      headers: { authorization: `Bearer ${tokenFor(AUTH)}` },
    });
    expect(nexted).toBe(true);
    expect(res.statusCode).toBe(200);
  });

  it("401s with the unchanged message when no Bearer header is present", async () => {
    const { res, nexted } = await runMiddleware({ headers: {} });
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: "Missing or invalid authorization header" });
  });

  it("IGNORES the access cookie while the flag is off", async () => {
    envMock.AUTH_COOKIE_MODE = false;
    const { res, nexted } = await runMiddleware({
      headers: { cookie: `${ACCESS_COOKIE_NAME}=${tokenFor(AUTH)}` },
    });
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  it("401s on an invalid Bearer token", async () => {
    const { res, nexted } = await runMiddleware({
      headers: { authorization: "Bearer not.a.jwt" },
    });
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: "Invalid or expired token" });
  });
});

describe("authMiddleware — cookie mode (flag on)", () => {
  beforeEach(() => {
    envMock.AUTH_COOKIE_MODE = true;
  });

  it("accepts the access cookie on a safe request when no Bearer is sent", async () => {
    const { res, nexted } = await runMiddleware({
      method: "GET",
      headers: { cookie: `${ACCESS_COOKIE_NAME}=${tokenFor(AUTH)}` },
    });
    expect(nexted).toBe(true);
    expect(res.statusCode).toBe(200);
  });

  it("keeps Bearer priority when BOTH a bearer and a cookie are present", async () => {
    // Bearer carries a valid token; cookie carries garbage. If cookie were
    // consulted the request would 401 — it must not be.
    const { res, nexted } = await runMiddleware({
      method: "POST",
      headers: {
        authorization: `Bearer ${tokenFor(AUTH)}`,
        cookie: `${ACCESS_COOKIE_NAME}=garbage`,
      },
    });
    expect(nexted).toBe(true);
    expect(res.statusCode).toBe(200); // no CSRF header needed — bearer is exempt
  });

  it("REJECTS a cookie-authed state-changing request with no CSRF header (403)", async () => {
    const { res, nexted } = await runMiddleware({
      method: "POST",
      headers: { cookie: `${ACCESS_COOKIE_NAME}=${tokenFor(AUTH)}` },
    });
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: "Missing CSRF header for cookie-based auth" });
  });

  it("ALLOWS a cookie-authed mutation that carries X-Requested-With", async () => {
    const { res, nexted } = await runMiddleware({
      method: "POST",
      headers: {
        cookie: `${ACCESS_COOKIE_NAME}=${tokenFor(AUTH)}`,
        "x-requested-with": "XMLHttpRequest",
      },
    });
    expect(nexted).toBe(true);
    expect(res.statusCode).toBe(200);
  });

  it("still 401s (not 403) when the cookie token itself is invalid", async () => {
    const { res, nexted } = await runMiddleware({
      method: "POST",
      headers: { cookie: `${ACCESS_COOKIE_NAME}=not.a.jwt` },
    });
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(401);
  });
});
