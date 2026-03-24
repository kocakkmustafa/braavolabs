/**
 * Onboarding Router — Faz 8
 *
 * Free plan onboarding: auto-creates hero social media company
 * with content pipeline pre-configured.
 */

import { Router } from "express";
import { z } from "zod";
import { authMiddleware } from "../../middleware/auth";
import { prisma } from "../../lib/db";
import { logger } from "../../lib/logger";
import { AppError } from "../../middleware/error";

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
