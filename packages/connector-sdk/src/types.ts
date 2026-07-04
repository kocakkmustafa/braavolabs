/**
 * Shared minimal tool shape (E5/T5).
 *
 * The marketplace signs and verifies manifests over tool lists that come from
 * two places: the publisher-declared `manifest.tools` and the live MCP
 * `tools/list` probe. Both reduce to this minimal shape for canonicalization,
 * so `canonicalManifestPayload` accepts either without importing the API's MCP
 * client type.
 */
export interface McpToolLike {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}
