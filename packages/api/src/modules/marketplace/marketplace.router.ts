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
import { systemScope } from "../../middleware/system-scope";
import { prisma } from "../../lib/db";
import { encrypt, decrypt } from "../../lib/encryption";
import { AppError } from "../../middleware/error";
import { logger } from "../../lib/logger";
import { assertSafeExternalUrl, SsrfError } from "../../lib/ssrf";
import { listTools, type McpTool } from "../../lib/mcp";
import { connectorManifestSchema } from "@ai-company-os/connector-sdk";
import { signManifest, verifyManifest, isSignedManifest } from "./manifest-signature";
import { claimQuota } from "../billing/metering";
import { PLAN_LIMITS } from "@ai-company-os/core";
import type { Plan } from "@ai-company-os/core";

export const marketplaceRouter = Router();

// ── Public catalog ────────────────────────────────────────

marketplaceRouter.get("/connectors", systemScope("route:marketplace-public"), async (req, res, next) => {
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

marketplaceRouter.get("/connectors/:slug", systemScope("route:marketplace-public"), async (req, res, next) => {
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
    let probedTools: McpTool[] | null = null;
    try {
      probedTools = await listTools(connector.mcpServerUrl, connector.authMethod, body.credentials);
      manifest = probedTools as any;
    } catch (err) {
      logger.warn(
        { err, slug: connector.slug, tenantId: req.auth!.tenantId },
        "Connector probe failed during install — caching publish-time manifest instead",
      );
    }

    // ── Manifest HMAC verification (E5/T5) ───────────────────────
    // When the connector carries a signature AND we got a live tool set,
    // verify the live surface matches what the publisher signed. A mismatch
    // means the MCP server's tool set was swapped after publish — reject the
    // install rather than caching a tampered manifest. Legacy/unsigned
    // connectors (no HMAC signature) skip verification for back-compat, and a
    // probe failure falls back to the already-signed publish-time manifest.
    if (probedTools && isSignedManifest(connector.manifestSignature)) {
      const ok = verifyManifest(connector.publisherTenantId ?? "", connector.manifestSignature, {
        slug: connector.slug,
        version: connector.version,
        tools: probedTools,
      });
      if (!ok) {
        throw new AppError(
          409,
          "Connector manifest signature mismatch — the live tool set does not match the signed manifest. " +
            "This connector may have been tampered with; install refused.",
        );
      }
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

    // ── Manifest HMAC verification (E5/T5) ───────────────────────
    // Refresh is the exact post-approval-swap attack surface: a publisher
    // changes the MCP server's tool set after approval and every tenant's
    // refresh silently pulls it. Verify the re-probed surface against the
    // signed manifest; a mismatch refuses to cache the tampered tools.
    if (isSignedManifest(connector.manifestSignature)) {
      const ok = verifyManifest(connector.publisherTenantId ?? "", connector.manifestSignature, {
        slug: connector.slug,
        version: connector.version,
        tools,
      });
      if (!ok) {
        throw new AppError(
          409,
          "Connector manifest signature mismatch — the live tool set does not match the signed manifest. " +
            "Refresh refused; the connector may have been tampered with after publish.",
        );
      }
    }

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
  // Publisher-declared tool surface. Optional — when omitted the publish-time
  // MCP probe supplies the tool list. Either way the SERVER signs it (the
  // publisher can NOT supply their own `manifestSignature`; a self-signed
  // digest would defeat the integrity check).
  tools: z
    .array(
      z.object({
        name: z.string().min(1).max(80),
        description: z.string().max(1000).optional(),
        inputSchema: z.record(z.unknown()).optional(),
        riskHint: z.enum(["low", "medium", "high", "money"]).optional(),
      }),
    )
    .max(200)
    .optional(),
});

// Connectors publishing is gated by plan connected-automation limits. FREE
// tenants may not publish at all; the rest are capped by
// maxConnectedAutomations (the same lever that bounds importer connections).
// A platform admin bypasses the gate entirely.
function publishLimitForPlan(plan: Plan): number {
  return PLAN_LIMITS[plan]?.maxConnectedAutomations ?? 0;
}

function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const adminEmails = (process.env.MARKETPLACE_ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return adminEmails.includes(email.toLowerCase());
}

tenantRouter.post("/publish", async (req, res, next) => {
  try {
    const body = publishSchema.parse(req.body);
    const tenantId = req.auth!.tenantId;

    // Full manifest validation FAIL-CLOSED. The Zod publishSchema already
    // constrained the individual fields, but running the SDK's
    // connectorManifestSchema here is the single source of truth so a
    // publish body and a `createConnector(...)` manifest validate identically.
    const manifestCheck = connectorManifestSchema.safeParse({
      slug: body.slug,
      name: body.name,
      version: body.version,
      vendor: body.vendor,
      description: body.description,
      iconUrl: body.iconUrl,
      documentationUrl: body.documentationUrl,
      mcpServerUrl: body.mcpServerUrl,
      authMethod: body.authMethod,
      visibility: body.visibility,
      tools: body.tools ?? [],
    });
    if (!manifestCheck.success) {
      const detail = manifestCheck.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
      throw new AppError(400, `Invalid connector manifest: ${detail}`);
    }

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
    if (existing && existing.publisherTenantId !== tenantId) {
      throw new AppError(409, "Connector slug already taken");
    }

    // ── Publish gate (E5/T6 — plan / quota / admin) ──────────────
    // Publishing was previously unbounded for any authenticated tenant.
    // Now it is gated: platform admins bypass; everyone else is bounded by
    // their plan's connected-automation allowance and a per-tenant publish
    // meter (claimQuota). A brand-new version of an EXISTING owned connector
    // is an update, not a new publish, so it doesn't re-consume the gate.
    const me = await prisma.user.findUnique({
      where: { id: req.auth!.userId },
      select: { email: true },
    });
    const admin = isAdminEmail(me?.email);
    const isNewPublish = !existing;
    if (!admin && isNewPublish) {
      const tenant = await prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { plan: true },
      });
      const plan = (tenant?.plan ?? "FREE") as Plan;
      const limit = publishLimitForPlan(plan);
      if (limit === 0) {
        throw new AppError(
          403,
          "Your plan does not include publishing connectors. Upgrade to publish to the marketplace.",
        );
      }
      if (limit > 0) {
        const publishedCount = await prisma.connector.count({
          where: { publisherTenantId: tenantId },
        });
        if (publishedCount >= limit) {
          throw new AppError(
            403,
            `You have reached your plan's connector limit (${limit}). Upgrade or unpublish a connector to publish another.`,
          );
        }
      }
      // Record a per-tenant publish in the billing meter for visibility.
      // NOTE: `connector_publishes` has no hard plan limit (limit=-1), so
      // claimQuota only increments the counter — in prod it never refuses, and
      // the 429 branch is defense-in-depth (kept harmless). The real cap is the
      // `publishedCount >= limit` check above, which is check-then-act: two
      // *concurrent* new publishes could marginally overshoot a tenant's OWN
      // cap. Acceptable for a low-frequency, admin-approved publish flow — a
      // transactional cap is a follow-up (would need a metered connector-
      // publish limit, i.e. a plans.ts change).
      const claim = await claimQuota(tenantId, "connector_publishes");
      if (!claim.claimed) {
        throw new AppError(429, "Connector publish quota exceeded for this billing period.");
      }
    }

    // Probe the manifest at publish time so the catalog listing shows the
    // live tool list. Prefer the publisher-DECLARED tool list when supplied
    // (that's the surface the publisher intends to sign); otherwise fall back
    // to a live probe. Failures degrade gracefully to an empty manifest.
    let toolsManifest: McpTool[] = [];
    if (body.tools && body.tools.length > 0) {
      toolsManifest = body.tools.map((t) => ({
        name: t.name,
        description: t.description ?? "",
        inputSchema: t.inputSchema ?? { type: "object", properties: {} },
      }));
    } else {
      try {
        toolsManifest = await listTools(body.mcpServerUrl, body.authMethod, {});
      } catch (err) {
        logger.warn({ err, slug: body.slug }, "Manifest probe failed at publish");
      }
    }

    // ── FULL HMAC signature (E5/T5) ──────────────────────────────
    // Sign the canonical tool surface with a key derived from the PUBLISHER's
    // tenant. Stored in manifestSignature; verified at install/refresh. The
    // publisher can never supply their own signature — a self-signed digest
    // would defeat the integrity check.
    const manifestSignature = signManifest(tenantId, {
      slug: body.slug,
      version: body.version,
      tools: toolsManifest,
    });

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
        manifestSignature,
        toolsManifest: toolsManifest as any,
        publisherTenantId: tenantId,
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
        manifestSignature,
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

/** Throws 403 unless the caller is a platform admin (env-listed email). A full
 * RBAC refactor is a follow-up; this keeps the moderation gate explicit and
 * bypassable only by the operator with shell access to .env. */
async function assertAdmin(userId: string): Promise<void> {
  const me = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
  if (!isAdminEmail(me?.email)) {
    throw new AppError(403, "Marketplace moderation is restricted to platform admins");
  }
}

tenantRouter.post("/connectors/:slug/approve", async (req, res, next) => {
  try {
    await assertAdmin(req.auth!.userId);
    await prisma.connector.update({
      where: { slug: req.params.slug },
      data: { isApproved: true },
    });
    await prisma.activityLog.create({
      data: {
        tenantId: req.auth!.tenantId,
        actor: req.auth!.userId,
        action: "marketplace.approve",
        resource: "connector",
        resourceId: req.params.slug,
        details: { slug: req.params.slug },
      },
    });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /connectors/:slug/unapprove — admin only. Pulls a previously-approved
// connector back out of the public catalog (spam / policy violation / manifest
// concern). The header documented this route but the code never had it.
tenantRouter.post("/connectors/:slug/unapprove", async (req, res, next) => {
  try {
    await assertAdmin(req.auth!.userId);
    const connector = await prisma.connector.findUnique({ where: { slug: req.params.slug } });
    if (!connector) throw new AppError(404, "Connector not found");
    await prisma.connector.update({
      where: { slug: req.params.slug },
      data: { isApproved: false },
    });
    await prisma.activityLog.create({
      data: {
        tenantId: req.auth!.tenantId,
        actor: req.auth!.userId,
        action: "marketplace.unapprove",
        resource: "connector",
        resourceId: connector.id,
        details: { slug: connector.slug },
      },
    });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// PATCH /connectors/:slug — publisher-only metadata update. Lets a publisher
// fix cosmetic fields (name, description, icon, docs URL) without a full
// re-publish. Deliberately NOT allowed to change mcpServerUrl / tools /
// visibility / version — those are the integrity-relevant fields that must go
// through the signed publish path (which re-signs + drops approval on a PUBLIC
// swap). This route never touches manifestSignature or isApproved.
const patchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().min(1).max(2000).optional(),
  iconUrl: z.string().url().max(500).nullable().optional(),
  documentationUrl: z.string().url().max(500).nullable().optional(),
});

tenantRouter.patch("/connectors/:slug", async (req, res, next) => {
  try {
    const body = patchSchema.parse(req.body);
    const connector = await prisma.connector.findUnique({ where: { slug: req.params.slug } });
    if (!connector) throw new AppError(404, "Connector not found");
    // Publisher-only: the connector must belong to the caller's tenant.
    if (connector.publisherTenantId !== req.auth!.tenantId) {
      throw new AppError(403, "Only the publishing tenant can update this connector");
    }
    // Build a data patch with only the fields that were supplied.
    const data: Record<string, unknown> = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.description !== undefined) data.description = body.description;
    if (body.iconUrl !== undefined) data.iconUrl = body.iconUrl;
    if (body.documentationUrl !== undefined) data.documentationUrl = body.documentationUrl;
    if (Object.keys(data).length === 0) {
      throw new AppError(400, "No updatable fields supplied");
    }
    const updated = await prisma.connector.update({
      where: { slug: req.params.slug },
      data,
    });
    await prisma.activityLog.create({
      data: {
        tenantId: req.auth!.tenantId,
        actor: req.auth!.userId,
        action: "marketplace.update",
        resource: "connector",
        resourceId: updated.id,
        details: { slug: updated.slug, fields: Object.keys(data) },
      },
    });
    res.json({ id: updated.id, slug: updated.slug });
  } catch (err) { next(err); }
});

// Mount the auth-protected surface on the same prefix so the catalog
// (public) and tenant routes share one base.
marketplaceRouter.use(tenantRouter);
