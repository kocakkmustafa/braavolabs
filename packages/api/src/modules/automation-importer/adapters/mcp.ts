/**
 * MCP server description → Braavolabs pipeline (read-only mirror).
 *
 * MCP server.json describes the server's tools and resources. We mirror
 * that as a pipeline of "mcp.invoke" steps — the executor at runtime
 * holds the live MCP connection and forwards the call. No conversion
 * loss for tool definitions; what we drop is the resource list (we
 * don't yet have a primitive that maps to "read-only resource").
 */

import type { ConvertedPipeline } from "./types";

interface McpServerJson {
  name?: string;
  description?: string;
  tools?: Array<{ name: string; description?: string; inputSchema?: unknown }>;
  resources?: Array<{ uri: string; name?: string }>;
}

export function fromMcp(payload: string): ConvertedPipeline {
  let server: McpServerJson;
  try {
    server = JSON.parse(payload) as McpServerJson;
  } catch (err) {
    throw new Error(`Invalid MCP server.json: ${err instanceof Error ? err.message : String(err)}`);
  }

  const steps: ConvertedPipeline["pipeline"]["steps"] = (server.tools ?? []).map((tool, idx) => ({
    id: `mcp-${idx + 1}`,
    type: "mcp.invoke",
    config: { tool: tool.name, description: tool.description, inputSchema: tool.inputSchema ?? {} },
  }));

  const dropped: ConvertedPipeline["dropped"] = (server.resources ?? []).map((res, idx) => ({
    id: `resource-${idx + 1}`,
    type: "mcp.resource",
    reason: `MCP read-only resource (${res.uri}) — no native primitive yet; subscribe via custom integration.`,
  }));

  return {
    pipeline: {
      name: server.name ?? "Imported MCP server",
      description: server.description ?? `Imported from MCP server.json (${steps.length} tool(s))`,
      steps,
    },
    dropped,
    warnings: dropped.length > 0 ? [`${dropped.length} read-only MCP resource(s) skipped.`] : [],
  };
}
