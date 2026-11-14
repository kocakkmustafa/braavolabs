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
import { scrubSecrets, credentialSecrets } from "../../lib/mcp-auth";
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
/** which layer carries the secret: the agent-visible result and/or the audit row */
function leakedLayers(res: unknown): string[] {
  const has = (v: unknown) => JSON.stringify(v).includes(SECRET);
  return [has(res) && "result", has(toolCallCreate.mock.calls) && "audit(tool_calls)", has(Object.values(logs).map((m) => (m as any).mock.calls)) && "logs"].filter(Boolean) as string[];
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

describe("secret egress — success payload (SEC-BRA-06b)", () => {
  async function echoingCall(payload: unknown) {
    callTool.mockResolvedValue(payload);
    return executeTool("mcp_acme_lookup", {}, { ...ctx, extraTools: await connectorTool() });
  }

  it("a successful upstream result that echoes the credential is scrubbed before the agent and the audit row see it", async () => {
    const res = await echoingCall({ content: [{ type: "text", text: `debug: key=${SECRET}` }] });
    expect(res.status).toBe("COMPLETED");
    expect(leakedLayers(res)).toEqual([]);
    expect(JSON.stringify(res.output)).toContain("debug: key=[REDACTED]");
  });

  it("scrubs nested objects, arrays and repeated occurrences; leaves other text intact", async () => {
    const res = await echoingCall({ content: [{ type: "text", text: `${SECRET}/${SECRET} ok` }], meta: { echo: [{ h: `Bearer ${SECRET}` }] } });
    expect(leakedLayers(res)).toEqual([]);
    expect(JSON.stringify(res.output)).toContain("[REDACTED]/[REDACTED] ok");
  });

  it("a clean result passes through unchanged", async () => {
    const payload = { content: [{ type: "text", text: "all good" }] };
    const res = await echoingCall(payload);
    expect(res.output).toEqual(payload);
  });
});

describe("secret egress — SEC-BRA-06b hardening", () => {
  async function call(inst: any, payload?: unknown, err?: Error) {
    findFirst.mockResolvedValue(inst);
    findMany.mockResolvedValue([inst]);
    if (err) callTool.mockRejectedValue(err);
    else callTool.mockResolvedValue(payload);
    const tools = await listConnectorToolsForTenant("tenant-a");
    return executeTool("mcp_acme_lookup", {}, { ...ctx, extraTools: new Map(tools.map((t) => [t.name, t])) });
  }
  const asAudit = () => JSON.stringify(toolCallCreate.mock.calls);

  it("fail-closed beyond depth 50: the subtree is redacted, not passed through", async () => {
    let deep: any = { s: SECRET };
    for (let i = 0; i < 60; i++) deep = { n: deep };
    const res = await call(install, { content: [], meta: deep });
    expect(leakedLayers(res)).toEqual([]);
    expect(JSON.stringify(res.output)).toContain("[REDACTED]");
    expect(toolCallCreate).toHaveBeenCalled();
  });

  it("a secret used as an object key is scrubbed", async () => {
    const res = await call(install, { meta: { [SECRET]: "v" } });
    expect(leakedLayers(res)).toEqual([]);
    expect(toolCallCreate).toHaveBeenCalled();
  });

  it("an AppError message (JSON-RPC style) containing the secret is scrubbed in result, audit and logs", async () => {
    const res = await call(install, undefined, new AppError(502, "MCP error -32000: bad key " + SECRET));
    expect(res.output).toEqual({ error: "MCP error -32000: bad key [REDACTED]" });
    expect(leakedLayers(res)).toEqual([]);
    expect(toolCallCreate).toHaveBeenCalled();
  });

  it("BASIC: an echoed base64 Basic token and the raw password are scrubbed", async () => {
    decrypt.mockReturnValue(JSON.stringify({ username: "alice-user", password: "p4ss-W0rd-long" }));
    const token = Buffer.from("alice-user:p4ss-W0rd-long").toString("base64");
    const res = await call(
      { ...install, connector: { ...connector, authMethod: "BASIC" } },
      { content: [{ type: "text", text: "Authorization: Basic " + token + " pw=p4ss-W0rd-long" }] },
    );
    const wire = JSON.stringify(res) + asAudit();
    expect(wire).not.toContain(token);
    expect(wire).not.toContain("p4ss-W0rd-long");
    expect(toolCallCreate).toHaveBeenCalled();
  });

  it("CUSTOM: an echoed header value from the headers JSON is scrubbed", async () => {
    decrypt.mockReturnValue(JSON.stringify({ headers: JSON.stringify({ "X-Api-Token": "hdr-secret-value-9", "X-Other": "other-secret-77" }) }));
    const res = await call(
      { ...install, connector: { ...connector, authMethod: "CUSTOM" } },
      { content: [{ type: "text", text: "got hdr-secret-value-9 and other-secret-77" }] },
    );
    const wire = JSON.stringify(res) + asAudit();
    expect(wire).not.toContain("hdr-secret-value-9");
    expect(wire).not.toContain("other-secret-77");
    expect(toolCallCreate).toHaveBeenCalled();
  });

  it("credentialSecrets/scrubSecrets: short values kept; trimmed, base64 and URL-encoded forms masked; input not mutated", () => {
    const input = { t: "pin 123 abcdefgh YWJjZGVmZ2g= abc%20defg" };
    const secrets = credentialSecrets("API_KEY", { apiKey: "abcdefgh\n", short: "123", sp: "abc defg" });
    const out = scrubSecrets(input, secrets) as any;
    expect(out.t).toBe("pin 123 [REDACTED] [REDACTED] [REDACTED]");
    expect(input.t).toContain("abcdefgh");
    expect(scrubSecrets(null, secrets)).toBeNull();
    expect(scrubSecrets({ n: 5 }, secrets)).toEqual({ n: 5 });
  });
});
