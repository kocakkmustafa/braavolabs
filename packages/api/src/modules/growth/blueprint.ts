/**
 * Blueprint Sharing System
 *
 * Allows users to publish their company spec as a shareable blueprint.
 * Other users can clone a blueprint to create their own company from it.
 *
 * Blueprint link: /blueprint/:slug
 * Each clone gives the blueprint creator bonus run credits.
 */

import { prisma } from "../../lib/db";
import { logger } from "../../lib/logger";
import { AppError } from "../../middleware/error";
import { slugify } from "@ai-company-os/core";

export interface Blueprint {
  id: string;
  slug: string;
  title: string;
  description: string;
  companyType: string;
  primitives: string[];
  spec: Record<string, unknown>;
  creatorTenantId: string;
  cloneCount: number;
  isPublic: boolean;
  createdAt: Date;
}

/**
 * Publish a company's configuration as a shareable blueprint.
 */
export async function publishBlueprint(
  companyId: string,
  tenantId: string,
  opts: { title?: string; description?: string; isPublic?: boolean } = {},
): Promise<Blueprint> {
  const company = await prisma.company.findFirst({
    where: { id: companyId, tenantId },
    include: { agents: true, pipelines: true },
  });

  if (!company) throw new AppError(404, "Company not found");

  // Build the blueprint spec from the company
  const spec = {
    primitives: company.primitives,
    config: company.config,
    agents: company.agents.map((a) => ({
      name: a.name,
      role: a.role,
      systemPrompt: a.systemPrompt,
      tools: a.tools,
    })),
    pipelines: company.pipelines.map((p) => ({
      name: p.name,
      trigger: p.trigger,
      schedule: p.schedule,
      steps: p.steps,
    })),
  };

  const title = opts.title ?? company.name;
  const slug = `${slugify(title)}-${Date.now().toString(36)}`;

  // Store blueprint as a special activity log + company config
  // Using activityLog as storage since we don't have a dedicated blueprints table
  const blueprint = await prisma.activityLog.create({
    data: {
      tenantId,
      actor: "system",
      action: "blueprint.published",
      resource: "blueprint",
      resourceId: slug,
      details: {
        slug,
        title,
        description: opts.description ?? company.description ?? "",
        companyType: (company.config as any)?.companyType ?? "custom",
        primitives: company.primitives,
        spec,
        creatorTenantId: tenantId,
        cloneCount: 0,
        isPublic: opts.isPublic ?? true,
      },
    },
  });

  logger.info({ slug, companyId, tenantId }, "Blueprint published");

  return {
    id: blueprint.id,
    slug,
    title,
    description: opts.description ?? company.description ?? "",
    companyType: (company.config as any)?.companyType ?? "custom",
    primitives: company.primitives as string[],
    spec,
    creatorTenantId: tenantId,
    cloneCount: 0,
    isPublic: opts.isPublic ?? true,
    createdAt: blueprint.createdAt,
  };
}

/**
 * Get a blueprint by slug.
 */
export async function getBlueprint(slug: string): Promise<Blueprint | null> {
  const log = await prisma.activityLog.findFirst({
    where: {
      action: "blueprint.published",
      resourceId: slug,
    },
    orderBy: { createdAt: "desc" },
  });

  if (!log) return null;

  const details = log.details as any;
  return {
    id: log.id,
    slug: details.slug,
    title: details.title,
    description: details.description,
    companyType: details.companyType,
    primitives: details.primitives,
    spec: details.spec,
    creatorTenantId: details.creatorTenantId,
    cloneCount: details.cloneCount ?? 0,
    isPublic: details.isPublic ?? true,
    createdAt: log.createdAt,
  };
}

/**
 * Clone a blueprint to create a new company for a tenant.
 */
export async function cloneBlueprint(
  slug: string,
  tenantId: string,
  overrides: { name?: string } = {},
): Promise<{ companyId: string }> {
  const blueprint = await getBlueprint(slug);
  if (!blueprint) throw new AppError(404, "Blueprint not found");
  if (!blueprint.isPublic && blueprint.creatorTenantId !== tenantId) {
    throw new AppError(403, "This blueprint is private");
  }

  const spec = blueprint.spec as any;
  const companyName = overrides.name ?? blueprint.title;

  // Create company from blueprint
  const company = await prisma.company.create({
    data: {
      tenantId,
      name: companyName,
      slug: `${slugify(companyName)}-${Date.now().toString(36)}`,
      description: blueprint.description,
      primitives: blueprint.primitives as any,
      status: "ACTIVE",
      config: spec.config ?? {},
    },
  });

  // Create agents
  for (const agentDef of spec.agents ?? []) {
    await prisma.agent.create({
      data: {
        companyId: company.id,
        name: agentDef.name,
        role: agentDef.role,
        systemPrompt: agentDef.systemPrompt,
        tools: agentDef.tools ?? [],
      },
    });
  }

  // Create pipelines
  for (const pipelineDef of spec.pipelines ?? []) {
    await prisma.pipeline.create({
      data: {
        companyId: company.id,
        name: pipelineDef.name,
        trigger: pipelineDef.trigger ?? "MANUAL",
        schedule: pipelineDef.schedule,
        steps: pipelineDef.steps ?? [],
      },
    });
  }

  // Reward blueprint creator with bonus runs
  if (blueprint.creatorTenantId !== tenantId) {
    const now = new Date();
    const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);

    await prisma.usageMeter.upsert({
      where: {
        tenantId_metric_periodStart: {
          tenantId: blueprint.creatorTenantId,
          metric: "bonus_runs",
          periodStart,
        },
      },
      update: { value: { increment: 3 } },
      create: {
        tenantId: blueprint.creatorTenantId,
        metric: "bonus_runs",
        value: 3,
        periodStart,
        periodEnd,
      },
    });
  }

  // Log clone
  await prisma.activityLog.create({
    data: {
      tenantId,
      actor: "system",
      action: "blueprint.cloned",
      resource: "company",
      resourceId: company.id,
      details: { blueprintSlug: slug, creatorTenantId: blueprint.creatorTenantId },
    },
  });

  logger.info({ slug, tenantId, companyId: company.id }, "Blueprint cloned");

  return { companyId: company.id };
}

/**
 * List public blueprints.
 */
export async function listBlueprints(limit = 20): Promise<Blueprint[]> {
  const logs = await prisma.activityLog.findMany({
    where: {
      action: "blueprint.published",
      details: { path: ["isPublic"], equals: true },
    },
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  return logs.map((log) => {
    const d = log.details as any;
    return {
      id: log.id,
      slug: d.slug,
      title: d.title,
      description: d.description,
      companyType: d.companyType,
      primitives: d.primitives,
      spec: d.spec,
      creatorTenantId: d.creatorTenantId,
      cloneCount: d.cloneCount ?? 0,
      isPublic: true,
      createdAt: log.createdAt,
    };
  });
}
