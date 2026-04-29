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
  PROVIDER_INFO,
  PROVIDER_BASE_URLS,
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
        baseUrl: null,
        availableProviders: Object.keys(PROVIDER_DEFAULT_MODELS),
        availableModels: PROVIDER_MODELS,
        providerInfo: PROVIDER_INFO,
        defaultBaseUrls: PROVIDER_BASE_URLS,
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
      baseUrl: aiConfig.baseUrl ?? null,
      availableProviders: Object.keys(PROVIDER_DEFAULT_MODELS),
      availableModels: PROVIDER_MODELS,
      providerInfo: PROVIDER_INFO,
      defaultBaseUrls: PROVIDER_BASE_URLS,
    });
  } catch (err) { next(err); }
});

const LOCAL_PROVIDER_LITERALS = ["OLLAMA", "LMSTUDIO", "CUSTOM"] as const;
const aiConfigSchema = z.object({
  provider: z.enum([
    "ANTHROPIC", "OPENAI", "GOOGLE", "MISTRAL", "GROQ", "OPENROUTER",
    "OLLAMA", "LMSTUDIO", "CUSTOM",
  ]),
  model: z.string().min(1),
  apiKey: z.string().min(8).optional(),
  // Custom base URL — required for CUSTOM, optional for OLLAMA/LMSTUDIO
  // (defaults to localhost:11434/1234), optional for cloud providers
  // (rare but useful for Azure/LiteLLM-shim users).
  baseUrl: z.string().url().optional().or(z.literal("")),
});

// Plans that may configure self-hosted LLM providers (Ollama, LM Studio,
// Custom). FREE plan keeps it simple — cloud BYOK only. CREATOR+ unlocks
// self-hosted endpoints. The frontend mirrors this list in LOCAL_LLM_PLANS.
//
// IMPORTANT: these names MUST match the Plan enum in
// packages/db/prisma/schema.prisma exactly. The previous version
// referenced STARTER/TEAM which don't exist — that bug would have
// rejected every paying customer's first self-hosted save with a 402.
const LOCAL_LLM_PLANS: ReadonlySet<string> = new Set([
  "CREATOR", "PRO", "BUSINESS", "ENTERPRISE",
]);

// PUT /api/v1/settings/ai-config
// Save AI provider selection and (optionally) API key + base URL.
settingsRouter.put("/ai-config", async (req, res, next) => {
  try {
    const { provider, model, apiKey, baseUrl } = aiConfigSchema.parse(req.body);
    const isLocal = (LOCAL_PROVIDER_LITERALS as readonly string[]).includes(provider);

    // Plan gate — self-hosted providers are CREATOR+ only. FREE-plan
    // tenants who attempt OLLAMA/LMSTUDIO/CUSTOM get a 402 with a
    // pointer to /pricing. Mirrors the UI guard.
    if (isLocal) {
      const tenant = await prisma.tenant.findUnique({
        where: { id: req.auth!.tenantId },
        select: { plan: true },
      });
      if (!tenant || !LOCAL_LLM_PLANS.has(tenant.plan)) {
        throw new AppError(
          402,
          "Self-hosted LLM providers (Ollama / LM Studio / Custom) require a Creator plan or higher. Visit /pricing to upgrade."
        );
      }
    }

    // CUSTOM requires a baseUrl on first save (no fallback default).
    if (provider === "CUSTOM" && !baseUrl) {
      throw new AppError(400, "Custom provider requires a base URL.");
    }

    // Local providers don't need an API key. Cloud providers do — but
    // only on first save (subsequent updates can reuse the existing
    // encrypted key by omitting apiKey).
    if (!apiKey && !isLocal) {
      const existing = await prisma.userAIConfig.findUnique({
        where: { tenantId: req.auth!.tenantId },
      });
      if (!existing?.encryptedApiKey) {
        throw new AppError(400, "API key is required when configuring a cloud provider for the first time");
      }
      // Just update provider/model/baseUrl, keep existing encrypted key
      await prisma.userAIConfig.update({
        where: { tenantId: req.auth!.tenantId },
        data: { provider, model, baseUrl: baseUrl || null },
      });
    } else {
      await saveTenantAIConfig(
        req.auth!.tenantId,
        provider as AIProviderType,
        model,
        apiKey || "",  // empty for local
        baseUrl || undefined,
      );
    }

    await prisma.activityLog.create({
      data: {
        tenantId: req.auth!.tenantId,
        actor: req.auth!.userId,
        action: "settings.ai_config_update",
        resource: "ai_config",
        details: { provider, model, hasBaseUrl: !!baseUrl },
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
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.json({ success: false, error: message });
  }
});
