import { Router } from "express";
import { authMiddleware } from "../../middleware/auth";
import { prisma } from "../../lib/db";
import { AppError } from "../../middleware/error";
import { rateLimit } from "../../middleware/rateLimit";
import { z } from "zod";
import { enqueueRun } from "./runner";
import Anthropic from "@anthropic-ai/sdk";
import { env } from "../../config/env";

// Expensive endpoints — per-tenant throttle to prevent Claude API cost abuse.
const naturalLanguageBuilderLimiter = rateLimit({ windowMs: 60_000, maxRequests: 10, keyPrefix: "rl:pipeline:nl" });
const runTriggerLimiter = rateLimit({ windowMs: 60_000, maxRequests: 30, keyPrefix: "rl:pipeline:run" });

export const pipelineRouter = Router();
pipelineRouter.use(authMiddleware);

const createSchema = z.object({
  companyId: z.string(),
  name: z.string().min(1),
  description: z.string().optional(),
  trigger: z.enum(["MANUAL", "SCHEDULED", "WEBHOOK", "EVENT"]).default("MANUAL"),
  schedule: z.string().optional(),
  steps: z.array(z.object({
    name: z.string(),
    agentRole: z.string(),
    order: z.number(),
    config: z.record(z.unknown()).optional(),
  })),
});

// POST /api/v1/pipelines/from-natural-language — doğal dil açıklamasından pipeline oluştur
const nlPipelineSchema = z.object({
  companyId: z.string(),
  description: z.string().min(10, "Description must be at least 10 characters"),
  name: z.string().min(1).optional(),
});

pipelineRouter.post("/from-natural-language", naturalLanguageBuilderLimiter, async (req, res, next) => {
  try {
    const { companyId, description, name } = nlPipelineSchema.parse(req.body);

    // Verify company ownership
    const company = await prisma.company.findFirst({
      where: { id: companyId, tenantId: req.auth!.tenantId },
      include: { agents: { select: { name: true, role: true } } },
    });
    if (!company) throw new AppError(404, "Company not found");

    // Build agent context for the prompt
    const agentList = company.agents.length > 0
      ? company.agents.map((a) => `- ${a.name} (role: ${a.role})`).join("\n")
      : "- No agents defined yet (use generic role names like 'researcher', 'writer', 'analyst')";

    const systemPrompt = `You are a pipeline architect for an AI company automation platform. Given a natural language description of a workflow, generate a structured pipeline configuration in JSON.

The company has these agents available:
${agentList}

Output ONLY valid JSON matching this schema (no explanation, no markdown):
{
  "name": "string — pipeline name",
  "trigger": "MANUAL" | "SCHEDULED",
  "schedule": "string (cron syntax, only if trigger is SCHEDULED, otherwise null)",
  "steps": [
    {
      "name": "string — step name",
      "agentRole": "string — must match one of the agent names or roles listed above",
      "order": number,
      "config": {}
    }
  ]
}

Rules:
- Steps must be in logical execution order
- agentRole must match an existing agent name or role from the list above
- For scheduled pipelines, use valid cron syntax
- Keep step names concise and action-oriented
- Maximum 8 steps per pipeline
- If a step needs to run after another, use sequential order numbers
- For parallel steps, assign the same order number`;

    const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

    const message = await anthropic.messages.create({
      model: env.CLAUDE_MODEL,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: "user", content: `Create a pipeline for: ${description}` }],
    });

    const rawContent = message.content[0];
    if (rawContent.type !== "text") throw new AppError(500, "Unexpected AI response format");

    // Parse the JSON response
    let pipelineConfig: {
      name: string;
      trigger: "MANUAL" | "SCHEDULED";
      schedule?: string;
      steps: Array<{ name: string; agentRole: string; order: number; config?: Record<string, unknown> }>;
    };

    try {
      // Strip markdown code blocks if present
      const cleaned = rawContent.text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      pipelineConfig = JSON.parse(cleaned);
    } catch {
      throw new AppError(422, "Failed to parse AI-generated pipeline config. Please try a more detailed description.");
    }

    // Validate parsed config
    if (!pipelineConfig.steps || pipelineConfig.steps.length === 0) {
      throw new AppError(422, "No steps were generated. Please provide a more detailed description.");
    }

    // Use provided name if given
    if (name) pipelineConfig.name = name;

    // Create the pipeline
    const pipeline = await prisma.pipeline.create({
      data: {
        companyId,
        name: pipelineConfig.name,
        trigger: pipelineConfig.trigger ?? "MANUAL",
        schedule: pipelineConfig.schedule ?? null,
        steps: pipelineConfig.steps as any,
      },
    });

    await prisma.activityLog.create({
      data: {
        tenantId: req.auth!.tenantId,
        actor: req.auth!.userId,
        action: "pipeline.created_from_nl",
        resource: "pipeline",
        resourceId: pipeline.id,
        details: { description, generatedName: pipelineConfig.name, stepCount: pipelineConfig.steps.length },
      },
    });

    res.status(201).json({
      pipeline,
      generatedFrom: description,
      aiModel: env.CLAUDE_MODEL,
    });
  } catch (err) { next(err); }
});

const updatePipelineSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  trigger: z.enum(["MANUAL", "SCHEDULED", "WEBHOOK", "EVENT"]).optional(),
  schedule: z.string().optional(),
  enabled: z.boolean().optional(),
  steps: z.array(z.object({
    name: z.string(),
    agentRole: z.string(),
    order: z.number(),
    config: z.record(z.unknown()).optional(),
  })).optional(),
});

// GET /api/v1/pipelines?companyId=xxx
pipelineRouter.get("/", async (req, res, next) => {
  try {
    const { companyId } = req.query;
    // Verify company belongs to tenant
    const company = await prisma.company.findFirst({
      where: { id: companyId as string, tenantId: req.auth!.tenantId },
    });
    if (!company) throw new AppError(404, "Company not found");

    const pipelines = await prisma.pipeline.findMany({
      where: { companyId: company.id },
      orderBy: { createdAt: "desc" },
    });
    res.json(pipelines);
  } catch (err) { next(err); }
});

// POST /api/v1/pipelines
pipelineRouter.post("/", async (req, res, next) => {
  try {
    const data = createSchema.parse(req.body);
    // Verify company belongs to tenant
    const company = await prisma.company.findFirst({
      where: { id: data.companyId, tenantId: req.auth!.tenantId },
    });
    if (!company) throw new AppError(404, "Company not found");

    const pipeline = await prisma.pipeline.create({ data: { ...data, steps: data.steps as any } });

    await prisma.activityLog.create({
      data: {
        tenantId: req.auth!.tenantId,
        actor: req.auth!.userId,
        action: "pipeline.create",
        resource: "pipeline",
        resourceId: pipeline.id,
      },
    });

    res.status(201).json(pipeline);
  } catch (err) { next(err); }
});

// POST /api/v1/pipelines/:id/run — trigger a pipeline run
pipelineRouter.post("/:id/run", runTriggerLimiter, async (req, res, next) => {
  try {
    const pipelineId = req.params.id as string;
    const pipeline = await prisma.pipeline.findUnique({
      where: { id: pipelineId },
      include: { company: true },
    });
    if (!pipeline || !pipeline.company || pipeline.company.tenantId !== req.auth!.tenantId) {
      throw new AppError(404, "Pipeline not found");
    }

    const run = await prisma.run.create({
      data: {
        pipelineId: pipeline.id,
        status: "PENDING",
        trigger: "manual",
        input: req.body.input ?? {},
      },
    });

    await prisma.activityLog.create({
      data: {
        tenantId: req.auth!.tenantId,
        actor: req.auth!.userId,
        action: "run.start",
        resource: "run",
        resourceId: run.id,
        details: { pipelineId: pipeline.id },
      },
    });

    // Enqueue run for BullMQ processing
    const jobId = await enqueueRun(run.id);

    res.status(201).json({ ...run, jobId });
  } catch (err) { next(err); }
});

// GET /api/v1/pipelines/:id — get pipeline by ID
pipelineRouter.get("/:id", async (req, res, next) => {
  try {
    const pipeline = await prisma.pipeline.findUnique({
      where: { id: req.params.id },
      include: { company: true, runs: { orderBy: { createdAt: "desc" }, take: 10 } },
    });
    if (!pipeline || pipeline.company.tenantId !== req.auth!.tenantId) {
      throw new AppError(404, "Pipeline not found");
    }
    res.json(pipeline);
  } catch (err) { next(err); }
});

// PATCH /api/v1/pipelines/:id — update pipeline
pipelineRouter.patch("/:id", async (req, res, next) => {
  try {
    const pipeline = await prisma.pipeline.findUnique({
      where: { id: req.params.id },
      include: { company: true },
    });
    if (!pipeline || pipeline.company.tenantId !== req.auth!.tenantId) {
      throw new AppError(404, "Pipeline not found");
    }

    const patchData = updatePipelineSchema.parse(req.body);
    const updated = await prisma.pipeline.update({
      where: { id: pipeline.id },
      data: { ...patchData, steps: patchData.steps as any },
    });

    await prisma.activityLog.create({
      data: {
        tenantId: req.auth!.tenantId,
        actor: req.auth!.userId,
        action: "pipeline.update",
        resource: "pipeline",
        resourceId: pipeline.id,
      },
    });

    res.json(updated);
  } catch (err) { next(err); }
});

// DELETE /api/v1/pipelines/:id — delete pipeline
pipelineRouter.delete("/:id", async (req, res, next) => {
  try {
    const pipeline = await prisma.pipeline.findUnique({
      where: { id: req.params.id },
      include: { company: true },
    });
    if (!pipeline || pipeline.company.tenantId !== req.auth!.tenantId) {
      throw new AppError(404, "Pipeline not found");
    }

    await prisma.pipeline.delete({ where: { id: pipeline.id } });

    await prisma.activityLog.create({
      data: {
        tenantId: req.auth!.tenantId,
        actor: req.auth!.userId,
        action: "pipeline.delete",
        resource: "pipeline",
        resourceId: pipeline.id,
      },
    });

    res.json({ success: true });
  } catch (err) { next(err); }
});
