import { Router } from "express";
import { authMiddleware } from "../../middleware/auth";
import { prisma } from "../../lib/db";
import { AppError } from "../../middleware/error";
import { z } from "zod";
import {
  searchMemory,
  searchMemoryText,
  storeEpisodicMemory,
  storeSemanticMemory,
  storeProceduralMemory,
  addEdge,
  getRelatedMemories,
  runConsolidation,
} from "@ai-company-os/memory";

export const memoryRouter = Router();
memoryRouter.use(authMiddleware);

const searchSchema = z.object({
  companyId: z.string(),
  query: z.string().min(1),
  type: z.enum(["EPISODIC", "SEMANTIC", "PROCEDURAL"]).optional(),
  status: z.enum(["CANDIDATE", "APPROVED", "DEPRECATED"]).optional(),
  limit: z.coerce.number().min(1).max(50).default(10),
  minConfidence: z.coerce.number().min(0).max(1).default(0),
  mode: z.enum(["vector", "text"]).default("vector"),
});

// POST /api/v1/memory/search — semantic memory search (pgvector)
memoryRouter.post("/search", async (req, res, next) => {
  try {
    const params = searchSchema.parse(req.body);

    const company = await prisma.company.findFirst({
      where: { id: params.companyId, tenantId: req.auth!.tenantId },
    });
    if (!company) throw new AppError(404, "Company not found");

    const results =
      params.mode === "vector"
        ? await searchMemory(params)
        : await searchMemoryText(params);

    await prisma.activityLog.create({
      data: {
        tenantId: req.auth!.tenantId,
        actor: req.auth!.userId,
        action: "memory.search",
        resource: "memory",
        details: { query: params.query, mode: params.mode, resultCount: results.length },
      },
    });

    res.json(results);
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

const createSchema = z.object({
  companyId: z.string(),
  type: z.enum(["EPISODIC", "SEMANTIC", "PROCEDURAL"]),
  content: z.string().min(1),
  metadata: z.record(z.unknown()).optional(),
  source: z.string().optional(),
  confidence: z.coerce.number().min(0).max(1).default(0.5),
});

// POST /api/v1/memory — store a new memory
memoryRouter.post("/", async (req, res, next) => {
  try {
    const data = createSchema.parse(req.body);

    const company = await prisma.company.findFirst({
      where: { id: data.companyId, tenantId: req.auth!.tenantId },
    });
    if (!company) throw new AppError(404, "Company not found");

    const storeFn = {
      EPISODIC: storeEpisodicMemory,
      SEMANTIC: storeSemanticMemory,
      PROCEDURAL: storeProceduralMemory,
    }[data.type];

    const memoryId = await storeFn(data);

    await prisma.activityLog.create({
      data: {
        tenantId: req.auth!.tenantId,
        actor: req.auth!.userId,
        action: "memory.create",
        resource: "memory",
        resourceId: memoryId,
        details: { type: data.type },
      },
    });

    res.status(201).json({ memoryId, type: data.type, status: "CANDIDATE" });
  } catch (err) { next(err); }
});

// GET /api/v1/memory/:id/related — get related memories via graph
memoryRouter.get("/:id/related", async (req, res, next) => {
  try {
    const { relation } = req.query;
    const related = await getRelatedMemories(
      req.params.id,
      relation as string | undefined,
    );
    res.json(related);
  } catch (err) { next(err); }
});

const edgeSchema = z.object({
  fromId: z.string(),
  toId: z.string(),
  relation: z.string(),
  weight: z.coerce.number().min(0).max(1).default(1),
});

// POST /api/v1/memory/edges — add a memory edge
memoryRouter.post("/edges", async (req, res, next) => {
  try {
    const data = edgeSchema.parse(req.body);
    const edgeId = await addEdge(data);
    res.status(201).json({ edgeId });
  } catch (err) { next(err); }
});

// POST /api/v1/memory/consolidate — trigger consolidation
memoryRouter.post("/consolidate", async (req, res, next) => {
  try {
    const result = await runConsolidation(req.auth!.tenantId);

    await prisma.activityLog.create({
      data: {
        tenantId: req.auth!.tenantId,
        actor: req.auth!.userId,
        action: "memory.consolidate",
        resource: "memory",
        details: result as any,
      },
    });

    res.json(result);
  } catch (err) { next(err); }
});
