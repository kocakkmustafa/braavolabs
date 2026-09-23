/**
 * Starter company endpoints — list pre-baked templates and clone one
 * into the calling tenant in a single round-trip.
 *
 *   GET  /api/v1/starters             — list (no auth, public catalog)
 *   POST /api/v1/starters/:id/clone   — clone (auth required)
 *
 * The list endpoint is intentionally public so the marketing site can
 * preview the starter catalog without forcing a sign-up — the cards
 * live behind the /companies/new picker too, but a future "see what
 * comes pre-built" link on the homepage can hit this directly.
 *
 * Clone is just a transactional INSERT chain (Company → Agents →
 * Pipeline). It's NOT routed through the AI builder, so cloning a
 * template costs ZERO trial Groq runs — those are saved for the actual
 * pipeline executions that show value.
 */
import { Router } from "express";
import { z } from "zod";
import { authMiddleware } from "../../middleware/auth";
import { AppError } from "../../middleware/error";
import { tenantTx } from "../../lib/db";
import { logger } from "../../lib/logger";
import { assertCompanyCapacity } from "../company/company-capacity";
import {
  STARTER_TEMPLATES,
  STARTER_TEMPLATE_IDS,
  getStarterTemplate,
  deriveCompanySlug,
  SAFE_TOOL_SET,
} from "./starter-templates";

export const starterRouter = Router();

// ────────────────────────────────────────────────────────────────
// GET /starters — list catalog (public)
//
// We strip the systemPrompts from the response — they're long, and
// exposing them publicly invites prompt-engineering screenshots that
// confuse non-technical visitors. Templates remain copy-able by the
// clone endpoint, which is the real consumer.
// ────────────────────────────────────────────────────────────────
starterRouter.get("/", (_req, res) => {
  const list = STARTER_TEMPLATES.map((t) => ({
    id: t.id,
    name: t.name,
    tagline: t.tagline,
    emoji: t.emoji,
    description: t.description,
    outcome: t.outcome,
    trialCost: t.trialCost,
    primitives: t.primitives,
    agentCount: t.agents.length,
    pipelineCount: t.pipelines.length,
    pipelineSteps: t.pipelines.reduce((s, p) => s + p.steps.length, 0),
  }));
  res.json({ templates: list });
});

// ────────────────────────────────────────────────────────────────
// POST /starters/:id/clone — clone into calling tenant
//
// Body: { name?: string }   — optional override for the company name
// Returns: { company: { id, slug, name }, agentCount, pipelineCount }
//
// Slug collision strategy: try base slug, then -2, -3, ... up to -10
// before giving up. Tenants are extremely unlikely to clone the same
// starter 11+ times; if they hit it, the error message tells them to
// rename existing copies.
// ────────────────────────────────────────────────────────────────
const cloneBodySchema = z.object({
  name: z.string().min(1).max(100).optional(),
});

starterRouter.post("/:id/clone", authMiddleware, async (req, res, next) => {
  try {
    // Express's typing widens path params to `string | string[]` because
    // a route like `/:id+` could match a slash-separated tuple. Ours
    // never does — single id only — so the cast is safe.
    const id = req.params.id as string;
    if (!id || !STARTER_TEMPLATE_IDS.includes(id)) {
      throw new AppError(
        404,
        `Unknown starter template "${id}". Available: ${STARTER_TEMPLATE_IDS.join(", ")}`,
      );
    }

    const body = cloneBodySchema.parse(req.body ?? {});
    const tenantId = req.auth!.tenantId;
    const userId = req.auth!.userId;
    const template = getStarterTemplate(id);

    // Defense in depth — even though the catalog is curated, refuse to
    // clone any template that references a tool outside the safe whitelist.
    // This catches future drift (someone adds a tool to a template but
    // forgets to update SAFE_TOOLS) before the pipeline starts failing
    // mysteriously at runtime.
    for (const agent of template.agents) {
      for (const tool of agent.tools) {
        if (!SAFE_TOOL_SET.has(tool)) {
          logger.error(
            { templateId: id, agent: agent.name, tool },
            "Starter template references unsafe tool — refusing to clone",
          );
          throw new AppError(
            500,
            `Starter template "${id}" is misconfigured (unsafe tool "${tool}"). Please report this to support.`,
          );
        }
      }
    }

    // Single transaction so a failure halfway through doesn't leave
    // orphan companies/agents in the DB. The tenant lock also makes slug
    // selection safe when two clone requests arrive together.
    const result = await tenantTx(async (tx) => {
      await assertCompanyCapacity(tx, tenantId);
      let slug = "";
      let attempt = 0;
      while (attempt < 10) {
        const candidate = deriveCompanySlug(template, attempt);
        const existing = await tx.company.findFirst({
          where: { tenantId, slug: candidate },
          select: { id: true },
        });
        if (!existing) {
          slug = candidate;
          break;
        }
        attempt++;
      }
      if (!slug) {
        throw new AppError(
          409,
          `You already have 10 copies of "${template.name}" — rename or archive the older ones first.`,
        );
      }
      const company = await tx.company.create({
        data: {
          tenantId,
          name: body.name ?? template.name,
          slug,
          description: template.description,
          primitives: template.primitives,
          status: "ACTIVE",
          config: {
            startedFromTemplate: template.id,
            templateOutcome: template.outcome,
          },
        },
      });

      // Map of role → agentId so we can wire pipelines correctly even if
      // two agents share a similar role. We resolve by exact role match.
      const roleToAgentId = new Map<string, string>();
      for (const agentDef of template.agents) {
        const agent = await tx.agent.create({
          data: {
            companyId: company.id,
            name: agentDef.name,
            role: agentDef.role,
            systemPrompt: agentDef.systemPrompt,
            tools: agentDef.tools as unknown as object,
            // model + maxTokens use the schema defaults (sonnet-4 + 4096),
            // but the trial path overrides at execution time to route
            // through Groq llama-3.3-70b-versatile. So we don't need to
            // hard-code model on the agent row — keeps the template
            // portable (BYOK users get their own model on the same agent).
          },
        });
        roleToAgentId.set(agentDef.role, agent.id);
      }

      for (const pipelineDef of template.pipelines) {
        await tx.pipeline.create({
          data: {
            companyId: company.id,
            name: pipelineDef.name,
            description: pipelineDef.description,
            trigger: "MANUAL",
            steps: pipelineDef.steps as unknown as object,
            config: {},
            enabled: true,
          },
        });
      }

      await tx.activityLog.create({
        data: {
          tenantId,
          actor: userId,
          action: "starter.clone",
          resource: "company",
          resourceId: company.id,
          details: {
            templateId: template.id,
            templateName: template.name,
            agentCount: template.agents.length,
            pipelineCount: template.pipelines.length,
          },
        },
      });

      return company;
    });

    logger.info(
      { tenantId, templateId: template.id, companyId: result.id, slug: result.slug },
      "Starter template cloned",
    );

    res.json({
      company: {
        id: result.id,
        slug: result.slug,
        name: result.name,
      },
      agentCount: template.agents.length,
      pipelineCount: template.pipelines.length,
      message: `Created "${result.name}". Next: open the company → run the "${template.pipelines[0]?.name}" pipeline to see your trial in action.`,
    });
  } catch (err) {
    next(err);
  }
});
