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

const updateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().optional(),
  config: z.record(z.unknown()).optional(),
});

// GET /api/v1/companies — list companies for tenant
companyRouter.get("/", async (req, res, next) => {
  try {
    const companies = await prisma.company.findMany({
      where: { tenantId: req.auth!.tenantId },
      orderBy: { createdAt: "desc" },
      include: {
        _count: {
          select: { agents: true, pipelines: true },
        },
      },
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
      data: { ...data, config: data.config as any, tenantId: req.auth!.tenantId },
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
    const data = updateSchema.parse(req.body);
    const company = await prisma.company.updateMany({
      where: { id: req.params.id, tenantId: req.auth!.tenantId },
      data: { ...data, config: data.config as any },
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
    const body = z
      .object({
        description: z.string().min(10),
        agentCount: z.number().int().min(1).max(20).optional(),
        workflowDescription: z.string().optional(),
        customPipelineSteps: z.array(z.string()).optional(),
      })
      .parse(req.body);

    // Enrich description with extra parameters if provided
    let description = body.description;
    if (body.agentCount) {
      description += `\n\nRequested agent count: ${body.agentCount} agents.`;
    }
    if (body.workflowDescription) {
      description += `\n\nWorkflow description: ${body.workflowDescription}`;
    }
    if (body.customPipelineSteps?.length) {
      description += `\n\nCustom pipeline steps: ${body.customPipelineSteps.join(", ")}`;
    }

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

    const session = await continueBuildSession(req.params.sessionId, req.auth!.tenantId, answer);

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
    const session = await confirmBuild(req.params.sessionId, req.auth!.tenantId);

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
    const session = getSession(req.params.sessionId, req.auth!.tenantId);
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

// DELETE /api/v1/companies/:id — archive (soft-delete) a company
companyRouter.delete("/:id", async (req, res, next) => {
  try {
    const result = await prisma.company.updateMany({
      where: { id: req.params.id, tenantId: req.auth!.tenantId },
      data: { status: "ARCHIVED" },
    });
    if (result.count === 0) throw new AppError(404, "Company not found");

    await prisma.activityLog.create({
      data: {
        tenantId: req.auth!.tenantId,
        actor: req.auth!.userId,
        action: "company.archive",
        resource: "company",
        resourceId: req.params.id,
      },
    });

    logger.info({ companyId: req.params.id }, "Company archived");
    res.json({ success: true, status: "ARCHIVED" });
  } catch (err) { next(err); }
});

// GET /api/v1/companies/:id/agents — list agents for a company
companyRouter.get("/:id/agents", async (req, res, next) => {
  try {
    const company = await prisma.company.findFirst({
      where: { id: req.params.id, tenantId: req.auth!.tenantId },
    });
    if (!company) throw new AppError(404, "Company not found");

    const agents = await prisma.agent.findMany({
      where: { companyId: company.id },
      orderBy: { createdAt: "desc" },
    });
    res.json(agents);
  } catch (err) { next(err); }
});

// POST /api/v1/companies/:id/agents — create agent for a company
const agentCreateSchema = z.object({
  name: z.string().min(1),
  role: z.string().min(1),
  systemPrompt: z.string().optional(),
  tools: z.array(z.string()).optional(),
  config: z.record(z.unknown()).optional(),
});

const agentUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  role: z.string().min(1).optional(),
  systemPrompt: z.string().optional(),
  tools: z.array(z.string()).optional(),
  config: z.record(z.unknown()).optional(),
});

companyRouter.post("/:id/agents", async (req, res, next) => {
  try {
    const company = await prisma.company.findFirst({
      where: { id: req.params.id, tenantId: req.auth!.tenantId },
    });
    if (!company) throw new AppError(404, "Company not found");

    const data = agentCreateSchema.parse(req.body);
    const agent = await prisma.agent.create({
      data: {
        companyId: company.id,
        name: data.name,
        role: data.role,
        systemPrompt: data.systemPrompt ?? "",
        tools: (data.tools ?? []) as any,
      },
    });

    await prisma.activityLog.create({
      data: {
        tenantId: req.auth!.tenantId,
        actor: req.auth!.userId,
        action: "agent.create",
        resource: "agent",
        resourceId: agent.id,
        details: { companyId: company.id, name: data.name, role: data.role },
      },
    });

    res.status(201).json(agent);
  } catch (err) { next(err); }
});

// PATCH /api/v1/companies/:companyId/agents/:agentId — update agent
companyRouter.patch("/:companyId/agents/:agentId", async (req, res, next) => {
  try {
    const company = await prisma.company.findFirst({
      where: { id: req.params.companyId, tenantId: req.auth!.tenantId },
    });
    if (!company) throw new AppError(404, "Company not found");

    const agent = await prisma.agent.findFirst({
      where: { id: req.params.agentId, companyId: company.id },
    });
    if (!agent) throw new AppError(404, "Agent not found");

    const updateData = agentUpdateSchema.parse(req.body);
    const updated = await prisma.agent.update({
      where: { id: agent.id },
      data: { ...updateData, tools: updateData.tools as any },
    });

    await prisma.activityLog.create({
      data: {
        tenantId: req.auth!.tenantId,
        actor: req.auth!.userId,
        action: "agent.update",
        resource: "agent",
        resourceId: agent.id,
      },
    });

    res.json(updated);
  } catch (err) { next(err); }
});

// DELETE /api/v1/companies/:companyId/agents/:agentId — delete agent
companyRouter.delete("/:companyId/agents/:agentId", async (req, res, next) => {
  try {
    const company = await prisma.company.findFirst({
      where: { id: req.params.companyId, tenantId: req.auth!.tenantId },
    });
    if (!company) throw new AppError(404, "Company not found");

    const deleted = await prisma.agent.deleteMany({
      where: { id: req.params.agentId, companyId: company.id },
    });
    if (deleted.count === 0) throw new AppError(404, "Agent not found");

    await prisma.activityLog.create({
      data: {
        tenantId: req.auth!.tenantId,
        actor: req.auth!.userId,
        action: "agent.delete",
        resource: "agent",
        resourceId: req.params.agentId,
      },
    });

    res.json({ success: true });
  } catch (err) { next(err); }
});

// GET /api/v1/companies/:id/activity — company-specific activity timeline
companyRouter.get("/:id/activity", async (req, res, next) => {
  try {
    const company = await prisma.company.findFirst({
      where: { id: req.params.id, tenantId: req.auth!.tenantId },
    });
    if (!company) throw new AppError(404, "Company not found");

    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const offset = Number(req.query.offset) || 0;

    const logs = await prisma.activityLog.findMany({
      where: {
        tenantId: req.auth!.tenantId,
        OR: [
          { resourceId: company.id },
          { details: { path: ["companyId"], equals: company.id } },
        ],
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
    });

    const total = await prisma.activityLog.count({
      where: {
        tenantId: req.auth!.tenantId,
        OR: [
          { resourceId: company.id },
          { details: { path: ["companyId"], equals: company.id } },
        ],
      },
    });

    res.json({ logs, total, limit, offset });
  } catch (err) { next(err); }
});

// GET /api/v1/companies/:id/contacts — company contacts (nested route)
companyRouter.get("/:id/contacts", async (req, res, next) => {
  try {
    const company = await prisma.company.findFirst({
      where: { id: req.params.id, tenantId: req.auth!.tenantId },
    });
    if (!company) throw new AppError(404, "Company not found");

    const contacts = await prisma.contact.findMany({
      where: { companyId: company.id },
      include: { deals: true },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    res.json(contacts);
  } catch (err) { next(err); }
});

// GET /api/v1/companies/:id/deals — company deals (nested route)
companyRouter.get("/:id/deals", async (req, res, next) => {
  try {
    const company = await prisma.company.findFirst({
      where: { id: req.params.id, tenantId: req.auth!.tenantId },
    });
    if (!company) throw new AppError(404, "Company not found");

    const deals = await prisma.deal.findMany({
      where: { companyId: company.id },
      include: { contact: true },
      orderBy: { createdAt: "desc" },
    });
    res.json(deals);
  } catch (err) { next(err); }
});

// GET /api/v1/companies/:id/webhooks — recent webhook events from activity log
companyRouter.get("/:id/webhooks", async (req, res, next) => {
  try {
    const company = await prisma.company.findFirst({
      where: { id: req.params.id, tenantId: req.auth!.tenantId },
    });
    if (!company) throw new AppError(404, "Company not found");

    const logs = await prisma.activityLog.findMany({
      where: {
        tenantId: req.auth!.tenantId,
        resourceId: company.id,
        action: { startsWith: "webhook." },
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    res.json(logs);
  } catch (err) { next(err); }
});
