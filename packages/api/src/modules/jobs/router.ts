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
import { INTENT_SYSTEM_PROMPT, classifyIntentRule, planFromMessage, sanitizeSnippet, type CostBasis } from "./plan";

// BRA-P0-03a — plan kartı üretimi. Kalıcı kayıt yok, çalıştırma yok.
// Niyet sınıflandırma deterministik; LLM yalnız "belirsiz" mesajda ve tenant'ın
// KENDİ sağlayıcısı (BYOK, D-013) varsa devreye girer. Sistem anahtarı harcanmaz.
const planLimiter = rateLimit({ windowMs: 60_000, maxRequests: 20, keyPrefix: "rl:jobs:plan" });

export const jobsRouter = Router();
jobsRouter.use(authMiddleware);

const planBodySchema = z
  .object({
    message: z.string().trim().min(1).max(4000),
    workspaceId: z.string().min(1).max(200).optional(),
  })
  .strict();

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

    // Fiyat tabanı: tenant'ın sağlayıcı/modeli (salt okuma, LLM çağırmaz).
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
    const cost: CostBasis = {
      lowUsd: est.lowUsd,
      highUsd: est.highUsd,
      provider,
      model,
      unknownModel: est.unknownModel,
      configured,
    };

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

    res.json(result);
  } catch (err) {
    next(err);
  }
});
