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
import { authMiddleware } from "../../middleware/auth";
import { prisma } from "../../lib/db";
import { AppError } from "../../middleware/error";
import { encrypt } from "../../lib/encryption";
import { assertPublicUrl } from "./adapters/types";
import { pollConnection, credentialsAad } from "./poller";

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
      assertPublicUrl(body.baseUrl);
    } catch (e) {
      throw new AppError(400, (e as Error).message);
    }

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
    const updated = await prisma.externalConnection.update({
      where: { id: conn.id },
      data: { encryptedCredentials: enc },
      select: PUBLIC_SELECT,
    });

    await prisma.activityLog.create({
      data: {
        tenantId: req.auth!.tenantId,
        actor: req.auth!.userId,
        action: "external.connect",
        resource: "external_connection",
        resourceId: conn.id,
        details: { platform: body.platform, label: body.label },
      },
    });

    res.status(201).json(updated);
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
    res.json(conns);
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
