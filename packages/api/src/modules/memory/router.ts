import { Router } from "express";
import { authMiddleware } from "../../middleware/auth";
import { prisma } from "../../lib/db";
import { AppError } from "../../middleware/error";
import { z } from "zod";

export const memoryRouter = Router();
memoryRouter.use(authMiddleware);

const searchSchema = z.object({
  companyId: z.string(),
  query: z.string().min(1),
  type: z.enum(["EPISODIC", "SEMANTIC", "PROCEDURAL"]).optional(),
  status: z.enum(["CANDIDATE", "APPROVED", "DEPRECATED"]).optional(),
  limit: z.coerce.number().min(1).max(50).default(10),
});

// POST /api/v1/memory/search — semantic memory search
memoryRouter.post("/search", async (req, res, next) => {
  try {
    const params = searchSchema.parse(req.body);

    // Verify company belongs to tenant
    const company = await prisma.company.findFirst({
      where: { id: params.companyId, tenantId: req.auth!.tenantId },
    });
    if (!company) throw new AppError(404, "Company not found");

    // TODO: Faz 2 — pgvector similarity search
    // For now, return text-match results
    const memories = await prisma.memoryItem.findMany({
      where: {
        companyId: params.companyId,
        ...(params.type && { type: params.type }),
        ...(params.status && { status: params.status }),
        content: { contains: params.query, mode: "insensitive" },
      },
      take: params.limit,
      orderBy: { createdAt: "desc" },
    });

    res.json(memories);
  } catch (err) { next(err); }
});

// GET /api/v1/memory?companyId=xxx — list memories
memoryRouter.get("/", async (req, res, next) => {
  try {
    const { companyId, type, status } = req.query;
    const company = await prisma.company.findFirst({
      where: { id: companyId as string, tenantId: req.auth!.tenantId },
    });
    if (!company) throw new AppError(404, "Company not found");

    const memories = await prisma.memoryItem.findMany({
      where: {
        companyId: company.id,
        ...(type && { type: type as string }),
        ...(status && { status: status as string }),
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    res.json(memories);
  } catch (err) { next(err); }
});
