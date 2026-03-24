import { Router } from "express";
import { authMiddleware } from "../../middleware/auth";
import { prisma } from "../../lib/db";
import { logger } from "../../lib/logger";
import { AppError } from "../../middleware/error";
import { z } from "zod";

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
