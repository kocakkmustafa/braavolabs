/**
 * Settings Router — AI provider config and other tenant settings.
 */

import { Router } from "express";
import { z } from "zod";
import { authMiddleware } from "../../middleware/auth";
import { AppError } from "../../middleware/error";
import { prisma } from "../../lib/db";
import { logger } from "../../lib/logger";
import {
  saveTenantAIConfig,
  PROVIDER_MODELS,
  PROVIDER_DEFAULT_MODELS,
  type AIProviderType,
} from "../../services/ai-client";
import { decrypt } from "../../lib/encryption";

export const settingsRouter = Router();
settingsRouter.use(authMiddleware);

// ─── AI Provider Config ───────────────────────────────────

// GET /api/v1/settings/ai-config
// Returns current AI provider config. API key is masked.
settingsRouter.get("/ai-config", async (req, res, next) => {
  try {
    const aiConfig = await prisma.userAIConfig.findUnique({
      where: { tenantId: req.auth!.tenantId },
    });

    if (!aiConfig) {
      // Return defaults — no key configured yet
      return res.json({
        provider: "ANTHROPIC",
        model: PROVIDER_DEFAULT_MODELS["ANTHROPIC"],
        hasApiKey: false,
        availableProviders: Object.keys(PROVIDER_DEFAULT_MODELS),
        availableModels: PROVIDER_MODELS,
      });
    }

    res.json({
      provider: aiConfig.provider,
      model: aiConfig.model,
      hasApiKey: !!aiConfig.encryptedApiKey,
      // Mask key — show last 4 chars only
      maskedApiKey: aiConfig.encryptedApiKey
        ? "••••••••" + (() => {
            try { return decrypt(aiConfig.encryptedApiKey!).slice(-4); }
            catch { return "????"; }
          })()
        : null,
      availableProviders: Object.keys(PROVIDER_DEFAULT_MODELS),
      availableModels: PROVIDER_MODELS,
    });
  } catch (err) { next(err); }
});

const aiConfigSchema = z.object({
  provider: z.enum(["ANTHROPIC", "OPENAI", "GOOGLE", "MISTRAL", "GROQ", "OPENROUTER"]),
  model: z.string().min(1),
  apiKey: z.string().min(8).optional(),
});

// PUT /api/v1/settings/ai-config
// Save AI provider selection and (optionally) API key.
settingsRouter.put("/ai-config", async (req, res, next) => {
  try {
    const { provider, model, apiKey } = aiConfigSchema.parse(req.body);

    // If no new API key provided, keep existing one
    if (!apiKey) {
      const existing = await prisma.userAIConfig.findUnique({
        where: { tenantId: req.auth!.tenantId },
      });
      if (!existing?.encryptedApiKey) {
        throw new AppError(400, "API key is required when configuring a provider for the first time");
      }
      // Just update provider/model, keep existing encrypted key
      await prisma.userAIConfig.update({
        where: { tenantId: req.auth!.tenantId },
        data: { provider, model },
      });
    } else {
      await saveTenantAIConfig(req.auth!.tenantId, provider as AIProviderType, model, apiKey);
    }

    await prisma.activityLog.create({
      data: {
        tenantId: req.auth!.tenantId,
        actor: req.auth!.userId,
        action: "settings.ai_config_update",
        resource: "ai_config",
        details: { provider, model },
      },
    });

    logger.info({ tenantId: req.auth!.tenantId, provider, model }, "AI config updated");
    res.json({ success: true, provider, model });
  } catch (err) { next(err); }
});

// DELETE /api/v1/settings/ai-config
// Remove AI config — revert to system default (Anthropic system key).
settingsRouter.delete("/ai-config", async (req, res, next) => {
  try {
    await prisma.userAIConfig.deleteMany({
      where: { tenantId: req.auth!.tenantId },
    });

    await prisma.activityLog.create({
      data: {
        tenantId: req.auth!.tenantId,
        actor: req.auth!.userId,
        action: "settings.ai_config_delete",
        resource: "ai_config",
      },
    });

    res.json({ success: true, message: "AI config removed. Using system default." });
  } catch (err) { next(err); }
});

// GET /api/v1/settings/ai-config/test
// Quick connectivity test — send a trivial message to the configured provider.
settingsRouter.post("/ai-config/test", async (req, res, next) => {
  try {
    const { getTenantAIConfig, chatCompletion } = await import("../../services/ai-client");
    const config = await getTenantAIConfig(req.auth!.tenantId);

    const result = await chatCompletion(
      config,
      "You are a helpful assistant.",
      [{ role: "user", content: "Reply with exactly: OK" }],
      16,
    );

    res.json({
      success: true,
      provider: config.provider,
      model: config.model,
      response: result.content.slice(0, 50),
    });
  } catch (err: any) {
    res.json({ success: false, error: err?.message ?? "Unknown error" });
  }
});
