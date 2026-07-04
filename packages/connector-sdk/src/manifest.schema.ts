/**
 * Connector manifest schema (E5/T5).
 *
 * A connector manifest is the publisher-authored contract that describes a
 * marketplace connector: its identity, the MCP server that hosts its tools,
 * the credentials it needs, and the tool surface it exposes. The marketplace
 * publish path validates the manifest with `connectorManifestSchema.safeParse`
 * FAIL-CLOSED — an invalid manifest is rejected with 400, never persisted.
 *
 * This is the same shape a `POST /marketplace/publish` body carries, plus the
 * optional `tools` list a publisher declares up front (the runtime still
 * re-probes the live MCP server, but the declared list lets us HMAC-sign a
 * stable manifest and detect a post-publish tool-set swap).
 */

import { z } from "zod";

/** A single credential field the install dialog will render. */
export const connectorAuthFieldSchema = z.object({
  name: z.string().min(1).max(60),
  type: z.enum(["string", "password", "url", "number"]).default("string"),
  required: z.boolean().default(true),
  label: z.string().max(120).optional(),
  hint: z.string().max(400).optional(),
});
export type ConnectorAuthField = z.infer<typeof connectorAuthFieldSchema>;

/** Publisher-declared coarse risk hint for a tool. Never LOWERS the runtime's
 * derived risk — only raises it (see connector-tool-risk.deriveConnectorToolMeta). */
export const publisherRiskHintSchema = z.enum(["low", "medium", "high", "money"]);
export type ManifestRiskHint = z.infer<typeof publisherRiskHintSchema>;

/** A tool the connector exposes. Mirrors the MCP `tools/list` shape plus an
 * optional publisher risk hint. */
export const connectorManifestToolSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(80)
    // Remote tool names become `mcp_{slug}_{name}` — keep them identifier-safe.
    .regex(/^[A-Za-z0-9_.-]+$/, "tool name must be alphanumeric with _ . - only"),
  description: z.string().max(1000).default(""),
  inputSchema: z.record(z.unknown()).default({ type: "object", properties: {} }),
  riskHint: publisherRiskHintSchema.optional(),
});
export type ConnectorManifestTool = z.infer<typeof connectorManifestToolSchema>;

/** The full connector manifest. `slug`/`version` mirror the publish body's
 * regexes so a manifest and a publish request validate identically. */
export const connectorManifestSchema = z.object({
  // Manifest format version — lets us evolve the schema without breaking
  // already-signed connectors.
  manifestVersion: z.literal(1).default(1),
  slug: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{1,60}[a-z0-9]$/, "slug must be lowercase alphanumeric with dashes"),
  name: z.string().min(1).max(120),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, "version must be semver x.y.z").default("1.0.0"),
  vendor: z.string().min(1).max(120),
  description: z.string().min(1).max(2000),
  iconUrl: z.string().url().max(500).optional(),
  documentationUrl: z.string().url().max(500).optional(),
  mcpServerUrl: z.string().url().max(500),
  authMethod: z.enum(["NONE", "API_KEY", "OAUTH2", "BASIC", "CUSTOM"]).default("NONE"),
  authFields: z.array(connectorAuthFieldSchema).max(20).default([]),
  visibility: z.enum(["PUBLIC", "UNLISTED", "PRIVATE"]).default("PRIVATE"),
  // Declared tool surface. The runtime re-probes the live server, but the
  // declared list is what gets HMAC-signed so a post-publish swap is caught.
  tools: z.array(connectorManifestToolSchema).max(200).default([]),
});
export type ConnectorManifest = z.infer<typeof connectorManifestSchema>;

/** Input shape (pre-defaults) — what a publisher actually writes. */
export type ConnectorManifestInput = z.input<typeof connectorManifestSchema>;

/**
 * Validate a manifest FAIL-CLOSED. Returns the parsed manifest on success or a
 * flat list of `field: message` errors on failure. Callers (the publish route)
 * MUST reject on `ok:false` — never persist an unvalidated manifest.
 */
export function validateManifest(
  input: unknown,
):
  | { ok: true; manifest: ConnectorManifest }
  | { ok: false; errors: string[] } {
  const parsed = connectorManifestSchema.safeParse(input);
  if (parsed.success) return { ok: true, manifest: parsed.data };
  const errors = parsed.error.issues.map(
    (i) => `${i.path.join(".") || "(root)"}: ${i.message}`,
  );
  return { ok: false, errors };
}
