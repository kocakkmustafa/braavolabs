/**
 * BRA-P0-07 — secret egress (negative, fail-closed).
 * A connector credential must not reach the agent (tool result), the tool-call
 * audit row, the logger or the tool listing, on failure paths. Real
 * executeTool + listConnectorToolsForTenant + executeMcpTool; DB, crypto and
 * the MCP socket are synthetic. NOT covered: Sentry (see sentry-redaction.test).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const SECRET = "sk-LIVE-connector-secret-123";
const logs = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
const toolCallCreate = vi.hoisted(() => vi.fn());
const findFirst = vi.hoisted(() => vi.fn());
const findMany = vi.hoisted(() => vi.fn());
const callTool = vi.hoisted(() => vi.fn());
const decrypt = vi.hoisted(() => vi.fn());

vi.mock("../../lib/logger", () => ({ logger: logs }));
vi.mock("../../lib/db", () => ({
  prisma: {
    tenantConnector: { findFirst, findMany, update: vi.fn(), updateMany: async () => ({ count: 1 }) },
    toolCall: { create: toolCallCreate },
  },
}));
vi.mock("../../lib/encryption", () => ({ decrypt }));
vi.mock("../../lib/mcp", () => ({ callTool }));
vi.mock("../../services/push", () => ({ notifyTenantUsers: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../lib/runEvents", () => ({ publishRunEvent: vi.fn().mockResolvedValue(undefined) }));

import { executeTool } from "../../modules/agent/tool-executor";
import { listConnectorToolsForTenant } from "../../modules/marketplace/dynamic-tools";
import { AppError } from "../../middleware/error";

const connector = { id: "conn-1", slug: "acme", name: "Acme", mcpServerUrl: "https://mcp.acme.example/rpc", authMethod: "API_KEY" };
const install = {
  id: "inst-1", spendUsd: 0, spendCapUsd: null, encryptedCredentials: "CIPHERTEXT-BLOB", revokedAt: null,
  audience: "https://mcp.acme.example", scopes: [], connector,
  cachedToolsManifest: [{ name: "lookup", description: "Look up a record", inputSchema: { type: "object", properties: {} } }],
};
const ctx = { runId: "run-1", runStepId: "step-1", companyId: "co-a", tenantId: "tenant-a", autonomy: "AUTONOMOUS" as const };

async function connectorTool() {
  findMany.mockResolvedValue([install]);
  const tools = await listConnectorToolsForTenant("tenant-a");
  return new Map(tools.map((t) => [t.name, t]));
}

/** Everything that left the process boundary for the agent / audit / logs. */
function egress(res: unknown): string {
  return JSON.stringify([res, toolCallCreate.mock.calls, Object.values(logs).map((m) => (m as any).mock.calls)]);
}

beforeEach(() => {
  for (const m of [...Object.values(logs), toolCallCreate, findFirst, findMany, callTool, decrypt]) (m as any).mockReset();
  toolCallCreate.mockResolvedValue({});
  findFirst.mockResolvedValue(install);
  decrypt.mockReturnValue(JSON.stringify({ apiKey: SECRET }));
});

describe("secret egress — failure paths", () => {
  it("an upstream crash echoing 'Bearer <secret>' leaks into neither the tool result, the audit row nor the logs", async () => {
    callTool.mockRejectedValue(new Error(`connect ECONNREFUSED; Authorization: Bearer ${SECRET} ${SECRET}`));
    const extraTools = await connectorTool();
    const res = await executeTool("mcp_acme_lookup", { q: "x" }, { ...ctx, extraTools });
    expect(res.status).toBe("COMPLETED");
    expect(res.output).toEqual({ error: "Connector invocation failed" });
    expect(egress(res)).not.toContain(SECRET);
    expect(logs.error).toHaveBeenCalled(); // the crash WAS logged, just sanitised
  });

  it("a decrypt failure whose message embeds the key is replaced by a fixed message everywhere", async () => {
    decrypt.mockImplementation(() => { throw new Error(`bad tag for ${SECRET}`); });
    const res = await executeTool("mcp_acme_lookup", {}, { ...ctx, extraTools: await connectorTool() });
    expect(res.output).toEqual({ error: "Failed to decrypt connector credentials" });
    expect(callTool).not.toHaveBeenCalled();
    expect(egress(res)).not.toContain(SECRET);
  });

  it("an AppError from the MCP client is relayed as its own (credential-free) message only", async () => {
    callTool.mockRejectedValue(new AppError(502, "MCP server returned 401"));
    const res = await executeTool("mcp_acme_lookup", {}, { ...ctx, extraTools: await connectorTool() });
    expect(res.output).toEqual({ error: "MCP server returned 401" });
    expect(egress(res)).not.toContain(SECRET);
  });

  it("the tool listing handed to the agent never carries the ciphertext or the plaintext credential", async () => {
    const tools = [...(await connectorTool()).values()];
    expect(tools.length).toBeGreaterThan(0);
    const wire = JSON.stringify(tools);
    expect(wire).not.toContain("CIPHERTEXT-BLOB");
    expect(wire).not.toContain(SECRET);
    expect(decrypt).not.toHaveBeenCalled(); // listing never touches credentials
  });

  it("a revoked install refuses before the credential is even decrypted", async () => {
    findFirst.mockResolvedValue({ ...install, revokedAt: new Date() });
    const res = await executeTool("mcp_acme_lookup", {}, { ...ctx, extraTools: await connectorTool() });
    expect(res.output).toMatchObject({ error: expect.stringMatching(/revoked/) });
    expect(decrypt).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
  });
});

describe("secret egress — KNOWN GAP (tripwire, see PR)", () => {
  // executeMcpTool returns the upstream result verbatim and executeTool persists
  // it in tool_calls.output. A connector that echoes the credential in a SUCCESS
  // payload therefore reaches the agent context (exfiltration primitive under
  // prompt injection). Production code is out of scope for BRA-P0-07; `it.fails`
  // flips red the day a redaction is added, forcing this test to be promoted.
  it.fails("a successful upstream result that echoes the credential is scrubbed before the agent sees it", async () => {
    callTool.mockResolvedValue({ content: [{ type: "text", text: `debug: key=${SECRET}` }] });
    const res = await executeTool("mcp_acme_lookup", {}, { ...ctx, extraTools: await connectorTool() });
    expect(egress(res)).not.toContain(SECRET);
  });
});
