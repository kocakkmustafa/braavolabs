/**
 * CRM Router — Faz 3
 *
 * HubSpot CRM sync + contact/deal management.
 */

import { Router } from "express";
import { authMiddleware } from "../../middleware/auth";

export const crmRouter = Router();
crmRouter.use(authMiddleware);

// TODO: Faz 3
// GET /api/v1/crm/contacts?companyId=xxx
// POST /api/v1/crm/contacts
// GET /api/v1/crm/deals?companyId=xxx
// POST /api/v1/crm/sync — trigger HubSpot sync
