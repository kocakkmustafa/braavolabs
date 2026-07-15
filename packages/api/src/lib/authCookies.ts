/**
 * Web auth cookie helpers (D-007 / E9).
 *
 * Dual-mode infrastructure so the web client can migrate off
 * localStorage-held JWTs onto httpOnly cookies WITHOUT any behavior change
 * until the operator flips `AUTH_COOKIE_MODE=true` (a separate, user-gated
 * step that ships alongside the UI migration). Everything here is a no-op
 * — or falls back to null — while the flag is off, so the bearer-only path
 * remains bit-for-bit identical.
 *
 * There is no cookie-parser in the middleware stack, so cookie reading is
 * hand-rolled (mirrors the OAuth-state cookie helpers in auth.router.ts).
 */
import type { Request, Response } from "express";
import { env } from "../config/env";

// Access cookie must ride on EVERY API request so authMiddleware can read
// it on any protected route → path "/". The refresh cookie is only needed
// by POST /auth/refresh and /auth/logout, so it is scoped to the auth
// router mount path to minimise where the long-lived token is exposed.
export const ACCESS_COOKIE_NAME = "bv_access_token";
export const REFRESH_COOKIE_NAME = "bv_refresh_token";
export const ACCESS_COOKIE_PATH = "/";
export const REFRESH_COOKIE_PATH = "/api/v1/auth";

// Fallbacks used only if JWT_EXPIRES_IN / JWT_REFRESH_EXPIRES_IN are set to
// something durationToMs can't parse — the cookie still expires, it just
// uses the documented default TTL.
const DEFAULT_ACCESS_MS = 60 * 60 * 1000; // 1h
const DEFAULT_REFRESH_MS = 7 * 24 * 60 * 60 * 1000; // 7d

/**
 * Parse a jsonwebtoken/`ms`-style duration into milliseconds.
 * Supports "300ms", "45s", "30m", "1h", "7d", and a bare number (which
 * jsonwebtoken interprets as SECONDS). Returns `fallbackMs` on no match so
 * a mis-set env can never produce a `NaN` maxAge.
 */
export function durationToMs(value: string, fallbackMs: number): number {
  const m = /^(\d+)\s*(ms|s|m|h|d)?$/.exec(value.trim());
  if (!m) return fallbackMs;
  const n = Number(m[1]);
  switch (m[2]) {
    case "ms":
      return n;
    case "s":
      return n * 1000;
    case "m":
      return n * 60_000;
    case "h":
      return n * 3_600_000;
    case "d":
      return n * 86_400_000;
    default:
      return n * 1000; // bare number → seconds (jsonwebtoken semantics)
  }
}

function baseCookieOptions() {
  return {
    httpOnly: true,
    // Follow the established codebase convention (OAuth-state cookie):
    // attach Secure in production so dev-over-http still works. Prod is
    // always HTTPS, so the cookie is Secure where it matters.
    secure: env.NODE_ENV === "production",
    // SameSite=Strict is the first CSRF layer — the cookie is never
    // attached to any cross-site request, top-level navigation included.
    sameSite: "strict" as const,
  };
}

/**
 * Deposit the token pair into httpOnly cookies. No-op unless
 * AUTH_COOKIE_MODE is on, so callers can invoke it unconditionally after
 * login/register/refresh and the bearer-only mode is untouched.
 */
export function setAuthCookies(
  res: Response,
  tokens: { token: string; refreshToken: string },
): void {
  if (!env.AUTH_COOKIE_MODE) return;
  res.cookie(ACCESS_COOKIE_NAME, tokens.token, {
    ...baseCookieOptions(),
    path: ACCESS_COOKIE_PATH,
    maxAge: durationToMs(env.JWT_EXPIRES_IN, DEFAULT_ACCESS_MS),
  });
  res.cookie(REFRESH_COOKIE_NAME, tokens.refreshToken, {
    ...baseCookieOptions(),
    path: REFRESH_COOKIE_PATH,
    maxAge: durationToMs(env.JWT_REFRESH_EXPIRES_IN, DEFAULT_REFRESH_MS),
  });
}

/**
 * Evict both auth cookies. Runs UNCONDITIONALLY (even with the flag off)
 * so a logout still clears any cookie set while the flag was previously
 * on — important during a rollback. clearCookie must use the same path the
 * cookie was set with or the browser ignores it.
 */
export function clearAuthCookies(res: Response): void {
  res.clearCookie(ACCESS_COOKIE_NAME, { path: ACCESS_COOKIE_PATH });
  res.clearCookie(REFRESH_COOKIE_NAME, { path: REFRESH_COOKIE_PATH });
}

/** Hand-rolled single-cookie reader (no cookie-parser in the stack). */
export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * Access token from the auth cookie, or null when cookie-mode is off or no
 * cookie is present. Centralising the AUTH_COOKIE_MODE gate here keeps the
 * middleware free of env branching (and makes it trivially mockable).
 */
export function getCookieAccessToken(req: Request): string | null {
  if (!env.AUTH_COOKIE_MODE) return null;
  return readCookie(req, ACCESS_COOKIE_NAME);
}

/** Refresh token from the auth cookie, or null when off / absent. */
export function getCookieRefreshToken(req: Request): string | null {
  if (!env.AUTH_COOKIE_MODE) return null;
  return readCookie(req, REFRESH_COOKIE_NAME);
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
export const CSRF_HEADER = "x-requested-with";

/**
 * CSRF gate for cookie-borne auth — the SECOND layer behind SameSite=Strict.
 *
 * Returns true when the request may proceed. Safe (non-mutating) methods
 * always pass. State-changing methods must carry the custom
 * `X-Requested-With` header: a browser cannot set a custom header on a
 * simple cross-site request (form/img/beacon) without triggering a CORS
 * preflight, and our origin allowlist rejects unknown origins at preflight
 * — so a forged cross-site POST can never present it. Bearer-authed callers
 * bypass this entirely: the browser never auto-attaches an Authorization
 * header, so there is no CSRF vector to close for them.
 *
 * (The rationale is asserted, not just commented — see the CSRF cases in
 * middleware/__tests__/auth-cookie.test.ts.)
 */
export function csrfOkForCookieAuth(req: Request): boolean {
  if (SAFE_METHODS.has(req.method.toUpperCase())) return true;
  const v = req.headers[CSRF_HEADER];
  return typeof v === "string" && v.length > 0;
}
