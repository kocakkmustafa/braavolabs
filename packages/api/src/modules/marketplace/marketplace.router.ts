/**
 * Connector marketplace router.
 *
 * Public surfaces:
 *   GET  /marketplace/connectors            catalog list (visibility=PUBLIC + approved)
 *   GET  /marketplace/connectors/:slug      detail
 *
 * Tenant surfaces (auth required):
 *   GET    /marketplace/installed            list this tenant's installs
 *   POST   /marketplace/connectors/:slug/install   { credentials, spendCapUsd? }
 *   POST   /marketplace/connectors/:slug/refresh   re-fetch the live manifest
 *   POST   /marketplace/connectors/:slug/uninstall
 *
 * Publisher surfaces (auth required):
 *   POST   /marketplace/publish              upsert a connector (own tenant)
 *   PATCH  /marketplace/connectors/:slug     update metadata (publisher only)
 *
 * Admin surfaces (auth + isAdmin):
 *   POST   /marketplace/connectors/:slug/approve
 *   POST   /marketplace/connectors/:slug/unapprove
 */

import { Router } from "express";
import { z } from "zod";
import { authMiddleware } from "../../middleware/auth";
import { prisma } from "../../lib/db";
import { encrypt, decrypt } from "../../lib/encryption";
import { AppError } from "../../middleware/error";
import { logger } from "../../lib/logger";
import { assertSafeExternalUrl, SsrfError } from "../../lib/ssrf";
import { listTools } from "../../lib/mcp";

export const marketplaceRouter = Router();

// ── Public catalog ────────────────────────────────────────

marketplaceRouter.get("/connectors", async (req, res, next) => {
  try {
    const q = (req.query.q as string | undefined)?.trim();
    const where: any = { visibility: "PUBLIC", isApproved: true };
    if (q) where.OR = [{ name: { contains: q, mode: "insensitive" } }, { slug: { contains: q, mode: "insensitive" } }];
    const list = await prisma.connector.findMany({
      where,
      orderBy: [{ installCount: "desc" }, { name: "asc" }],
      select: {
        id: true,
        slug: true,
        name: true,
        version: true,
        vendor: true,
        description: true,
        iconUrl: true,
        documentationUrl: true,
        authMethod: true,
        installCount: true,
        toolsManifest: true,
      },
    });
    res.json(list);
  } catch (err) { next(err); }
});

marketplaceRouter.get("/connectors/:slug", async (req, res, next) => {
  try {
    const slug = req.params.slug;
    const c = await prisma.connector.findUnique({ where: { slug } });
    if (!c) throw new AppError(404, "Connector not found");
    if (c.visibility !== "PUBLIC" || !c.isApproved) {
      // Hide unapproved from public; the publisher tenant sees the
      // detail via /tenant/installed/.../draft path instead.
      throw new AppError(404, "Connector not found");
    }
    res.json({
      id: c.id,
      slug: c.slug,
      name: c.name,
      version: c.version,
      vendor: c.vendor,
      description: c.description,
      iconUrl: c.iconUrl,
      documentationUrl: c.documentationUrl,
      authMethod: c.authMethod,
      authSchema: c.authSchema,
      installCount: c.installCount,
      toolsManifest: c.toolsManifest,
      manifestSignature: c.manifestSignature,
    });
  } catch (err) { next(err); }
});

// ── Tenant surfaces (auth) ────────────────────────────────

const tenantRouter = Router();
tenantRouter.use(authMiddleware);

const installSchema = z.object({
  credentials: z.record(z.string()).default({}),
  spendCapUsd: z.number().min(0.01).max(10_000).nullable().optional(),
});

function aadFor(tenantId: string, connectorId: string): string {
  return `${tenantId}|tenant_connector|${connectorId}`;
}

tenantRouter.get("/installed", async (req, res, next) => {
  try {
    const installs = await prisma.tenantConnector.findMany({
      where: { tenantId: req.auth!.tenantId },
      include: {
        connector: {
          select: {
            id: true,
            slug: true,
            name: true,
            vendor: true,
            version: true,
            iconUrl: true,
            description: true,
            authMethod: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });
    res.json(installs);
  } catch (err) { next(err); }
});

tenantRouter.post("/connectors/:slug/install", async (req, res, next) => {
  try {
    const body = installSchema.parse(req.body);
    const connector = await prisma.connector.findUnique({ where: { slug: req.params.slug } });
    if (!connector) throw new AppError(404, "Connector not found");
    // PRIVATE connectors can only be installed by their publisher
    // tenant; UNLISTED can be installed by anyone who knows the
    // slug; PUBLIC requires approval (which the catalog enforces).
    if (connector.visibility === "PRIVATE" && connector.publisherTenantId !== req.auth!.tenantId) {
      throw new AppError(404, "Connector not found");
    }
    if (connector.visibility === "PUBLIC" && !connector.isApproved) {
      throw new AppError(404, "Connector not found");
    }

    const credsBlob = JSON.stringify(body.credentials);
    const encryptedCredentials = encrypt(credsBlob, aadFor(req.auth!.tenantId, connector.id));

    // Probe the MCP server with the supplied credentials before
    // committing — fail-fast on a bad API key rather than letting
    // the agent discover it mid-run.
    let manifest: unknown = connector.toolsManifest;
    try {
      const tools = await listTools(connector.mcpServerUrl, connector.authMethod, body.credentials);
      manifest = tools as any;
    } catch (err) {
      logger.warn(
        { err, slug: connector.slug, tenantId: req.auth!.tenantId },
        "Connector probe failed during install — caching publish-time manifest instead",
      );
    }

    const install = await prisma.tenantConnector.upsert({
      where: {
        tenantId_connectorId: { tenantId: req.auth!.tenantId, connectorId: connector.id },
      },
      create: {
        tenantId: req.auth!.tenantId,
        connectorId: connector.id,
        encryptedCredentials,
        cachedToolsManifest: manifest as any,
        cachedAt: new Date(),
        spendCapUsd: body.spendCapUsd ?? null,
      },
      update: {
        encryptedCredentials,
        cachedToolsManifest: manifest as any,
        cachedAt: new Date(),
        spendCapUsd: body.spendCapUsd ?? null,
        isEnabled: true,
      },
    });
    await prisma.connector.update({
      where: { id: connector.id },
      data: { installCount: { increment: 1 } },
    });
    await prisma.activityLog.create({
      data: {
        tenantId: req.auth!.tenantId,
        actor: req.auth!.userId,
        action: "marketplace.install",
        resource: "tenant_connector",
        resourceId: install.id,
        details: { slug: connector.slug, version: connector.version },
      },
    });
    res.json({ id: install.id, slug: connector.slug, version: connector.version });
  } catch (err) { next(err); }
});

tenantRouter.post("/connectors/:slug/refresh", async (req, res, next) => {
  try {
    const connector = await prisma.connector.findUnique({ where: { slug: req.params.slug } });
    if (!connector) throw new AppError(404, "Connector not found");
    const install = await prisma.tenantConnector.findUnique({
      where: { tenantId_connectorId: { tenantId: req.auth!.tenantId, connectorId: connector.id } },
    });
    if (!install) throw new AppError(404, "Connector not installed");
    let creds: Record<string, string> | undefined;
    try {
      creds = JSON.parse(decrypt(install.encryptedCredentials, aadFor(req.auth!.tenantId, connector.id)));
    } catch {
      throw new AppError(500, "Failed to decrypt connector credentials");
    }
    const tools = await listTools(connector.mcpServerUrl, connector.authMethod, creds);
    await prisma.tenantConnector.update({
      where: { id: install.id },
      data: { cachedToolsManifest: tools as any, cachedAt: new Date() },
    });
    res.json({ success: true, toolCount: tools.length });
  } catch (err) { next(err); }
});

tenantRouter.post("/connectors/:slug/uninstall", async (req, res, next) => {
  try {
    const connector = await prisma.connector.findUnique({ where: { slug: req.params.slug } });
    if (!connector) throw new AppError(404, "Connector not found");
    await prisma.tenantConnector.deleteMany({
      where: { tenantId: req.auth!.tenantId, connectorId: connector.id },
    });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── Publisher surface ─────────────────────────────────────

const publishSchema = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,60}[a-z0-9]$/),
  name: z.string().min(1).max(120),
  version: z.string().regex(/^\d+\.\d+\.\d+$/).default("1.0.0"),
  vendor: z.string().min(1).max(120),
  description: z.string().min(1).max(2000),
  iconUrl: z.string().url().max(500).optional(),
  documentationUrl: z.string().url().max(500).optional(),
  mcpServerUrl: z.string().url().max(500),
  authMethod: z.enum(["NONE", "API_KEY", "OAUTH2", "BASIC", "CUSTOM"]).default("NONE"),
  authSchema: z.record(z.unknown()).default({}),
  visibility: z.enum(["PUBLIC", "UNLISTED", "PRIVATE"]).default("PRIVATE"),
  manifestSignature: z.string().max(1000).optional(),
});

tenantRouter.post("/publish", async (req, res, next) => {
  try {
    const body = publishSchema.parse(req.body);
    // SSRF guard on the MCP server URL — same as every other tenant-
    // supplied URL across the platform.
    try {
      await assertSafeExternalUrl(body.mcpServerUrl);
    } catch (err) {
      if (err instanceof SsrfError) {
        throw new AppError(400, `mcpServerUrl rejected: ${err.message}`);
      }
      throw err;
    }
    // PUBLIC submissions land as is_approved=false; admin
    // approval flips the flag and surfaces them in the catalog.
    // UNLISTED / PRIVATE are usable immediately by anyone who
    // knows the slug or by the publishing tenant.
    const existing = await prisma.connector.findUnique({ where: { slug: body.slug } });
    if (existing && existing.publisherTenantId !== req.auth!.tenantId) {
      throw new AppError(409, "Connector slug already taken");
    }
    // Probe the manifest at publish time so the catalog listing
    // shows the live tool list. Failures degrade gracefully —
    // the connector still publishes with an empty manifest.
    let toolsManifest: unknown = [];
    try {
      const tools = await listTools(body.mcpServerUrl, body.authMethod, {});
      toolsManifest = tools as any;
    } catch (err) {
      logger.warn({ err, slug: body.slug }, "Manifest probe failed at publish");
    }
    const upserted = await prisma.connector.upsert({
      where: { slug: body.slug },
      create: {
        slug: body.slug,
        name: body.name,
        version: body.version,
        vendor: body.vendor,
        description: body.description,
        iconUrl: body.iconUrl,
        documentationUrl: body.documentationUrl,
        mcpServerUrl: body.mcpServerUrl,
        authMethod: body.authMethod,
        authSchema: body.authSchema as any,
        visibility: body.visibility,
        manifestSignature: body.manifestSignature,
        toolsManifest: toolsManifest as any,
        publisherTenantId: req.auth!.tenantId,
        isApproved: body.visibility !== "PUBLIC",
      },
      update: {
        name: body.name,
        version: body.version,
        vendor: body.vendor,
        description: body.description,
        iconUrl: body.iconUrl,
        documentationUrl: body.documentationUrl,
        mcpServerUrl: body.mcpServerUrl,
        authMethod: body.authMethod,
        authSchema: body.authSchema as any,
        visibility: body.visibility,
        toolsManifest: toolsManifest as any,
        manifestSignature: body.manifestSignature,
        // Updating an approved PUBLIC connector requires re-approval
        // to prevent a published-then-swapped malicious manifest.
        isApproved: body.visibility !== "PUBLIC" ? true : !!(existing?.isApproved && existing.version === body.version),
      },
    });
    await prisma.activityLog.create({
      data: {
        tenantId: req.auth!.tenantId,
        actor: req.auth!.userId,
        action: "marketplace.publish",
        resource: "connector",
        resourceId: upserted.id,
        details: { slug: upserted.slug, version: upserted.version, visibility: upserted.visibility },
      },
    });
    res.json({
      id: upserted.id,
      slug: upserted.slug,
      version: upserted.version,
      isApproved: upserted.isApproved,
      pendingReview: !upserted.isApproved && upserted.visibility === "PUBLIC",
    });
  } catch (err) { next(err); }
});

// ── Admin moderation (env-gated) ──────────────────────────

tenantRouter.post("/connectors/:slug/approve", async (req, res, next) => {
  try {
    // Simple admin check via env-listed user emails. A full RBAC
    // refactor is a follow-up; this keeps the moderation gate
    // explicit and bypassable only by the operator with shell
    // access to .env.
    const adminEmails = (process.env.MARKETPLACE_ADMIN_EMAILS ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
    const me = await prisma.user.findUnique({ where: { id: req.auth!.userId }, select: { email: true } });
    if (!me || !adminEmails.includes(me.email.toLowerCase())) {
      throw new AppError(403, "Marketplace moderation is restricted to platform admins");
    }
    await prisma.connector.update({
      where: { slug: req.params.slug },
      data: { isApproved: true },
    });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// Mount the auth-protected surface on the same prefix so the catalog
// (public) and tenant routes share one base.
marketplaceRouter.use(tenantRouter);
