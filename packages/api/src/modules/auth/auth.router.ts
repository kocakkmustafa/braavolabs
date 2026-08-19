/**
 * Auth Router — register and login.
 * No auth middleware on these endpoints.
 */

import { Router, urlencoded } from "express";
import type { Request, Response } from "express";
import crypto from "crypto";
import { z } from "zod";
import jwt from "jsonwebtoken";
import { register, login, getGoogleAuthUrl, googleCallback, getGitHubAuthUrl, githubCallback, requestPasswordReset, resetPassword, refreshTokens, revokeAllRefreshTokens, userIdFromRefreshToken, stashOAuthExchange, redeemOAuthExchange, appleMobileSignIn, googleMobileSignIn, githubMobileSignIn, verifyEmail, resendVerifyEmail, getAppleWebAuthUrl, appleWebCallback } from "./auth.service";
import { authMiddleware } from "../../middleware/auth";
import { systemScope } from "../../middleware/system-scope";
import { setAuthCookies, clearAuthCookies, getCookieAccessToken, getCookieRefreshToken, csrfOkForCookieAuth } from "../../lib/authCookies";
import { validate } from "../../middleware/validate";
import { rateLimit } from "../../middleware/rateLimit";
import { redis } from "../../lib/redis";
import { env } from "../../config/env";
import { AppError } from "../../middleware/error";

export const authRouter = Router();
// BR-P0-004: register/login/refresh/reset/OAuth-callback all run before a
// session exists. Mounted router-wide and BEFORE any per-route authMiddleware:
// the one gated route here (/verify-email/resend) then binds its tenant INSIDE
// this scope, which is the permitted nesting direction.
authRouter.use(systemScope("route:auth"));

// Rate limit auth endpoints. Tuned for shared NAT / corporate WiFi where
// many users share one egress IP — at 10 req / 15 min the previous limit
// blocked legitimate users after one teammate fat-fingered a password.
// Account-level lockout (5 fails / 15 min on the email+ip key, see
// auth.service.login) remains the primary brute-force defense; this IP
// limit is now a much looser DDoS shield.
//
// Per-endpoint keyPrefix (MED-4 fix) — the previous shared `rl:auth`
// bucket meant a brute-forced user couldn't legitimately request a
// password-reset link during their own brute-force window, since both
// flows decremented the same counter. Now each endpoint has its own
// quota.
// Tighter per-IP limits than the earlier 30/15-min budgets — the
// account-lockout (5 fails / 15-min / email+ip key, see auth.service.login)
// already absorbs slow brute force against valid emails; this IP-level
// gate is the DDoS / enumeration shield on /login, /register, /forgot,
// /reset. 10/15-min/IP is comfortably above a human user's worst day
// (a single fat-fingered password retried 3-4 times) and two orders of
// magnitude below what a serious attacker would need.
const loginRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  maxRequests: 10,
  keyPrefix: "rl:auth:login",
});
const forgotRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  maxRequests: 10,
  keyPrefix: "rl:auth:forgot",
});
const resetRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  maxRequests: 10,
  keyPrefix: "rl:auth:reset",
});
const registerRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  maxRequests: 5,
  keyPrefix: "rl:register",
});

// ─── OAuth state browser binding (double-submit cookie) ─────────────
//
// The Redis `oauth:state:*` key proves a state value was ISSUED BY US
// and is single-use — but it's global: any browser presenting any
// outstanding state passes. That leaves a login-CSRF / session-fixation
// hole: an attacker who starts a flow themselves can splice their fresh
// `state` (+ their own OAuth code) into a victim's browser and silently
// log the victim into the attacker's account.
//
// Fix: at authorize time we ALSO drop the state into an httpOnly cookie
// on the API origin; the callback requires the cookie to match the
// `state` query param. The cookie can only exist in the browser that
// called the authorize endpoint, so the flow is bound to one user agent.
//
// SameSite notes:
//  - Google/GitHub return via top-level GET redirect → `Lax` is sent.
//  - Apple returns via cross-site form POST (`response_mode=form_post`)
//    → Lax cookies are NOT attached to cross-site POSTs, so Apple's
//    cookie must be `None` (+ Secure — Apple web auth requires HTTPS
//    anyway, so the dev-mode loss is theoretical).
// The UI fetches the authorize endpoints with `credentials: "include"`;
// app and API are same-site (*.braavolabs.com), so browsers accept the
// cookie. Mobile clients use the /auth/*/mobile endpoints and are
// unaffected.
const OAUTH_STATE_COOKIE_PREFIX = "bv_oauth_state_";
// Scope to the auth router so the cookie never rides along on other
// API requests. Must match the mount path in index.ts (`/api/v1/auth`).
const OAUTH_STATE_COOKIE_PATH = "/api/v1/auth";

type OAuthProvider = "google" | "github" | "apple";

function setOAuthStateCookie(res: Response, provider: OAuthProvider, state: string): void {
  res.cookie(`${OAUTH_STATE_COOKIE_PREFIX}${provider}`, state, {
    httpOnly: true,
    secure: env.NODE_ENV === "production" || provider === "apple",
    sameSite: provider === "apple" ? "none" : "lax",
    maxAge: 10 * 60 * 1000, // matches the Redis state TTL
    path: OAUTH_STATE_COOKIE_PATH,
  });
}

function readCookie(req: Request, name: string): string | null {
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
 * One-time read + verify of the state cookie. Always clears the cookie
 * (success or failure) so a state value can never be replayed from the
 * cookie jar. Returns true only when the cookie exists and matches the
 * `state` the provider echoed back.
 */
function consumeOAuthStateCookie(
  req: Request,
  res: Response,
  provider: OAuthProvider,
  state: string,
): boolean {
  const name = `${OAUTH_STATE_COOKIE_PREFIX}${provider}`;
  const cookieState = readCookie(req, name);
  res.clearCookie(name, { path: OAUTH_STATE_COOKIE_PATH });
  if (!cookieState || cookieState.length !== state.length) return false;
  return crypto.timingSafeEqual(Buffer.from(cookieState), Buffer.from(state));
}

// Exported so __tests__/auth.test.ts can validate them in isolation.
// Anything that lands in the production form/router contract belongs in
// a schema test — drift between client + server validation is the most
// common cause of "Validation failed" noise reaching the user.
// Length caps prevent payload-amplification DoS via bcrypt — a 1 MB password
// monopolises a Node thread for seconds. RFC 5321 caps email at 254 chars;
// 128 is well above any real password yet far below the DoS threshold.
export const registerSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(8).max(128).regex(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/, "Password must contain uppercase, lowercase, and a number"),
  name: z.string().min(1).max(200),
  tenantName: z.string().min(1).max(100),
  ref: z.string().max(64).optional(),
});

export const loginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(128),
});


// POST /api/v1/auth/register
authRouter.post("/register", registerRateLimit, validate(registerSchema), async (req, res, next) => {
  try {
    const result = await register(req.body);
    // Dual-mode: also mint httpOnly auth cookies (no-op unless the flag is
    // on). Response body is unchanged, so existing/mobile clients that read
    // the JSON token bundle keep working.
    setAuthCookies(res, result);
    res.status(201).json(result);
  } catch (err) { next(err); }
});

// POST /api/v1/auth/login
authRouter.post("/login", loginRateLimit, validate(loginSchema), async (req, res, next) => {
  try {
    // Pass requesting IP into login() so the lockout key is composite —
    // an attacker bombarding /login with bad passwords can only lock out
    // their own (email,ip) pair, not arbitrary users.
    const result = await login(req.body, req.ip);
    // Dual-mode cookies — no-op unless AUTH_COOKIE_MODE is on; body unchanged.
    setAuthCookies(res, result);
    res.json(result);
  } catch (err) { next(err); }
});

export const forgotSchema = z.object({ email: z.string().email().max(254) });
export const resetSchema = z.object({
  token: z.string().min(1).max(256),
  password: z.string().min(8).max(128).regex(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/, "Password must contain uppercase, lowercase, and a number"),
});

// POST /api/v1/auth/forgot-password
authRouter.post("/forgot-password", forgotRateLimit, validate(forgotSchema), async (req, res, next) => {
  try {
    await requestPasswordReset(req.body.email);
    res.json({ message: "If that email exists, a reset link has been sent." });
  } catch (err) { next(err); }
});

// POST /api/v1/auth/reset-password
authRouter.post("/reset-password", resetRateLimit, validate(resetSchema), async (req, res, next) => {
  try {
    await resetPassword(req.body.token, req.body.password);
    res.json({ message: "Password reset successful." });
  } catch (err) { next(err); }
});

// Rate limit refresh endpoint to prevent token abuse
const refreshRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  maxRequests: 30,
  keyPrefix: "rl:refresh",
});

// POST /api/v1/auth/refresh — exchange refresh token for new access + refresh tokens
authRouter.post("/refresh", refreshRateLimit, async (req, res, next) => {
  try {
    // Body token keeps PRIORITY (current clients POST { refreshToken }).
    // Only when the body omits it do we fall back to the httpOnly refresh
    // cookie — and since that cookie is browser-auto-attached, a cookie-
    // sourced refresh is a state-changing request that must clear the CSRF
    // gate. getCookieRefreshToken returns null when the flag is off, so the
    // strict-parse path below is byte-for-byte the previous behavior.
    const bodyToken =
      typeof req.body?.refreshToken === "string" ? req.body.refreshToken : undefined;
    let refreshToken = bodyToken;
    if (!refreshToken) {
      const cookieToken = getCookieRefreshToken(req);
      if (cookieToken) {
        if (!csrfOkForCookieAuth(req)) {
          res.status(403).json({ error: "Missing CSRF header for cookie-based auth" });
          return;
        }
        refreshToken = cookieToken;
      }
    }
    if (!refreshToken) {
      // Unchanged contract when there is neither a body token nor a cookie:
      // strict zod validation → ZodError → 400 (kept identical for tests).
      refreshToken = z.object({ refreshToken: z.string().min(1) }).parse(req.body).refreshToken;
    }
    const result = await refreshTokens(refreshToken);
    // Rotate the cookies too (no-op unless the flag is on).
    setAuthCookies(res, result);
    res.json(result);
  } catch (err) { next(err); }
});

// Rate limit logout — it is auth-OPTIONAL (below), so unlike the old
// authMiddleware-gated version it can be reached without a valid access token.
// 30/15-min/IP is generous for real sign-outs and a DDoS shield on the
// (cheap, Redis-only) revoke path.
const logoutRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  maxRequests: 30,
  keyPrefix: "rl:auth:logout",
});

// POST /api/v1/auth/logout — revoke ALL refresh tokens for the user.
//
// Auth-OPTIONAL by design (audit #1 / the original C3 hole). A valid access
// token identifies the user, BUT a user whose short-lived access token has
// EXPIRED (idle app, a very common sign-out state) must still be able to
// revoke — otherwise sign-out clears only local state and leaves the 7-day
// refresh token valid server-side, which is exactly C3. So we fall back to
// identifying the user from a cryptographically-verified refresh token (body
// keeps priority, then the httpOnly cookie).
//
// Safe to expose without authMiddleware: both paths verify against JWT_SECRET
// before revoking, so this adds no forge/oracle surface beyond POST
// /auth/refresh (already public). A forged/absent token yields userId=null → a
// harmless no-op, and the 200 response is byte-identical whether or not
// anything was revoked, so the endpoint is not a token-validity oracle. A
// cookie-sourced token (browser-auto-attached) must clear the CSRF gate, matching
// the /auth/refresh contract — without it, logout would be CSRF-able once
// AUTH_COOKIE_MODE is enabled.
authRouter.post("/logout", logoutRateLimit, async (req, res, next) => {
  try {
    let userId: string | null = null;

    // 1) Access token — Bearer header first, then the httpOnly access cookie
    //    (null unless AUTH_COOKIE_MODE is on). Verify-only; never 401 here.
    const header = req.headers.authorization;
    if (header?.startsWith("Bearer ")) {
      try {
        const p = jwt.verify(header.slice(7), env.JWT_SECRET, { algorithms: ["HS256"] }) as { userId?: string; typ?: string };
        // A refresh token in the bearer slot must NOT resolve here (typ guard,
        // mirrors authMiddleware) — it falls through to the refresh path below.
        if (p.typ !== "refresh") userId = p.userId ?? null;
      } catch { /* expired/invalid access token — fall through to the refresh path */ }
    } else {
      const cookieAccess = getCookieAccessToken(req);
      if (cookieAccess) {
        if (!csrfOkForCookieAuth(req)) {
          res.status(403).json({ error: "Missing CSRF header for cookie-based auth" });
          return;
        }
        try {
          const p = jwt.verify(cookieAccess, env.JWT_SECRET, { algorithms: ["HS256"] }) as { userId?: string; typ?: string };
          if (p.typ !== "refresh") userId = p.userId ?? null;
        } catch { /* fall through to the refresh path */ }
      }
    }

    // 2) Refresh token fallback — body keeps priority; a cookie-sourced token
    //    requires the CSRF header.
    if (!userId) {
      const bodyToken = typeof req.body?.refreshToken === "string" ? req.body.refreshToken : undefined;
      let refreshToken = bodyToken;
      if (!refreshToken) {
        const cookieRefresh = getCookieRefreshToken(req);
        if (cookieRefresh) {
          if (!csrfOkForCookieAuth(req)) {
            res.status(403).json({ error: "Missing CSRF header for cookie-based auth" });
            return;
          }
          refreshToken = cookieRefresh;
        }
      }
      if (refreshToken) userId = userIdFromRefreshToken(refreshToken);
    }

    // 3) Revoke everything for the resolved user (no-op if unresolved). Always
    //    clear cookies + 200 — idempotent, and identical for valid/invalid so
    //    the endpoint cannot be used as a token-validity oracle.
    if (userId) await revokeAllRefreshTokens(userId);
    clearAuthCookies(res);
    res.json({ message: "Logged out successfully." });
  } catch (err) { next(err); }
});

// GET /api/v1/auth/google — redirect to Google consent screen with CSRF state
authRouter.get("/google", async (_req, res, next) => {
  try {
    const state = crypto.randomBytes(32).toString("hex");
    await redis.set(`oauth:state:${state}`, "1", "EX", 600); // 10 min TTL
    setOAuthStateCookie(res, "google", state); // bind flow to this browser
    const url = getGoogleAuthUrl(state);
    res.json({ url, state });
  } catch (err) { next(err); }
});

// GET /api/v1/auth/google/callback — handle Google OAuth callback
const googleCallbackSchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
  ref: z.string().optional(),
});

authRouter.get("/google/callback", async (req, res, next) => {
  try {
    const { code, state, ref } = googleCallbackSchema.parse(req.query);

    // Validate OAuth state to prevent CSRF
    const stateKey = `oauth:state:${state}`;
    const stateValid = await redis.get(stateKey);
    if (!stateValid) {
      res.status(400).json({ error: "Invalid or expired OAuth state" });
      return;
    }
    await redis.del(stateKey); // One-time use

    // Double-submit: the state must come back from the SAME browser
    // that initiated the flow (see cookie helpers above). Redis alone
    // only proves we issued the state, not who we issued it to.
    if (!consumeOAuthStateCookie(req, res, "google", state)) {
      res.status(400).json({ error: "Invalid or expired OAuth state" });
      return;
    }

    const result = await googleCallback(code, ref);
    // Stash the token bundle behind a single-use exchange code so the
    // bearer + refresh tokens never appear in the redirect URL (which
    // would leak them to browser history, server access logs, and
    // Referer headers). The SPA calls POST /auth/oauth/exchange with
    // the code to retrieve the bundle once, in-page.
    const exchangeCode = await stashOAuthExchange(result);
    const redirectUrl = new URL("/auth/callback", env.APP_URL);
    redirectUrl.searchParams.set("code", exchangeCode);
    res.redirect(redirectUrl.toString());
  } catch (err) { next(err); }
});

// GET /api/v1/auth/github — redirect to GitHub consent with CSRF state
authRouter.get("/github", async (_req, res, next) => {
  try {
    const state = crypto.randomBytes(32).toString("hex");
    await redis.set(`oauth:state:${state}`, "1", "EX", 600);
    setOAuthStateCookie(res, "github", state); // bind flow to this browser
    const url = getGitHubAuthUrl(state);
    res.json({ url, state });
  } catch (err) { next(err); }
});

// GET /api/v1/auth/github/callback — handle GitHub OAuth callback
const githubCallbackSchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
  ref: z.string().optional(),
});

authRouter.get("/github/callback", async (req, res, next) => {
  try {
    const { code, state, ref } = githubCallbackSchema.parse(req.query);
    const stateKey = `oauth:state:${state}`;
    const stateValid = await redis.get(stateKey);
    if (!stateValid) {
      res.status(400).json({ error: "Invalid or expired OAuth state" });
      return;
    }
    await redis.del(stateKey);

    // Double-submit browser binding — same rationale as Google above.
    if (!consumeOAuthStateCookie(req, res, "github", state)) {
      res.status(400).json({ error: "Invalid or expired OAuth state" });
      return;
    }

    const result = await githubCallback(code, ref);
    const exchangeCode = await stashOAuthExchange(result);
    const redirectUrl = new URL("/auth/callback", env.APP_URL);
    redirectUrl.searchParams.set("code", exchangeCode);
    res.redirect(redirectUrl.toString());
  } catch (err) { next(err); }
});

// POST /api/v1/auth/oauth/exchange — redeem the one-time code emitted by
// the OAuth callback for the underlying token bundle. Same rate-limit
// budget as /auth/refresh because both endpoints mint long-lived
// refresh tokens.
authRouter.post("/oauth/exchange", refreshRateLimit, async (req, res, next) => {
  try {
    const { code } = z.object({ code: z.string().min(1).max(128) }).parse(req.body);
    const bundle = await redeemOAuthExchange(code);
    res.json(bundle);
  } catch (err) { next(err); }
});

// ─── Mobile OAuth ───────────────────────────────────────────────────
//
// Three POST endpoints used by the iOS/Android app. Same rate-limit
// bucket as /auth/login because they all issue the same kind of
// session and would be the attractive surface for a credential-stuffing
// or token-replay attack.

const appleMobileSchema = z.object({
  identityToken: z.string().min(20).max(8192),
  fullName: z.string().max(120).optional().nullable(),
});
authRouter.post(
  "/apple/mobile",
  loginRateLimit,
  validate(appleMobileSchema),
  async (req, res, next) => {
    try {
      const { identityToken, fullName } = appleMobileSchema.parse(req.body);
      const result = await appleMobileSignIn(identityToken, fullName ?? null);
      res.json(result);
    } catch (err) { next(err); }
  },
);

const googleMobileSchema = z.object({
  idToken: z.string().min(20).max(8192),
});
authRouter.post(
  "/google/mobile",
  loginRateLimit,
  validate(googleMobileSchema),
  async (req, res, next) => {
    try {
      const { idToken } = googleMobileSchema.parse(req.body);
      const result = await googleMobileSignIn(idToken);
      res.json(result);
    } catch (err) { next(err); }
  },
);

const githubMobileSchema = z.object({
  code: z.string().min(1).max(512),
  redirectUri: z.string().min(1).max(256),
});
authRouter.post(
  "/github/mobile",
  loginRateLimit,
  validate(githubMobileSchema),
  async (req, res, next) => {
    try {
      const { code, redirectUri } = githubMobileSchema.parse(req.body);
      const result = await githubMobileSignIn(code, redirectUri);
      res.json(result);
    } catch (err) { next(err); }
  },
);

// ─── Email verification ─────────────────────────────────────────────
//
// GET  /api/v1/auth/verify-email?token=...  → redeems token, redirects
//                                              to APP_URL with a flag
// POST /api/v1/auth/verify-email/resend     → re-sends to logged-in user
//
// The GET endpoint is single-click from any email client (no JS), and
// always redirects so the user lands on a friendly page. Errors are
// passed as `?status=invalid` or `?status=expired` so the front-end
// can render a localised message.

authRouter.get("/verify-email", async (req, res, next) => {
  try {
    const token = z.string().min(16).max(256).parse(req.query.token);
    const { email } = await verifyEmail(token);
    const url = new URL("/auth/verified", env.APP_URL);
    url.searchParams.set("status", "ok");
    url.searchParams.set("email", email);
    res.redirect(url.toString());
  } catch (err) {
    const url = new URL("/auth/verified", env.APP_URL);
    url.searchParams.set(
      "status",
      err instanceof AppError && err.statusCode === 400 ? "invalid" : "error",
    );
    res.redirect(url.toString());
  }
});

authRouter.post(
  "/verify-email/resend",
  refreshRateLimit, // Same bucket as refresh — both issue emails / tokens
  authMiddleware,
  async (req, res, next) => {
    try {
      await resendVerifyEmail(req.auth!.userId);
      // Always 200 — never reveal whether the account is already
      // verified, which would leak account state to an attacker.
      res.json({ message: "If your email is unverified, a fresh link has been sent." });
    } catch (err) { next(err); }
  },
);

// ─── Web Sign In with Apple ─────────────────────────────────────────
//
// Two-step flow (like /auth/google + /auth/github above):
//   1. GET  /auth/apple           — return Apple authorize URL + state
//   2. POST /auth/apple/callback  — Apple POSTs id_token back (form_post)
//
// Apple's `response_mode=form_post` means we need `urlencoded` body
// parsing on the callback route specifically; the global JSON parser
// won't read it.

// GET /api/v1/auth/apple — issue OAuth state, return Apple authorize URL
authRouter.get("/apple", async (_req, res, next) => {
  try {
    const state = crypto.randomBytes(32).toString("hex");
    await redis.set(`oauth:state:${state}`, "1", "EX", 600);
    // SameSite=None + Secure — Apple's form_post callback is a
    // cross-site POST, which never carries Lax cookies.
    setOAuthStateCookie(res, "apple", state);
    const url = getAppleWebAuthUrl(state);
    res.json({ url, state });
  } catch (err) { next(err); }
});

// POST /api/v1/auth/apple/callback — Apple POSTs back here with form data.
// Mounted with a dedicated urlencoded parser because the global stack
// only parses JSON for /api/* routes.
authRouter.post(
  "/apple/callback",
  urlencoded({ extended: false }),
  async (req, res, next) => {
    try {
      const schema = z.object({
        id_token: z.string().min(20).max(8192),
        state: z.string().min(1),
        // `user` is only present on the FIRST sign-in. JSON-stringified
        // by Apple: `{"name":{"firstName":"...","lastName":"..."},"email":"..."}`
        user: z.string().optional(),
        // `code` is also delivered but we don't use it — we verify the
        // id_token directly against Apple's JWKS.
        code: z.string().optional(),
        // Apple sometimes appends an `error` query param instead of a
        // success payload (e.g. user cancelled on consent screen).
        error: z.string().optional(),
      });
      const body = schema.parse(req.body);

      if (body.error) {
        // Redirect to login with an error flag so the SPA shows a banner.
        const url = new URL("/login", env.APP_URL);
        url.searchParams.set("oauth_error", body.error);
        res.redirect(url.toString());
        return;
      }

      // CSRF — same one-time state token machinery as Google/GitHub.
      const stateKey = `oauth:state:${body.state}`;
      const stateValid = await redis.get(stateKey);
      if (!stateValid) {
        res.status(400).json({ error: "Invalid or expired OAuth state" });
        return;
      }
      await redis.del(stateKey);

      // Double-submit browser binding (None+Secure cookie — Apple POSTs
      // cross-site, so Lax would never arrive; see helpers above).
      if (!consumeOAuthStateCookie(req, res, "apple", body.state)) {
        res.status(400).json({ error: "Invalid or expired OAuth state" });
        return;
      }

      const result = await appleWebCallback(body.id_token, body.user ?? null);

      // Stash + redirect (same as Google/GitHub web flow) — the bearer
      // + refresh tokens never appear in the redirect URL.
      const exchangeCode = await stashOAuthExchange(result);
      const redirectUrl = new URL("/auth/callback", env.APP_URL);
      redirectUrl.searchParams.set("code", exchangeCode);
      res.redirect(redirectUrl.toString());
    } catch (err) { next(err); }
  },
);
