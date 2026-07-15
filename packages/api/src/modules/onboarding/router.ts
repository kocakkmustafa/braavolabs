/**
 * Onboarding Router — Faz 8
 *
 * Free plan onboarding: auto-creates hero social media company
 * with content pipeline pre-configured.
 */

import { Router } from "express";
import { z } from "zod";
import { authMiddleware } from "../../middleware/auth";
import { rateLimit } from "../../middleware/rateLimit";
import { prisma } from "../../lib/db";
import { logger } from "../../lib/logger";
import { AppError } from "../../middleware/error";
import {
  chatCompletion,
  PROVIDER_DEFAULT_MODELS,
  LOCAL_PROVIDERS,
  type AIClientConfig,
} from "../../services/ai-client";
import { classifyProviderError } from "../../services/provider-chain";
import { isKnownProvider } from "../settings/provider-models";

export const onboardingRouter = Router();
onboardingRouter.use(authMiddleware);

// GET /api/v1/onboarding/status — check onboarding state
onboardingRouter.get("/status", async (req, res, next) => {
  try {
    const tenantId = req.auth!.tenantId;

    const [companyCount, hasRuns] = await Promise.all([
      prisma.company.count({ where: { tenantId } }),
      prisma.run.count({
        where: { pipeline: { company: { tenantId } } },
        take: 1,
      }),
    ]);

    const steps = {
      accountCreated: true,
      heroCompanyCreated: companyCount > 0,
      firstPipelineRun: hasRuns > 0,
      firstDraftCreated: false,
    };

    // Check for first draft
    if (companyCount > 0) {
      const draftCount = await prisma.draft.count({
        where: { company: { tenantId } },
        take: 1,
      });
      steps.firstDraftCreated = draftCount > 0;
    }

    const completedSteps = Object.values(steps).filter(Boolean).length;
    const totalSteps = Object.keys(steps).length;

    res.json({
      completed: completedSteps === totalSteps,
      progress: completedSteps / totalSteps,
      steps,
    });
  } catch (err) { next(err); }
});

// POST /api/v1/onboarding/hero-company — create hero social media company
const heroSchema = z.object({
  companyName: z.string().min(1).default("My AI Social Agency"),
  niche: z.string().optional(),
  targetAudience: z.string().optional(),
});

onboardingRouter.post("/hero-company", async (req, res, next) => {
  try {
    const tenantId = req.auth!.tenantId;
    const { companyName, niche, targetAudience } = heroSchema.parse(req.body);

    // Check plan limit
    const existingCompanies = await prisma.company.count({
      where: { tenantId },
    });

    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { plan: true },
    });

    if (tenant?.plan === "FREE" && existingCompanies >= 1) {
      throw new AppError(
        403,
        "Free plan allows only 1 company. Upgrade to Pro for more.",
      );
    }

    // Create the hero company from template
    const slug = companyName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");

    const description = [
      `AI-powered social media management company`,
      niche && `specializing in ${niche}`,
      targetAudience && `targeting ${targetAudience}`,
    ]
      .filter(Boolean)
      .join(", ");

    const company = await prisma.company.create({
      data: {
        tenantId,
        name: companyName,
        slug: `${slug}-${Date.now().toString(36)}`,
        description,
        primitives: ["CONTENT", "ACQUISITION", "ANALYTICS", "DELIVERY"],
        status: "ACTIVE",
        config: {
          channels: ["tiktok", "linkedin"],
          postingFrequency: "daily",
          niche: niche ?? "general",
          targetAudience: targetAudience ?? "B2B professionals",
        },
      },
    });

    // Create agents
    const contentAgent = await prisma.agent.create({
      data: {
        companyId: company.id,
        name: "Content Creator",
        role: "content_creator",
        systemPrompt: [
          `You are a social media content creator for "${companyName}".`,
          niche ? `Your niche is: ${niche}.` : "",
          targetAudience ? `Target audience: ${targetAudience}.` : "",
          "",
          "You create engaging social media posts for TikTok and LinkedIn.",
          "Always explain your reasoning for content decisions.",
          "Use trends analysis to inform your content strategy.",
          "Create drafts and schedule them for optimal engagement times.",
        ]
          .filter(Boolean)
          .join("\n"),
        tools: [
          "generate_post",
          "create_draft",
          "schedule_content",
          "analyze_trends",
          "store_memory",
          "recall_memory",
        ],
        model: "claude-sonnet-4-20250514",
        maxTokens: 4096,
      },
    });

    const analyticsAgent = await prisma.agent.create({
      data: {
        companyId: company.id,
        name: "Analytics Agent",
        role: "analytics",
        systemPrompt: [
          `You are the analytics agent for "${companyName}".`,
          "You analyze trends, track performance metrics, and generate reports.",
          "Always provide data-driven insights with clear reasoning.",
          "Compare performance across periods to identify growth opportunities.",
        ].join("\n"),
        tools: [
          "fetch_metrics",
          "generate_report",
          "compare_performance",
          "recall_memory",
        ],
        model: "claude-sonnet-4-20250514",
        maxTokens: 4096,
      },
    });

    // Create daily content pipeline
    const pipeline = await prisma.pipeline.create({
      data: {
        companyId: company.id,
        name: "Daily Content Pipeline",
        trigger: "SCHEDULED",
        schedule: "0 9 * * *",
        steps: [
          {
            name: "analyze_trends",
            agentRole: "analytics",
            order: 1,
            config: { lookbackDays: 7 },
          },
          {
            name: "create_content",
            agentRole: "content_creator",
            order: 2,
            config: { platforms: ["tiktok", "linkedin"], count: 2 },
          },
          {
            name: "review_draft",
            agentRole: "content_creator",
            order: 3,
            config: { autoApprove: false },
          },
        ],
      },
    });

    // Log onboarding activity
    await prisma.activityLog.create({
      data: {
        tenantId,
        actor: req.auth!.userId,
        action: "onboarding.hero_company_created",
        resource: "company",
        resourceId: company.id,
        details: { niche, targetAudience, template: "hero_social_media" },
      },
    });

    logger.info(
      { tenantId, companyId: company.id },
      "Hero company created via onboarding",
    );

    res.status(201).json({
      company,
      agents: [contentAgent, analyticsAgent],
      pipeline,
      nextStep: "Run your first pipeline to generate content!",
    });
  } catch (err) { next(err); }
});

// ─── Key validation (FAZ-A 1C) ─────────────────────────────
//
// POST /api/v1/onboarding/validate-key — lets the onboarding wizard check
// a provider API key BEFORE the tenant commits to saving it (PUT
// /settings/ai-config). Never persists, never logs, never echoes the raw
// key back — it only ever answers "does this key work".
//
// Validation call: the cheapest real request that proves the key is live —
// a 1-token chat completion via the SAME chatCompletion() transport every
// other AI surface in this codebase uses (ai-config/test in settings/router
// is the established sibling pattern; this just skips the persistence step
// and takes the key straight from the request body instead of storage).

/** Strip anything that could leak the plaintext key (or a partial echo of
 * it some providers include in their error body, e.g. "Incorrect API key
 * provided: sk-ab…yz") out of a provider error message before it goes back
 * to the client or into a log line. */
function sanitizeValidationReason(message: string, apiKey: string | undefined): string {
  let msg = message.slice(0, 300);
  if (apiKey && apiKey.length >= 6) {
    msg = msg.split(apiKey).join("[REDACTED]");
  }
  // Generic secret-shaped token catch-all (sk-…, pk-…, Bearer …, etc.) for
  // any partial-echo shape we didn't anticipate above.
  msg = msg.replace(/\b(sk|pk|sess|key|token|bearer)[-_ ][A-Za-z0-9_-]{6,}\b/gi, "[REDACTED]");
  return msg;
}

const validateKeyLimiter = rateLimit({
  windowMs: 60_000,
  maxRequests: 5,
  keyPrefix: "rl:onboarding:validate-key",
});

const validateKeySchema = z.object({
  provider: z.string().min(1),
  apiKey: z.string().min(1).optional(),
  // Required for CUSTOM, optional self-hosted override for OLLAMA/LMSTUDIO.
  baseUrl: z.string().url().optional().or(z.literal("")),
});

// POST /api/v1/onboarding/validate-key
// Auth'lu, tenant-scoped, rate-limited. Body: { provider, apiKey?, baseUrl? }.
// Response: { valid: boolean, provider, reason? } — always 200 on a
// completed check (provider rejection is a *result*, not an HTTP error);
// 400 only for malformed input (unknown provider, missing required field).
onboardingRouter.post("/validate-key", validateKeyLimiter, async (req, res, next) => {
  try {
    const { provider: rawProvider, apiKey, baseUrl } = validateKeySchema.parse(req.body);
    const provider = rawProvider.trim().toUpperCase();

    if (!isKnownProvider(provider)) {
      throw new AppError(400, `Unknown AI provider: ${provider}`);
    }

    const isLocal = LOCAL_PROVIDERS.has(provider);
    if (!isLocal && !apiKey) {
      throw new AppError(400, "apiKey is required to validate a cloud provider");
    }
    if (provider === "CUSTOM" && !baseUrl) {
      throw new AppError(400, "Custom provider requires a base URL to validate");
    }

    const config: AIClientConfig = {
      provider,
      model: PROVIDER_DEFAULT_MODELS[provider],
      apiKey: apiKey ?? "",
      baseUrl: baseUrl || undefined,
    };

    try {
      // 1-token ping — cheapest real call that proves the key/endpoint works
      // across every provider transport (Anthropic SDK + every OpenAI-
      // compatible fetch path) without a bespoke per-provider request.
      await chatCompletion(
        config,
        "You are a connectivity check.",
        [{ role: "user", content: "Reply with exactly: OK" }],
        8,
      );

      logger.info(
        { tenantId: req.auth!.tenantId, provider },
        "onboarding.validate_key succeeded",
      );
      res.json({ valid: true, provider });
    } catch (err) {
      const classification = classifyProviderError(err);
      const rawMessage = err instanceof Error ? err.message : "Unknown error";
      const reason = sanitizeValidationReason(rawMessage, apiKey);

      // Log the classification only — never the (potentially key-bearing)
      // raw provider message, and the key itself is never passed to the
      // logger at all (req.body.apiKey is additionally redacted by the
      // pino-http request logger in index.ts, defense-in-depth).
      logger.info(
        { tenantId: req.auth!.tenantId, provider, classification },
        "onboarding.validate_key failed",
      );
      res.json({ valid: false, provider, reason });
    }
  } catch (err) { next(err); }
});
