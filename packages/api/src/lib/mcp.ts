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
import { assertSafeExternalUrl, SsrfError } from "./ssrf";

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

function authHeaders(method: string, creds: Record<string, string> | undefined): Record<string, string> {
  if (!creds) return {};
  switch (method) {
    case "NONE":
      return {};
    case "API_KEY":
      // Accept either standard header keys or a tenant-supplied
      // override (header name is encoded into the connector's
      // authSchema).
      if (creds.headerName && creds.apiKey) return { [creds.headerName]: creds.apiKey };
      if (creds.apiKey) return { Authorization: `Bearer ${creds.apiKey}` };
      return {};
    case "BASIC":
      if (creds.username && creds.password) {
        const token = Buffer.from(`${creds.username}:${creds.password}`).toString("base64");
        return { Authorization: `Basic ${token}` };
      }
      return {};
    case "OAUTH2":
      // OAuth2 access tokens are short-lived; we expect the install
      // flow to refresh them before storing. Long-term refresh is
      // a follow-up — out of scope for the MVP marketplace.
      if (creds.accessToken) return { Authorization: `Bearer ${creds.accessToken}` };
      return {};
    case "CUSTOM":
      // Custom auth: caller pre-formats headers into `headers` JSON.
      try {
        return creds.headers ? (JSON.parse(creds.headers) as Record<string, string>) : {};
      } catch {
        return {};
      }
    default:
      return {};
  }
}

async function callMcp<T>(
  baseUrl: string,
  body: JsonRpcRequest,
  authMethod: string,
  creds: Record<string, string> | undefined,
): Promise<T> {
  try {
    await assertSafeExternalUrl(baseUrl);
  } catch (err) {
    if (err instanceof SsrfError) {
      throw new AppError(400, `Connector URL rejected: ${err.message}`);
    }
    throw err;
  }
  const res = await fetch(baseUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...authHeaders(authMethod, creds),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    logger.warn({ status: res.status, body: text.slice(0, 300) }, "MCP HTTP error");
    throw new AppError(502, `MCP server returned ${res.status}`);
  }
  const json = (await res.json()) as JsonRpcResponse;
  if (json.error) {
    throw new AppError(502, `MCP error ${json.error.code}: ${json.error.message}`);
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
