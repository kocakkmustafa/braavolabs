/**
 * External-automation connections API.
 *
 * Connect an existing n8n / Make / Zapier instance so the poller mirrors its
 * executions into ExternalRun — the dashboard then shows native + external
 * runs together. Credentials are AES-256-GCM encrypted at rest with a
 * row-bound AAD; the plaintext key is never returned (PUBLIC_SELECT omits it).
 */
import { Router } from "express";
import { z } from "zod";
import { PLAN_LIMITS } from "@ai-company-os/core";
import { authMiddleware } from "../../middleware/auth";
import { prisma } from "../../lib/db";
import { AppError } from "../../middleware/error";
import { encrypt } from "../../lib/encryption";
import { assertPublicUrl } from "./adapters/types";
import { pollConnection, credentialsAad, validateConnectionCredentials } from "./poller";
import { capabilitiesFor, listExternalWorkflows, runControlAction } from "./control";
import { getEffectivePlan } from "../billing/entitlement-ledger.service";

export const externalRouter = Router();
externalRouter.use(authMiddleware);

// Never select encryptedCredentials — the plaintext key must never round-trip.
const PUBLIC_SELECT = {
  id: true,
  platform: true,
  label: true,
  baseUrl: true,
  companyId: true,
  pollIntervalSec: true,
  enabled: true,
  status: true,
  lastPolledAt: true,
  lastError: true,
  createdAt: true,
  updatedAt: true,
} as const;

const createSchema = z.object({
  platform: z.enum(["N8N", "MAKE", "ZAPIER", "GENERIC"]),
  label: z.string().min(1).max(120),
  baseUrl: z.string().url().max(500),
  apiKey: z.string().min(1).max(2000),
  companyId: z.string().optional(),
  pollIntervalSec: z.number().int().min(30).max(3600).optional(),
});

// POST /api/v1/external-connections — connect a platform
externalRouter.post("/", async (req, res, next) => {
  try {
    const body = createSchema.parse(req.body);
    try {
      await assertPublicUrl(body.baseUrl);
    } catch (e) {
      throw new AppError(400, (e as Error).message);
    }

    // Resolve current ledger rights before validating or storing credentials.
    const tenant = await prisma.tenant.findUnique({
      where: { id: req.auth!.tenantId },
      select: { plan: true },
    });
    if (!tenant) throw new AppError(401, "Tenant not found");
    const plan = await getEffectivePlan(req.auth!.tenantId, tenant.plan);
    const limit = PLAN_LIMITS[plan].maxConnectedAutomations;
    if (limit !== -1) {
      const count = await prisma.externalConnection.count({ where: { tenantId: req.auth!.tenantId } });
      if (count >= limit) {
        throw new AppError(
          402,
          `Connected-automation limit reached for ${plan} plan (${limit}). Upgrade to connect more.`,
        );
      }
    }

    // Feature F3 — live validation before we commit the connection's health.
    // One real fetchExecutions with the submitted credential tells the user
    // immediately whether it works, instead of silently creating a dead row.
    // Never throws — the connection is still created either way.
    const validation = await validateConnectionCredentials({
      platform: body.platform,
      baseUrl: body.baseUrl,
      apiKey: body.apiKey,
    });

    // Create first to get the row id, then encrypt the key bound to it.
    const conn = await prisma.externalConnection.create({
      data: {
        tenantId: req.auth!.tenantId,
        platform: body.platform,
        label: body.label,
        baseUrl: body.baseUrl,
        companyId: body.companyId ?? null,
        pollIntervalSec: body.pollIntervalSec ?? 60,
        encryptedCredentials: "",
      },
    });
    const enc = encrypt(body.apiKey, credentialsAad(req.auth!.tenantId, conn.id));
    // Reflect the validation result on the existing status/lastError columns
    // (no migration needed — same fields the poller writes). Validated →
    // ACTIVE with lastPolledAt; failed → ERROR + lastError so the card shows
    // the reason. The poller will retry a failed connection on schedule.
    const updated = await prisma.externalConnection.update({
      where: { id: conn.id },
      data: {
        encryptedCredentials: enc,
        status: validation.validated ? "ACTIVE" : "ERROR",
        lastError: validation.validated ? null : validation.validationError ?? "Validation failed",
        ...(validation.validated ? { lastPolledAt: new Date() } : {}),
      },
      select: PUBLIC_SELECT,
    });

    await prisma.activityLog.create({
      data: {
        tenantId: req.auth!.tenantId,
        actor: req.auth!.userId,
        action: "external.connect",
        resource: "external_connection",
        resourceId: conn.id,
        details: {
          platform: body.platform,
          label: body.label,
          validated: validation.validated,
          recentRuns: validation.recentRuns,
        },
      },
    });

    // Return the connection plus the explicit validation outcome so the UI can
    // surface "Connected ✓ — N recent runs found" or "Couldn't reach it: …".
    res.status(201).json({
      ...updated,
      validated: validation.validated,
      validationError: validation.validationError,
      recentRuns: validation.recentRuns,
    });
  } catch (err) { next(err); }
});

// GET /api/v1/external-connections — list the tenant's connections
externalRouter.get("/", async (req, res, next) => {
  try {
    const conns = await prisma.externalConnection.findMany({
      where: { tenantId: req.auth!.tenantId },
      select: PUBLIC_SELECT,
      orderBy: { createdAt: "desc" },
    });
    // Attach the platform's honest control capabilities so the UI knows which
    // buttons (trigger / pause / stop) to render per connection.
    res.json(conns.map((c) => ({ ...c, capabilities: capabilitiesFor(c.platform) })));
  } catch (err) { next(err); }
});

const patchSchema = z.object({
  enabled: z.boolean().optional(),
  pollIntervalSec: z.number().int().min(30).max(3600).optional(),
  label: z.string().min(1).max(120).optional(),
});

// PATCH /api/v1/external-connections/:id — toggle enabled / interval / label
externalRouter.patch("/:id", async (req, res, next) => {
  try {
    const conn = await prisma.externalConnection.findFirst({
      where: { id: req.params.id, tenantId: req.auth!.tenantId },
    });
    if (!conn) throw new AppError(404, "Connection not found");
    const patch = patchSchema.parse(req.body);
    const updated = await prisma.externalConnection.update({
      where: { id: conn.id },
      data: patch,
      select: PUBLIC_SELECT,
    });
    res.json(updated);
  } catch (err) { next(err); }
});

// DELETE /api/v1/external-connections/:id
externalRouter.delete("/:id", async (req, res, next) => {
  try {
    const conn = await prisma.externalConnection.findFirst({
      where: { id: req.params.id, tenantId: req.auth!.tenantId },
    });
    if (!conn) throw new AppError(404, "Connection not found");
    await prisma.externalConnection.delete({ where: { id: conn.id } });
    await prisma.activityLog.create({
      data: {
        tenantId: req.auth!.tenantId,
        actor: req.auth!.userId,
        action: "external.disconnect",
        resource: "external_connection",
        resourceId: conn.id,
      },
    });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /api/v1/external-connections/:id/poll — poll now (test the connection)
externalRouter.post("/:id/poll", async (req, res, next) => {
  try {
    const conn = await prisma.externalConnection.findFirst({
      where: { id: req.params.id, tenantId: req.auth!.tenantId },
    });
    if (!conn) throw new AppError(404, "Connection not found");
    await pollConnection(conn);
    const fresh = await prisma.externalConnection.findUnique({
      where: { id: conn.id },
      select: PUBLIC_SELECT,
    });
    res.json(fresh);
  } catch (err) { next(err); }
});

// GET /api/v1/external-connections/:id/runs — mirrored external executions
externalRouter.get("/:id/runs", async (req, res, next) => {
  try {
    const conn = await prisma.externalConnection.findFirst({
      where: { id: req.params.id, tenantId: req.auth!.tenantId },
      select: { id: true },
    });
    if (!conn) throw new AppError(404, "Connection not found");
    const runs = await prisma.externalRun.findMany({
      where: { connectionId: conn.id },
      orderBy: { startedAt: "desc" },
      take: 50,
    });
    res.json(runs);
  } catch (err) { next(err); }
});

// ── Control plane ──────────────────────────────────────────────

const controlSchema = z.object({
  type: z.enum(["TRIGGER", "PAUSE", "RESUME", "STOP"]),
  // workflow/scenario id, execution id, or (GENERIC trigger) a full https URL.
  targetId: z.string().min(1).max(2000),
});

// GET /api/v1/external-connections/:id/workflows — list automations on the platform
externalRouter.get("/:id/workflows", async (req, res, next) => {
  try {
    const conn = await prisma.externalConnection.findFirst({
      where: { id: req.params.id, tenantId: req.auth!.tenantId },
    });
    if (!conn) throw new AppError(404, "Connection not found");
    res.json(await listExternalWorkflows(conn));
  } catch (err) { next(err); }
});

// POST /api/v1/external-connections/:id/control — trigger / pause / resume / stop
externalRouter.post("/:id/control", async (req, res, next) => {
  try {
    const conn = await prisma.externalConnection.findFirst({
      where: { id: req.params.id, tenantId: req.auth!.tenantId },
    });
    if (!conn) throw new AppError(404, "Connection not found");
    const { type, targetId } = controlSchema.parse(req.body);
    const result = await runControlAction({ conn, actor: req.auth!.userId, type, targetId });
    res.json(result);
  } catch (err) { next(err); }
});
