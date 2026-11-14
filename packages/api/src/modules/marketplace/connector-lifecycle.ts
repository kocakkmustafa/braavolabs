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
import { logger } from "../../lib/logger";
import { safeExternalFetch } from "../../lib/ssrf";
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

/** Empty/omitted scopes or "*" = unrestricted (legacy); else exact tool-name match. */
export function isToolInScope(scopes: string[] | null | undefined, remoteToolName: string): boolean {
  const list = scopes ?? [];
  return list.length === 0 || list.includes("*") || list.includes(remoteToolName);
}

/** Strip secret material from an install row before it leaves the API. */
export function toInstalledView<T extends { encryptedCredentials?: unknown }>(
  install: T,
): Omit<T, "encryptedCredentials"> {
  const { encryptedCredentials: _omit, ...rest } = install;
  return rest;
}

/** Returns an error message when the call must be refused, else null. */
export function checkConnectorCallAllowed(
  install: GuardInstall,
  remoteToolName: string | null,
): string | null {
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
  // remoteToolName null = lifecycle call (refresh): revoked/audience only.
  if (remoteToolName === null) return null;
  if (!isToolInScope(install.scopes, remoteToolName)) {
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
  const denied = checkConnectorCallAllowed({ ...install, connector }, null);
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

const REVOKE_TIMEOUT_MS = 5_000;
const REVOKE_MAX_BYTES = 16 * 1024;

interface UpstreamRevoke {
  url: string;
  form: URLSearchParams;
}

function isHttpsUrl(url: unknown): url is string {
  if (typeof url !== "string" || !url) return false;
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Resolve (in memory) what to send to the provider's RFC 7009 endpoint.
 * Prefers the refresh token, else the access token. Returns null when there is
 * nothing to do (legacy install, no/HTTP URL) or the blob cannot be decrypted.
 */
function prepareUpstreamRevoke(slug: string, encryptedCredentials: string, aad: string): UpstreamRevoke | null {
  let creds: Record<string, string>;
  try {
    creds = JSON.parse(decrypt(encryptedCredentials, aad));
  } catch {
    logger.warn({ slug }, "revoke: credentials undecryptable; local revoke proceeds without upstream");
    return null;
  }
  const url = creds?.revocationUrl || creds?.revokeUrl;
  const token = creds?.refreshToken || creds?.accessToken;
  if (!token || !isHttpsUrl(url)) return null;
  const form = new URLSearchParams({
    token,
    token_type_hint: creds.refreshToken ? "refresh_token" : "access_token",
  });
  if (creds.clientId) form.set("client_id", creds.clientId);
  if (creds.clientSecret) form.set("client_secret", creds.clientSecret);
  return { url, form };
}

/** Best-effort provider call; never throws, never logs token material. */
async function sendUpstreamRevoke(slug: string, { url, form }: UpstreamRevoke): Promise<void> {
  try {
    const res = await safeExternalFetch(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: form.toString(),
        signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
      },
      { requireHttps: true, maxRedirects: 0, maxResponseBytes: REVOKE_MAX_BYTES },
    );
    if (!res.ok) logger.warn({ slug, status: res.status }, "upstream revoke rejected; local revoke already done");
  } catch {
    logger.warn({ slug }, "upstream revoke failed; local revoke already done");
  }
}

export async function revokeInstall(tenantId: string, actor: string, slug: string): Promise<{ revokedAt: Date }> {
  const connector = await prisma.connector.findUnique({ where: { slug } });
  if (!connector) throw new AppError(404, "Connector not found");
  const install = await prisma.tenantConnector.findUnique({
    where: { tenantId_connectorId: { tenantId, connectorId: connector.id } },
  });
  if (!install) throw new AppError(404, "Connector not installed");
  if (install.revokedAt) return { revokedAt: install.revokedAt }; // idempotent
  const aad = connectorAad(tenantId, connector.id);
  const revokedAt = new Date();
  let blob = install.encryptedCredentials;
  // At most two claim attempts (no loop): a concurrent refresh rotation changes
  // the blob, so the first CAS may lose; we then re-read once and retry.
  for (let attempt = 0; attempt < 2; attempt++) {
    // (a) resolve tokens from the blob we are about to claim, into memory.
    const upstream = prepareUpstreamRevoke(connector.slug, blob, aad);
    // (b) commit the local revoke: unusable from this point on. CAS on the blob
    // so a rotated RT2/AT2 written meanwhile is never left alive.
    const won = await tenantTx(async (tx) => {
      // Conditional claim: a losing call gets count 0 -> no audit, no upstream.
      // If the audit insert throws, the whole tx (claim included) rolls back.
      const claimed = await tx.tenantConnector.updateMany({
        where: { id: install.id, tenantId, revokedAt: null, encryptedCredentials: blob },
        data: { isEnabled: false, revokedAt, encryptedCredentials: encrypt("{}", aad) },
      });
      if (claimed.count === 0) return false;
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
      return true;
    });
    // (c) only the claim winner talks to the provider, once, with the token read
    // at claim time. Known limits: a crash/SIGTERM between claim and this call
    // leaves credentials wiped but the provider token un-revoked (no retry); an
    // RT2/AT2 minted by a refresh before our claim cannot be revoked (by design).
    if (won) {
      if (upstream) await sendUpstreamRevoke(connector.slug, upstream);
      return { revokedAt };
    }
    const current = await prisma.tenantConnector.findUnique({
      where: { tenantId_connectorId: { tenantId, connectorId: connector.id } },
      select: { revokedAt: true, encryptedCredentials: true },
    });
    if (!current) break;
    if (current.revokedAt) return { revokedAt: current.revokedAt };
    blob = current.encryptedCredentials;
  }
  const final = await prisma.tenantConnector.findUnique({
    where: { tenantId_connectorId: { tenantId, connectorId: connector.id } },
    select: { revokedAt: true },
  });
  if (final?.revokedAt) return { revokedAt: final.revokedAt };
  // Fail closed: never report success while the row is still live.
  throw new AppError(409, "Connector credentials changed concurrently; revoke not applied, retry");
}
