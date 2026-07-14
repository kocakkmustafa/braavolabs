/**
 * D-007 / E9 — auth router wires the cookie helpers correctly.
 *
 * The MODE gate (does a cookie actually get set?) lives inside lib/authCookies
 * and is proven in middleware/__tests__/auth-cookie.test.ts. Here we prove the
 * ROUTER contract that holds in BOTH modes:
 *   • login / register / refresh call setAuthCookies with the issued bundle,
 *     and the JSON response body is unchanged (mobile/existing clients safe);
 *   • refresh prefers a body token, else falls back to the refresh cookie
 *     behind the CSRF gate, else preserves the strict-400 validation;
 *   • logout clears the cookies.
 *
 * auth.service and lib/authCookies are mocked; handlers are extracted straight
 * off the Router stack (same zero-network harness as pipeline-router tests).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Router } from "express";

const loginMock = vi.hoisted(() => vi.fn());
const registerMock = vi.hoisted(() => vi.fn());
const refreshTokensMock = vi.hoisted(() => vi.fn());
const revokeAllMock = vi.hoisted(() => vi.fn());

// Mock the whole service module — only the four functions the tested handlers
// call need real behavior; the rest are referenced only inside untested
// handlers, so `undefined` is harmless.
vi.mock("../auth.service", () => ({
  login: (...a: unknown[]) => loginMock(...a),
  register: (...a: unknown[]) => registerMock(...a),
  refreshTokens: (...a: unknown[]) => refreshTokensMock(...a),
  revokeAllRefreshTokens: (...a: unknown[]) => revokeAllMock(...a),
}));

const setAuthCookiesMock = vi.hoisted(() => vi.fn());
const clearAuthCookiesMock = vi.hoisted(() => vi.fn());
const getCookieRefreshTokenMock = vi.hoisted(() => vi.fn());
const csrfOkMock = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/authCookies", () => ({
  setAuthCookies: (...a: unknown[]) => setAuthCookiesMock(...a),
  clearAuthCookies: (...a: unknown[]) => clearAuthCookiesMock(...a),
  getCookieRefreshToken: (...a: unknown[]) => getCookieRefreshTokenMock(...a),
  csrfOkForCookieAuth: (...a: unknown[]) => csrfOkMock(...a),
}));

import { authRouter } from "../auth.router";

function getHandler(router: Router, method: string, path: string) {
  const layer = (router as any).stack.find(
    (l: any) => l.route && l.route.path === path && l.route.methods[method.toLowerCase()],
  );
  if (!layer) throw new Error(`No route ${method} ${path}`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle as (req: any, res: any, next: any) => Promise<void> | void;
}

function mockRes() {
  const res: any = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

async function invoke(handler: any, req: any) {
  const res = mockRes();
  let nextErr: any = undefined;
  await handler(
    { headers: {}, method: "POST", body: {}, query: {}, ip: "1.2.3.4", ...req },
    res,
    (err?: any) => {
      nextErr = err;
    },
  );
  return { res, nextErr };
}

const BUNDLE = {
  token: "access-jwt",
  refreshToken: "refresh-jwt",
  user: { id: "u1", email: "a@b.com", name: "A", role: "admin" },
  tenant: { id: "t1", name: "Acme", slug: "acme", plan: "FREE" },
};

beforeEach(() => {
  vi.clearAllMocks();
  csrfOkMock.mockReturnValue(true);
  getCookieRefreshTokenMock.mockReturnValue(null);
});

describe("POST /login", () => {
  const handler = getHandler(authRouter, "post", "/login");

  it("sets auth cookies with the bundle and returns the unchanged body", async () => {
    loginMock.mockResolvedValue(BUNDLE);
    const { res, nextErr } = await invoke(handler, {
      body: { email: "a@b.com", password: "x" },
    });
    expect(nextErr).toBeUndefined();
    expect(loginMock).toHaveBeenCalledWith({ email: "a@b.com", password: "x" }, "1.2.3.4");
    expect(setAuthCookiesMock).toHaveBeenCalledWith(res, BUNDLE);
    expect(res.body).toBe(BUNDLE); // body identical → mobile/existing clients safe
  });
});

describe("POST /register", () => {
  const handler = getHandler(authRouter, "post", "/register");

  it("sets auth cookies and returns 201 with the unchanged body", async () => {
    registerMock.mockResolvedValue(BUNDLE);
    const { res, nextErr } = await invoke(handler, {
      body: { email: "a@b.com", password: "Strong1Pass", name: "A", tenantName: "Acme" },
    });
    expect(nextErr).toBeUndefined();
    expect(res.statusCode).toBe(201);
    expect(setAuthCookiesMock).toHaveBeenCalledWith(res, BUNDLE);
    expect(res.body).toBe(BUNDLE);
  });
});

describe("POST /refresh", () => {
  const handler = getHandler(authRouter, "post", "/refresh");

  it("prefers the body token and never consults the cookie", async () => {
    refreshTokensMock.mockResolvedValue(BUNDLE);
    const { res, nextErr } = await invoke(handler, { body: { refreshToken: "body-refresh" } });
    expect(nextErr).toBeUndefined();
    expect(refreshTokensMock).toHaveBeenCalledWith("body-refresh");
    expect(getCookieRefreshTokenMock).not.toHaveBeenCalled();
    expect(setAuthCookiesMock).toHaveBeenCalledWith(res, BUNDLE);
    expect(res.body).toBe(BUNDLE);
  });

  it("falls back to the refresh cookie (CSRF ok) when the body omits the token", async () => {
    getCookieRefreshTokenMock.mockReturnValue("cookie-refresh");
    csrfOkMock.mockReturnValue(true);
    refreshTokensMock.mockResolvedValue(BUNDLE);
    const { res, nextErr } = await invoke(handler, {
      body: {},
      headers: { "x-requested-with": "XMLHttpRequest" },
    });
    expect(nextErr).toBeUndefined();
    expect(refreshTokensMock).toHaveBeenCalledWith("cookie-refresh");
    expect(res.body).toBe(BUNDLE);
  });

  it("403s a cookie-sourced refresh with no CSRF header, without refreshing", async () => {
    getCookieRefreshTokenMock.mockReturnValue("cookie-refresh");
    csrfOkMock.mockReturnValue(false);
    const { res, nextErr } = await invoke(handler, { body: {} });
    expect(nextErr).toBeUndefined();
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: "Missing CSRF header for cookie-based auth" });
    expect(refreshTokensMock).not.toHaveBeenCalled();
    expect(setAuthCookiesMock).not.toHaveBeenCalled();
  });

  it("preserves the strict-400 contract with neither body token nor cookie", async () => {
    getCookieRefreshTokenMock.mockReturnValue(null); // flag-off equivalent
    const { nextErr } = await invoke(handler, { body: {} });
    // zod .parse throws ZodError → forwarded to next() → 400 (unchanged).
    expect(nextErr).toBeDefined();
    expect(refreshTokensMock).not.toHaveBeenCalled();
  });
});

describe("POST /logout", () => {
  const handler = getHandler(authRouter, "post", "/logout");

  it("revokes refresh tokens and clears the auth cookies", async () => {
    revokeAllMock.mockResolvedValue(undefined);
    const { res, nextErr } = await invoke(handler, {
      auth: { userId: "u1", tenantId: "t1", role: "admin" },
    });
    expect(nextErr).toBeUndefined();
    expect(revokeAllMock).toHaveBeenCalledWith("u1");
    expect(clearAuthCookiesMock).toHaveBeenCalledWith(res);
    expect(res.body).toEqual({ message: "Logged out successfully." });
  });
});
