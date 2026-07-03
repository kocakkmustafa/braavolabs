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
import { decryptForTenant } from "../../lib/encryption";
import { getProviderModels, isKnownProvider } from "./provider-models";

export const settingsRouter = Router();
settingsRouter.use(authMiddleware);

// ─── AI Provider Config ───────────────────────────────────

// GET /api/v1/settings/ai-config
// Returns current AI provider config. API key is masked.
settingsRouter.get("/ai-config", async (req, res, next) => {
  try {
    // Multi-key BYOK (E2/T6): one row per (tenant, provider) — this legacy
    // endpoint keeps its one-config contract by returning the DEFAULT row
    // (same resolution order as getTenantAIConfig).
    const aiConfig = await prisma.userAIConfig.findFirst({
      where: { tenantId: req.auth!.tenantId },
      orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    });

    if (!aiConfig) {
      // Return defaults — no key configured yet
      return res.json({
        provider: "ANTHROPIC",
        model: PROVIDER_DEFAULT_MODELS["ANTHROPIC"],
        hasApiKey: false,
        baseUrl: null,
        allowSystemFallback: false,
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
            try { return decryptForTenant(aiConfig.encryptedApiKey!, req.auth!.tenantId).slice(-4); }
            catch { return "????"; }
          })()
        : null,
      baseUrl: aiConfig.baseUrl ?? null,
      // E2/T7 — opt-in flag on the default row: may the failover chain fall
      // to the trial/system providers once the tenant's own links die?
      allowSystemFallback: aiConfig.allowSystemFallback ?? false,
      availableProviders: Object.keys(PROVIDER_DEFAULT_MODELS),
      availableModels: PROVIDER_MODELS,
      providerInfo: PROVIDER_INFO,
      defaultBaseUrls: PROVIDER_BASE_URLS,
    });
  } catch (err) { next(err); }
});

// GET /api/v1/settings/ai-config/providers  (E3/T5 — B5.2)
//
// The multi-BYOK LIST endpoint E2 never wrote: the schema moved to one row per
// (tenant, provider) but the settings router stayed single-config (GET/PUT/
// DELETE /ai-config all resolve the DEFAULT row only). E3 needs the full list
// so the HandoffPanel provider picker (and the CLI) can show every provider the
// tenant configured — this is that data source.
//
// Contract (packages/ui/lib/api.ts listProviderLinks): Bearer auth; returns
// `{ providers: [{ provider, model, isDefault, fallbackOrder, keyMasked }] }`.
// keyMasked is "sk-…abcd"-style (last 4 chars) or null for keyless-local rows —
// the plaintext apiKey is NEVER returned. Rows are ordered exactly like
// listTenantProviderLinks (default first, then fallbackOrder asc, then
// createdAt) so the picker's default is the picker's first entry.
settingsRouter.get("/ai-config/providers", async (req, res, next) => {
  try {
    const rows = await prisma.userAIConfig.findMany({
      where: { tenantId: req.auth!.tenantId },
    });

    const sorted = [...rows].sort((a, b) => {
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
      const ao = a.fallbackOrder ?? Number.MAX_SAFE_INTEGER;
      const bo = b.fallbackOrder ?? Number.MAX_SAFE_INTEGER;
      if (ao !== bo) return ao - bo;
      return a.createdAt.getTime() - b.createdAt.getTime();
    });

    const providers = sorted.map((row) => {
      // Mask the key: show only the last 4 plaintext chars behind a fixed dot
      // prefix. Never surfaces the ciphertext or the plaintext key. Keyless-
      // local rows (Ollama/LM Studio/Custom) legitimately have no key → null.
      let keyMasked: string | null = null;
      if (row.encryptedApiKey) {
        try {
          keyMasked = "••••" + decryptForTenant(row.encryptedApiKey, req.auth!.tenantId).slice(-4);
        } catch {
          keyMasked = "••••????";
        }
      }
      return {
        provider: row.provider,
        model: row.model,
        isDefault: row.isDefault,
        fallbackOrder: row.fallbackOrder,
        baseUrl: row.baseUrl ?? null,
        keyMasked,
      };
    });

    res.json({ providers });
  } catch (err) { next(err); }
});

// GET /api/v1/settings/ai-providers/:provider/models  (E2/T10 — API leg)
// Live model catalogue for one provider: JIT proxy of the provider's own
// /models listing using the tenant's stored BYOK key (5-minute cache),
// falling back to the static PROVIDER_MODELS catalogue whenever a live
// list can't be produced (no key, decrypt failure, timeout, non-2xx…).
//
// Contract with the Settings UI (packages/ui/app/settings/page.tsx
// loadProviderModels): Bearer auth; responds `{ models: string[] }` (plus
// provider/source metadata) with 200 on every outcome except an unknown
// provider id (400). It must NEVER 500 — the UI tolerates the fallback,
// but a 500 here would surface as a broken settings panel.
settingsRouter.get("/ai-providers/:provider/models", async (req, res) => {
  const provider = String(req.params.provider ?? "").trim().toUpperCase();
  if (!isKnownProvider(provider)) {
    return res.status(400).json({ error: `Unknown AI provider: ${provider || "(empty)"}`, models: [] });
  }

  try {
    const result = await getProviderModels(req.auth!.tenantId, provider);
    res.json(result);
  } catch (err) {
    // getProviderModels degrades internally on every upstream failure —
    // this catch is belt-and-suspenders against programmer errors so the
    // never-500 contract holds even then.
    logger.warn(
      { provider, err: err instanceof Error ? err.message : String(err) },
      "ai-providers/:provider/models fell through to the static catalogue",
    );
    res.json({ provider, models: PROVIDER_MODELS[provider], source: "static" });
  }
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
  // E2/T7 — opt-in: allow the failover chain to fall back to the trial /
  // system providers once the tenant's own links are exhausted. Stored on
  // the default row; omitted = keep the stored value (false by default).
  allowSystemFallback: z.boolean().optional(),
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
    const { provider, model, apiKey, baseUrl, allowSystemFallback } = aiConfigSchema.parse(req.body);
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
    //
    // Multi-key BYOK (E2/T6): the reusable key must belong to THIS
    // provider's row. (The old single-row code reused whatever key the
    // tenant had — switching provider without a key could silently pair
    // e.g. OpenAI with a Groq key and 401. Per-provider rows fix that:
    // switching to an unconfigured cloud provider without a key is 400.)
    if (!apiKey && !isLocal) {
      const existing = await prisma.userAIConfig.findUnique({
        where: { tenantId_provider: { tenantId: req.auth!.tenantId, provider } },
      });
      if (!existing?.encryptedApiKey) {
        throw new AppError(400, "API key is required when configuring a cloud provider for the first time");
      }
      // Update model/baseUrl, keep the existing encrypted key, and promote
      // this row to the tenant's default (demote-then-promote, same
      // invariant as saveTenantAIConfig — one default per tenant).
      await prisma.$transaction([
        prisma.userAIConfig.updateMany({
          where: { tenantId: req.auth!.tenantId, NOT: { provider }, isDefault: true },
          data: { isDefault: false },
        }),
        prisma.userAIConfig.update({
          where: { tenantId_provider: { tenantId: req.auth!.tenantId, provider } },
          data: {
            model,
            baseUrl: baseUrl || null,
            isDefault: true,
            ...(allowSystemFallback !== undefined ? { allowSystemFallback } : {}),
          },
        }),
      ]);
    } else {
      await saveTenantAIConfig(
        req.auth!.tenantId,
        provider as AIProviderType,
        model,
        apiKey || "",  // empty for local
        baseUrl || undefined,
        allowSystemFallback,
      );
    }

    await prisma.activityLog.create({
      data: {
        tenantId: req.auth!.tenantId,
        actor: req.auth!.userId,
        action: "settings.ai_config_update",
        resource: "ai_config",
        details: {
          provider,
          model,
          hasBaseUrl: !!baseUrl,
          ...(allowSystemFallback !== undefined ? { allowSystemFallback } : {}),
        },
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
