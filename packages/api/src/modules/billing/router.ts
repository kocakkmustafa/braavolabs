/**
 * Billing Router — Faz 5
 *
 * Stripe usage metering + subscription management.
 */

import { Router } from "express";
import { authMiddleware } from "../../middleware/auth";

export const billingRouter = Router();
billingRouter.use(authMiddleware);

// TODO: Faz 5
// GET /api/v1/billing/usage — current period usage
// GET /api/v1/billing/subscription — subscription details
// POST /api/v1/billing/portal — Stripe customer portal link
