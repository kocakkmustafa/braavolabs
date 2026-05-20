/**
 * Auth Router — register and login.
 * No auth middleware on these endpoints.
 */

import { Router, urlencoded } from "express";
import crypto from "crypto";
import { z } from "zod";
import { register, login, getGoogleAuthUrl, googleCallback, getGitHubAuthUrl, githubCallback, requestPasswordReset, resetPassword, refreshTokens, revokeAllRefreshTokens, stashOAuthExchange, redeemOAuthExchange, appleMobileSignIn, googleMobileSignIn, githubMobileSignIn, verifyEmail, resendVerifyEmail, getAppleWebAuthUrl, appleWebCallback } from "./auth.service";
import { authMiddleware } from "../../middleware/auth";
import { validate } from "../../middleware/validate";
import { rateLimit } from "../../middleware/rateLimit";
import { redis } from "../../lib/redis";
import { env } from "../../config/env";
import { AppError } from "../../middleware/error";

export const authRouter = Router();

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
    const { refreshToken } = z.object({ refreshToken: z.string().min(1) }).parse(req.body);
    const result = await refreshTokens(refreshToken);
    res.json(result);
  } catch (err) { next(err); }
});

// POST /api/v1/auth/logout — revoke all refresh tokens for the current user
authRouter.post("/logout", authMiddleware, async (req, res, next) => {
  try {
    await revokeAllRefreshTokens(req.auth!.userId);
    res.json({ message: "Logged out successfully." });
  } catch (err) { next(err); }
});

// GET /api/v1/auth/google — redirect to Google consent screen with CSRF state
authRouter.get("/google", async (_req, res, next) => {
  try {
    const state = crypto.randomBytes(32).toString("hex");
    await redis.set(`oauth:state:${state}`, "1", "EX", 600); // 10 min TTL
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
