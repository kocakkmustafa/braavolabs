/**
 * Auth Router — register and login.
 * No auth middleware on these endpoints.
 */

import { Router } from "express";
import crypto from "crypto";
import { z } from "zod";
import { register, login, getGoogleAuthUrl, googleCallback, requestPasswordReset, resetPassword, refreshTokens, revokeAllRefreshTokens } from "./auth.service";
import { authMiddleware } from "../../middleware/auth";
import { validate } from "../../middleware/validate";
import { rateLimit } from "../../middleware/rateLimit";
import { redis } from "../../lib/redis";
import { env } from "../../config/env";

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
const loginRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  maxRequests: 30,
  keyPrefix: "rl:auth:login",
});
const forgotRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  maxRequests: 30,
  keyPrefix: "rl:auth:forgot",
});
const resetRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  maxRequests: 30,
  keyPrefix: "rl:auth:reset",
});
const registerRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  maxRequests: 10,
  keyPrefix: "rl:register",
});

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).regex(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/, "Password must contain uppercase, lowercase, and a number"),
  name: z.string().min(1),
  tenantName: z.string().min(1),
  ref: z.string().optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
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

const forgotSchema = z.object({ email: z.string().email() });
const resetSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8).regex(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/, "Password must contain uppercase, lowercase, and a number"),
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
    // Redirect to frontend with token. APP_URL is validated at boot
    // (https:// in prod, no localhost fallback) — using env.APP_URL here
    // closes the open-redirect surface a missing/typo'd env var would
    // otherwise create.
    const redirectUrl = new URL("/auth/callback", env.APP_URL);
    redirectUrl.searchParams.set("token", result.token);
    redirectUrl.searchParams.set("refreshToken", result.refreshToken);
    res.redirect(redirectUrl.toString());
  } catch (err) { next(err); }
});
