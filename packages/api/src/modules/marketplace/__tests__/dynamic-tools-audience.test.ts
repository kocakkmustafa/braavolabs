/**
 * SEC-BRA-02 / B8 — executeMcpTool audience binding.
 * The upstream URL + credentials come from the tenant's installed connector
 * row only; agent/tool-output supplied args can never redirect them, and
 * credentials that do not decrypt under (tenant, connector) AAD are never used.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const findFirst = vi.fn();
const update = vi.fn();
const decrypt = vi.fn();
const callTool = vi.fn();
vi.mock("../../../lib/db", () => ({
  prisma: { tenantConnector: { findFirst: (...a: unknown[]) => findFirst(...a), update: (...a: unknown[]) => update(...a) } },
}));
vi.mock("../../../lib/encryption", () => ({ decrypt: (...a: unknown[]) => decrypt(...a) }));
vi.mock("../../../lib/mcp", () => ({ callTool: (...a: unknown[]) => callTool(...a) }));
vi.mock("../../../lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { executeMcpTool, parseConnectorToolName } from "../dynamic-tools";

const install = {
  id: "inst-1",
  spendUsd: 0,
  spendCapUsd: null,
  encryptedCredentials: "enc",
  connector: { id: "conn-1", slug: "acme", mcpServerUrl: "https://mcp.acme.example/rpc", authMethod: "API_KEY" },
};

beforeEach(() => {
  findFirst.mockReset();
  update.mockReset();
  decrypt.mockReset();
  callTool.mockReset();
});

describe("executeMcpTool — audience binding (B8)", () => {
  it("scopes the lookup to the acting tenant and uses only the registered URL", async () => {
    findFirst.mockResolvedValue(install);
    decrypt.mockReturnValue(JSON.stringify({ apiKey: "k" }));
    callTool.mockResolvedValue({ content: [] });
    await executeMcpTool("tenant-a", "acme", "lookup", {
      mcpServerUrl: "https://attacker.example", url: "http://169.254.169.254/", tenantId: "tenant-b",
    });
    expect(findFirst.mock.calls[0]![0].where).toMatchObject({ tenantId: "tenant-a", isEnabled: true });
    expect(decrypt).toHaveBeenCalledWith("enc", "tenant-a|tenant_connector|conn-1");
    expect(callTool.mock.calls[0]![0]).toBe("https://mcp.acme.example/rpc");
    // injected fields are plain arguments for the remote tool, nothing more
    expect(callTool.mock.calls[0]![4]).toMatchObject({ mcpServerUrl: "https://attacker.example" });
  });

  it("another tenant's connector slug resolves to nothing: no credential decrypted or sent", async () => {
    findFirst.mockResolvedValue(null);
    const out = await executeMcpTool("tenant-b", "acme", "lookup", {});
    expect(out).toMatchObject({ error: expect.stringMatching(/not installed/) });
    expect(decrypt).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
  });

  it("credentials failing AAD decryption are never sent upstream and nothing leaks", async () => {
    findFirst.mockResolvedValue(install);
    decrypt.mockImplementation(() => { throw new Error("auth tag mismatch for sk-LEAK"); });
    const out = (await executeMcpTool("tenant-a", "acme", "lookup", {})) as { error: string };
    expect(out.error).toBe("Failed to decrypt connector credentials");
    expect(callTool).not.toHaveBeenCalled();
  });

  it("an unexpected upstream failure is returned without the credential", async () => {
    findFirst.mockResolvedValue(install);
    decrypt.mockReturnValue(JSON.stringify({ apiKey: "sk-SECRET" }));
    callTool.mockRejectedValue(new Error("connect ECONNREFUSED with Bearer sk-SECRET"));
    const out = (await executeMcpTool("tenant-a", "acme", "lookup", {})) as { error: string };
    expect(out.error).toBe("Connector invocation failed");
  });

  it("tool-name injection cannot smuggle a different connector slug", () => {
    expect(parseConnectorToolName("mcp_acme_lookup")).toEqual({ slug: "acme", remoteName: "lookup" });
    expect(parseConnectorToolName("mcp_acme_evil_slug_x")).toEqual({ slug: "acme", remoteName: "evil_slug_x" });
    expect(parseConnectorToolName("acme_lookup")).toBeNull();
  });
});
