/**
 * Dynamic MCP tool registration.
 *
 * Connector tools aren't known at boot — they come from the tenant's
 * installed connectors. This helper resolves the live tool set for a
 * tenant + company combination and returns them in the same shape as
 * the static registry, so the agent loop can splice them in.
 *
 * Tool naming convention:
 *
 *   mcp_{connectorSlug}_{remoteToolName}
 *
 * Slugs are validated at publish-time (lowercase alphanumeric + dash)
 * so the resulting tool name is always a safe identifier.
 *
 * Invocation path:
 *
 *   agent → tool registry → executeMcpTool(tenantId, connectorSlug,
 *     remoteToolName, args) → mcp.callTool → return result
 *
 * Per-tenant spend cap is enforced before the upstream call so a
 * connector that loops its own paid tools can't blow the budget.
 */

import { prisma } from "../../lib/db";
import { decrypt } from "../../lib/encryption";
import { callTool, type McpTool } from "../../lib/mcp";
import { credentialSecrets, scrubSecrets } from "../../lib/mcp-auth";
import type { ToolDefinition } from "../agent/registry";
import { deriveConnectorToolMeta } from "./connector-tool-risk";
import { AppError } from "../../middleware/error";
import { checkConnectorCallAllowed, pinAudienceIfUnset } from "./connector-lifecycle";
import { logger } from "../../lib/logger";

const TOOL_PREFIX = "mcp_";

export function makeConnectorToolName(connectorSlug: string, remoteToolName: string): string {
  return `${TOOL_PREFIX}${connectorSlug}_${remoteToolName}`;
}

export function parseConnectorToolName(toolName: string): { slug: string; remoteName: string } | null {
  if (!toolName.startsWith(TOOL_PREFIX)) return null;
  const rest = toolName.slice(TOOL_PREFIX.length);
  const sepIdx = rest.indexOf("_");
  if (sepIdx <= 0) return null;
  // The slug regex prevents underscores; the first `_` is the slug
  // boundary. Subsequent underscores belong to the remote tool name.
  return { slug: rest.slice(0, sepIdx), remoteName: rest.slice(sepIdx + 1) };
}

function aadFor(tenantId: string, connectorId: string): string {
  return `${tenantId}|tenant_connector|${connectorId}`;
}

export async function listConnectorToolsForTenant(tenantId: string): Promise<ToolDefinition[]> {
  const installs = await prisma.tenantConnector.findMany({
    where: { tenantId, isEnabled: true },
    include: { connector: true },
  });
  const tools: ToolDefinition[] = [];
  for (const install of installs) {
    const manifest = (install.cachedToolsManifest ?? []) as unknown as McpTool[];
    for (const tool of manifest) {
      // D-005 (E5/T4): DERIVE the risk meta from the remote tool's name +
      // description instead of the old blanket `low / no-approval`. A remote
      // delete/send/charge tool must NOT slip past the approval gate once it
      // is spliced into the agent loop (T7). Fail-safe: ambiguous → medium +
      // approval; money verbs → moneyTouching (gated at every autonomy).
      tools.push({
        name: makeConnectorToolName(install.connector.slug, tool.name),
        description:
          `[${install.connector.name}] ${tool.description ?? ""}`.trim().slice(0, 1000),
        inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
        meta: deriveConnectorToolMeta(tool.name, tool.description, tool.inputSchema),
        handler: async (args) => executeMcpTool(tenantId, install.connector.slug, tool.name, args),
      });
    }
  }
  return tools;
}

/** Never hand a raw Error (message/stack may embed a bearer token) to the logger. */
function sanitizeErr(err: unknown): { message: string } {
  const raw = err instanceof Error ? err.message : String(err);
  return {
    message: raw
      .replace(/(bearer\s+)[^\s"']+/gi, "$1[REDACTED]")
      .replace(/\bsk-[A-Za-z0-9_-]+/g, "[REDACTED]")
      .slice(0, 200),
  };
}

export async function executeMcpTool(
  tenantId: string,
  connectorSlug: string,
  remoteToolName: string,
  args: unknown,
): Promise<unknown> {
  const install = await prisma.tenantConnector.findFirst({
    where: { tenantId, connector: { slug: connectorSlug }, isEnabled: true },
    include: { connector: true },
  });
  if (!install) {
    return { error: `Connector "${connectorSlug}" is not installed or is disabled for this tenant.` };
  }
  // SEC-BRA-03: revoked / audience-mismatch / out-of-scope → refuse before
  // any credential is decrypted or sent.
  const denied = checkConnectorCallAllowed(install, remoteToolName);
  if (denied) return { error: denied };
  await pinAudienceIfUnset(install);
  // Spend cap check.
  if (install.spendCapUsd && Number(install.spendUsd) >= Number(install.spendCapUsd)) {
    return {
      error: `Connector "${connectorSlug}" has hit its per-tenant spend cap ($${install.spendCapUsd}). Raise the cap on Settings → Marketplace.`,
    };
  }
  let creds: Record<string, string> = {};
  try {
    creds = JSON.parse(decrypt(install.encryptedCredentials, aadFor(tenantId, install.connector.id)));
  } catch {
    return { error: "Failed to decrypt connector credentials" };
  }
  const secrets = credentialSecrets(install.connector.authMethod, creds);
  try {
    const result = await callTool(
      install.connector.mcpServerUrl,
      install.connector.authMethod,
      creds,
      remoteToolName,
      args,
    );
    // Best-effort cost accounting — connectors can return a `cost`
    // hint in meta. The runtime accumulates so the spend cap stays
    // accurate over time.
    const cost =
      typeof result.meta?.costUsd === "number"
        ? Math.max(0, Math.min(100, result.meta.costUsd))
        : 0;
    if (cost > 0) {
      await prisma.tenantConnector.update({
        where: { id: install.id },
        data: { spendUsd: { increment: cost } },
      });
    }
    return scrubSecrets(result, secrets) as typeof result;
  } catch (err) {
    if (err instanceof AppError) {
      const safeMsg = scrubSecrets(err.message, secrets) as string;
      logger.info({ err: safeMsg, slug: connectorSlug }, "Connector tool failed");
      return { error: safeMsg };
    }
    logger.error({ err: sanitizeErr(err), slug: connectorSlug }, "Connector tool crashed");
    return { error: "Connector invocation failed" };
  }
}
