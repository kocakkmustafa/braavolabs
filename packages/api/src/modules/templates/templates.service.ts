/**
 * Company-template marketplace service.
 *
 * Three core operations:
 *
 *   exportCompanyToTemplate(companyId, opts)
 *     Captures the company's current shape (pipelines, agents,
 *     memory seeds, primitives) into a JSON snapshot suitable for
 *     republishing into another tenant. Credentials + tenant-bound
 *     ids are stripped — only the structure travels.
 *
 *   installTemplate(templateId, tenantId, opts)
 *     Creates a fresh Company in the installing tenant by replaying
 *     the snapshot. Agents are minted with new ids; pipelines
 *     reference the new agent ids; memory seeds are inserted as
 *     `candidate` rows (manual promotion follows the same memory
 *     lifecycle rule as the rest of the platform).
 *
 *   rateTemplate(templateId, tenantId, rating, review?)
 *     1..5 rating, one per (template, tenant). Average and count
 *     are refreshed on the template row so the catalog can sort
 *     by rating without a scan.
 */

import crypto from "node:crypto";
import { prisma, tenantTx } from "../../lib/db";
import { assertCompanyCapacity } from "../company/company-capacity";
import { seedCreatorAsOwner } from "../company/owner-seed";
import { z } from "zod";
import { AppError } from "../../middleware/error";
import { afterCursorWhere, decodeCursor, encodeCursor, LIST_ORDER, parseLimit } from "../run/list-cursor";

// ── Snapshot shape ──────────────────────────────────────────

interface AgentSnapshot {
  // Stable handle used to rewire pipelines to the cloned agent IDs
  // at install time. NOT a real DB id — the installer mints fresh
  // CUIDs and looks them up via this key.
  handle: string;
  name: string;
  role: string;
  systemPrompt: string;
  model: string;
  maxTokens: number;
  tools: unknown;
}

interface PipelineSnapshot {
  name: string;
  description?: string;
  trigger: "MANUAL" | "SCHEDULED" | "WEBHOOK" | "EVENT";
  schedule?: string;
  pipelineType: "SEQUENTIAL" | "HIERARCHICAL";
  managerAgentHandle?: string;
  maxDelegationDepth: number;
  steps: unknown;
  config: unknown;
}

interface MemorySeed {
  type: "EPISODIC" | "SEMANTIC" | "PROCEDURAL";
  content: string;
  metadata?: unknown;
}

export interface CompanyTemplateSnapshot {
  name: string;
  description: string | null;
  primitives: unknown;
  agents: AgentSnapshot[];
  pipelines: PipelineSnapshot[];
  memorySeeds: MemorySeed[];
}

// ── Export ──────────────────────────────────────────────────

export async function exportCompanyToTemplate(
  companyId: string,
  tenantId: string,
): Promise<CompanyTemplateSnapshot> {
  const company = await prisma.company.findFirst({
    where: { id: companyId, tenantId },
  });
  if (!company) throw new AppError(404, "Company not found");
  const [companyAgents, companyPipelines, companyMemoryItems] = await Promise.all([
    prisma.agent.findMany({ where: { companyId: company.id } }),
    prisma.pipeline.findMany({ where: { companyId: company.id } }),
    prisma.memoryItem.findMany({
      where: { companyId: company.id, status: "APPROVED" },
      take: 100,
    }),
  ]);

  // Stable handles so the installer can map manager refs even after
  // ids are reissued.
  const handleByOldId = new Map<string, string>();
  const agents: AgentSnapshot[] = companyAgents.map((a) => {
    const handle = `agent-${crypto.randomBytes(3).toString("hex")}`;
    handleByOldId.set(a.id, handle);
    return {
      handle,
      name: a.name,
      role: a.role,
      systemPrompt: a.systemPrompt,
      model: a.model,
      maxTokens: a.maxTokens,
      tools: a.tools,
    };
  });

  const pipelines: PipelineSnapshot[] = companyPipelines.map((p) => ({
    name: p.name,
    description: p.description ?? undefined,
    trigger: p.trigger,
    schedule: p.schedule ?? undefined,
    pipelineType: p.pipelineType,
    managerAgentHandle: p.managerAgentId ? handleByOldId.get(p.managerAgentId) : undefined,
    maxDelegationDepth: p.maxDelegationDepth,
    steps: p.steps,
    config: p.config,
  }));

  const memorySeeds: MemorySeed[] = companyMemoryItems.map((m) => ({
    type: (m.type as MemorySeed["type"]) ?? "semantic",
    content: m.content,
    metadata: m.metadata,
  }));

  return {
    name: company.name,
    description: company.description ?? null,
    primitives: company.primitives,
    agents,
    pipelines,
    memorySeeds,
  };
}

// ── Install ─────────────────────────────────────────────────

export async function installTemplate(
  templateId: string,
  tenantId: string,
  opts: { companyNameOverride?: string } = {},
  userId?: string,
): Promise<{ companyId: string; slug: string }> {
  const template = await prisma.companyTemplate.findUnique({ where: { id: templateId } });
  if (!template) throw new AppError(404, "Template not found");
  if (template.visibility === "PRIVATE" && template.publisherTenantId !== tenantId) {
    throw new AppError(404, "Template not found");
  }
  if (template.visibility === "PUBLIC" && !template.isApproved) {
    throw new AppError(404, "Template not found");
  }
  if (template.pricing === "PAID") {
    // There is no server-verified checkout for template purchases yet.
    throw new AppError(503, "Paid template installation is unavailable until verified checkout is implemented.");
  }

  const snapshot = template.snapshot as unknown as CompanyTemplateSnapshot;
  return materialiseTemplate(template.id, tenantId, snapshot, opts, userId);
}

export async function materialiseTemplate(
  templateId: string,
  tenantId: string,
  snapshot: CompanyTemplateSnapshot,
  opts: { companyNameOverride?: string } = {},
  userId?: string, // oluşturan; yoksa (sistem yolu) OWNER eklenmez
): Promise<{ companyId: string; slug: string }> {
  const name = opts.companyNameOverride ?? snapshot.name;
  const slug =
    `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")}` +
    "-" + Date.now().toString(36);

  // Single transaction so a half-installed template can't leave the
  // tenant with orphan agents or pipelines.
  const result = await tenantTx(async (tx) => {
    await assertCompanyCapacity(tx, tenantId);
    const company = await tx.company.create({
      data: {
        tenantId,
        name,
        slug,
        description: snapshot.description ?? null,
        primitives: snapshot.primitives as any,
        status: "DRAFT",
      },
    });
    await seedCreatorAsOwner(tx, { tenantId, companyId: company.id, userId });

    const handleToNewId = new Map<string, string>();
    for (const a of snapshot.agents) {
      const created = await tx.agent.create({
        data: {
          companyId: company.id,
          name: a.name,
          role: a.role,
          systemPrompt: a.systemPrompt,
          model: a.model,
          maxTokens: a.maxTokens,
          tools: a.tools as any,
        },
      });
      handleToNewId.set(a.handle, created.id);
    }

    for (const p of snapshot.pipelines) {
      await tx.pipeline.create({
        data: {
          companyId: company.id,
          name: p.name,
          description: p.description ?? null,
          trigger: p.trigger,
          schedule: p.schedule ?? null,
          pipelineType: p.pipelineType,
          managerAgentId: p.managerAgentHandle ? handleToNewId.get(p.managerAgentHandle) ?? null : null,
          maxDelegationDepth: p.maxDelegationDepth,
          steps: p.steps as any,
          config: p.config as any,
        },
      });
    }

    // Memory seeds land as `candidate` so they go through the same
    // lifecycle as user-generated memories. Tenant can manually
    // promote to `approved` after reviewing.
    for (const m of snapshot.memorySeeds) {
      await tx.memoryItem.create({
        data: {
          companyId: company.id,
          type: m.type as any,
          content: m.content,
          metadata: m.metadata as any,
          status: "CANDIDATE",
        },
      });
    }

    await tx.companyTemplate.update({
      where: { id: templateId },
      data: { installCount: { increment: 1 } },
    });

    await tx.templateInstall.create({
      data: {
        templateId,
        tenantId,
        installedCompanyId: company.id,
      },
    });

    await tx.activityLog.create({
      data: {
        tenantId,
        actor: "marketplace",
        action: "template.install",
        resource: "company",
        resourceId: company.id,
        details: { templateId },
      },
    });

    return { companyId: company.id, slug: company.slug };
  });
  return result;
}

// ── Ratings ─────────────────────────────────────────────────

export async function rateTemplate(
  templateId: string,
  tenantId: string,
  rating: number,
  review?: string,
): Promise<void> {
  if (rating < 1 || rating > 5) {
    throw new AppError(400, "rating must be between 1 and 5");
  }
  const exists = await prisma.companyTemplate.findUnique({ where: { id: templateId } });
  if (!exists) throw new AppError(404, "Template not found");
  // Require that the tenant has installed the template before they
  // can rate it. Stops rating-bombs from random tenants.
  const installed = await prisma.templateInstall.findFirst({
    where: { templateId, tenantId },
  });
  if (!installed) {
    throw new AppError(403, "Install the template before rating it");
  }
  await tenantTx(async (tx) => {
    await tx.templateRating.upsert({
      where: { templateId_tenantId: { templateId, tenantId } },
      create: { templateId, tenantId, rating, review },
      update: { rating, review },
    });
    const agg = await tx.templateRating.aggregate({
      where: { templateId },
      _avg: { rating: true },
      _count: { rating: true },
    });
    await tx.companyTemplate.update({
      where: { id: templateId },
      data: {
        ratingAvg: agg._avg.rating ?? 0,
        ratingCount: agg._count.rating ?? 0,
      },
    });
  });
}

// ── Public catalog listing ──────────────────────────────────

export const TEMPLATE_LIST_DEFAULT_LIMIT = 24;
export const TEMPLATE_LIST_MAX_LIMIT = 100;
const PRIMITIVE_VALUES = [
  "ACQUISITION", "SALES", "DELIVERY", "CONTENT", "OPERATIONS",
  "FINANCE", "ANALYTICS", "MEMORY", "GOVERNANCE",
] as const;
const primitiveEnum = z.enum(PRIMITIVE_VALUES);

/**
 * Query contract. Everything is a plain string (Express gives strings or
 * arrays); repeated params / unknown keys fail `.strict()` -> 400.
 *   category   one primitive (the catalog has no separate category column;
 *              a template's category is the primitive it touches)
 *   primitives comma list, ALL must be present on the template
 *   pricing    FREE | PAID
 */
export const templateListQuerySchema = z.object({
  q: z.string().max(200).optional(),
  category: primitiveEnum.optional(),
  primitives: z.string().max(200).optional(),
  pricing: z.enum(["FREE", "PAID"]).optional(),
  limit: z.string().optional(),
  cursor: z.string().optional(),
}).strict();

export async function listPublicTemplates(rawQuery: unknown): Promise<{ items: unknown[]; nextCursor: string | null }> {
  const q = templateListQuerySchema.parse(rawQuery ?? {});
  const limit = parseLimit(q.limit, TEMPLATE_LIST_DEFAULT_LIMIT, TEMPLATE_LIST_MAX_LIMIT);
  if (limit === null) throw new AppError(400, `Invalid limit. Use an integer between 1 and ${TEMPLATE_LIST_MAX_LIMIT}.`);
  const cursor = q.cursor === undefined ? undefined : decodeCursor(q.cursor);
  if (cursor === null) throw new AppError(400, "Invalid cursor.");

  const wanted = new Set<string>();
  if (q.category) wanted.add(q.category);
  if (q.primitives !== undefined) {
    for (const raw of q.primitives.split(",")) {
      const parsed = primitiveEnum.safeParse(raw.trim());
      if (!parsed.success) throw new AppError(400, "Invalid primitives filter.");
      wanted.add(parsed.data);
    }
  }

  const and: any[] = [];
  const text = q.q?.trim();
  if (text) and.push({ OR: [{ name: { contains: text, mode: "insensitive" } }, { description: { contains: text, mode: "insensitive" } }] });
  for (const p of wanted) and.push({ primitives: { array_contains: [p] } });
  if (cursor) and.push(afterCursorWhere(cursor));
  // PUBLIC + approved only: UNLISTED is slug-only, PRIVATE never listed.
  const where: any = { visibility: "PUBLIC", isApproved: true, ...(q.pricing ? { pricing: q.pricing } : {}), ...(and.length ? { AND: and } : {}) };

  const rows = await prisma.companyTemplate.findMany({
    where,
    orderBy: LIST_ORDER,
    take: limit + 1,
    select: {
      id: true, slug: true, name: true, version: true, vendor: true, description: true,
      iconUrl: true, screenshotUrls: true, primitives: true, pricing: true, priceUsd: true,
      installCount: true, ratingAvg: true, ratingCount: true, createdAt: true,
    },
  });
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return { items, nextCursor: hasMore && last ? encodeCursor(last) : null };
}
