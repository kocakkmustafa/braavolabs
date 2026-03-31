/**
 * Growth & Referral Router — Faz 9
 *
 * Referral code generation, tracking, and reward application.
 */

import { Router } from "express";
import { z } from "zod";
import crypto from "crypto";
import { authMiddleware } from "../../middleware/auth";
import { prisma } from "../../lib/db";
import { logger } from "../../lib/logger";
import { AppError } from "../../middleware/error";

export const growthRouter = Router();
growthRouter.use(authMiddleware);

/**
 * Generate a unique referral code.
 */
function generateReferralCode(): string {
  return `AICOS-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}

// GET /api/v1/growth/referral — get or create referral code for current tenant
growthRouter.get("/referral", async (req, res, next) => {
  try {
    const tenantId = req.auth!.tenantId;

    // Find existing active referral code
    let referral = await prisma.referral.findFirst({
      where: {
        referrerTenantId: tenantId,
        referredTenantId: null,
        status: "PENDING",
      },
      orderBy: { createdAt: "desc" },
    });

    // Create one if none exists
    if (!referral) {
      referral = await prisma.referral.create({
        data: {
          referrerTenantId: tenantId,
          referralCode: generateReferralCode(),
        },
      });
    }

    // Get stats
    const stats = await prisma.referral.groupBy({
      by: ["status"],
      where: { referrerTenantId: tenantId },
      _count: true,
    });

    const totalReferred = stats.reduce((sum, s) => sum + s._count, 0);
    const converted = stats.find((s) => s.status === "CONVERTED")?._count ?? 0;

    // Get referred tenants
    const referrals = await prisma.referral.findMany({
      where: {
        referrerTenantId: tenantId,
        status: "CONVERTED",
      },
      orderBy: { convertedAt: "desc" },
      take: 20,
    });

    res.json({
      code: referral.referralCode,
      stats: {
        totalReferred: totalReferred - 1, // Exclude the active pending code
        converted,
        rewardsApplied: referrals.filter((r) => r.rewardApplied).length,
      },
      referrals: referrals.map((r) => ({
        id: r.id,
        referredTenantId: r.referredTenantId,
        convertedAt: r.convertedAt,
        rewardType: r.rewardType,
        rewardApplied: r.rewardApplied,
      })),
    });
  } catch (err) { next(err); }
});

// POST /api/v1/growth/referral/generate — create a new referral code
growthRouter.post("/referral/generate", async (req, res, next) => {
  try {
    const tenantId = req.auth!.tenantId;

    const referral = await prisma.referral.create({
      data: {
        referrerTenantId: tenantId,
        referralCode: generateReferralCode(),
      },
    });

    await prisma.activityLog.create({
      data: {
        tenantId,
        actor: req.auth!.userId,
        action: "growth.referral_created",
        resource: "referral",
        resourceId: referral.id,
      },
    });

    res.status(201).json({
      code: referral.referralCode,
      id: referral.id,
    });
  } catch (err) { next(err); }
});

// POST /api/v1/growth/referral/redeem — redeem a referral code (called by new user)
const redeemSchema = z.object({
  code: z.string().min(1),
});

growthRouter.post("/referral/redeem", async (req, res, next) => {
  try {
    const tenantId = req.auth!.tenantId;
    const { code } = redeemSchema.parse(req.body);

    // Find the referral
    const referral = await prisma.referral.findUnique({
      where: { referralCode: code },
    });

    if (!referral) {
      throw new AppError(404, "Referral code not found");
    }

    if (referral.status !== "PENDING") {
      throw new AppError(400, "This referral code has already been used");
    }

    if (referral.referrerTenantId === tenantId) {
      throw new AppError(400, "You cannot redeem your own referral code");
    }

    // Mark as converted
    await prisma.referral.update({
      where: { id: referral.id },
      data: {
        referredTenantId: tenantId,
        status: "CONVERTED",
        convertedAt: new Date(),
        rewardType: "extra_runs",
      },
    });

    // Apply reward: give both referrer and referred extra runs
    const now = new Date();
    const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);

    // Bonus runs for referrer
    await prisma.usageMeter.upsert({
      where: {
        tenantId_metric_periodStart: {
          tenantId: referral.referrerTenantId,
          metric: "bonus_runs",
          periodStart,
        },
      },
      update: { value: { increment: 5 } },
      create: {
        tenantId: referral.referrerTenantId,
        metric: "bonus_runs",
        value: 5,
        periodStart,
        periodEnd,
      },
    });

    // Bonus runs for referred
    await prisma.usageMeter.upsert({
      where: {
        tenantId_metric_periodStart: {
          tenantId,
          metric: "bonus_runs",
          periodStart,
        },
      },
      update: { value: { increment: 5 } },
      create: {
        tenantId,
        metric: "bonus_runs",
        value: 5,
        periodStart,
        periodEnd,
      },
    });

    // Mark reward as applied
    await prisma.referral.update({
      where: { id: referral.id },
      data: { rewardApplied: true },
    });

    // Log activity for both
    await prisma.activityLog.createMany({
      data: [
        {
          tenantId: referral.referrerTenantId,
          actor: "system",
          action: "growth.referral_converted",
          resource: "referral",
          resourceId: referral.id,
          details: { reward: "5 bonus runs", referredTenantId: tenantId },
        },
        {
          tenantId,
          actor: req.auth!.userId,
          action: "growth.referral_redeemed",
          resource: "referral",
          resourceId: referral.id,
          details: { reward: "5 bonus runs", referrerTenantId: referral.referrerTenantId },
        },
      ],
    });

    logger.info(
      { referralId: referral.id, referrer: referral.referrerTenantId, referred: tenantId },
      "Referral code redeemed",
    );

    res.json({
      success: true,
      reward: "5 bonus runs added to your account",
    });
  } catch (err) { next(err); }
});

// GET /api/v1/growth/pql — get PQL score for current tenant
growthRouter.get("/pql", async (req, res, next) => {
  try {
    const { calculatePQLScore } = await import("./pql");
    const score = await calculatePQLScore(req.auth!.tenantId);
    res.json(score);
  } catch (err) { next(err); }
});

// POST /api/v1/growth/blueprint/publish — publish a company as a blueprint
const publishBlueprintSchema = z.object({
  companyId: z.string().uuid(),
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  isPublic: z.boolean().optional(),
});

growthRouter.post("/blueprint/publish", async (req, res, next) => {
  try {
    const data = publishBlueprintSchema.parse(req.body);
    const { publishBlueprint } = await import("./blueprint");
    const blueprint = await publishBlueprint(data.companyId, req.auth!.tenantId, {
      title: data.title,
      description: data.description,
      isPublic: data.isPublic,
    });
    res.status(201).json(blueprint);
  } catch (err) { next(err); }
});

// GET /api/v1/growth/blueprints — list public blueprints
growthRouter.get("/blueprints", async (req, res, next) => {
  try {
    const { listBlueprints } = await import("./blueprint");
    const blueprints = await listBlueprints(20);
    res.json(blueprints);
  } catch (err) { next(err); }
});

// GET /api/v1/growth/blueprint/:slug — get a blueprint by slug
growthRouter.get("/blueprint/:slug", async (req, res, next) => {
  try {
    const { getBlueprint } = await import("./blueprint");
    const blueprint = await getBlueprint(req.params.slug);
    if (!blueprint) throw new AppError(404, "Blueprint not found");
    res.json(blueprint);
  } catch (err) { next(err); }
});

// POST /api/v1/growth/blueprint/:slug/clone — clone a blueprint
const cloneBlueprintSchema = z.object({
  name: z.string().min(1).optional(),
});

growthRouter.post("/blueprint/:slug/clone", async (req, res, next) => {
  try {
    const { name } = cloneBlueprintSchema.parse(req.body);
    const { cloneBlueprint } = await import("./blueprint");
    const result = await cloneBlueprint(req.params.slug, req.auth!.tenantId, { name });
    res.status(201).json(result);
  } catch (err) { next(err); }
});

// GET /api/v1/growth/blueprints/catalog — list all 15 pre-built blueprint templates
growthRouter.get("/blueprints/catalog", async (req, res, next) => {
  try {
    const { industry } = req.query;
    const { BLUEPRINT_CATALOG, getBlueprintsByIndustry } = await import("./blueprint-catalog");

    const blueprints = industry
      ? getBlueprintsByIndustry(industry as string)
      : BLUEPRINT_CATALOG;

    // Strip out full spec for list view — only return metadata
    const list = blueprints.map(({ spec: _spec, ...meta }) => ({
      ...meta,
      agentCount: _spec?.agents?.length ?? meta.agentCount,
      pipelineCount: _spec?.pipelines?.length ?? meta.pipelineCount,
    }));

    res.json(list);
  } catch (err) { next(err); }
});

// GET /api/v1/growth/blueprints/catalog/:slug — get full catalog blueprint spec
growthRouter.get("/blueprints/catalog/:slug", async (req, res, next) => {
  try {
    const { getCatalogBlueprint } = await import("./blueprint-catalog");
    const blueprint = getCatalogBlueprint(req.params.slug);
    if (!blueprint) throw new AppError(404, "Catalog blueprint not found");
    res.json(blueprint);
  } catch (err) { next(err); }
});

// POST /api/v1/growth/blueprints/catalog/:slug/clone — clone a catalog template into a real company
const cloneCatalogSchema = z.object({
  name: z.string().min(1).optional(),
});

growthRouter.post("/blueprints/catalog/:slug/clone", async (req, res, next) => {
  try {
    const tenantId = req.auth!.tenantId;
    const { name } = cloneCatalogSchema.parse(req.body);
    const { getCatalogBlueprint } = await import("./blueprint-catalog");
    const { slugify } = await import("@ai-company-os/core");

    const catalog = getCatalogBlueprint(req.params.slug);
    if (!catalog) throw new AppError(404, "Catalog blueprint not found");

    const companyName = name ?? catalog.title;

    // Create company from catalog spec
    const company = await prisma.company.create({
      data: {
        tenantId,
        name: companyName,
        slug: `${slugify(companyName)}-${Date.now().toString(36)}`,
        description: catalog.description,
        primitives: catalog.primitives as any,
        status: "ACTIVE",
        config: (catalog.spec.config ?? {}) as any,
      },
    });

    // Create agents
    for (const agentDef of catalog.spec.agents) {
      await prisma.agent.create({
        data: {
          companyId: company.id,
          name: agentDef.name,
          role: agentDef.role,
          systemPrompt: agentDef.systemPrompt,
          tools: agentDef.tools,
        },
      });
    }

    // Create pipelines
    for (const pipelineDef of catalog.spec.pipelines) {
      await prisma.pipeline.create({
        data: {
          companyId: company.id,
          name: pipelineDef.name,
          trigger: pipelineDef.trigger as any,
          schedule: pipelineDef.schedule,
          steps: pipelineDef.steps as any,
        },
      });
    }

    await prisma.activityLog.create({
      data: {
        tenantId,
        actor: req.auth!.userId,
        action: "blueprint.catalog_cloned",
        resource: "company",
        resourceId: company.id,
        details: { catalogSlug: catalog.slug, catalogTitle: catalog.title },
      },
    });

    logger.info({ tenantId, catalogSlug: catalog.slug, companyId: company.id }, "Catalog blueprint cloned");

    res.status(201).json({
      companyId: company.id,
      company: { id: company.id, name: company.name, slug: company.slug },
    });
  } catch (err) { next(err); }
});

// GET /api/v1/growth/stats — growth dashboard stats
growthRouter.get("/stats", async (req, res, next) => {
  try {
    const tenantId = req.auth!.tenantId;

    const [totalReferrals, convertedCount, tenant] = await Promise.all([
      prisma.referral.count({ where: { referrerTenantId: tenantId } }),
      prisma.referral.count({ where: { referrerTenantId: tenantId, status: "CONVERTED" } }),
      prisma.tenant.findUnique({ where: { id: tenantId }, select: { plan: true, createdAt: true } }),
    ]);

    // Calculate bonus runs
    const now = new Date();
    const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const bonusMeter = await prisma.usageMeter.findUnique({
      where: {
        tenantId_metric_periodStart: {
          tenantId,
          metric: "bonus_runs",
          periodStart,
        },
      },
    });

    res.json({
      plan: tenant?.plan ?? "FREE",
      memberSince: tenant?.createdAt,
      referrals: {
        total: totalReferrals,
        converted: convertedCount,
        conversionRate: totalReferrals > 0 ? convertedCount / totalReferrals : 0,
      },
      bonusRuns: bonusMeter?.value ?? 0,
    });
  } catch (err) { next(err); }
});
