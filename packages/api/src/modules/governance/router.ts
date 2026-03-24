/**
 * Governance Router — Faz 6
 *
 * Risk detection, safety stops, policy enforcement.
 */

import { Router } from "express";
import { authMiddleware } from "../../middleware/auth";

export const governanceRouter = Router();
governanceRouter.use(authMiddleware);

// TODO: Faz 6
// GET /api/v1/governance/risks?companyId=xxx
// GET /api/v1/governance/stops — recent risk stops
// POST /api/v1/governance/config — update governance config
