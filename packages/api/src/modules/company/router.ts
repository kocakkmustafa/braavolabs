import { Router } from "express";
import { requirePermission } from "../../middleware/require-permission";
import { authMiddleware } from "../../middleware/auth";
import { prisma, tenantTx } from "../../lib/db";
import { logger } from "../../lib/logger";
import { AppError } from "../../middleware/error";
import { rateLimit } from "../../middleware/rateLimit";
import { PLAN_LIMITS, MODEL_MODES, type ModelMode } from "@ai-company-os/core";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { applyNaturalLanguageEdit, AgentConfig } from "../agent/nl-editor";
import {
  startBuildSession,
  continueBuildSession,
  confirmBuild,
  getSession,
} from "./builder";
import { updateAgentWithHistory } from "./agent-update";
import { composeAgent } from "../agent/composer";
import { assertCompanyCapacity } from "./company-capacity";
import { getEffectivePlan } from "../billing/entitlement-ledger.service";
import { toPublicCompany } from "./redact";
import { buildModelsOverview } from "./models-overview";
import { buildCompanySummary } from "./summary";
import { BUDGET_CONFIG_KEY, validateBudgetInput } from "./budget";
import {
  applyCompanyModeSettings,
  extractModeSettings,
  validateCompanyModeSettingsInput,
  validateModelModeConfigInput,
} from "./model-mode-settings";

export const companyRouter = Router();
companyRouter.use(authMiddleware);

// Expensive: freeform builder triggers Claude clarification loop (expensive tokens).
const buildStartLimiter = rateLimit({ windowMs: 60_000, maxRequests: 5, keyPrefix: "rl:company:build" });
const buildAnswerLimiter = rateLimit({ windowMs: 60_000, maxRequests: 20, keyPrefix: "rl:company:build:answer" });
// Composer: one LLM round-trip per call, cheaper than build but still costs tokens.
const agentComposeLimiter = rateLimit({ windowMs: 60_000, maxRequests: 10, keyPrefix: "rl:agent:compose" });

const createSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/),
  description: z.string().optional(),
  primitives: z.array(z.enum([
    "ACQUISITION", "SALES", "DELIVERY", "CONTENT",
    "OPERATIONS", "FINANCE", "ANALYTICS", "MEMORY", "GOVERNANCE",
  ])).min(1),
  config: z.record(z.string(), z.unknown()).optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
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

    res.json(companies.map((c) => toPublicCompany(c)));
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
    res.json(toPublicCompany(company));
  } catch (err) { next(err); }
});

// POST /api/v1/companies
companyRouter.post("/", async (req, res, next) => {
  try {
    const data = createSchema.parse(req.body);
    const tenantId = req.auth!.tenantId;

    // BRA-P0-06a-2: oluşturmada gelen kip anahtarları da PATCH /:id/model-mode ile aynı kuralla doğrulanır.
    const modeKeys = extractModeSettings(data.config);
    if (modeKeys) {
      const v = validateCompanyModeSettingsInput(modeKeys);
      if (!v.ok) throw new AppError(400, v.error);
    }

    const company = await tenantTx(async (tx) => {
      await assertCompanyCapacity(tx, tenantId);
      const created = await tx.company.create({
        data: { ...data, config: data.config as any, tenantId },
      });
      await tx.activityLog.create({
        data: {
          tenantId,
          actor: req.auth!.userId,
          action: "company.create",
          resource: "company",
          resourceId: created.id,
          details: { name: created.name, slug: created.slug },
        },
      });
      return created;
    });

    logger.info({ companyId: company.id }, "Company created");
    res.status(201).json(toPublicCompany(company));
  } catch (err) { next(err); }
});

// PATCH /api/v1/companies/:id
companyRouter.patch("/:id", async (req, res, next) => {
  try {
    const data = updateSchema.parse(req.body);

    // MED-1 fix: config write allowlist. The previous schema accepted
    // `z.record(z.unknown())`, letting a tenant PATCH `webhookSecret`
    // (and pick a known value before publishing as a blueprint — see
    // HIGH-3) or any internal flag like `_quarantined`. Now we accept
    // only the keys a user is supposed to manage. Other keys are
    // silently dropped — better than 400ing on legacy clients.
    const USER_WRITABLE_CONFIG_KEYS = new Set([
      "niche",
      "targetAudience",
      "channels",
      "companyType",
      "brand_voice",
      "icp",
      "kpi",
      "budget",
      "work_mode",
      "use_cases",
    ]);

    let sanitizedData: typeof data = data;
    if (data.config && typeof data.config === "object") {
      const filteredConfig: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(data.config as Record<string, unknown>)) {
        if (USER_WRITABLE_CONFIG_KEYS.has(k)) filteredConfig[k] = v;
      }
      sanitizedData = { ...data, config: filteredConfig };
    }

    const tenantId = req.auth!.tenantId;

    // Channel enforcement — `config.channels` must be a subset of the
    // tenant's plan-allowed channels. Onboarding hard-codes the right
    // list, but a Free user PATCHing this endpoint directly could
    // otherwise add `instagram` / `youtube` and use paid features.
    // NOT: Denetim BİRLEŞİK config üzerinde yapılır (eski kodla aynı): mevcut config'te plan dışı
    // kanal kalmışsa ilgisiz bir yama da 403 alır — bilinçli, davranış korunur.
    // Plan/izinli küme ilk ihtiyaçta bir kez hesaplanır; yeniden denemelerde tekrar sorgulanmaz.
    let planCache: { plan: string; allowed: Set<string> } | undefined;
    const enforceChannels = async (cfg: unknown) => {
      if (cfg && typeof cfg === "object" && "channels" in cfg) {
        const proposedChannels = (cfg as Record<string, unknown>).channels;
        if (Array.isArray(proposedChannels)) {
          if (!planCache) {
            const tenant = await prisma.tenant.findUnique({
              where: { id: tenantId },
              select: { plan: true },
            });
            const p = await getEffectivePlan(tenantId, tenant?.plan);
            planCache = { plan: p, allowed: new Set<string>(PLAN_LIMITS[p].channels) };
          }
          const { plan, allowed } = planCache;
          const denied = proposedChannels.filter(
            (c) => typeof c !== "string" || !allowed.has(c),
          );
          if (denied.length > 0) {
            throw new AppError(
              403,
              `Plan "${plan}" does not allow channels: ${denied.join(", ")}. Allowed: ${[...allowed].join(", ")}.`,
            );
          }
        }
      }
    };

    const logUpdate = () => prisma.activityLog.create({
      data: {
        tenantId,
        actor: req.auth!.userId,
        action: "company.update",
        resource: "company",
        resourceId: req.params.id,
      },
    });

    // config yazımı: oku-birleştir-yaz, updatedAt iyimser kilidiyle (bütçe/kip uçlarıyla aynı kalıp).
    // Eşzamanlı bir yazım config'in başka anahtarını değiştirirse updateMany count 0 döner ve yeniden denenir.
    if (sanitizedData.config && typeof sanitizedData.config === "object") {
      for (let attempt = 0; attempt < 3; attempt++) {
        const existing = await prisma.company.findFirst({
          where: { id: req.params.id, tenantId },
          select: { config: true, updatedAt: true },
        });
        if (!existing) throw new AppError(404, "Company not found");
        const merged: Record<string, unknown> =
          existing.config && typeof existing.config === "object" && !Array.isArray(existing.config)
            ? { ...(existing.config as Record<string, unknown>) } : {};
        for (const [k, v] of Object.entries(sanitizedData.config as Record<string, unknown>)) {
          merged[k] = v;
        }
        await enforceChannels(merged);
        const result = await prisma.company.updateMany({
          where: { id: req.params.id, tenantId, updatedAt: existing.updatedAt },
          data: { ...sanitizedData, config: merged as any },
        });
        if (result.count === 0) continue;
        await logUpdate();
        res.json({ success: true });
        return;
      }
      throw new AppError(409, "Company was modified concurrently; retry");
    }

    const company = await prisma.company.updateMany({
      where: { id: req.params.id, tenantId },
      data: { ...sanitizedData, config: sanitizedData.config as any },
    });
    if (company.count === 0) throw new AppError(404, "Company not found");

    await logUpdate();

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
companyRouter.post("/build", buildStartLimiter, async (req, res, next) => {
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
companyRouter.post("/build/:sessionId/answer", buildAnswerLimiter, async (req, res, next) => {
  try {
    const { answer } = z
      .object({ answer: z.string().min(1) })
      .parse(req.body);

    const session = await continueBuildSession(req.params.sessionId as string, req.auth!.tenantId, answer);

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
companyRouter.delete("/:id", requirePermission("company:delete"), async (req, res, next) => {
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

// GET /api/v1/companies/:id/models — salt-okur model + yetki dökümü (BRA-UX-API-02)
companyRouter.get("/:id/models", async (req, res, next) => {
  try {
    const company = await prisma.company.findFirst({
      where: { id: req.params.id, tenantId: req.auth!.tenantId },
      select: { id: true },
    });
    if (!company) throw new AppError(404, "Company not found");
    res.json(await buildModelsOverview(req.auth!.tenantId, company.id));
  } catch (err) { next(err); }
});

// GET /api/v1/companies/:id/summary — salt-okur şirket özeti (BRA-P0-11b)
companyRouter.get("/:id/summary", async (req, res, next) => {
  try {
    const company = await prisma.company.findFirst({
      where: { id: req.params.id, tenantId: req.auth!.tenantId },
      select: { id: true, config: true },
    });
    if (!company) throw new AppError(404, "Company not found");
    res.json(await buildCompanySummary(req.auth!.tenantId, company.id, new Date(), company.config));
  } catch (err) { next(err); }
});

// PATCH /api/v1/companies/:id/budget — aylık bütçe (Company.config.monthlyBudgetUsd; BRA-P0-11c).
// Yetki: requirePermission("billing:budget") (ADMIN+; billing/router.ts tenant bütçe ucuyla aynı izin).
// config'in diğer anahtarları korunur; eşzamanlı yazma updatedAt iyimser kilidiyle yakalanır.
const budgetSchema = z.object({ monthlyBudgetUsd: z.unknown().refine((v) => v !== undefined, "monthlyBudgetUsd is required") });
companyRouter.patch("/:id/budget", requirePermission("billing:budget"), async (req, res, next) => {
  try {
    const body = budgetSchema.parse(req.body ?? {});
    let value: number | null = null;
    if (body.monthlyBudgetUsd !== null) {
      const v = validateBudgetInput(body.monthlyBudgetUsd);
      if (!v.ok) throw new AppError(400, v.error);
      value = v.value;
    }
    const tenantId = req.auth!.tenantId;
    for (let attempt = 0; attempt < 3; attempt++) {
      const existing = await prisma.company.findFirst({
        where: { id: req.params.id, tenantId },
        select: { config: true, updatedAt: true },
      });
      if (!existing) throw new AppError(404, "Company not found");
      const base = existing.config && typeof existing.config === "object" && !Array.isArray(existing.config)
        ? { ...(existing.config as Record<string, unknown>) } : {};
      if (value === null) delete base[BUDGET_CONFIG_KEY]; else base[BUDGET_CONFIG_KEY] = value;
      const result = await prisma.company.updateMany({
        where: { id: req.params.id, tenantId, updatedAt: existing.updatedAt },
        data: { config: base as any },
      });
      if (result.count === 0) continue;
      await prisma.activityLog.create({
        data: {
          tenantId,
          actor: req.auth!.userId,
          action: "company.budget.update",
          resource: "company",
          resourceId: req.params.id,
          details: { monthlyBudgetUsd: value },
        },
      });
      res.json({ success: true, monthlyBudgetUsd: value });
      return;
    }
    throw new AppError(409, "Company was modified concurrently; retry");
  } catch (err) { next(err); }
});

// PATCH /api/v1/companies/:id/model-mode — şirket model kipi + autoSelection (BRA-P0-06a-2).
// Body: { modelMode?: "DIRECT"|"CASCADE"|"COMPARE"|null, autoSelection?: { enabled: boolean }|null }; null = ayarı sil.
// Yetki: şirket PATCH'iyle aynı kapı (kimliği doğrulanmış kiracı üyesi; kurucu kararı 2026-11-15 "mevcut kapı kalır").
// Genel PATCH /:id bu anahtarları KABUL ETMEZ (allowlist dışı); oluşturmada (POST /) aynı doğrulama uygulanır.
// Yetki bilinçli olarak şirket PATCH'iyle aynı (en düşük üye rolü dahil); budget ucu gibi ADMIN şartı YOK.
// config'in diğer anahtarları korunur; eşzamanlı yazma updatedAt iyimser kilidiyle yakalanır.
companyRouter.patch("/:id/model-mode", async (req, res, next) => {
  try {
    const v = validateCompanyModeSettingsInput(req.body ?? {});
    if (!v.ok) throw new AppError(400, v.error);
    const tenantId = req.auth!.tenantId;
    for (let attempt = 0; attempt < 3; attempt++) {
      const existing = await prisma.company.findFirst({
        where: { id: req.params.id, tenantId },
        select: { config: true, updatedAt: true },
      });
      if (!existing) throw new AppError(404, "Company not found");
      const merged = applyCompanyModeSettings(existing.config, v.value);
      const result = await prisma.company.updateMany({
        where: { id: req.params.id, tenantId, updatedAt: existing.updatedAt },
        data: { config: merged as any },
      });
      if (result.count === 0) continue;
      await prisma.activityLog.create({
        data: {
          tenantId,
          actor: req.auth!.userId,
          action: "company.model_mode.update",
          resource: "company",
          resourceId: req.params.id,
          details: v.value as any,
        },
      });
      res.json({
        success: true,
        modelMode: (merged.modelMode as ModelMode | undefined) ?? null,
        autoSelection: (merged.autoSelection as { enabled: boolean } | undefined) ?? null,
      });
      return;
    }
    throw new AppError(409, "Company was modified concurrently; retry");
  } catch (err) { next(err); }
});

// POST /api/v1/companies/:id/agents — create agent for a company
const agentCreateSchema = z.object({
  name: z.string().min(1),
  role: z.string().min(1),
  systemPrompt: z.string().optional(),
  tools: z.array(z.string()).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  // BRA-P0-06a-2: ajan model kipi; null/yok = şirket ayarını miras al.
  modelMode: z.enum(MODEL_MODES).nullable().optional(),
  modelModeConfig: z.unknown().optional(),
});

/** Kip alanlarını Prisma verisine çevirir; geçersiz modelModeConfig -> 400. null = temizle. */
function agentModeFields(input: { modelMode?: ModelMode | null; modelModeConfig?: unknown }) {
  const out: { modelMode?: ModelMode | null; modelModeConfig?: Prisma.InputJsonValue | typeof Prisma.DbNull } = {};
  if (input.modelMode !== undefined) out.modelMode = input.modelMode;
  if (input.modelModeConfig !== undefined) {
    if (input.modelModeConfig === null) {
      out.modelModeConfig = Prisma.DbNull;
    } else {
      const v = validateModelModeConfigInput(input.modelModeConfig);
      if (!v.ok) throw new AppError(400, v.error);
      out.modelModeConfig = v.value as Prisma.InputJsonValue;
    }
  }
  return out;
}

const agentUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  role: z.string().min(1).optional(),
  systemPrompt: z.string().optional(),
  tools: z.array(z.string()).optional(),
  // Agent settings use the supported flat fields below; Agent has no config column.
  config: z.never({ error: "Agent config is not supported; use the supported agent fields" }).optional(),
  // Per-agent model override — when set, this agent uses this specific
  // model id instead of the tenant-wide default from Settings → AI
  // Provider. Lets a user run e.g. Memory Curator on cheap Gemma 3 4B
  // and Sales Outreach on premium Claude Sonnet inside the same company.
  model: z.string().min(1).max(100).optional(),
  maxTokens: z.number().int().min(100).max(200_000).optional(),
  // Graduated autonomy (Feature D6) — how eager this agent is to pause for
  // approval on non-money tools. Money always needs approval regardless.
  autonomy: z.enum(["SUPERVISED", "BALANCED", "AUTONOMOUS"]).optional(),
  // BRA-P0-06a-2: model kipi (DIRECT/CASCADE/COMPARE) ve kip ayarı; null = temizle (şirketi miras al).
  modelMode: z.enum(MODEL_MODES).nullable().optional(),
  modelModeConfig: z.unknown().optional(),
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
        ...agentModeFields(data),
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

// POST /api/v1/companies/:id/agents/compose — AI Agent Composer
//
// Takes a plain-English description, calls the tenant's configured LLM
// (BYOK Anthropic / OpenAI / Gemini / Groq / Ollama / etc.), and writes
// a complete agent (name, role, systemPrompt, tools) to the database.
//
// Tool whitelist is enforced — any tool name the LLM hallucinates is
// dropped during validation, returned in `droppedTools` so the user knows.
const agentComposeSchema = z.object({
  description: z.string().min(10).max(4000),
});

companyRouter.post("/:id/agents/compose", agentComposeLimiter, async (req, res, next) => {
  try {
    // Cast to string — when this endpoint chains through agentComposeLimiter
    // (rate-limit middleware), the inferred type of req.params.id widens to
    // `string | string[]` which Prisma rejects. Other endpoints in this file
    // skip the cast because they don't compose through this middleware.
    const companyId = req.params.id as string;
    const company = await prisma.company.findFirst({
      where: { id: companyId, tenantId: req.auth!.tenantId },
    });
    if (!company) throw new AppError(404, "Company not found");

    const { description } = agentComposeSchema.parse(req.body);
    let result;
    try {
      result = await composeAgent(req.auth!.tenantId, description);
    } catch (err) {
      // Surface common composer failures as 400 with actionable copy
      // instead of a generic 500. Two big buckets:
      //  - missing/invalid AI key → user must visit Settings
      //  - LLM returned non-JSON / bad shape → suggest a different provider
      const msg = err instanceof Error ? err.message : String(err);
      if (/no ai provider|api key|not initialized|configure/i.test(msg)) {
        throw new AppError(
          400,
          "Configure an AI provider in Settings → AI Provider before composing agents. Anthropic, OpenAI, Gemini, Groq, or self-hosted Ollama all work.",
        );
      }
      if (/json|valid agent spec|did not return/i.test(msg)) {
        throw new AppError(400, msg);
      }
      throw err;
    }

    const agent = await prisma.agent.create({
      data: {
        companyId: company.id,
        name: result.agent.name,
        role: result.agent.role,
        systemPrompt: result.agent.systemPrompt,
        tools: result.agent.tools as any,
      },
    });

    await prisma.activityLog.create({
      data: {
        tenantId: req.auth!.tenantId,
        actor: req.auth!.userId,
        action: "agent.compose",
        resource: "agent",
        resourceId: agent.id,
        details: {
          companyId: company.id,
          provider: result.provider,
          model: result.model,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          droppedTools: result.droppedTools,
          descriptionLength: description.length,
        },
      },
    });

    res.status(201).json({
      agent,
      droppedTools: result.droppedTools,
      provider: result.provider,
      model: result.model,
      tokens: { input: result.inputTokens, output: result.outputTokens },
    });
  } catch (err) { next(err); }
});

// PATCH /api/v1/companies/:companyId/agents/:agentId — update agent
companyRouter.patch("/:companyId/agents/:agentId", async (req, res, next) => {
  try {
    const { modelMode, modelModeConfig, ...updateData } = agentUpdateSchema.parse(req.body);
    const { agent: updated } = await updateAgentWithHistory({
      tenantId: req.auth!.tenantId,
      companyId: req.params.companyId,
      agentId: req.params.agentId,
      actor: req.auth!.userId,
      data: { ...updateData, tools: updateData.tools as any, ...agentModeFields({ modelMode, modelModeConfig }) },
      kind: "update",
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

// ─── Natural Language Agent Editing ─────────────────────────

const nlEditSchema = z.object({
  instruction: z.string().min(1).max(2000),
});

const nlEditApplySchema = z.object({
  updatedConfig: z.object({
    name: z.string().min(1),
    role: z.string().min(1),
    systemPrompt: z.string(),
    model: z.string(),
    temperature: z.number().min(0).max(2),
    maxTokens: z.number().int().min(100).max(200000),
    tools: z.array(z.string()),
  }),
});

// POST /api/v1/companies/:companyId/agents/:agentId/nl-edit — Preview NL edit
companyRouter.post("/:companyId/agents/:agentId/nl-edit", async (req, res, next) => {
  try {
    const company = await prisma.company.findFirst({
      where: { id: req.params.companyId, tenantId: req.auth!.tenantId },
    });
    if (!company) throw new AppError(404, "Company not found");

    const agent = await prisma.agent.findFirst({
      where: { id: req.params.agentId, companyId: company.id },
    });
    if (!agent) throw new AppError(404, "Agent not found");

    const { instruction } = nlEditSchema.parse(req.body);

    // Build current config from agent DB fields
    const agentTools = (Array.isArray(agent.tools) ? agent.tools : []) as string[];
    const currentConfig: AgentConfig = {
      name: agent.name,
      role: agent.role,
      systemPrompt: agent.systemPrompt,
      model: agent.model,
      temperature: 0.7, // default — not stored in DB
      maxTokens: agent.maxTokens,
      tools: agentTools,
    };

    const preview = applyNaturalLanguageEdit({ instruction, currentConfig });

    await prisma.activityLog.create({
      data: {
        tenantId: req.auth!.tenantId,
        actor: req.auth!.userId,
        action: "agent.nl-edit.preview",
        resource: "agent",
        resourceId: agent.id,
        details: {
          instruction,
          changesCount: preview.changes.length,
          fields: preview.changes.map((c) => c.field),
        },
      },
    });

    res.json({
      agentId: agent.id,
      preview,
    });
  } catch (err) { next(err); }
});

// POST /api/v1/companies/:companyId/agents/:agentId/nl-edit/apply — Apply previewed edit
companyRouter.post("/:companyId/agents/:agentId/nl-edit/apply", async (req, res, next) => {
  try {
    const { updatedConfig } = nlEditApplySchema.parse(req.body);
    const { agent: updated, version: nextVersion } = await updateAgentWithHistory({
      tenantId: req.auth!.tenantId,
      companyId: req.params.companyId,
      agentId: req.params.agentId,
      actor: req.auth!.userId,
      // Temperature is not persisted in the Agent schema.
      data: {
        name: updatedConfig.name,
        role: updatedConfig.role,
        systemPrompt: updatedConfig.systemPrompt,
        model: updatedConfig.model,
        maxTokens: updatedConfig.maxTokens,
        tools: updatedConfig.tools as any,
      },
      kind: "nl-edit",
      updatedFields: Object.keys(updatedConfig),
    });

    logger.info({ agentId: updated.id, version: nextVersion }, "NL edit applied to agent");

    res.json({
      success: true,
      agent: updated,
      version: nextVersion,
    });
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

    // Filter strictly by resourceId. Earlier this OR'd against a JSONB
    // path-equality on `details.companyId` — that branch is fragile
    // (any future writer that puts an attacker-controlled companyId
    // into the JSON blob without a tenant check would leak rows) and
    // it's also a planner pessimist: pgsql ends up sequential-scanning
    // activity_log because no GIN index covers the path expression.
    // The resourceId column is indexed and tenant-scoped — that's all
    // we need for the per-company timeline. Anything still writing
    // activity to `details.companyId` instead of `resourceId` is a
    // bug at the writer, not a query we should paper over here.
    const whereClause = {
      tenantId: req.auth!.tenantId,
      resourceId: company.id,
    };
    const logs = await prisma.activityLog.findMany({
      where: whereClause,
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
    });

    const total = await prisma.activityLog.count({ where: whereClause });

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
