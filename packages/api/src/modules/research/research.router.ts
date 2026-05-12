/**
 * Web research router.
 *
 * Endpoints:
 *   POST /api/v1/research          start a session (async)
 *   GET  /api/v1/research          list sessions for the tenant
 *   GET  /api/v1/research/:id      session detail + sources
 *   POST /api/v1/research/:id/cancel
 */

import { Router } from "express";
import { z } from "zod";
import { authMiddleware } from "../../middleware/auth";
import { rateLimit } from "../../middleware/rateLimit";
import { prisma } from "../../lib/db";
import { AppError } from "../../middleware/error";
import { startResearch } from "./research.service";

export const researchRouter = Router();
researchRouter.use(authMiddleware);

// Each session costs $0.10-$1.00 depending on rounds + provider; cap
// at 20 sessions/hour/tenant so a bug in a pipeline can't burn the
// search-API budget.
const startLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  maxRequests: 20,
  keyPrefix: "rl:research:start",
});

const startSchema = z.object({
  companyId: z.string().min(1),
  query: z.string().min(5).max(1000),
  maxRounds: z.number().int().min(1).max(6).optional(),
  maxSources: z.number().int().min(5).max(40).optional(),
  maxCostUsd: z.number().min(0.1).max(10).optional(),
});

researchRouter.post("/", startLimiter, async (req, res, next) => {
  try {
    const body = startSchema.parse(req.body);
    const company = await prisma.company.findFirst({
      where: { id: body.companyId, tenantId: req.auth!.tenantId },
    });
    if (!company) throw new AppError(404, "Company not found");
    const { sessionId } = await startResearch({
      tenantId: req.auth!.tenantId,
      companyId: body.companyId,
      query: body.query,
      maxRounds: body.maxRounds,
      maxSources: body.maxSources,
      maxCostUsd: body.maxCostUsd,
    });
    res.status(201).json({ id: sessionId, status: "PENDING" });
  } catch (err) { next(err); }
});

researchRouter.get("/", async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 30, 100);
    const sessions = await prisma.webResearchSession.findMany({
      where: { tenantId: req.auth!.tenantId },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: {
        id: true,
        companyId: true,
        query: true,
        status: true,
        costUsd: true,
        startedAt: true,
        completedAt: true,
        createdAt: true,
      },
    });
    res.json(sessions);
  } catch (err) { next(err); }
});

researchRouter.get("/:id", async (req, res, next) => {
  try {
    const session = await prisma.webResearchSession.findFirst({
      where: { id: req.params.id, tenantId: req.auth!.tenantId },
      include: {
        sources: {
          orderBy: { fetchedAt: "asc" },
          select: {
            id: true,
            url: true,
            title: true,
            relevance: true,
            fetchedAt: true,
            // Truncate content for the list view; full text via a
            // dedicated /sources/:id endpoint if we add one later.
            content: false,
          },
        },
      },
    });
    if (!session) throw new AppError(404, "Research session not found");
    res.json(session);
  } catch (err) { next(err); }
});

researchRouter.post("/:id/cancel", async (req, res, next) => {
  try {
    const session = await prisma.webResearchSession.findFirst({
      where: { id: req.params.id, tenantId: req.auth!.tenantId },
    });
    if (!session) throw new AppError(404, "Research session not found");
    if (session.status === "COMPLETED" || session.status === "FAILED") {
      res.json({ success: true, status: session.status });
      return;
    }
    // Soft-cancel: the loop polls status before each round. The next
    // round will see CANCELLED and bail out before the next search.
    const updated = await prisma.webResearchSession.update({
      where: { id: session.id },
      data: { status: "CANCELLED", completedAt: new Date() },
    });
    res.json({ success: true, status: updated.status });
  } catch (err) { next(err); }
});
