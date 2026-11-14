/** BRA-P1-02a — OAuth2 refresh: single in-flight refresh, fail-closed, backward compatible. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const findFirst = vi.fn();
const update = vi.fn();
const decrypt = vi.fn();
const encrypt = vi.fn();
const callTool = vi.fn();
const safeFetch = vi.fn();
const logs: unknown[] = [];
vi.mock("../../../lib/db", () => ({
  prisma: { tenantConnector: { findFirst: (...a: unknown[]) => findFirst(...a), update: (...a: unknown[]) => update(...a), updateMany: async () => ({ count: 1 }) } },
}));
vi.mock("../../../lib/encryption", () => ({
  decrypt: (...a: unknown[]) => decrypt(...a),
  encrypt: (...a: unknown[]) => encrypt(...a),
}));
vi.mock("../../../lib/mcp", () => ({ callTool: (...a: unknown[]) => callTool(...a) }));
vi.mock("../../../lib/ssrf", () => ({ safeExternalFetch: (...a: unknown[]) => safeFetch(...a) }));
vi.mock("../../../lib/logger", () => ({
  logger: { info: (...a: unknown[]) => logs.push(a), warn: (...a: unknown[]) => logs.push(a), error: (...a: unknown[]) => logs.push(a) },
}));

import { executeMcpTool } from "../dynamic-tools";

const mkInstall = (url = "https://mcp.acme.example/rpc") => ({
  id: "inst-1",
  spendUsd: 0,
  spendCapUsd: null,
  encryptedCredentials: "enc",
  connector: { id: "conn-1", slug: "acme", mcpServerUrl: url, authMethod: "OAUTH2" },
});
const expired = {
  accessToken: "OLD-ACCESS-TOKEN-xyz",
  refreshToken: "REFRESH-TOKEN-abc123",
  expiresAt: String(Date.now() - 10_000),
  tokenUrl: "https://auth.acme.example/token",
  clientId: "cid",
};
const tokenOk = () =>
  new Response(JSON.stringify({ access_token: "NEW-ACCESS-TOKEN-999", expires_in: 3600 }), { status: 200 });

beforeEach(() => {
  for (const m of [findFirst, update, decrypt, encrypt, callTool, safeFetch]) m.mockReset();
  logs.length = 0;
  findFirst.mockResolvedValue(mkInstall());
  encrypt.mockReturnValue("re-encrypted");
  callTool.mockResolvedValue({ content: [] });
});

describe("OAuth2 refresh", () => {
  it("refreshes an expired token once, re-encrypts, persists and uses the new token", async () => {
    decrypt.mockReturnValue(JSON.stringify(expired));
    safeFetch.mockImplementation(async () => tokenOk());
    await executeMcpTool("t", "acme", "x", {});
    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(safeFetch.mock.calls[0]![2]).toMatchObject({ requireHttps: true });
    expect(update).toHaveBeenCalledTimes(1);
    expect(encrypt.mock.calls[0]![1]).toBe("t|tenant_connector|conn-1");
    const saved = JSON.parse(encrypt.mock.calls[0]![0] as string);
    expect(saved).toMatchObject({ accessToken: "NEW-ACCESS-TOKEN-999", refreshToken: "REFRESH-TOKEN-abc123" });
    expect(Number(saved.expiresAt)).toBeGreaterThan(Date.now());
    expect(callTool.mock.calls[0]![2]).toMatchObject({ accessToken: "NEW-ACCESS-TOKEN-999" });
  });

  it("concurrent calls for the same connector share a single refresh", async () => {
    decrypt.mockReturnValue(JSON.stringify(expired));
    safeFetch.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return tokenOk();
    });
    await Promise.all([1, 2, 3].map(() => executeMcpTool("t", "acme", "x", {})));
    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(callTool).toHaveBeenCalledTimes(3);
    for (const c of callTool.mock.calls) expect(c[2]).toMatchObject({ accessToken: "NEW-ACCESS-TOKEN-999" });
  });

  it("does not refresh while the token is still valid", async () => {
    decrypt.mockReturnValue(JSON.stringify({ ...expired, expiresAt: String(Date.now() + 3_600_000) }));
    await executeMcpTool("t", "acme", "x", {});
    expect(safeFetch).not.toHaveBeenCalled();
    expect(callTool.mock.calls[0]![2]).toMatchObject({ accessToken: "OLD-ACCESS-TOKEN-xyz" });
  });

  it.each([
    ["HTTP error", async () => new Response("secret REFRESH-TOKEN-abc123", { status: 400 })],
    ["network error", async () => { throw new Error("boom REFRESH-TOKEN-abc123"); }],
    ["bad body", async () => new Response("{}", { status: 200 })],
  ])("refresh failure (%s) rejects the call; no token reaches upstream or logs", async (_n, impl) => {
    decrypt.mockReturnValue(JSON.stringify(expired));
    safeFetch.mockImplementation(impl);
    const out = (await executeMcpTool("t", "acme", "x", {})) as { error: string };
    expect(out.error).toMatch(/yenilenemedi/);
    expect(callTool).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    const blob = JSON.stringify([out, logs]);
    for (const t of ["OLD-ACCESS-TOKEN", "REFRESH-TOKEN-abc123"]) expect(blob).not.toContain(t);
  });

  it("failed persistence rejects the call", async () => {
    decrypt.mockReturnValue(JSON.stringify(expired));
    safeFetch.mockImplementation(async () => tokenOk());
    update.mockRejectedValue(new Error("db down"));
    const out = (await executeMcpTool("t", "acme", "x", {})) as { error: string };
    expect(out.error).toMatch(/yenilenemedi/);
    expect(callTool).not.toHaveBeenCalled();
  });

  it("refuses http:// token endpoint and http:// mcpServerUrl without any fetch", async () => {
    decrypt.mockReturnValue(JSON.stringify({ ...expired, tokenUrl: "http://auth.acme.example/token" }));
    expect(await executeMcpTool("t", "acme", "x", {})).toMatchObject({ error: expect.stringMatching(/HTTPS/) });
    findFirst.mockResolvedValue(mkInstall("http://mcp.acme.example/rpc"));
    decrypt.mockReturnValue(JSON.stringify(expired));
    expect(await executeMcpTool("t", "acme", "x", {})).toMatchObject({ error: expect.stringMatching(/HTTPS/) });
    expect(safeFetch).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
  });

  it("backward compat: OAUTH2 creds without refreshToken are used as-is, even if expired", async () => {
    decrypt.mockReturnValue(JSON.stringify({ accessToken: "LEGACY", expiresAt: "1" }));
    await executeMcpTool("t", "acme", "x", {});
    expect(safeFetch).not.toHaveBeenCalled();
    expect(callTool.mock.calls[0]![2]).toMatchObject({ accessToken: "LEGACY" });
    decrypt.mockReturnValue(JSON.stringify({ accessToken: "LEGACY2" }));
    await executeMcpTool("t", "acme", "x", {});
    expect(callTool.mock.calls[1]![2]).toMatchObject({ accessToken: "LEGACY2" });
  });
});
