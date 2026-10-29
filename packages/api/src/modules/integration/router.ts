import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/db";
import { encryptForTenant, decryptForTenant } from "../../lib/encryption";
import { logger } from "../../lib/logger";
import { AppError } from "../../middleware/error";
import { authMiddleware } from "../../middleware/auth";
import { validate } from "../../middleware/validate";
import { assertSafeExternalUrl } from "../../lib/ssrf";
import { PROVIDER_INFO, getRequiredProviders, getMissingIntegrations, TOOL_PROVIDER_MAP } from "./checker";
import { getIntegrationCatalog, getIntegrationById } from "./catalog";

const saveIntegrationSchema = z.object({
  provider: z.string().min(1),
  credentials: z.record(z.string(), z.string()),
  label: z.string().optional(),
});

const testIntegrationSchema = z.object({
  provider: z.string().min(1),
});

export const integrationRouter = Router();
integrationRouter.use(authMiddleware);

/**
 * GET /integrations/catalog — browse the pre-built integration catalog
 * Query params: ?category=crm&search=email&status=available
 */
integrationRouter.get("/catalog", (req, res) => {
  const { category, search, status } = req.query;
  const results = getIntegrationCatalog({
    category: category as any,
    search: search as string | undefined,
    status: status as any,
  });
  res.json({
    total: results.length,
    connectors: results,
  });
});

/**
 * GET /integrations/catalog/:id — get a single connector from the catalog
 */
integrationRouter.get("/catalog/:id", (req, res, next) => {
  try {
    const connector = getIntegrationById(req.params.id);
    if (!connector) throw new AppError(404, `Connector '${req.params.id}' not found in catalog`);
    res.json(connector);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /integrations/providers — list all available providers with setup info
 */
integrationRouter.get("/providers", (_req, res) => {
  const providers = Object.entries(PROVIDER_INFO).map(([key, info]) => ({
    provider: key,
    ...info,
  }));
  res.json(providers);
});

/**
 * GET /integrations/tool-map — which tools require which providers
 */
integrationRouter.get("/tool-map", (_req, res) => {
  res.json(TOOL_PROVIDER_MAP);
});

/**
 * GET /integrations/:companyId — list integrations for a company
 */
integrationRouter.get("/:companyId", async (req, res, next) => {
  try {
    const companyId = req.params.companyId as string;
    const company = await prisma.company.findFirst({
      where: { id: companyId, tenantId: req.auth!.tenantId },
    });
    if (!company) throw new AppError(404, "Company not found");

    const integrations = await prisma.integration.findMany({
      where: { companyId },
      orderBy: { createdAt: "desc" },
    });

    // Return integrations WITHOUT decrypted credentials (just status and metadata)
    const safe = integrations.map((i) => ({
      id: i.id,
      companyId: i.companyId,
      provider: i.provider,
      status: i.status,
      label: i.label,
      metadata: i.metadata,
      lastTestedAt: i.lastTestedAt,
      createdAt: i.createdAt,
      updatedAt: i.updatedAt,
      // Show which fields are set (without revealing values)
      fieldsSet: getFieldsSet(i.credentials, req.auth!.tenantId),
    }));

    res.json(safe);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /integrations/:companyId — create or update an integration
 */
integrationRouter.post("/:companyId", validate(saveIntegrationSchema), async (req, res, next) => {
  try {
    const companyId = req.params.companyId as string;
    const ownerCheck = await prisma.company.findFirst({
      where: { id: companyId, tenantId: req.auth!.tenantId },
    });
    if (!ownerCheck) throw new AppError(404, "Company not found");

    const { provider, credentials, label } = req.body;

    if (!PROVIDER_INFO[provider]) {
      throw new AppError(400, `Unknown provider: ${provider}`);
    }

    // SSRF guard on any tenant-supplied URLs inside the credentials
    // payload. Integrations like WordPress (`siteUrl`), Shopify
    // (`shopDomain`), and Custom HTTP webhooks let the user point us
    // at any URL — without validation that means anyone with a paid
    // tenant could aim those at AWS / GCP / Azure instance-metadata
    // IPs, our own Postgres / Redis, or internal Lightsail services.
    // Reject loopback, private, and cloud-metadata ranges at save
    // time so the encrypted blob in the DB is already safe to use.
    const urlFieldNames = ["siteUrl", "shopDomain", "baseUrl", "url", "endpoint", "webhookUrl"];
    for (const key of urlFieldNames) {
      const value = (credentials as Record<string, unknown>)[key];
      if (typeof value !== "string" || value.length === 0) continue;
      // Shopify accepts a bare domain like "shop.myshopify.com" — wrap
      // such values in https:// before validating so the SSRF guard
      // can parse them as URLs.
      const candidate = /^https?:\/\//i.test(value) ? value : `https://${value}`;
      try {
        await assertSafeExternalUrl(candidate);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Invalid URL";
        throw new AppError(400, `Integration credentials field "${key}" rejected: ${message}`);
      }
    }

    // Encrypt credentials
    const encryptedCredentials = encryptForTenant(JSON.stringify(credentials), req.auth!.tenantId);

    // Upsert — one provider per company
    const integration = await prisma.integration.upsert({
      where: {
        companyId_provider: { companyId, provider },
      },
      create: {
        companyId,
        provider,
        credentials: encryptedCredentials,
        label: label || PROVIDER_INFO[provider].name,
        status: "PENDING",
      },
      update: {
        credentials: encryptedCredentials,
        label: label || undefined,
        status: "PENDING",
        lastTestedAt: null,
      },
    });

    // Log activity
    await prisma.activityLog.create({
      data: {
        tenantId: req.auth!.tenantId,
        actor: req.auth!.userId,
        action: "integration.save",
        resource: "integration",
        resourceId: integration.id,
        details: { provider, companyId },
      },
    });

    logger.info({ integrationId: integration.id, provider, companyId }, "Integration saved");

    res.json({
      id: integration.id,
      provider: integration.provider,
      status: integration.status,
      label: integration.label,
      createdAt: integration.createdAt,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /integrations/:companyId/test — test a connection
 */
integrationRouter.post("/:companyId/test", validate(testIntegrationSchema), async (req, res, next) => {
  try {
    const companyId = req.params.companyId as string;
    const ownerCheck = await prisma.company.findFirst({
      where: { id: companyId, tenantId: req.auth!.tenantId },
    });
    if (!ownerCheck) throw new AppError(404, "Company not found");

    const { provider } = req.body;

    const integration = await prisma.integration.findFirst({
      where: { companyId, provider },
    });

    if (!integration) {
      throw new AppError(404, `No ${provider} integration found for this company`);
    }

    // Decrypt and validate credentials exist
    let creds: Record<string, string>;
    try {
      creds = JSON.parse(decryptForTenant(integration.credentials, req.auth!.tenantId));
    } catch {
      await prisma.integration.update({
        where: { id: integration.id },
        data: { status: "ERROR", lastTestedAt: new Date() },
      });
      return res.json({ success: false, error: "Failed to decrypt credentials — please re-enter" });
    }

    // Basic validation: check all required fields have values
    const providerInfo = PROVIDER_INFO[provider];
    const missingFields = providerInfo?.fields
      .filter((f) => !creds[f.key] || creds[f.key].trim() === "")
      .map((f) => f.label) ?? [];

    if (missingFields.length > 0) {
      await prisma.integration.update({
        where: { id: integration.id },
        data: { status: "ERROR", lastTestedAt: new Date() },
      });
      return res.json({ success: false, error: `Missing fields: ${missingFields.join(", ")}` });
    }

    // Mark as active (real API validation would go here per provider)
    await prisma.integration.update({
      where: { id: integration.id },
      data: { status: "ACTIVE", lastTestedAt: new Date() },
    });

    logger.info({ integrationId: integration.id, provider }, "Integration test passed");

    res.json({ success: true, provider, status: "ACTIVE" });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /integrations/:companyId/:provider — remove an integration
 */
integrationRouter.delete("/:companyId/:provider", async (req, res, next) => {
  try {
    const { companyId, provider } = req.params;
    const ownerCheck = await prisma.company.findFirst({
      where: { id: companyId, tenantId: req.auth!.tenantId },
    });
    if (!ownerCheck) throw new AppError(404, "Company not found");

    await prisma.integration.deleteMany({
      where: { companyId, provider: provider as any },
    });

    logger.info({ companyId, provider }, "Integration deleted");
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /integrations/:companyId/missing — check what's missing for company's tools
 */
integrationRouter.get("/:companyId/missing", async (req, res, next) => {
  try {
    const companyId = req.params.companyId as string;
    const ownerCheck = await prisma.company.findFirst({
      where: { id: companyId, tenantId: req.auth!.tenantId },
    });
    if (!ownerCheck) throw new AppError(404, "Company not found");

    // Get all agents' tools for this company
    const agents = await prisma.agent.findMany({
      where: { companyId },
      select: { tools: true },
    });

    const allTools = agents.flatMap((a) => (a.tools as string[]) ?? []);
    const requiredProviders = getRequiredProviders(allTools);
    const missing = await getMissingIntegrations(companyId, requiredProviders);

    res.json({
      requiredProviders,
      missing,
      allConfigured: missing.length === 0,
    });
  } catch (err) {
    next(err);
  }
});

// Helper: show which fields are set without revealing values
function getFieldsSet(encryptedCredentials: string, tenantId: string): string[] {
  try {
    const creds = JSON.parse(decryptForTenant(encryptedCredentials, tenantId));
    return Object.keys(creds).filter((k) => creds[k] && creds[k].trim() !== "");
  } catch {
    return [];
  }
}
