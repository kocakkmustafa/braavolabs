/**
 * Auth Router — register and login.
 * No auth middleware on these endpoints.
 */

import { Router } from "express";
import { z } from "zod";
import { register, login } from "./auth.service";
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
