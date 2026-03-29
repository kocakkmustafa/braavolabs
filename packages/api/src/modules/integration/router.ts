import { Router } from "express";
import { prisma } from "../../lib/db";
import { encrypt, decrypt } from "../../lib/encryption";
import { logger } from "../../lib/logger";
import { AppError } from "../../middleware/error";
import { PROVIDER_INFO, getRequiredProviders, getMissingIntegrations, TOOL_PROVIDER_MAP } from "./checker";

export const integrationRouter = Router();

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
    const { companyId } = req.params;
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
      fieldsSet: getFieldsSet(i.credentials),
    }));

    res.json(safe);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /integrations/:companyId — create or update an integration
 */
integrationRouter.post("/:companyId", async (req, res, next) => {
  try {
    const { companyId } = req.params;
    const { provider, credentials, label } = req.body;

    if (!provider || !credentials) {
      throw new AppError(400, "provider and credentials are required");
    }

    if (!PROVIDER_INFO[provider]) {
      throw new AppError(400, `Unknown provider: ${provider}`);
    }

    // Encrypt credentials
    const encryptedCredentials = encrypt(JSON.stringify(credentials));

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
        tenantId: (await prisma.company.findUnique({ where: { id: companyId } }))?.tenantId ?? "",
        actor: "user",
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
integrationRouter.post("/:companyId/test", async (req, res, next) => {
  try {
    const { companyId } = req.params;
    const { provider } = req.body;

    if (!provider) throw new AppError(400, "provider is required");

    const integration = await prisma.integration.findFirst({
      where: { companyId, provider },
    });

    if (!integration) {
      throw new AppError(404, `No ${provider} integration found for this company`);
    }

    // Decrypt and validate credentials exist
    let creds: Record<string, string>;
    try {
      creds = JSON.parse(decrypt(integration.credentials));
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
    const { companyId } = req.params;

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
function getFieldsSet(encryptedCredentials: string): string[] {
  try {
    const creds = JSON.parse(decrypt(encryptedCredentials));
    return Object.keys(creds).filter((k) => creds[k] && creds[k].trim() !== "");
  } catch {
    return [];
  }
}
