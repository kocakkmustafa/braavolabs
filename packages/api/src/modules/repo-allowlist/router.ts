import { Router } from "express";
import { z } from "zod";
import { authMiddleware } from "../../middleware/auth";
import { requirePermission } from "../../middleware/require-permission";
import { prisma, tenantTx } from "../../lib/db";
import { AppError } from "../../middleware/error";
import { env } from "../../config/env";
import {
  MAX_REPOS_PER_TENANT,
  isValidBranch,
  isValidInstallationId,
  isValidOwner,
  isValidRepo,
  repoFullName,
} from "./validate";

/**
 * BRA-P1-03-N1 — tenant repository ALLOWLIST (read-only intent). Mounted at /api/v1/tenant-repos behind
 * TENANT_REPOS_ENABLED (default off => 404). It only records which repositories a tenant lists; there is no GitHub
 * call, no token, no write access anywhere in this module. Listing is open to any tenant member, changing the list
 * needs `repo:manage` (ADMIN). The table ships with a migration that goes live only with a `v*` release.
 *
 * TRUST NOTE: a row is a tenant's INTENT, not proof of access. `installationId` is stored unverified, so one tenant
 * could list another's repository name. The later GitHub App slice must, on EVERY use, check with GitHub that the
 * installation really reaches that repository (and belongs to the tenant) instead of trusting this table.
 */
export const tenantRepoRouter = Router();
tenantRepoRouter.use(authMiddleware);
tenantRepoRouter.use((_req, _res, next) => {
  if (!env.TENANT_REPOS_ENABLED) return next(new AppError(404, "Not found"));
  next();
});

const SELECT = {
  id: true,
  provider: true,
  owner: true,
  repo: true,
  fullName: true,
  installationId: true,
  defaultBranch: true,
  createdAt: true,
  updatedAt: true,
} as const;

const createSchema = z.strictObject({
  owner: z.string().refine(isValidOwner, "invalid owner"),
  repo: z.string().refine(isValidRepo, "invalid repo"),
  installationId: z.string().refine(isValidInstallationId, "invalid installationId").optional(),
  defaultBranch: z.string().refine(isValidBranch, "invalid defaultBranch").optional(),
});

const isUniqueViolation = (err: unknown) => typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002";

// GET /api/v1/tenant-repos
tenantRepoRouter.get("/", async (req, res, next) => {
  try {
    const repos = await prisma.tenantRepository.findMany({
      where: { tenantId: req.auth!.tenantId },
      orderBy: { fullName: "asc" },
      take: MAX_REPOS_PER_TENANT,
      select: SELECT,
    });
    res.json({ repositories: repos });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/tenant-repos/:id
tenantRepoRouter.get("/:id", async (req, res, next) => {
  try {
    const repo = await prisma.tenantRepository.findFirst({
      where: { id: String(req.params.id), tenantId: req.auth!.tenantId },
      select: SELECT,
    });
    if (!repo) throw new AppError(404, "Repository not found");
    res.json(repo);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/tenant-repos — add to the allowlist (ADMIN)
tenantRepoRouter.post("/", requirePermission("repo:manage"), async (req, res, next) => {
  try {
    const body = createSchema.parse(req.body);
    const tenantId = req.auth!.tenantId;
    let created;
    try {
      created = await tenantTx(async (tx) => {
        // Same tenant-row lock as assertCompanyCapacity: serialises concurrent adds so the cap cannot be overrun.
        const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM tenants WHERE id = ${tenantId} FOR UPDATE`;
        if (locked.length !== 1) throw new AppError(401, "Tenant not found");
        const count = await tx.tenantRepository.count({ where: { tenantId } });
        if (count >= MAX_REPOS_PER_TENANT) throw new AppError(409, `Repository allowlist is full (${MAX_REPOS_PER_TENANT})`, undefined, "REPO_ALLOWLIST_FULL");
        const row = await tx.tenantRepository.create({
          data: {
            tenantId,
            provider: "GITHUB",
            owner: body.owner,
            repo: body.repo,
            fullName: repoFullName(body.owner, body.repo),
            installationId: body.installationId ?? null,
            defaultBranch: body.defaultBranch ?? null,
            createdByUserId: req.auth!.userId,
          },
          select: SELECT,
        });
        await tx.activityLog.create({
          data: {
            tenantId,
            actor: req.auth!.userId,
            action: "repo.allowlist.add",
            resource: "tenant_repository",
            resourceId: row.id,
            details: { fullName: row.fullName },
          },
        });
        return row;
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new AppError(409, "Repository already in the allowlist", undefined, "REPO_ALREADY_REGISTERED");
      throw err;
    }
    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/tenant-repos/:id — remove from the allowlist (ADMIN)
tenantRepoRouter.delete("/:id", requirePermission("repo:manage"), async (req, res, next) => {
  try {
    const tenantId = req.auth!.tenantId;
    const id = String(req.params.id);
    await tenantTx(async (tx) => {
      const existing = await tx.tenantRepository.findFirst({ where: { id, tenantId }, select: { id: true, fullName: true } });
      if (!existing) throw new AppError(404, "Repository not found");
      await tx.tenantRepository.deleteMany({ where: { id, tenantId } });
      await tx.activityLog.create({
        data: {
          tenantId,
          actor: req.auth!.userId,
          action: "repo.allowlist.remove",
          resource: "tenant_repository",
          resourceId: existing.id,
          details: { fullName: existing.fullName },
        },
      });
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
