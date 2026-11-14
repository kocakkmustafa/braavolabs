/**
 * SEC-BRA-03 — connector refresh + revoke, scope/audience enforcement.
 * Integration across lifecycle service + executeMcpTool with a stateful
 * in-memory tenantConnector (no real DB).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { row, connectorRow, activityCreate, callTool, listTools, logSink } = vi.hoisted(() => ({
  row: {} as Record<string, any>,
  connectorRow: {
    id: "conn-1", slug: "acme", mcpServerUrl: "https://mcp.acme.example/rpc", authMethod: "API_KEY",
    version: "1.0.0", manifestSignature: null as string | null, publisherTenantId: "pub",
  },
  activityCreate: vi.fn(),
  callTool: vi.fn(),
  listTools: vi.fn(),
  logSink: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const dbMock = {
    connector: { findUnique: async () => connectorRow },
    tenantConnector: {
      findUnique: async () => ({ ...row, connector: connectorRow }),
      findFirst: async (a: any) =>
        a.where.isEnabled && !row.isEnabled ? null : { ...row, connector: connectorRow },
      update: async ({ data }: any) => { Object.assign(row, data); return row; },
      updateMany: async ({ where, data }: any) => {
        if (where.audience === null && row.audience !== null) return { count: 0 };
        Object.assign(row, data); return { count: 1 };
      },
    },
    activityLog: { create: (...a: unknown[]) => activityCreate(...a) },
};
vi.mock("../../../lib/db", () => ({
  get prisma() { return dbMock; },
  tenantTx: async (fn: (tx: unknown) => Promise<unknown>) => fn(dbMock),
}));
vi.mock("../../../lib/encryption", () => ({
  encrypt: (plain: string, aad: string) => `enc:${aad}:${plain}`,
  decrypt: (blob: string, aad: string) => {
    const prefix = `enc:${aad}:`;
    if (!blob.startsWith(prefix)) throw new Error("auth tag mismatch");
    return blob.slice(prefix.length);
  },
}));
vi.mock("../../../lib/mcp", () => ({
  callTool: (...a: unknown[]) => callTool(...a),
  listTools: (...a: unknown[]) => listTools(...a),
}));
vi.mock("../../../lib/logger", () => ({ logger: logSink }));

import { executeMcpTool } from "../dynamic-tools";
import { refreshInstall, revokeInstall, audienceOf } from "../connector-lifecycle";

const AAD = "t1|tenant_connector|conn-1";

beforeEach(() => {
  Object.keys(row).forEach((k) => delete row[k]);
  Object.assign(row, {
    id: "inst-1", tenantId: "t1", connectorId: "conn-1", isEnabled: true, revokedAt: null,
    spendUsd: 0, spendCapUsd: null, scopes: [], audience: "https://mcp.acme.example",
    cachedToolsManifest: [], encryptedCredentials: `enc:${AAD}:${JSON.stringify({ apiKey: "sk-SECRET" })}`,
  });
  connectorRow.mcpServerUrl = "https://mcp.acme.example/rpc";
  callTool.mockReset().mockResolvedValue({ content: [] });
  listTools.mockReset().mockResolvedValue([{ name: "lookup" }, { name: "send" }]);
  activityCreate.mockReset();
  Object.values(logSink).forEach((f) => f.mockReset());
});

describe("refresh", () => {
  it("re-probes with decrypted creds and caches the manifest", async () => {
    const out = await refreshInstall("t1", "acme");
    expect(out.toolCount).toBe(2);
    expect(listTools.mock.calls[0]![2]).toEqual({ apiKey: "sk-SECRET" });
    expect(row.cachedToolsManifest).toHaveLength(2);
    expect(row.cachedAt).toBeInstanceOf(Date);
  });

  it("refuses a revoked install without probing upstream", async () => {
    await revokeInstall("t1", "u1", "acme");
    await expect(refreshInstall("t1", "acme")).rejects.toMatchObject({ statusCode: 409 });
    expect(listTools).not.toHaveBeenCalled();
  });
});

describe("revoke", () => {
  it("disables, stamps revokedAt, destroys credentials and audits", async () => {
    const before = row.encryptedCredentials as string;
    await revokeInstall("t1", "u1", "acme");
    expect(row.isEnabled).toBe(false);
    expect(row.revokedAt).toBeInstanceOf(Date);
    expect(row.encryptedCredentials).not.toBe(before);
    expect(row.encryptedCredentials).not.toContain("sk-SECRET");
    expect(activityCreate.mock.calls[0]![0].data).toMatchObject({ action: "marketplace.revoke", tenantId: "t1" });
  });

  it("tool call after revoke is rejected and never reaches the upstream", async () => {
    expect(await executeMcpTool("t1", "acme", "lookup", {})).not.toHaveProperty("error");
    callTool.mockClear();
    await revokeInstall("t1", "u1", "acme");
    const out = (await executeMcpTool("t1", "acme", "lookup", {})) as { error: string };
    expect(out.error).toMatch(/not installed or is disabled/);
    expect(callTool).not.toHaveBeenCalled();
  });

  it("a revoked-but-still-enabled row (defence in depth) is refused by revokedAt", async () => {
    row.revokedAt = new Date();
    const out = (await executeMcpTool("t1", "acme", "lookup", {})) as { error: string };
    expect(out.error).toMatch(/revoked/);
    expect(callTool).not.toHaveBeenCalled();
  });
});

describe("scope / audience", () => {
  it("tool outside granted scopes is refused; in-scope and '*' pass; empty = legacy unrestricted", async () => {
    row.scopes = ["lookup"];
    expect(((await executeMcpTool("t1", "acme", "send", {})) as any).error).toMatch(/outside the granted scope/);
    expect(callTool).not.toHaveBeenCalled();
    expect(await executeMcpTool("t1", "acme", "lookup", {})).not.toHaveProperty("error");
    row.scopes = ["*"];
    expect(await executeMcpTool("t1", "acme", "send", {})).not.toHaveProperty("error");
    row.scopes = [];
    expect(await executeMcpTool("t1", "acme", "send", {})).not.toHaveProperty("error");
  });

  it("audience mismatch (server URL moved to another origin) is refused before decrypt/send", async () => {
    connectorRow.mcpServerUrl = "https://evil.example/rpc";
    const out = (await executeMcpTool("t1", "acme", "lookup", {})) as { error: string };
    expect(out.error).toMatch(/audience mismatch/);
    expect(callTool).not.toHaveBeenCalled();
  });

  it("audienceOf returns the origin", () => {
    expect(audienceOf("https://mcp.acme.example/rpc?x=1")).toBe("https://mcp.acme.example");
  });

  it("the credential is never written to logs", async () => {
    callTool.mockRejectedValue(new Error("boom Bearer sk-SECRET"));
    await executeMcpTool("t1", "acme", "lookup", {});
    await revokeInstall("t1", "u1", "acme");
    const calls = Object.values(logSink).flatMap((f) => f.mock.calls);
    expect(calls.length).toBeGreaterThan(0);
    const flat = JSON.stringify(calls, (_k, v) => (v instanceof Error ? { m: v.message, st: v.stack } : v));
    expect(flat).not.toContain("sk-SECRET");
    expect(flat).toContain("REDACTED");
  });

  it("NULL audience is pinned on first valid call, then a different origin is refused", async () => {
    row.audience = null;
    await executeMcpTool("t1", "acme", "lookup", {});
    expect(row.audience).toBe("https://mcp.acme.example");
    callTool.mockClear();
    connectorRow.mcpServerUrl = "https://evil.example/rpc";
    const out = (await executeMcpTool("t1", "acme", "lookup", {})) as { error: string };
    expect(out.error).toMatch(/audience mismatch/);
    expect(callTool).not.toHaveBeenCalled();
  });
});

describe("refresh gate (no decrypt/probe on refusal)", () => {
  it("audience mismatch refused", async () => {
    connectorRow.mcpServerUrl = "https://evil.example/rpc";
    await expect(refreshInstall("t1", "acme")).rejects.toMatchObject({ statusCode: 409 });
    expect(listTools).not.toHaveBeenCalled();
  });
  it("disabled refused", async () => {
    row.isEnabled = false;
    await expect(refreshInstall("t1", "acme")).rejects.toMatchObject({ statusCode: 409 });
    expect(listTools).not.toHaveBeenCalled();
  });
  it("NULL audience pinned on refresh", async () => {
    row.audience = null;
    await refreshInstall("t1", "acme");
    expect(row.audience).toBe("https://mcp.acme.example");
  });
});

describe("revoke idempotency", () => {
  it("second revoke keeps the first revokedAt and writes one audit row", async () => {
    const first = await revokeInstall("t1", "u1", "acme");
    const second = await revokeInstall("t1", "u1", "acme");
    expect(second.revokedAt).toBe(first.revokedAt);
    expect(activityCreate).toHaveBeenCalledTimes(1);
  });
});
