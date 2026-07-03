/**
 * External automation importer.
 *
 * Lets a user paste / upload an automation definition from another
 * orchestrator and have it land as a Braavolabs Pipeline + Agents pair
 * — so the dashboard becomes the single pane of glass for everything
 * the user runs, not just what they built natively here.
 *
 * Supported sources (each in its own adapter under ./adapters/):
 *   • n8n        — exported workflow JSON
 *   • Claude Automation / Claude Code routines (.claude/routines/*.md
 *                 or auto-dev playbook bundle)
 *   • OpenClaw   — exported skill bundle
 *   • Nemo / NemoClaw — workflow bundle
 *   • MCP server — server.json + skill list (read-only mirror)
 *   • Generic    — JSON describing nodes + edges (last-resort schema)
 *
 * The importer is intentionally lossy — Braavolabs primitives don't
 * map 1:1 onto every node type. Conversion is best-effort + always
 * produces a machine-readable diff so the user can see which nodes
 * dropped and why. The original payload is stored verbatim alongside
 * the pipeline so re-import after a converter improvement is cheap.
 */

import { Router } from "express";
import { z } from "zod";
import { authMiddleware } from "../../middleware/auth";
import { prisma } from "../../lib/db";
import { AppError } from "../../middleware/error";
import { logger } from "../../lib/logger";
import type { ConvertedPipeline } from "./adapters/types";
import { deriveAgentsFromSteps } from "./agent-synthesis";
import { maskSecrets } from "./mask-secrets";

export const automationImporterRouter = Router();
automationImporterRouter.use(authMiddleware);

const SOURCE_TYPES = [
  "n8n",
  "claude-automation",
  "claude-code-routine",
  "openclaw",
  "nemoclaw",
  "mcp",
  "generic",
] as const;

const importSchema = z.object({
  source: z.enum(SOURCE_TYPES),
  // The raw payload — JSON for n8n / generic / mcp, markdown for Claude
  // routines, .zip→base64 for skill bundles. Capped at 1 MB; large
  // bundles must be uploaded via /imports/upload (file route, planned).
  payload: z.string().min(1).max(1_000_000),
  // Optional human label so the user finds the pipeline later.
  name: z.string().min(1).max(200).optional(),
  // companyId the resulting pipeline should belong to. If omitted we
  // create an "Imported automations" company on first import.
  companyId: z.string().optional(),
});

// POST /api/v1/automation-imports/preview — dry-run, returns the would-be
// Pipeline + Agents tree without persisting anything. Lets the UI show
// a "what will land in Braavolabs" preview before the user commits.
automationImporterRouter.post("/preview", async (req, res, next) => {
  try {
    const body = importSchema.parse(req.body);
    const result = await convertOne(body.source, body.payload);
    // SECURITY: mask per-step secrets before echoing the would-be pipeline back
    // over the wire — the preview response must never surface imported
    // apiKey/token/password in plaintext (same leak class as the persist path).
    const previewPipeline: ConvertedPipeline["pipeline"] = {
      ...result.pipeline,
      steps: result.pipeline.steps.map((s) => ({ ...s, config: maskSecrets(s.config) })),
    };
    res.json({
      success: true,
      preview: previewPipeline,
      droppedNodes: result.dropped,
      warnings: result.warnings,
    });
  } catch (err) {
    if (err instanceof AppError) return next(err);
    logger.error({ err }, "Automation import preview failed");
    next(new AppError(400, err instanceof Error ? err.message : "Preview failed"));
  }
});

// POST /api/v1/automation-imports — convert + persist
automationImporterRouter.post("/", async (req, res, next) => {
  try {
    const body = importSchema.parse(req.body);
    const tenantId = req.auth!.tenantId;

    const result = await convertOne(body.source, body.payload);

    // Resolve target company. If the caller didn't provide one we
    // create a single bucket company per tenant so all imports collect
    // in one place — the user can split them out later.
    let companyId = body.companyId;
    if (companyId) {
      const company = await prisma.company.findFirst({
        where: { id: companyId, tenantId },
      });
      if (!company) throw new AppError(404, "Company not found");
    } else {
      const bucket = await prisma.company.findFirst({
        where: { tenantId, slug: "imported-automations" },
      });
      if (bucket) {
        companyId = bucket.id;
      } else {
        const created = await prisma.company.create({
          data: {
            tenantId,
            name: "Imported automations",
            slug: "imported-automations",
            primitives: ["OPERATIONS"] as any,
            status: "ACTIVE" as any,
          },
        });
        companyId = created.id;
      }
    }

    // ── Agent synthesis (E5/T1) ──────────────────────────────────────────
    // Synthesize the fixed-2-role Agents the converted steps reference so the
    // pipeline is actually RUNNABLE (findings E5-IMP-01/02). Each step's
    // agentRole exact-matches one of these Agent roles (kabul #2).
    const { agents: agentSpecs } = deriveAgentsFromSteps(result.pipeline.steps);

    // Mask secret-like fields in the verbatim payload before persisting it, so
    // embedded n8n/MCP credentials don't sit in plaintext in Pipeline.config
    // JSONB (Açık Soru #2 karar; findings B9). Also mask any secrets that rode
    // along into per-step config.
    //
    // SECURITY (HIGH — adversarial/live-verified): the masked steps below MUST
    // be what we write to the RUNNABLE `Pipeline.steps` column (line ~166) too,
    // not just to the audit copy in `config.converted`. Earlier revisions masked
    // only `config.converted` (a dead copy with no reader) while persisting the
    // UNMASKED `result.pipeline.steps` into `Pipeline.steps` — which the executor
    // AND the API response actually read — leaking imported apiKey/token/password
    // in plaintext. One `maskedSteps` var now feeds BOTH sinks.
    //
    // This is SAFE for runtime: in E5 Faz-1 the executor does not dispatch on
    // step.type (agent-loop only), so masked step.config never reaches a live
    // credential path — credentials are re-supplied via the BYOK/secure route.
    const maskedPayload = maskSecrets(safeParseMaybeJson(body.payload));
    const maskedSteps = result.pipeline.steps.map((s) => ({
      ...s,
      config: maskSecrets(s.config),
    }));
    const maskedConverted: ConvertedPipeline["pipeline"] = {
      ...result.pipeline,
      steps: maskedSteps,
    };

    // Persist agents + pipeline (with steps) + activity log atomically. Agents
    // are created FIRST (idempotent findFirst→create — Agent has no @@unique on
    // (companyId, role) so upsert is impossible, adversarial A2), THEN the
    // pipeline that references them by role.
    const pipeline = await prisma.$transaction(async (tx) => {
      for (const spec of agentSpecs) {
        const existing = await tx.agent.findFirst({
          where: { companyId: companyId!, role: spec.role },
        });
        if (!existing) {
          await tx.agent.create({
            data: {
              companyId: companyId!,
              name: spec.name,
              role: spec.role,
              systemPrompt: spec.systemPrompt,
            },
          });
        }
      }

      const created = await tx.pipeline.create({
        data: {
          companyId: companyId!,
          name: body.name ?? result.pipeline.name,
          trigger: "MANUAL",
          // The runnable step list — the executor reads THIS column
          // (runner.ts:145), not config.converted (which no longer has any
          // reader — kept only as a masked audit/diff copy). MASKED so no
          // imported plaintext credential lands in the runnable column or the
          // API response (see SECURITY note above).
          steps: maskedSteps as any,
          config: {
            importedFrom: body.source,
            originalPayload: maskedPayload,
            converted: maskedConverted,
            droppedNodes: result.dropped,
            warnings: result.warnings,
          } as any,
        },
      });

      await tx.activityLog.create({
        data: {
          tenantId,
          actor: req.auth!.userId,
          action: "automation.imported",
          resource: "pipeline",
          resourceId: created.id,
          details: {
            source: body.source,
            dropped: result.dropped.length,
            steps: result.pipeline.steps.length,
            agents: agentSpecs.length,
          } as any,
        },
      });

      return created;
    });

    res.status(201).json({
      success: true,
      pipelineId: pipeline.id,
      droppedNodes: result.dropped,
      warnings: result.warnings,
    });
  } catch (err) {
    if (err instanceof AppError) return next(err);
    logger.error({ err }, "Automation import failed");
    next(new AppError(400, err instanceof Error ? err.message : "Import failed"));
  }
});

// ─── Helpers ─────────────────────────────────────────────

/**
 * Payloads are JSON for n8n/generic/mcp/openclaw but markdown for Claude
 * routines. Parse to an object when it's JSON so maskSecrets can walk it;
 * otherwise return the raw string (markdown has no structured secret fields
 * to redact — and we still keep it verbatim for re-import/diff).
 */
function safeParseMaybeJson(payload: string): unknown {
  const trimmed = payload.trimStart();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return payload;
  try {
    return JSON.parse(payload);
  } catch {
    return payload;
  }
}

// ─── Adapter dispatch ────────────────────────────────────

async function convertOne(
  source: (typeof SOURCE_TYPES)[number],
  payload: string,
): Promise<ConvertedPipeline> {
  switch (source) {
    case "n8n":
      return (await import("./adapters/n8n")).fromN8n(payload);
    case "claude-automation":
    case "claude-code-routine":
      return (await import("./adapters/claude-automation")).fromClaudeAutomation(payload);
    case "openclaw":
      return (await import("./adapters/openclaw")).fromOpenClaw(payload);
    case "nemoclaw":
      return (await import("./adapters/openclaw")).fromOpenClaw(payload); // shares format
    case "mcp":
      return (await import("./adapters/mcp")).fromMcp(payload);
    case "generic":
      return (await import("./adapters/generic")).fromGeneric(payload);
    default:
      throw new AppError(400, `Unknown source: ${source}`);
  }
}
