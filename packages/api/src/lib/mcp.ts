/**
 * Minimal MCP (Model Context Protocol) client.
 *
 * The spec defines a JSON-RPC 2.0 protocol with three core methods:
 *   - tools/list     → returns available tools
 *   - tools/call     → invokes a tool with arguments
 *   - resources/list → optional resource enumeration
 *
 * We implement the HTTP transport (most public MCP servers expose
 * this). stdio transport is out of scope — that's for local
 * Claude Code / Cursor integrations, not server-to-server.
 *
 * Authentication: the caller supplies a credentials object pulled
 * from the tenant's TenantConnector row (already decrypted). The
 * client maps it onto the right header per the connector's
 * `authMethod`.
 *
 * Every outbound call goes through `assertSafeExternalUrl` so a
 * malicious connector manifest can't aim us at internal hostnames.
 */

import { logger } from "./logger";
import { AppError } from "../middleware/error";
import { authHeaders, credentialSecrets, scrubSecrets } from "./mcp-auth";
import { safeExternalFetch, SsrfError } from "./ssrf";

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpInvokeResult {
  content?: Array<{ type: "text"; text: string } | { type: "image"; data: string }>;
  isError?: boolean;
  meta?: Record<string, unknown>;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string;
  method: string;
  params?: unknown;
}
interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const REQUEST_TIMEOUT_MS = 30_000;

async function callMcp<T>(
  baseUrl: string,
  body: JsonRpcRequest,
  authMethod: string,
  creds: Record<string, string> | undefined,
): Promise<T> {
  // SSRF: validate + pin the resolved address to the socket (no DNS-rebinding
  // gap) and re-validate every redirect hop. The connector credentials must
  // never follow a redirect to another origin or an internal address.
  let res: Response;
  try {
    res = await safeExternalFetch(baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...authHeaders(authMethod, creds),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof SsrfError) {
      throw new AppError(400, `Connector URL rejected: ${err.message}`);
    }
    throw err;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    logger.warn(
      { status: res.status, body: scrubSecrets(text.slice(0, 300), credentialSecrets(authMethod, creds)) },
      "MCP HTTP error",
    );
    throw new AppError(502, `MCP server returned ${res.status}`);
  }
  const json = (await res.json()) as JsonRpcResponse;
  if (json.error) {
    const msg = scrubSecrets(`MCP error ${json.error.code}: ${json.error.message}`, credentialSecrets(authMethod, creds));
    throw new AppError(502, msg as string);
  }
  return json.result as T;
}

export async function listTools(
  mcpServerUrl: string,
  authMethod: string,
  creds: Record<string, string> | undefined,
): Promise<McpTool[]> {
  const result = await callMcp<{ tools: McpTool[] }>(
    mcpServerUrl,
    {
      jsonrpc: "2.0",
      id: `list-${Date.now()}`,
      method: "tools/list",
    },
    authMethod,
    creds,
  );
  return Array.isArray(result?.tools) ? result.tools : [];
}

export async function callTool(
  mcpServerUrl: string,
  authMethod: string,
  creds: Record<string, string> | undefined,
  toolName: string,
  args: unknown,
): Promise<McpInvokeResult> {
  const result = await callMcp<McpInvokeResult>(
    mcpServerUrl,
    {
      jsonrpc: "2.0",
      id: `call-${Date.now()}`,
      method: "tools/call",
      params: { name: toolName, arguments: args ?? {} },
    },
    authMethod,
    creds,
  );
  return result ?? {};
}
