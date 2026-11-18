import { Router } from "express";
import { z } from "zod";
import { authMiddleware } from "../../middleware/auth";
import { prisma, tenantTx } from "../../lib/db";
import { logger } from "../../lib/logger";
import { AppError } from "../../middleware/error";
import { env } from "../../config/env";
import { MAX_CONTENT_BYTES, MAX_PATCHES, MAX_PATH_LENGTH, planWorktree } from "./worktree-planner";
import { buildWorktreePreview } from "./worktree-preview";
import {
  createVersion,
  listVersions,
  getVersion,
  diffVersions,
  rollbackToVersion,
  lockAgentHistory,
} from "./version-control";

export const agentVersionRouter = Router();
agentVersionRouter.use(authMiddleware);

/**
 * Helper: verify the agent belongs to a company owned by the tenant.
 */
async function verifyAgentAccess(agentId: string, tenantId: string) {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    include: { company: { select: { tenantId: true } } },
  });
  if (!agent || agent.company.tenantId !== tenantId) {
    throw new AppError(404, "Agent not found");
  }
  return agent;
}

// GET /api/v1/agents/:id/versions — list all versions
agentVersionRouter.get("/:id/versions", async (req, res, next) => {
  try {
    await verifyAgentAccess(req.params.id, req.auth!.tenantId);
    const versions = await listVersions(req.params.id);

    await prisma.activityLog.create({
      data: {
        tenantId: req.auth!.tenantId,
        actor: req.auth!.userId,
        action: "agent_version.list",
        resource: "agent",
        resourceId: req.params.id,
      },
    });

    res.json(versions);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/agents/:id/versions — create a manual snapshot
const createVersionSchema = z.object({
  label: z.string().max(200).optional(),
  changeSummary: z.string().max(2000).optional(),
});

agentVersionRouter.post("/:id/versions", async (req, res, next) => {
  try {
    const version = await tenantTx(async (tx) => {
      await lockAgentHistory(tx, req.params.id, req.auth!.tenantId);
      const data = createVersionSchema.parse(req.body);
      const created = await createVersion(req.params.id, {
        label: data.label, changeSummary: data.changeSummary, createdBy: req.auth!.userId,
      }, tx);
      await tx.activityLog.create({
        data: {
          tenantId: req.auth!.tenantId, actor: req.auth!.userId,
          action: "agent_version.create", resource: "agent_version", resourceId: created.id,
          details: { agentId: req.params.id, version: created.version },
        },
      });
      return created;
    });
    logger.info({ agentId: req.params.id, version: version.version }, "Agent version created");

    res.status(201).json(version);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/agents/:id/versions/:version — get specific version detail
agentVersionRouter.get("/:id/versions/:version", async (req, res, next) => {
  try {
    await verifyAgentAccess(req.params.id, req.auth!.tenantId);
    const versionNum = parseInt(req.params.version, 10);
    if (isNaN(versionNum)) throw new AppError(400, "Invalid version number");

    const version = await getVersion(req.params.id, versionNum);
    if (!version) throw new AppError(404, "Version not found");

    res.json(version);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/agents/:id/versions/:v1/diff/:v2 — diff two versions
agentVersionRouter.get("/:id/versions/:v1/diff/:v2", async (req, res, next) => {
  try {
    await verifyAgentAccess(req.params.id, req.auth!.tenantId);

    const v1 = parseInt(req.params.v1, 10);
    const v2 = parseInt(req.params.v2, 10);
    if (isNaN(v1) || isNaN(v2)) throw new AppError(400, "Invalid version numbers");

    const diffs = await diffVersions(req.params.id, v1, v2);

    await prisma.activityLog.create({
      data: {
        tenantId: req.auth!.tenantId,
        actor: req.auth!.userId,
        action: "agent_version.diff",
        resource: "agent",
        resourceId: req.params.id,
        details: { v1, v2 },
      },
    });

    res.json({ agentId: req.params.id, v1, v2, diffs });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/agents/:id/rollback — rollback to a target version
const rollbackSchema = z.object({
  targetVersion: z.number().int().min(1),
});

agentVersionRouter.post("/:id/rollback", async (req, res, next) => {
  try {
    const result = await tenantTx(async (tx) => {
      await lockAgentHistory(tx, req.params.id, req.auth!.tenantId);
      const { targetVersion } = rollbackSchema.parse(req.body);
      const rolledBack = await rollbackToVersion(req.params.id, targetVersion, req.auth!.userId, tx);
      await tx.activityLog.create({
        data: {
          tenantId: req.auth!.tenantId, actor: req.auth!.userId,
          action: "agent_version.rollback", resource: "agent", resourceId: req.params.id,
          details: { targetVersion, newVersion: rolledBack.version.version },
        },
      });
      return { ...rolledBack, targetVersion };
    });
    logger.info({ agentId: req.params.id, newVersion: result.version.version }, "Agent rolled back");

    res.json({
      agent: result.agent,
      version: result.version,
      message: `Rolled back to version ${result.targetVersion}`,
    });
  } catch (err) {
    next(err);
  }
});

// BRA-P2-02e: dry-run worktree PREVIEW. Behind WORKTREE_PLAN_ENABLED (default off => 404). Pure planning only:
// nothing is written, stored or executed; the response is metadata-only (see worktree-preview.ts, ADR-0008:
// persistence of worktree state is deferred). Tenant scope: the agent must belong to the caller's tenant.
const worktreePlanSchema = z.strictObject({
  root: z.string().min(1).max(MAX_PATH_LENGTH),
  subPath: z.string().min(1).max(MAX_PATH_LENGTH).optional(),
  patches: z
    .array(
      z.strictObject({
        path: z.string().max(MAX_PATH_LENGTH),
        op: z.enum(["create", "modify", "delete"]),
        content: z.string().max(MAX_CONTENT_BYTES).optional(),
      }),
    )
    .max(MAX_PATCHES),
});

// POST /api/v1/agents/:id/worktree/plan
agentVersionRouter.post("/:id/worktree/plan", async (req, res, next) => {
  try {
    if (!env.WORKTREE_PLAN_ENABLED) throw new AppError(404, "Not found");
    const agentId = String(req.params.id);
    await verifyAgentAccess(agentId, req.auth!.tenantId);
    const body = worktreePlanSchema.parse(req.body);
    const plan = planWorktree(body);
    if (!plan.ok) {
      // code only: the planner's message can echo the caller's path.
      res.status(422).json({ dryRun: true, ok: false, code: plan.code });
      return;
    }
    res.json(buildWorktreePreview(plan, body.patches, { tenantId: req.auth!.tenantId, agentId, now: new Date() }));
  } catch (err) {
    next(err);
  }
});
