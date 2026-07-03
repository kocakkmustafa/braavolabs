import { Router } from "express";
import { authMiddleware } from "../../middleware/auth";
import { prisma } from "../../lib/db";
import { AppError } from "../../middleware/error";
import { rateLimit } from "../../middleware/rateLimit";
import { z } from "zod";
import { enqueueRun, registerSchedule, removeSchedule } from "./runner";
import { scheduleQueue } from "../../lib/queue";
import * as cron from "node-cron";
import { claimQuota } from "../billing/metering";
import Anthropic from "@anthropic-ai/sdk";
import { env } from "../../config/env";
import { logger } from "../../lib/logger";
import { getTenantAIConfig, type AIProviderType } from "../../services/ai-client";
import { estimatePipelineCostUsd } from "../../lib/modelPricing";

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
  // Topology — SEQUENTIAL keeps the existing array-order behaviour
  // (default for every legacy pipeline); HIERARCHICAL turns the
  // pipeline into a manager+workers crew. Steps are not used by
  // HIERARCHICAL but the column is required by the schema; the
  // service accepts an empty array for that case.
  pipelineType: z.enum(["SEQUENTIAL", "HIERARCHICAL"]).default("SEQUENTIAL"),
  managerAgentId: z.string().optional(),
  maxDelegationDepth: z.number().int().min(1).max(10).default(3),
  steps: z.array(z.object({
    name: z.string(),
    agentRole: z.string(),
    order: z.number(),
    config: z.record(z.unknown()).optional(),
  })),
}).superRefine((val, ctx) => {
  if (val.pipelineType === "HIERARCHICAL" && !val.managerAgentId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["managerAgentId"],
      message: "Hierarchical pipelines require a managerAgentId",
    });
  }
  // SCHED-06 — a SCHEDULED pipeline without a valid cron schedule would be
  // silently dropped by the scheduler filter, so reject it at the door.
  if (val.trigger === "SCHEDULED") {
    if (!val.schedule || !cron.validate(val.schedule)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["schedule"],
        message: "SCHEDULED pipelines require a valid cron schedule",
      });
    }
  }
});

// POST /api/v1/pipelines/from-natural-language — doğal dil açıklamasından pipeline oluştur
const nlPipelineSchema = z.object({
  companyId: z.string(),
  // Cap at 2000 chars (ISS-004): the description is fed to Claude and a
  // 9.5KB jailbreak payload can rack up serious cost in milliseconds. The
  // builder needs maybe 100-500 chars to produce a sensible pipeline.
  description: z
    .string()
    .min(10, "Description must be at least 10 characters")
    .max(2000, "Description is too long — keep it under 2000 characters"),
  name: z.string().min(1).max(120).optional(),
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

    if (!env.ANTHROPIC_API_KEY) {
      throw new AppError(503, "Pipeline natural-language builder unavailable: ANTHROPIC_API_KEY not configured.");
    }

    // Wrap the Anthropic call with explicit timeout + retry. The bare SDK
    // call has no per-request deadline by default, so a slow Anthropic API
    // could pin this Express handler indefinitely; the rateLimiter at
    // /from-natural-language gives 10 req/min which means up to ~10
    // wedged handlers can hold up the worker pool. 60s timeout + 3 retries
    // (built into the SDK) gives a hard upper bound of ~3 minutes per
    // request before we surface a 504 to the caller.
    const anthropic = new Anthropic({
      apiKey: env.ANTHROPIC_API_KEY,
      timeout: 60_000,
      maxRetries: 3,
    });

    const message = await anthropic.messages.create({
      model: env.CLAUDE_MODEL,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: "user", content: `Create a pipeline for: ${description}` }],
    });

    // Cost telemetry — without this, every NL pipeline build is an
    // un-tracked Claude charge that won't show up in usage analytics.
    logger.info(
      {
        tenantId: req.auth!.tenantId,
        companyId,
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        model: env.CLAUDE_MODEL,
      },
      "Pipeline NL builder Claude call completed",
    );

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

    // E4 — register the schedule for an NL-generated SCHEDULED pipeline (G1).
    // The NL builder can emit a cron schedule; validate before registering so
    // a malformed AI-produced pattern is logged-and-skipped, not thrown.
    if (pipeline.trigger === "SCHEDULED" && pipeline.enabled && pipeline.schedule) {
      await registerSchedule(pipeline);
    }

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
}).superRefine((val, ctx) => {
  // When a PATCH explicitly sets trigger=SCHEDULED it must carry a valid cron
  // schedule in the same request (SCHED-06). When it only supplies a schedule
  // string (keeping an existing SCHEDULED trigger), that string must still be
  // a valid pattern. Fuller "resulting-state" validation lives in the handler.
  if (val.trigger === "SCHEDULED" && (!val.schedule || !cron.validate(val.schedule))) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["schedule"],
      message: "SCHEDULED pipelines require a valid cron schedule",
    });
  } else if (val.schedule !== undefined && !cron.validate(val.schedule)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["schedule"],
      message: "Invalid cron schedule",
    });
  }
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

// GET /api/v1/pipelines/scheduled — the scheduling dashboard feed (E4/T5).
//
// nextRunAt is read live from the BullMQ JobScheduler (source of truth for the
// next fire), lastRunAt from the DB column stamped by processScheduledTick.
// Every field is real — no placeholder/hardcoded values; an empty result is a
// genuine empty [] (no schedulers registered for this tenant).
//
// MUST be declared before GET /:id so "/scheduled" isn't captured as an :id.
pipelineRouter.get("/scheduled", async (req, res, next) => {
  try {
    // Tenant-scope: only this tenant's SCHEDULED pipelines. Optional companyId
    // query narrows further (and is ownership-checked when present).
    const companyId = req.query.companyId as string | undefined;
    if (companyId) {
      const company = await prisma.company.findFirst({
        where: { id: companyId, tenantId: req.auth!.tenantId },
        select: { id: true },
      });
      if (!company) throw new AppError(404, "Company not found");
    }

    const pipelines = await prisma.pipeline.findMany({
      where: {
        trigger: "SCHEDULED",
        ...(companyId ? { companyId } : {}),
        company: { tenantId: req.auth!.tenantId },
      },
      select: {
        id: true,
        name: true,
        schedule: true,
        enabled: true,
        lastRunAt: true,
        companyId: true,
      },
      orderBy: { createdAt: "desc" },
    });

    // Build a pipelineId → nextRun(epoch ms) map from the live schedulers.
    // Schedulers live on the dedicated pipeline-schedules queue (E4), not
    // runQueue.
    const schedulers = await scheduleQueue.getJobSchedulers(0, -1);
    const nextByKey = new Map<string, number | undefined>();
    for (const s of schedulers) {
      const key = s.key ?? s.id;
      if (key) nextByKey.set(key, s.next ?? undefined);
    }

    const result = pipelines.map((p) => {
      const next = nextByKey.get(p.id);
      return {
        id: p.id,
        name: p.name,
        companyId: p.companyId,
        schedule: p.schedule,
        enabled: p.enabled,
        nextRunAt: next != null ? new Date(next).toISOString() : null,
        lastRunAt: p.lastRunAt ? p.lastRunAt.toISOString() : null,
      };
    });

    res.json(result);
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

    // Manager agent must belong to the same company. The .superRefine
    // already enforced "managerAgentId present when HIERARCHICAL"; this
    // is the cross-tenant / cross-company defence-in-depth check.
    if (data.pipelineType === "HIERARCHICAL" && data.managerAgentId) {
      const manager = await prisma.agent.findFirst({
        where: { id: data.managerAgentId, companyId: data.companyId },
      });
      if (!manager) {
        throw new AppError(400, "managerAgentId does not belong to this company");
      }
    }

    const pipeline = await prisma.pipeline.create({ data: { ...data, steps: data.steps as any } });

    // E4 — register the BullMQ schedule immediately so a runtime-created
    // SCHEDULED pipeline fires without waiting for a process restart (G1).
    if (pipeline.trigger === "SCHEDULED" && pipeline.enabled && pipeline.schedule) {
      await registerSchedule(pipeline);
    }

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

    // ── Atomic quota claim (ISS-010) ────────────────────────────────────
    // Single SQL statement claims one run from the meter or refuses if over
    // limit. Closes the read-then-write TOCTOU window that previously let
    // two concurrent POSTs at value=9, limit=10 both succeed.
    const claim = await claimQuota(req.auth!.tenantId, "runs");
    if (!claim.claimed) {
      throw new AppError(
        429,
        `Monthly run limit reached (${claim.value}/${claim.limit}). Upgrade your plan for more runs.`,
      );
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
        details: { pipelineId: pipeline.id, quotaClaimedValue: claim.value, quotaLimit: claim.limit },
      },
    });

    // Enqueue run for BullMQ processing
    const jobId = await enqueueRun(run.id);

    res.status(201).json({ ...run, jobId });
  } catch (err) { next(err); }
});

// GET /api/v1/pipelines/:id/cost-estimate — approximate USD cost to run this
// pipeline once, using the tenant's configured AI provider/model.
//
// ⚠️ ESTIMATE ONLY. Derived from a baseline per-step token assumption (see
// lib/modelPricing.ts) and returned as a low–high range. The run's live
// `costUsd` (metered from real usage) is the source of truth — the UI labels
// this clearly as an estimate. Nobody else in the market shows a pre-run cost,
// so honesty here is the whole point.
pipelineRouter.get("/:id/cost-estimate", async (req, res, next) => {
  try {
    const pipeline = await prisma.pipeline.findUnique({
      where: { id: req.params.id },
      include: { company: true },
    });
    if (!pipeline || pipeline.company.tenantId !== req.auth!.tenantId) {
      throw new AppError(404, "Pipeline not found");
    }

    // Step count drives the estimate. HIERARCHICAL pipelines store an empty
    // steps array (the manager plans at runtime); fall back to a modest
    // assumption so the manager turn still shows a cost.
    const steps = Array.isArray(pipeline.steps) ? pipeline.steps : [];
    const stepCount =
      pipeline.pipelineType === "HIERARCHICAL"
        ? Math.max(steps.length, 3)
        : steps.length;

    // Read the tenant's configured provider/model. getTenantAIConfig throws
    // if nothing is configured AND no system key exists; treat that as
    // "can't estimate yet" rather than a hard error so the run button still
    // works (the estimate is advisory).
    let provider: AIProviderType = "ANTHROPIC";
    let model = env.CLAUDE_MODEL;
    let configured = true;
    try {
      const cfg = await getTenantAIConfig(req.auth!.tenantId);
      provider = cfg.provider;
      model = cfg.model;
    } catch {
      configured = false;
    }

    const estimate = estimatePipelineCostUsd(stepCount, provider, model);

    res.json({
      stepCount: estimate.stepCount,
      provider: estimate.provider,
      model: estimate.model,
      lowUsd: estimate.lowUsd,
      highUsd: estimate.highUsd,
      perStepUsd: estimate.perStepUsd,
      // Flags the UI uses to phrase the label honestly.
      isEstimate: true,
      isFree: estimate.isFree,
      unknownModel: estimate.unknownModel,
      configured,
    });
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

    // D4 — revision history. When the patch changes `steps`, snapshot the
    // PREVIOUS steps into activity_log so the edit is reversible. No new table:
    // activity_log already exists and is tenant-scoped + indexed by resourceId.
    const stepsChanged =
      patchData.steps !== undefined &&
      JSON.stringify(patchData.steps) !== JSON.stringify(pipeline.steps ?? []);

    const updated = await prisma.pipeline.update({
      where: { id: pipeline.id },
      data: { ...patchData, steps: patchData.steps as any },
    });

    // E4 — reconcile the BullMQ schedule against the RESULTING state (G1/G3).
    // registerSchedule is idempotent (jobSchedulerId=pipeline.id), so a PATCH
    // that changes the cron pattern updates in place; anything that leaves the
    // pipeline non-schedulable (disabled, trigger away from SCHEDULED, or
    // schedule cleared) tears the scheduler down.
    if (updated.trigger === "SCHEDULED" && updated.enabled && updated.schedule) {
      await registerSchedule(updated);
    } else {
      await removeSchedule(updated.id);
    }

    if (stepsChanged) {
      await prisma.activityLog.create({
        data: {
          tenantId: req.auth!.tenantId,
          actor: req.auth!.userId,
          action: "pipeline.revision",
          resource: "pipeline",
          resourceId: pipeline.id,
          details: {
            // The steps as they were BEFORE this edit — what "Restore" reverts to.
            previousSteps: pipeline.steps ?? [],
            stepCountBefore: Array.isArray(pipeline.steps) ? pipeline.steps.length : 0,
            stepCountAfter: Array.isArray(patchData.steps) ? patchData.steps.length : 0,
            at: new Date().toISOString(),
          } as any,
        },
      });
    }

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

// GET /api/v1/pipelines/:id/revisions — recent step-snapshots (D4).
// Reads activity_log "pipeline.revision" rows for this pipeline and returns the
// last ~10 prior step snapshots, newest first. Each entry is a restore point.
pipelineRouter.get("/:id/revisions", async (req, res, next) => {
  try {
    const pipeline = await prisma.pipeline.findUnique({
      where: { id: req.params.id },
      include: { company: true },
    });
    if (!pipeline || pipeline.company.tenantId !== req.auth!.tenantId) {
      throw new AppError(404, "Pipeline not found");
    }

    const logs = await prisma.activityLog.findMany({
      where: {
        tenantId: req.auth!.tenantId,
        action: "pipeline.revision",
        resource: "pipeline",
        resourceId: pipeline.id,
      },
      orderBy: { createdAt: "desc" },
      take: 10,
    });

    const revisions = logs.map((log) => {
      const details =
        log.details && typeof log.details === "object" && !Array.isArray(log.details)
          ? (log.details as Record<string, unknown>)
          : {};
      const prev = details.previousSteps;
      return {
        id: log.id,
        actor: log.actor,
        createdAt: log.createdAt,
        stepCountBefore: typeof details.stepCountBefore === "number" ? details.stepCountBefore : undefined,
        stepCountAfter: typeof details.stepCountAfter === "number" ? details.stepCountAfter : undefined,
        // The snapshot the caller would restore to.
        steps: Array.isArray(prev) ? prev : [],
      };
    });

    res.json({ revisions });
  } catch (err) { next(err); }
});

const restoreRevisionSchema = z
  .object({
    revisionId: z.string().optional(),
    index: z.number().int().min(0).optional(),
  })
  .refine((v) => v.revisionId !== undefined || v.index !== undefined, {
    message: "Provide a revisionId or an index",
  });

// POST /api/v1/pipelines/:id/revisions/restore — revert steps to a snapshot (D4).
// Body: { revisionId } or { index } (0 = most recent revision). Sets
// pipeline.steps back to that snapshot and logs a NEW revision (snapshotting the
// current steps first) so the restore is itself reversible.
pipelineRouter.post("/:id/revisions/restore", async (req, res, next) => {
  try {
    const pipeline = await prisma.pipeline.findUnique({
      where: { id: req.params.id },
      include: { company: true },
    });
    if (!pipeline || pipeline.company.tenantId !== req.auth!.tenantId) {
      throw new AppError(404, "Pipeline not found");
    }

    const body = restoreRevisionSchema.parse(req.body);

    const logs = await prisma.activityLog.findMany({
      where: {
        tenantId: req.auth!.tenantId,
        action: "pipeline.revision",
        resource: "pipeline",
        resourceId: pipeline.id,
      },
      orderBy: { createdAt: "desc" },
      take: 10,
    });

    const target =
      body.revisionId !== undefined
        ? logs.find((l) => l.id === body.revisionId)
        : logs[body.index!];
    if (!target) throw new AppError(404, "Revision not found");

    const details =
      target.details && typeof target.details === "object" && !Array.isArray(target.details)
        ? (target.details as Record<string, unknown>)
        : {};
    const snapshot = Array.isArray(details.previousSteps) ? details.previousSteps : null;
    if (!snapshot) throw new AppError(422, "This revision has no step snapshot to restore");

    // Snapshot the CURRENT steps as a new revision so the restore is reversible,
    // then apply the chosen snapshot — both in one transaction.
    const restored = await prisma.$transaction(async (tx) => {
      await tx.activityLog.create({
        data: {
          tenantId: req.auth!.tenantId,
          actor: req.auth!.userId,
          action: "pipeline.revision",
          resource: "pipeline",
          resourceId: pipeline.id,
          details: {
            previousSteps: pipeline.steps ?? [],
            stepCountBefore: Array.isArray(pipeline.steps) ? pipeline.steps.length : 0,
            stepCountAfter: snapshot.length,
            at: new Date().toISOString(),
            restoredFrom: target.id,
          } as any,
        },
      });
      const updated = await tx.pipeline.update({
        where: { id: pipeline.id },
        data: { steps: snapshot as any },
      });
      await tx.activityLog.create({
        data: {
          tenantId: req.auth!.tenantId,
          actor: req.auth!.userId,
          action: "pipeline.revision.restore",
          resource: "pipeline",
          resourceId: pipeline.id,
          details: { restoredFrom: target.id, stepCount: snapshot.length } as any,
        },
      });
      return updated;
    });

    res.json(restored);
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

    // E4 — tear down the BullMQ schedule so a deleted pipeline's scheduler
    // doesn't keep firing ticks that create runs against a now-invalid FK
    // (G1/SCHED-04). Safe no-op when the pipeline had no scheduler.
    await removeSchedule(pipeline.id);

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
