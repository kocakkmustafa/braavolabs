import { Router } from "express";
import { authMiddleware } from "../../middleware/auth";
import { prisma } from "../../lib/db";
import { logger } from "../../lib/logger";
import { AppError } from "../../middleware/error";
import { z } from "zod";
import {
  startBuildSession,
  continueBuildSession,
  confirmBuild,
  getSession,
} from "./builder";

export const companyRouter = Router();
companyRouter.use(authMiddleware);

const createSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/),
  description: z.string().optional(),
  primitives: z.array(z.enum([
    "ACQUISITION", "SALES", "DELIVERY", "CONTENT",
    "OPERATIONS", "FINANCE", "ANALYTICS", "MEMORY", "GOVERNANCE",
  ])).min(1),
  config: z.record(z.unknown()).optional(),
});

// GET /api/v1/companies — list companies for tenant
companyRouter.get("/", async (req, res, next) => {
  try {
    const companies = await prisma.company.findMany({
      where: { tenantId: req.auth!.tenantId },
      orderBy: { createdAt: "desc" },
    });

    await prisma.activityLog.create({
      data: {
        tenantId: req.auth!.tenantId,
        actor: req.auth!.userId,
        action: "company.list",
        resource: "company",
      },
    });

    res.json(companies);
  } catch (err) { next(err); }
});

// GET /api/v1/companies/:id
companyRouter.get("/:id", async (req, res, next) => {
  try {
    const company = await prisma.company.findFirst({
      where: { id: req.params.id, tenantId: req.auth!.tenantId },
      include: { agents: true, pipelines: true },
    });
    if (!company) throw new AppError(404, "Company not found");
    res.json(company);
  } catch (err) { next(err); }
});

// POST /api/v1/companies
companyRouter.post("/", async (req, res, next) => {
  try {
    const data = createSchema.parse(req.body);
    const company = await prisma.company.create({
      data: { ...data, tenantId: req.auth!.tenantId },
    });

    await prisma.activityLog.create({
      data: {
        tenantId: req.auth!.tenantId,
        actor: req.auth!.userId,
        action: "company.create",
        resource: "company",
        resourceId: company.id,
        details: { name: company.name, slug: company.slug },
      },
    });

    logger.info({ companyId: company.id }, "Company created");
    res.status(201).json(company);
  } catch (err) { next(err); }
});

// PATCH /api/v1/companies/:id
companyRouter.patch("/:id", async (req, res, next) => {
  try {
    const company = await prisma.company.updateMany({
      where: { id: req.params.id, tenantId: req.auth!.tenantId },
      data: req.body,
    });
    if (company.count === 0) throw new AppError(404, "Company not found");

    await prisma.activityLog.create({
      data: {
        tenantId: req.auth!.tenantId,
        actor: req.auth!.userId,
        action: "company.update",
        resource: "company",
        resourceId: req.params.id,
      },
    });

    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /api/v1/companies/:id/pause
companyRouter.post("/:id/pause", async (req, res, next) => {
  try {
    const result = await prisma.company.updateMany({
      where: { id: req.params.id, tenantId: req.auth!.tenantId, status: "ACTIVE" },
      data: { status: "PAUSED" },
    });
    if (result.count === 0) throw new AppError(404, "Company not found or not active");

    await prisma.activityLog.create({
      data: {
        tenantId: req.auth!.tenantId,
        actor: req.auth!.userId,
        action: "company.pause",
        resource: "company",
        resourceId: req.params.id,
      },
    });

    res.json({ success: true, status: "PAUSED" });
  } catch (err) { next(err); }
});

// POST /api/v1/companies/:id/resume
companyRouter.post("/:id/resume", async (req, res, next) => {
  try {
    const result = await prisma.company.updateMany({
      where: { id: req.params.id, tenantId: req.auth!.tenantId, status: "PAUSED" },
      data: { status: "ACTIVE" },
    });
    if (result.count === 0) throw new AppError(404, "Company not found or not paused");

    await prisma.activityLog.create({
      data: {
        tenantId: req.auth!.tenantId,
        actor: req.auth!.userId,
        action: "company.resume",
        resource: "company",
        resourceId: req.params.id,
      },
    });

    res.json({ success: true, status: "ACTIVE" });
  } catch (err) { next(err); }
});

// ─── COMPANY BUILDER (Freeform text → AI company) ──────

// POST /api/v1/companies/build — start building from freeform text
companyRouter.post("/build", async (req, res, next) => {
  try {
    const { description } = z
      .object({ description: z.string().min(10) })
      .parse(req.body);

    const session = await startBuildSession(req.auth!.tenantId, description);

    if (session.status === "error") {
      throw new AppError(403, "Company limit reached for your plan");
    }

    await prisma.activityLog.create({
      data: {
        tenantId: req.auth!.tenantId,
        actor: req.auth!.userId,
        action: "company.build_start",
        resource: "company",
        details: { sessionId: session.sessionId, description: description.slice(0, 200) },
      },
    });

    res.status(201).json({
      sessionId: session.sessionId,
      status: session.status,
      turn: session.turn,
      companySpec: session.companySpec,
      // Return last assistant message for the client to display
      message: session.messages[session.messages.length - 1]?.content,
    });
  } catch (err) { next(err); }
});

// POST /api/v1/companies/build/:sessionId/answer — answer clarification questions
companyRouter.post("/build/:sessionId/answer", async (req, res, next) => {
  try {
    const { answer } = z
      .object({ answer: z.string().min(1) })
      .parse(req.body);

    const session = await continueBuildSession(req.params.sessionId, answer);

    res.json({
      sessionId: session.sessionId,
      status: session.status,
      turn: session.turn,
      companySpec: session.companySpec,
      message: session.messages[session.messages.length - 1]?.content,
    });
  } catch (err) { next(err); }
});

// POST /api/v1/companies/build/:sessionId/confirm — confirm and create the company
companyRouter.post("/build/:sessionId/confirm", async (req, res, next) => {
  try {
    const session = await confirmBuild(req.params.sessionId);

    res.status(201).json({
      sessionId: session.sessionId,
      status: session.status,
      companyId: session.companyId,
      companySpec: session.companySpec,
    });
  } catch (err) { next(err); }
});

// GET /api/v1/companies/build/:sessionId — get session status
companyRouter.get("/build/:sessionId", async (req, res, next) => {
  try {
    const session = getSession(req.params.sessionId);
    if (!session) throw new AppError(404, "Build session not found");

    res.json({
      sessionId: session.sessionId,
      status: session.status,
      turn: session.turn,
      companySpec: session.companySpec,
      companyId: session.companyId,
    });
  } catch (err) { next(err); }
});
