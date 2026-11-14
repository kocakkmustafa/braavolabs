/**
 * SEC-BRA-03 — connector install lifecycle: refresh + revoke, plus the
 * scope / audience / revoked guard used by executeMcpTool.
 *
 * Revoke destroys the stored credentials (re-encrypts an empty blob under the
 * same AAD), disables the install and stamps revokedAt; a revoked install can
 * never reach the upstream again. Credentials/tokens are never logged.
 */
import { prisma, tenantTx } from "../../lib/db";
import { encrypt, decrypt } from "../../lib/encryption";
import { AppError } from "../../middleware/error";
import { listTools } from "../../lib/mcp";
import { verifyManifest, isSignedManifest } from "./manifest-signature";

export function connectorAad(tenantId: string, connectorId: string): string {
  return `${tenantId}|tenant_connector|${connectorId}`;
}

/** Origin an install's credentials are bound to (audience). */
export function audienceOf(mcpServerUrl: string): string {
  return new URL(mcpServerUrl).origin;
}

interface GuardInstall {
  revokedAt?: Date | null;
  audience?: string | null;
  scopes?: string[] | null;
  connector: { slug: string; mcpServerUrl: string };
}

/** Returns an error message when the call must be refused, else null. */
export function checkConnectorCallAllowed(install: GuardInstall, remoteToolName: string): string | null {
  const slug = install.connector.slug;
  if (install.revokedAt) return `Connector "${slug}" has been revoked for this tenant.`;
  if (install.audience) {
    let origin: string;
    try {
      origin = audienceOf(install.connector.mcpServerUrl);
    } catch {
      return `Connector "${slug}" audience check failed.`;
    }
    if (origin !== install.audience) {
      return `Connector "${slug}" audience mismatch: credentials are not valid for this server.`;
    }
  }
  const scopes = install.scopes ?? [];
  if (scopes.length > 0 && !scopes.includes("*") && !scopes.includes(remoteToolName)) {
    return `Tool "${remoteToolName}" is outside the granted scope of connector "${slug}".`;
  }
  return null;
}

/**
 * Legacy installs have audience NULL (migration is ADD COLUMN only). Pin it on
 * the first valid use so the check becomes mandatory afterwards. Conditional
 * on audience IS NULL so a concurrent pin/re-install is never overwritten.
 */
export async function pinAudienceIfUnset(
  install: { id: string; audience?: string | null; connector: { mcpServerUrl: string } },
): Promise<void> {
  if (install.audience) return;
  await prisma.tenantConnector.updateMany({
    where: { id: install.id, audience: null },
    data: { audience: audienceOf(install.connector.mcpServerUrl) },
  });
}

export async function refreshInstall(tenantId: string, slug: string): Promise<{ toolCount: number }> {
  const connector = await prisma.connector.findUnique({ where: { slug } });
  if (!connector) throw new AppError(404, "Connector not found");
  const install = await prisma.tenantConnector.findUnique({
    where: { tenantId_connectorId: { tenantId, connectorId: connector.id } },
  });
  if (!install) throw new AppError(404, "Connector not installed");
  // Gate BEFORE any decrypt/probe so credentials never travel to a revoked,
  // disabled or re-pointed (audience-mismatched) server.
  if (install.revokedAt) throw new AppError(409, "Connector has been revoked");
  if (!install.isEnabled) throw new AppError(409, "Connector is disabled");
  const denied = checkConnectorCallAllowed({ ...install, connector }, "*");
  if (denied) throw new AppError(409, denied);
  await pinAudienceIfUnset({ ...install, connector });
  let creds: Record<string, string> | undefined;
  try {
    creds = JSON.parse(decrypt(install.encryptedCredentials, connectorAad(tenantId, connector.id)));
  } catch {
    throw new AppError(500, "Failed to decrypt connector credentials");
  }
  const tools = await listTools(connector.mcpServerUrl, connector.authMethod, creds);

  // Manifest HMAC verification (E5/T5): refuse a post-approval tool-set swap.
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
  return { toolCount: tools.length };
}

export async function revokeInstall(tenantId: string, actor: string, slug: string): Promise<{ revokedAt: Date }> {
  const connector = await prisma.connector.findUnique({ where: { slug } });
  if (!connector) throw new AppError(404, "Connector not found");
  const install = await prisma.tenantConnector.findUnique({
    where: { tenantId_connectorId: { tenantId, connectorId: connector.id } },
  });
  if (!install) throw new AppError(404, "Connector not installed");
  if (install.revokedAt) return { revokedAt: install.revokedAt }; // idempotent
  const revokedAt = new Date();
  await tenantTx(async (tx) => {
    await tx.tenantConnector.update({
      where: { id: install.id },
      data: {
        isEnabled: false,
        revokedAt,
        encryptedCredentials: encrypt("{}", connectorAad(tenantId, connector.id)),
      },
    });
    await tx.activityLog.create({
      data: {
        tenantId,
        actor,
        action: "marketplace.revoke",
        resource: "tenant_connector",
        resourceId: install.id,
        details: { slug: connector.slug },
      },
    });
  });
  return { revokedAt };
}
