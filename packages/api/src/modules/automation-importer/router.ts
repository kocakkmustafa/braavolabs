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
    res.json({
      success: true,
      preview: result.pipeline,
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

    // Persist pipeline + activity log atomically. Tool / agent
    // resolution is left for a follow-up — current scope is the
    // pipeline shell (config JSON keeps the converted node graph).
    const pipeline = await prisma.$transaction(async (tx) => {
      const created = await tx.pipeline.create({
        data: {
          companyId: companyId!,
          name: body.name ?? result.pipeline.name,
          trigger: "MANUAL",
          config: {
            importedFrom: body.source,
            originalPayload: body.payload,
            converted: result.pipeline,
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
          details: { source: body.source, dropped: result.dropped.length } as any,
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

// ─── Adapter dispatch ────────────────────────────────────

interface ConvertedPipeline {
  pipeline: {
    name: string;
    description?: string;
    steps: Array<{ id: string; type: string; config: unknown }>;
  };
  dropped: Array<{ id: string; type: string; reason: string }>;
  warnings: string[];
}

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
