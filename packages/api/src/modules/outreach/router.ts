/**
 * Outreach Router — Faz 3
 *
 * Endpoints for managing outreach sequences and enrollments.
 * Will handle email, LinkedIn, Twitter sequences.
 */

import { Router } from "express";
import { authMiddleware } from "../../middleware/auth";

export const outreachRouter = Router();
outreachRouter.use(authMiddleware);

// TODO: Faz 3
// GET /api/v1/outreach/sequences?companyId=xxx
// POST /api/v1/outreach/sequences
// POST /api/v1/outreach/sequences/:id/enroll
// GET /api/v1/outreach/enrollments?sequenceId=xxx
