/**
 * Auth Router — register and login.
 * No auth middleware on these endpoints.
 */

import { Router } from "express";
import crypto from "crypto";
import { z } from "zod";
import { register, login, getGoogleAuthUrl, googleCallback, requestPasswordReset, resetPassword } from "./auth.service";
import { validate } from "../../middleware/validate";
import { rateLimit } from "../../middleware/rateLimit";
import { redis } from "../../lib/redis";

export const authRouter = Router();

// Rate limit auth endpoints to prevent brute force
const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  maxRequests: 10,
  keyPrefix: "rl:auth",
});
const registerRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  maxRequests: 5,
  keyPrefix: "rl:register",
});

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
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
authRouter.post("/login", authRateLimit, validate(loginSchema), async (req, res, next) => {
  try {
    const result = await login(req.body);
    res.json(result);
  } catch (err) { next(err); }
});

const forgotSchema = z.object({ email: z.string().email() });
const resetSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

// POST /api/v1/auth/forgot-password
authRouter.post("/forgot-password", authRateLimit, validate(forgotSchema), async (req, res, next) => {
  try {
    await requestPasswordReset(req.body.email);
    res.json({ message: "If that email exists, a reset link has been sent." });
  } catch (err) { next(err); }
});

// POST /api/v1/auth/reset-password
authRouter.post("/reset-password", authRateLimit, validate(resetSchema), async (req, res, next) => {
  try {
    await resetPassword(req.body.token, req.body.password);
    res.json({ message: "Password reset successful." });
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
    // Redirect to frontend with token
    const redirectUrl = new URL("/auth/callback", process.env.APP_URL ?? "http://localhost:3001");
    redirectUrl.searchParams.set("token", result.token);
    res.redirect(redirectUrl.toString());
  } catch (err) { next(err); }
});
