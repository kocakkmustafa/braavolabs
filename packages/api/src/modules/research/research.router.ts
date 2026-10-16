/**
 * Web research router.
 *
 * Endpoints:
 *   POST /api/v1/research          start a session (async)
 *   POST /api/v1/research/compare  multi-model compare-and-synthesize (E2/T8)
 *   POST /api/v1/research/cascade  cheapest-capable-first cascade (Forge P1)
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
import { startCompare, startResearch } from "./research.service";
import { runTenantCascade, runTenantSelectedCascade } from "./cascade.service";
import { listCompareSelectionOptions } from "../../services/compare-options";

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
  // E2/T8: augment the final synthesis with a multi-model compare across
  // the tenant's configured providers (embedded in findings.multiModel).
  multiModel: z.boolean().optional(),
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
      multiModel: body.multiModel,
    });
    res.status(201).json({ id: sessionId, status: "PENDING" });
  } catch (err) { next(err); }
});

// ── Multi-model compare-and-synthesize (E2/T8 — plan §2.5) ──
//
// Runs ONE task on ≤3 of the tenant's OWN configured providers in
// parallel, then the tenant-default provider synthesizes (consensus +
// disagreements + final answer). Async like POST /: returns a session id,
// poll GET /research/:id — the result lands in findings.multiModel.
// Costs up to 4 LLM calls per request → same 20/hour ceiling, own bucket.
const compareLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  maxRequests: 20,
  keyPrefix: "rl:research:compare",
});

const compareSchema = z.object({
  selections: z.array(z.object({
    provider: z.string().min(1), model: z.string().min(1),
    reasoningEffort: z.enum(["low", "medium", "high"]).optional(),
  }).strict()).min(1).max(3).optional(),
  companyId: z.string().min(1),
  query: z.string().min(5).max(1000),
  maxCandidates: z.number().int().min(1).max(3).optional(),
  maxTokensPerCandidate: z.number().int().min(256).max(8192).optional(),
  maxCostUsd: z.number().min(0.1).max(10).optional(),
  // Optional debate rounds (0 = classic compare). Budget-gated server-side.
  debateRounds: z.number().int().min(0).max(3).optional(),
}).strict();

const compareOptionsQuery = z.object({ companyId: z.string().min(1) }).strict();

researchRouter.get("/compare/options", async (req, res, next) => {
  try {
    const { companyId } = compareOptionsQuery.parse(req.query);
    const company = await prisma.company.findFirst({
      where: { id: companyId, tenantId: req.auth!.tenantId },
    });
    if (!company) throw new AppError(404, "Company not found");
    const selections = await listCompareSelectionOptions(req.auth!.tenantId);
    res.set("Cache-Control", "private, no-store");
    res.json({ companyId, maxCandidates: 3, selections });
  } catch (err) { next(err); }
});

researchRouter.post(["/compare", "/compare/selected"], compareLimiter, async (req, res, next) => {
  try {
    const body = compareSchema.parse(req.body);
    if (req.path === "/compare/selected" && body.selections === undefined) throw new AppError(400, "Explicit model selections required");
    const company = await prisma.company.findFirst({
      where: { id: body.companyId, tenantId: req.auth!.tenantId },
    });
    if (!company) throw new AppError(404, "Company not found");
    const { sessionId } = await startCompare({
      tenantId: req.auth!.tenantId,
      companyId: body.companyId,
      query: body.query,
      selections: body.selections,
      maxCandidates: body.maxCandidates,
      maxTokensPerCandidate: body.maxTokensPerCandidate,
      maxCostUsd: body.maxCostUsd,
      debateRounds: body.debateRounds,
    });
    res.status(201).json({ id: sessionId, status: "PENDING" });
  } catch (err) { next(err); }
});

// ── Cascade: cheapest-capable-first, escalate-on-low-confidence (Forge P1) ──
//
// Runs `prompt` on the tenant's cheapest configured provider first;
// escalates to a costlier tenant-configured provider only when the
// answer's (heuristic) confidence is below threshold. Synchronous —
// bounded by the tenant's own provider count (small, no polling needed
// unlike the async research/compare sessions above). Candidates are the
// tenant's OWN BYOK rows only (cascade.service.ts#runTenantCascade).
const cascadeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  maxRequests: 20,
  keyPrefix: "rl:research:cascade",
});

const cascadeSchema = z.object({
  prompt: z.string().min(1).max(4000),
  confidenceThreshold: z.number().min(0).max(1).optional(),
  secondOpinion: z.boolean().optional(),
  budgetUsdCap: z.number().min(0).max(10).optional(),
});

researchRouter.post("/cascade", cascadeLimiter, async (req, res, next) => {
  try {
    const body = cascadeSchema.parse(req.body);
    const result = await runTenantCascade(req.auth!.tenantId, body.prompt, {
      confidenceThreshold: body.confidenceThreshold,
      secondOpinion: body.secondOpinion,
      budgetUsdCap: body.budgetUsdCap,
    });
    res.status(200).json(result);
  } catch (err) { next(err); }
});

// Additive paths: an older server returns 404 instead of stripping a selection
// from a legacy cascade request and silently running its automatic model.
researchRouter.get("/cascade/options", async (req, res, next) => {
  try {
    const selections = await listCompareSelectionOptions(req.auth!.tenantId);
    res.set("Cache-Control", "private, no-store");
    res.json({ selectionContract: "exact-single-v1", selections });
  } catch (err) { next(err); }
});

const selectedCascadeSchema = cascadeSchema.extend({
  selection: z.object({
    provider: z.string().min(1),
    model: z.string().min(1),
    reasoningEffort: z.enum(["low", "medium", "high"]).optional(),
  }).strict(),
  secondOpinion: z.literal(false).optional(),
}).strict();

researchRouter.post("/cascade/selected", cascadeLimiter, async (req, res, next) => {
  try {
    const body = selectedCascadeSchema.parse(req.body);
    const result = await runTenantSelectedCascade(req.auth!.tenantId, body.prompt, body.selection, {
      confidenceThreshold: body.confidenceThreshold,
      secondOpinion: body.secondOpinion,
      budgetUsdCap: body.budgetUsdCap,
    });
    res.status(200).json(result);
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
