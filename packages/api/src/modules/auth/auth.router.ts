/**
 * Auth Router — register and login.
 * No auth middleware on these endpoints.
 */

import { Router } from "express";
import { z } from "zod";
import { register, login, getGoogleAuthUrl, googleCallback } from "./auth.service";
import { validate } from "../../middleware/validate";

export const authRouter = Router();

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  name: z.string().min(1),
  tenantName: z.string().min(1),
  ref: z.string().optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// POST /api/v1/auth/register
authRouter.post("/register", validate(registerSchema), async (req, res, next) => {
  try {
    const result = await register(req.body);
    res.status(201).json(result);
  } catch (err) { next(err); }
});

// POST /api/v1/auth/login
authRouter.post("/login", validate(loginSchema), async (req, res, next) => {
  try {
    const result = await login(req.body);
    res.json(result);
  } catch (err) { next(err); }
});

// GET /api/v1/auth/google — redirect to Google consent screen
authRouter.get("/google", (_req, res, next) => {
  try {
    const url = getGoogleAuthUrl();
    res.json({ url });
  } catch (err) { next(err); }
});

// GET /api/v1/auth/google/callback — handle Google OAuth callback
const googleCallbackSchema = z.object({
  code: z.string().min(1),
  ref: z.string().optional(),
});

authRouter.get("/google/callback", async (req, res, next) => {
  try {
    const { code, ref } = googleCallbackSchema.parse(req.query);
    const result = await googleCallback(code, ref);
    // Redirect to frontend with token
    const redirectUrl = new URL("/auth/callback", process.env.APP_URL ?? "http://localhost:3000");
    redirectUrl.searchParams.set("token", result.token);
    res.redirect(redirectUrl.toString());
  } catch (err) { next(err); }
});
