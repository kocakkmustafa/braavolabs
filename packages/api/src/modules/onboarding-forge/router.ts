/**
 * Onboarding Router — Forge wizard (FAZ1-1C).
 *
 * A SEPARATE surface from modules/onboarding/router.ts (Faz-8's "hero social
 * media company" onboarding, incl. its own /validate-key). That router is
 * NOT touched or reused by this file — this is a new, independent Forge
 * provider-setup wizard: curated free-tier-friendly provider catalogue →
 * validate a key (or try Braavolabs' own trial-funded key, gated by the
 * trial-credit cap) → save via the SAME saveTenantAIConfig/encryptForTenant
 * path settings/router.ts uses (no new crypto) → wizard progress status.
 *
 * Mounted at /api/v1/onboarding/forge (see index.ts).
 */

import { Router } from "express";
import type { RequestHandler } from "express";
import { z } from "zod";
import { authMiddleware } from "../../middleware/auth";
import { rateLimit } from "../../middleware/rateLimit";
import { AppError } from "../../middleware/error";
import { prisma } from "../../lib/db";
import { logger } from "../../lib/logger";
import { roleCan, type AppRole } from "../../lib/rbac";
import {
  chatCompletion,
  saveTenantAIConfig,
  PROVIDER_DEFAULT_MODELS,
  PROVIDER_INFO,
  LOCAL_PROVIDERS,
  type AIClientConfig,
  type AIProviderType,
} from "../../services/ai-client";
import { classifyProviderError } from "../../services/provider-chain";
import { isKnownProvider } from "../settings/provider-models";
import {
  hasSystemHeldKey,
  runForgeTrialCompletion,
  getForgeTrialCreditStatus,
  TrialCreditExhaustedError,
  NoSystemHeldKeyError,
} from "../billing/trial-credit.service";

export const onboardingForgeRouter = Router();
onboardingForgeRouter.use(authMiddleware);

// ─── Provider catalogue (Bölüm A.1) ───────────────────────
//
// STATIC curated data — Forge-verified free-tier-friendly providers only.
// Text is deliberately built from PROVIDER_INFO (ai-client.ts)'s existing,
// already-vetted setupHint strings rather than inventing new numeric tier
// claims here: where PROVIDER_INFO doesn't itself state a concrete free-tier
// number, this appends a generic "check the provider" disclaimer instead of
// guessing. Braavolabs does not control or guarantee any third party's free
// tier — it can change without notice.

export interface ForgeCatalogEntry {
  provider: AIProviderType;
  displayName: string;
  freeTierFacts: string;
  keyCreationUrl: string;
  /** "oauth-google" — the client performs a Google-delegated OAuth popup and
   * mints an API key without the user ever seeing raw key text (client-side
   * flow; NOT implemented by this API — see router docblock / final report).
   * "manual-guided" — every other provider: the wizard walks the user
   * through `guideSteps` to a page where they copy/paste a key. */
  keyCreationMode: "oauth-google" | "manual-guided";
  guideSteps: string[];
  /** Braavolabs holds a system key for this provider — enables
   * POST /validate { useSystemTrialKey: true } (gated by the Forge
   * trial-credit cap; see modules/billing/trial-credit.service.ts). */
  systemTrialAvailable: boolean;
}

const GENERIC_FREE_TIER_DISCLAIMER =
  "Free tier available — exact limits are set by the provider and can change; check their site for current details.";

function buildForgeCatalog(): ForgeCatalogEntry[] {
  return [
    {
      provider: "CEREBRAS",
      displayName: PROVIDER_INFO.CEREBRAS.label,
      freeTierFacts: PROVIDER_INFO.CEREBRAS.setupHint,
      keyCreationUrl: "https://cloud.cerebras.ai",
      keyCreationMode: "manual-guided",
      guideSteps: [
        "Go to cloud.cerebras.ai and create a free account",
        "Open the API Keys section of the dashboard",
        "Create a new key and copy it",
        "Paste it below — Braavolabs stores it encrypted, never in plaintext",
      ],
      systemTrialAvailable: hasSystemHeldKey("CEREBRAS"),
    },
    {
      provider: "GROQ",
      displayName: PROVIDER_INFO.GROQ.label,
      freeTierFacts: `${PROVIDER_INFO.GROQ.setupHint}. ${GENERIC_FREE_TIER_DISCLAIMER}`,
      keyCreationUrl: "https://console.groq.com/keys",
      keyCreationMode: "manual-guided",
      guideSteps: [
        "Go to console.groq.com and sign in (or create an account)",
        "Open API Keys",
        "Create a new key and copy it",
        "Paste it below — Braavolabs stores it encrypted, never in plaintext",
      ],
      systemTrialAvailable: hasSystemHeldKey("GROQ"),
    },
    {
      provider: "GOOGLE",
      displayName: PROVIDER_INFO.GOOGLE.label,
      freeTierFacts: `${PROVIDER_INFO.GOOGLE.setupHint}. ${GENERIC_FREE_TIER_DISCLAIMER}`,
      keyCreationUrl: "https://aistudio.google.com/apikey",
      // The only oauth-delegated provider (task requirement) — the CLIENT
      // performs a Google OAuth popup against apikeys.googleapis.com and
      // mints a key without a manual copy/paste step. This API only ever
      // receives the resulting key at /validate; it does not perform or
      // proxy the OAuth flow itself (see final report — conscious gap,
      // client-side responsibility).
      keyCreationMode: "oauth-google",
      guideSteps: [
        "Sign in with Google when prompted",
        "Approve Braavolabs' request to create an AI Studio API key on your behalf",
        "The key is created and filled in automatically",
      ],
      systemTrialAvailable: hasSystemHeldKey("GOOGLE"),
    },
    {
      provider: "ZHIPU",
      displayName: PROVIDER_INFO.ZHIPU.label,
      freeTierFacts: PROVIDER_INFO.ZHIPU.setupHint,
      keyCreationUrl: "https://z.ai",
      keyCreationMode: "manual-guided",
      guideSteps: [
        "Go to z.ai and create a free account",
        "Open the API keys page",
        "Create a new key and copy it",
        "Paste it below — Braavolabs stores it encrypted, never in plaintext",
      ],
      systemTrialAvailable: hasSystemHeldKey("ZHIPU"),
    },
    {
      provider: "OPENROUTER",
      displayName: PROVIDER_INFO.OPENROUTER.label,
      freeTierFacts: `${PROVIDER_INFO.OPENROUTER.setupHint}. Includes several ":free"-suffixed models at $0 cost — availability and limits vary by model; check openrouter.ai.`,
      keyCreationUrl: "https://openrouter.ai/keys",
      keyCreationMode: "manual-guided",
      guideSteps: [
        "Go to openrouter.ai and create a free account",
        "Open the Keys page",
        "Create a new key and copy it",
        "Paste it below — Braavolabs stores it encrypted, never in plaintext",
      ],
      systemTrialAvailable: hasSystemHeldKey("OPENROUTER"),
    },
  ];
}

// GET /api/v1/onboarding/forge/catalog
onboardingForgeRouter.get("/catalog", async (_req, res, next) => {
  try {
    res.json({ providers: buildForgeCatalog() });
  } catch (err) { next(err); }
});

// ─── Key validation + optional trial + optional save (Bölüm A.2/A.3) ──────

/** Strip anything that could leak the plaintext key (or a partial echo of
 * it some providers include in their error body) out of a provider error
 * message before it goes back to the client or into a log line. Duplicated
 * (not imported) from modules/onboarding/router.ts on purpose — this router
 * is an intentionally independent surface. */
function sanitizeValidationReason(message: string, apiKey: string | undefined): string {
  let msg = message.slice(0, 300);
  // P3 hardening (Opus adversarial review, 2026-07-23): threshold lowered
  // from 6→4. Real provider keys are always far longer than 4 chars, so this
  // is a defensive margin, not a behavior change for any real key — a 4-6
  // char threshold makes no practical difference to what gets redacted in
  // production, it only widens the (already-narrow) window that a
  // deliberately short test/malformed key still gets exact-match redacted.
  // Kept above ~3 so we don't start over-redacting common short substrings
  // that could legitimately appear in a provider's error prose.
  if (apiKey && apiKey.length >= 4) {
    msg = msg.split(apiKey).join("[REDACTED]");
  }
  msg = msg.replace(/\b(sk|pk|sess|key|token|bearer)[-_ ][A-Za-z0-9_-]{6,}\b/gi, "[REDACTED]");
  return msg;
}

const validateLimiter = rateLimit({
  windowMs: 60_000,
  maxRequests: 5,
  keyPrefix: "rl:onboarding-forge:validate",
});

const requireForgeSaveRole: RequestHandler = (req, res, next) => {
  if (req.body?.save !== true) {
    next();
    return;
  }
  if (!req.auth) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  if (!roleCan(req.auth.role as AppRole, "settings:ai-config")) {
    res.status(403).json({ error: "Insufficient permissions" });
    return;
  }
  next();
};

const validateSchema = z.object({
  provider: z.string().min(1),
  apiKey: z.string().min(1).optional(),
  // Required for CUSTOM, optional override for OLLAMA/LMSTUDIO.
  baseUrl: z.string().url().optional().or(z.literal("")),
  // Bölüm B wiring point: skip the tenant's own key entirely and try
  // Braavolabs' held key for this provider, gated by the trial-credit cap.
  useSystemTrialKey: z.boolean().optional().default(false),
  // Bölüm A.3 — validate→save in one round trip. Ignored when
  // useSystemTrialKey is set (a trial call never persists a tenant config).
  save: z.boolean().optional().default(false),
  model: z.string().optional(),
  allowSystemFallback: z.boolean().optional(),
});

// POST /api/v1/onboarding/forge/validate
//
// Always 200 on a completed check (provider/trial rejection is a *result*,
// not an HTTP error) — 400 only for malformed input. Response shape:
//   { valid, provider, reason?, saved?, trial?, trialExhausted?, costUsd? }
onboardingForgeRouter.post("/validate", requireForgeSaveRole, validateLimiter, async (req, res, next) => {
  try {
    const parsed = validateSchema.parse(req.body);
    const provider = parsed.provider.trim().toUpperCase();

    if (!isKnownProvider(provider)) {
      throw new AppError(400, `Unknown AI provider: ${provider}`);
    }

    const isLocal = LOCAL_PROVIDERS.has(provider);
    const tenantId = req.auth!.tenantId;

    // ── Trial path: dial Braavolabs' own held key, gated by trial-credit ──
    if (parsed.useSystemTrialKey) {
      if (isLocal) {
        throw new AppError(400, "Local providers don't use a system trial key — set a base URL instead.");
      }
      if (!hasSystemHeldKey(provider)) {
        return res.json({
          valid: false,
          provider,
          trial: true,
          reason: "Braavolabs holds no trial key for this provider yet — add your own API key instead.",
        });
      }

      try {
        const result = await runForgeTrialCompletion(
          tenantId,
          provider,
          PROVIDER_DEFAULT_MODELS[provider],
          "You are a connectivity check.",
          [{ role: "user", content: "Reply with exactly: OK" }],
          16,
        );
        logger.info(
          { tenantId, provider, costUsd: result.costUsd },
          "onboarding_forge.validate trial call succeeded",
        );
        return res.json({ valid: true, provider, trial: true, costUsd: result.costUsd });
      } catch (err) {
        if (err instanceof TrialCreditExhaustedError) {
          logger.info({ tenantId, provider }, "onboarding_forge.validate trial refused — credit exhausted/disabled");
          return res.json({
            valid: false,
            provider,
            trial: true,
            trialExhausted: true,
            reason: err.message,
          });
        }
        if (err instanceof NoSystemHeldKeyError) {
          return res.json({ valid: false, provider, trial: true, reason: err.message });
        }
        const classification = classifyProviderError(err);
        const rawMessage = err instanceof Error ? err.message : "Unknown error";
        const reason = sanitizeValidationReason(rawMessage, undefined);
        logger.info(
          { tenantId, provider, classification },
          "onboarding_forge.validate trial call failed",
        );
        return res.json({ valid: false, provider, trial: true, reason });
      }
    }

    // ── Candidate-key path: the tenant's OWN key, never persisted here ──
    if (!isLocal && !parsed.apiKey) {
      throw new AppError(400, "apiKey is required to validate a cloud provider");
    }
    if (provider === "CUSTOM" && !parsed.baseUrl) {
      throw new AppError(400, "Custom provider requires a base URL to validate");
    }

    const config: AIClientConfig = {
      provider,
      model: PROVIDER_DEFAULT_MODELS[provider],
      apiKey: parsed.apiKey ?? "",
      baseUrl: parsed.baseUrl || undefined,
    };

    try {
      // 1-token ping — same cheap-connectivity-test transport as
      // settings/router.ts's POST /ai-config/test.
      await chatCompletion(
        config,
        "You are a connectivity check.",
        [{ role: "user", content: "Reply with exactly: OK" }],
        8,
      );
    } catch (err) {
      const classification = classifyProviderError(err);
      const rawMessage = err instanceof Error ? err.message : "Unknown error";
      const reason = sanitizeValidationReason(rawMessage, parsed.apiKey);
      logger.info({ tenantId, provider, classification }, "onboarding_forge.validate failed");
      return res.json({ valid: false, provider, reason });
    }

    // Valid. Optionally persist — reuses saveTenantAIConfig/encryptForTenant
    // verbatim (no new crypto), same as settings/router.ts PUT /ai-config.
    let saved = false;
    if (parsed.save) {
      const model = parsed.model || PROVIDER_DEFAULT_MODELS[provider];
      await saveTenantAIConfig(
        tenantId,
        provider as AIProviderType,
        model,
        parsed.apiKey || "",
        parsed.baseUrl || undefined,
        parsed.allowSystemFallback,
      );
      await prisma.activityLog.create({
        data: {
          tenantId,
          actor: req.auth!.userId,
          action: "onboarding_forge.provider_saved",
          resource: "ai_config",
          details: { provider, model },
        },
      });
      saved = true;
    }

    logger.info({ tenantId, provider, saved }, "onboarding_forge.validate succeeded");
    res.json({ valid: true, provider, saved });
  } catch (err) { next(err); }
});

// ─── Wizard progress (Bölüm A.4) ──────────────────────────
//
// Deliberately separate from modules/onboarding/router.ts's GET /status
// (Faz-8's hero-company checklist) — this is the Forge provider-setup
// wizard's own progress: how many providers the tenant has configured plus
// where they stand on the trial-credit allowance.

onboardingForgeRouter.get("/status", async (req, res, next) => {
  try {
    const tenantId = req.auth!.tenantId;
    const [providersConfigured, trialCredit] = await Promise.all([
      prisma.userAIConfig.count({ where: { tenantId } }),
      getForgeTrialCreditStatus(tenantId),
    ]);

    res.json({
      providersConfigured,
      hasDefaultProvider: providersConfigured > 0,
      trialCredit,
    });
  } catch (err) { next(err); }
});
