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
import { slugify, PLAN_LIMITS } from "@ai-company-os/core";
import { getToolNames } from "../agent/registry";

// ─── Blueprint sanitization limits ─────────────────────────
// Prevents prompt-injection + supply-chain attacks in shared blueprints.
const MAX_AGENTS_PER_BLUEPRINT = 15;
const MAX_PIPELINES_PER_BLUEPRINT = 20;
const MAX_STEPS_PER_PIPELINE = 15;
const MAX_SYSTEM_PROMPT_CHARS = 8000;
const MAX_TOOLS_PER_AGENT = 20;
const MAX_NAME_CHARS = 100;
const MAX_DESCRIPTION_CHARS = 500;
const MAX_ROLE_CHARS = 80;

const ALLOWED_PIPELINE_TRIGGERS = new Set(["MANUAL", "SCHEDULED", "WEBHOOK", "EVENT"]);

/**
 * Sanitize a blueprint spec before cloning it into a victim tenant.
 *
 * Protects against:
 *  - Prompt injection via oversized systemPrompts
 *  - Tool whitelist bypass (attacker adding tools not registered in the system)
 *  - Resource exhaustion (1000-agent blueprints)
 *  - Arbitrary field injection via extra JSON properties
 *
 * We only copy a strict shape and reject anything unknown.
 */
function sanitizeBlueprintSpec(spec: unknown): {
  agents: Array<{ name: string; role: string; systemPrompt: string; tools: string[] }>;
  pipelines: Array<{ name: string; trigger: string; schedule: string | null; steps: unknown[] }>;
  config: Record<string, unknown>;
  warnings: string[];
} {
  const warnings: string[] = [];
  if (!spec || typeof spec !== "object") {
    throw new AppError(400, "Invalid blueprint spec");
  }
  const s = spec as any;

  const validToolNames = new Set(getToolNames());

  // Agents
  const rawAgents = Array.isArray(s.agents) ? s.agents : [];
  if (rawAgents.length > MAX_AGENTS_PER_BLUEPRINT) {
    warnings.push(`Agents truncated: ${rawAgents.length} → ${MAX_AGENTS_PER_BLUEPRINT}`);
  }
  const agents = rawAgents.slice(0, MAX_AGENTS_PER_BLUEPRINT).map((a: any, i: number) => {
    if (!a || typeof a !== "object") {
      throw new AppError(400, `Blueprint agent #${i} is invalid`);
    }
    const name = String(a.name ?? `Agent ${i + 1}`).slice(0, MAX_NAME_CHARS);
    const role = String(a.role ?? "assistant").slice(0, MAX_ROLE_CHARS);
    const systemPromptRaw = typeof a.systemPrompt === "string" ? a.systemPrompt : "";
    const systemPrompt = systemPromptRaw.slice(0, MAX_SYSTEM_PROMPT_CHARS);
    if (systemPromptRaw.length > MAX_SYSTEM_PROMPT_CHARS) {
      warnings.push(`Agent "${name}" systemPrompt truncated to ${MAX_SYSTEM_PROMPT_CHARS} chars`);
    }

    const rawTools = Array.isArray(a.tools) ? a.tools : [];
    const tools: string[] = [];
    const invalidTools: string[] = [];
    for (const t of rawTools.slice(0, MAX_TOOLS_PER_AGENT)) {
      if (typeof t === "string" && validToolNames.has(t)) {
        tools.push(t);
      } else if (typeof t === "string") {
        invalidTools.push(t);
      }
    }
    if (invalidTools.length > 0) {
      warnings.push(
        `Agent "${name}" references unknown tools (stripped): ${invalidTools.join(", ")}`,
      );
    }
    return { name, role, systemPrompt, tools };
  });

  // Pipelines
  const rawPipelines = Array.isArray(s.pipelines) ? s.pipelines : [];
  if (rawPipelines.length > MAX_PIPELINES_PER_BLUEPRINT) {
    warnings.push(`Pipelines truncated: ${rawPipelines.length} → ${MAX_PIPELINES_PER_BLUEPRINT}`);
  }
  const pipelines = rawPipelines.slice(0, MAX_PIPELINES_PER_BLUEPRINT).map((p: any, i: number) => {
    if (!p || typeof p !== "object") {
      throw new AppError(400, `Blueprint pipeline #${i} is invalid`);
    }
    const name = String(p.name ?? `Pipeline ${i + 1}`).slice(0, MAX_NAME_CHARS);
    const triggerRaw = typeof p.trigger === "string" ? p.trigger.toUpperCase() : "MANUAL";
    const trigger = ALLOWED_PIPELINE_TRIGGERS.has(triggerRaw) ? triggerRaw : "MANUAL";
    const schedule = typeof p.schedule === "string" ? p.schedule.slice(0, 100) : null;
    const rawSteps = Array.isArray(p.steps) ? p.steps : [];
    const steps = rawSteps.slice(0, MAX_STEPS_PER_PIPELINE).map((st: any, j: number) => {
      if (!st || typeof st !== "object") return { name: `Step ${j + 1}`, agentRole: "assistant", order: j };
      return {
        name: String(st.name ?? `Step ${j + 1}`).slice(0, MAX_NAME_CHARS),
        agentRole: String(st.agentRole ?? "assistant").slice(0, MAX_ROLE_CHARS),
        order: Number.isFinite(st.order) ? Math.max(0, Math.floor(st.order)) : j,
        config: typeof st.config === "object" && st.config !== null ? st.config : {},
      };
    });
    return { name, trigger, schedule, steps };
  });

  // Config — accept only JSON-serializable object, bounded size (10KB)
  let config: Record<string, unknown> = {};
  if (s.config && typeof s.config === "object") {
    try {
      const serialized = JSON.stringify(s.config);
      if (serialized.length <= 10_000) {
        config = JSON.parse(serialized);
      } else {
        warnings.push("Blueprint config > 10KB — dropped");
      }
    } catch {
      warnings.push("Blueprint config not JSON-serializable — dropped");
    }
  }

  return { agents, pipelines, config, warnings };
}

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

  // Enforce plan company limit before clone
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { plan: true, _count: { select: { companies: true } } },
  });
  if (!tenant) throw new AppError(401, "Tenant not found");
  const companyLimit = PLAN_LIMITS[tenant.plan].maxCompanies;
  if (companyLimit !== -1 && tenant._count.companies >= companyLimit) {
    throw new AppError(
      402,
      `Company limit reached for ${tenant.plan} plan (${companyLimit}). Upgrade to clone more blueprints.`,
    );
  }

  // Sanitize spec BEFORE writing anything to the victim tenant.
  // Prevents prompt-injection / tool whitelist bypass / resource exhaustion
  // from malicious shared blueprints.
  const sanitized = sanitizeBlueprintSpec(blueprint.spec);
  if (sanitized.warnings.length > 0) {
    logger.warn(
      { slug, tenantId, warnings: sanitized.warnings },
      "Blueprint clone: sanitization warnings",
    );
  }

  const companyName = (overrides.name ?? blueprint.title).slice(0, MAX_NAME_CHARS);

  // Create company from sanitized blueprint
  const company = await prisma.company.create({
    data: {
      tenantId,
      name: companyName,
      slug: `${slugify(companyName)}-${Date.now().toString(36)}`,
      description: (blueprint.description ?? "").slice(0, MAX_DESCRIPTION_CHARS),
      primitives: blueprint.primitives as any,
      status: "ACTIVE",
      config: sanitized.config as any,
    },
  });

  // Create agents (sanitized)
  for (const agentDef of sanitized.agents) {
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

  // Create pipelines (sanitized)
  for (const pipelineDef of sanitized.pipelines) {
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
