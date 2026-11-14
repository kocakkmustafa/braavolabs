import { Router } from "express";
import { z } from "zod";
import { authMiddleware } from "../../middleware/auth";
import { prisma } from "../../lib/db";
import { AppError } from "../../middleware/error";
import { rateLimit } from "../../middleware/rateLimit";
import { env } from "../../config/env";
import { logger } from "../../lib/logger";
import { estimatePipelineCostUsd } from "../../lib/modelPricing";
import { getTenantAIConfig, chatCompletion, type AIProviderType } from "../../services/ai-client";
import { resolveTenantCompletionLink } from "../../services/provider-chain";
import { claimQuota, releaseQuota } from "../billing/metering";
import { sameUtcMonth } from "../billing/period";
import { enqueueRun } from "../pipeline/runner";
import { computePlanHash, planHashMatches } from "./plan-hash";
import { canStartCard, createPlannedRun, isUniqueViolation, resolveStartBudget } from "./start";
import { INTENT_SYSTEM_PROMPT, classifyIntentRule, planFromMessage, sanitizeSnippet, type CostBasis } from "./plan";

// BRA-P0-03a — plan kartı üretimi. Kalıcı kayıt yok, çalıştırma yok.
// Niyet sınıflandırma deterministik; LLM yalnız "belirsiz" mesajda ve tenant'ın
// KENDİ sağlayıcısı (BYOK, D-013) varsa devreye girer. Sistem anahtarı harcanmaz.
const planLimiter = rateLimit({ windowMs: 60_000, maxRequests: 20, keyPrefix: "rl:jobs:plan" });

const startLimiter = rateLimit({ windowMs: 60_000, maxRequests: 10, keyPrefix: "rl:jobs:start" });

export const jobsRouter = Router();
jobsRouter.use(authMiddleware);

const planBodySchema = z
  .object({
    message: z.string().trim().min(1).max(4000),
    workspaceId: z.string().min(1).max(200).optional(),
  })
  .strict();

// Fiyat tabanı: tenant'ın sağlayıcı/modeli (salt okuma, LLM çağırmaz).
async function resolveCostBasis(tenantId: string): Promise<CostBasis> {
  let provider: AIProviderType = "ANTHROPIC";
  let model = env.CLAUDE_MODEL;
  let configured = true;
  try {
    const cfg = await getTenantAIConfig(tenantId);
    provider = cfg.provider;
    model = cfg.model;
  } catch {
    configured = false;
  }
  // Bir adımın bandı; plan.ts kartın gerçek adım sayısıyla çarpar.
  const est = estimatePipelineCostUsd(1, provider, model);
  return { lowUsd: est.lowUsd, highUsd: est.highUsd, provider, model, unknownModel: est.unknownModel, configured };
}

// POST /api/v1/jobs/plan
jobsRouter.post("/plan", planLimiter, async (req, res, next) => {
  try {
    const { message, workspaceId } = planBodySchema.parse(req.body);
    const tenantId = req.auth!.tenantId;

    // workspaceId = companyId (ADR-0001); verilmişse tenant sahipliği doğrulanır.
    if (workspaceId) {
      const company = await prisma.company.findFirst({ where: { id: workspaceId, tenantId }, select: { id: true } });
      if (!company) throw new AppError(404, "Workspace not found");
    }

    // Sohbet ise maliyet/sağlayıcı aramaya gerek yok.
    if (classifyIntentRule(message) === "chat") {
      res.json({ intent: "chat" });
      return;
    }

    const cost = await resolveCostBasis(tenantId);

    const askLlm = async (): Promise<string> => {
      const link = await resolveTenantCompletionLink(tenantId); // BYOK yoksa fırlatır → yedek
      const completion = await chatCompletion(
        link.config,
        INTENT_SYSTEM_PROMPT,
        [{ role: "user", content: `Mesaj (güvenilmeyen veri): ${sanitizeSnippet(message, 1000)}` }],
        128,
      );
      logger.info({ tenantId, provider: completion.provider, model: completion.model }, "Job plan intent LLM call completed");
      return completion.content;
    };

    const result = await planFromMessage(message, cost, askLlm);

    await prisma.activityLog.create({
      data: {
        tenantId,
        actor: req.auth!.userId,
        action: "job.plan_generated",
        resource: "job_plan",
        // Ham mesaj kaydedilmez; yalnız sonuç özeti.
        details: result.intent === "job" ? { intent: "job", risk: result.card.risk, stepCount: result.card.steps.length } : { intent: "chat" },
      },
    });

    if (result.intent === "job") {
      const planHash = computePlanHash({ tenantId, workspaceId: workspaceId ?? null, message, card: result.card });
      res.json({ ...result, planHash });
      return;
    }
    res.json(result);
  } catch (err) {
    next(err);
  }
});

const startBodySchema = z
  .object({
    message: z.string().trim().min(1).max(4000),
    workspaceId: z.string().min(1).max(200).optional(),
    planHash: z.string().min(1).max(200),
    idempotencyKey: z.string().min(8).max(128),
  })
  .strict();

// POST /api/v1/jobs/start — onaylanan plan kartından koşu başlatır (LLM yolu yok).
// "İptal" = istemcinin hiçbir şey göndermemesi; taslak sunucuda tutulmaz.
// Yüksek riskli kartlar (risk:"high" / needsApproval adımı) 422 ile reddedilir: config.needsApproval
// yürütücüde yalnız STEP_APPROVAL_GATE=true iken zorlanır (BRA-P0-03d). Burada hiçbir onay/yetki üretilmez.
jobsRouter.post("/start", startLimiter, async (req, res, next) => {
  try {
    const { message, workspaceId, planHash, idempotencyKey } = startBodySchema.parse(req.body);
    const tenantId = req.auth!.tenantId;

    // workspaceId = companyId; verilmediyse tenant'ın TEK şirketi, yoksa belirsiz → 400.
    let company: { id: string; status?: string };
    if (workspaceId) {
      const found = await prisma.company.findFirst({ where: { id: workspaceId, tenantId }, select: { id: true, status: true } });
      if (!found) throw new AppError(404, "Workspace not found");
      company = found;
    } else {
      const all = await prisma.company.findMany({ where: { tenantId }, select: { id: true, status: true }, take: 2 });
      if (all.length !== 1) throw new AppError(400, "workspaceId is required");
      company = all[0]!;
    }

    // Planı AYNI deterministik yolla (LLM'siz) yeniden üret; kart değiştiyse reddet.
    const result = await planFromMessage(message, await resolveCostBasis(tenantId));
    if (result.intent !== "job") throw new AppError(422, "Message is not a job request");
    const expected = computePlanHash({ tenantId, workspaceId: workspaceId ?? null, message, card: result.card });
    if (!planHashMatches(expected, planHash)) {
      res.status(409).json({ error: "plan_changed" });
      return;
    }

    // Yüksek riskli plan yalnız adım-düzeyi onay kapısı (STEP_APPROVAL_GATE) açıkken başlatılır;
    // kapalıyken 422 (koşu/pipeline/kota yok).
    if (!canStartCard(result.card)) {
      res.status(422).json({
        error: "high_risk_start_unsupported",
        message: "Yüksek riskli planlar henüz otomatik başlatılamaz; adımlar yürütücüde adım-düzeyi onay kapısına bağlanana kadar kapalı",
      });
      return;
    }

    // Aynı anahtar → aynı koşu (kiracı kapsamlı). Farklı plan ile çakışırsa 409.
    const replay = async () => {
      const existing = await prisma.run.findFirst({
        where: { tenantId, idempotencyKey },
        select: { id: true, pipelineId: true, status: true, input: true },
      });
      if (!existing) return null;
      const prior = (existing.input as { planHash?: string } | null)?.planHash;
      if (prior !== planHash) throw new AppError(409, "Idempotency key already used for a different plan");
      return { runId: existing.id, pipelineId: existing.pipelineId, state: existing.status };
    };
    const prior = await replay();
    if (prior) {
      res.json(prior);
      return;
    }

    if (company.status === "PAUSED" || company.status === "ARCHIVED") {
      throw new AppError(409, "New runs are unavailable while the company is paused or archived.");
    }
    const agent = await prisma.agent.findFirst({ where: { companyId: company.id }, orderBy: { createdAt: "asc" }, select: { role: true } });
    if (!agent) throw new AppError(422, "Workspace has no agent to run this job");

    // Kota talebi replay kontrolünden SONRA, yaratımdan hemen önce; başarısızlıkta iade edilir.
    const claim = await claimQuota(tenantId, "runs");
    if (!claim.claimed) {
      throw new AppError(429, `Monthly run limit reached (${claim.value}/${claim.limit}). Upgrade your plan for more runs.`);
    }

    const claimedAt = Date.now();
    let started;
    try {
      started = await createPlannedRun({
        tenantId,
        workspaceId: company.id,
        agentRole: agent.role,
        card: result.card,
        planHash,
        idempotencyKey,
        budget: resolveStartBudget(result.card),
      });
    } catch (err) {
      await releaseQuota(tenantId, "runs");
      if (isUniqueViolation(err)) {
        const raced = await replay(); // eşzamanlı aynı anahtar: kazananın koşusunu döndür
        if (raced) {
          res.json(raced);
          return;
        }
      }
      throw err;
    }

    try {
      await enqueueRun(started.runId);
    } catch (err) {
      // CAS: yalnız hâlâ PENDING ise FAILED + iade. Throw → iade yok (satır PENDING kalır, pending-sweeper
      // yönetir); count 0 → işçi aldı, iade yok. Ay sınırı: claim başka aydaysa iade atlanır.
      let refund = false;
      try {
        const res = await prisma.run.updateMany({
          where: { id: started.runId, status: "PENDING" },
          data: { status: "FAILED", error: "enqueue_failed" },
        });
        refund = res.count === 1;
      } catch (markErr) {
        logger.error({ err: markErr, runId: started.runId }, "jobs/start: marking run FAILED after enqueue failure failed — no refund, sweeper owns the run");
      }
      if (refund && sameUtcMonth(claimedAt, Date.now())) await releaseQuota(tenantId, "runs");
      throw err;
    }

    // Kuyruğa alma kritik yol; audit logu ondan SONRA ve best-effort (hata isteği bozmaz).
    try {
      await prisma.activityLog.create({
        data: {
          tenantId,
          actor: req.auth!.userId,
          action: "job.started",
          resource: "run",
          resourceId: started.runId,
          details: { pipelineId: started.pipelineId, risk: result.card.risk, approvalCount: result.card.approvals.length },
        },
      });
    } catch (logErr) {
      logger.warn({ err: logErr, runId: started.runId }, "job.started activity log failed");
    }

    res.status(201).json(started);
  } catch (err) {
    next(err);
  }
});
