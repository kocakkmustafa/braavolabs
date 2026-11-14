/** BRA-P1-02a — OAuth2 refresh: single in-flight refresh, fail-closed, backward compatible. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const findFirst = vi.fn();
const update = vi.fn();
const casWrite = vi.fn(); // refresh CAS writes
const updateMany = (a: { where: Record<string, unknown> }) =>
  "encryptedCredentials" in a.where ? casWrite(a) : Promise.resolve({ count: 1 });
const decrypt = vi.fn();
const encrypt = vi.fn();
const callTool = vi.fn();
const safeFetch = vi.fn();
const logs: unknown[] = [];
vi.mock("../../../lib/db", () => ({
  prisma: { tenantConnector: { findFirst: (...a: unknown[]) => findFirst(...a), update: (...a: unknown[]) => update(...a), updateMany: (a: never) => updateMany(a) } },
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
import { __resetOAuthRefreshState } from "../oauth-refresh";

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
  for (const m of [findFirst, update, casWrite, decrypt, encrypt, callTool, safeFetch]) m.mockReset();
  logs.length = 0;
  __resetOAuthRefreshState();
  vi.restoreAllMocks();
  casWrite.mockResolvedValue({ count: 1 });
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
    expect(casWrite).toHaveBeenCalledTimes(1);
    expect(casWrite.mock.calls[0]![0].where).toMatchObject({ id: "inst-1", revokedAt: null, isEnabled: true, encryptedCredentials: "enc" });
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
    expect(casWrite).not.toHaveBeenCalled();
    const blob = JSON.stringify([out, logs]);
    for (const t of ["OLD-ACCESS-TOKEN", "REFRESH-TOKEN-abc123"]) expect(blob).not.toContain(t);
  });

  it("failed persistence rejects the call", async () => {
    decrypt.mockReturnValue(JSON.stringify(expired));
    safeFetch.mockImplementation(async () => tokenOk());
    casWrite.mockRejectedValue(new Error("db down"));
    const out = (await executeMcpTool("t", "acme", "x", {})) as { error: string };
    expect(out.error).toMatch(/yenilenemedi/);
    expect(casWrite).toHaveBeenCalledTimes(2); // one short retry
    expect(JSON.stringify(logs)).toContain("rotation write failed");
    expect(JSON.stringify(logs)).not.toContain("NEW-ACCESS-TOKEN");
    expect(callTool).not.toHaveBeenCalled();
  });

  it("transient write failure is retried once and the call proceeds", async () => {
    decrypt.mockReturnValue(JSON.stringify(expired));
    safeFetch.mockImplementation(async () => tokenOk());
    casWrite.mockRejectedValueOnce(new Error("blip")).mockResolvedValueOnce({ count: 1 });
    await executeMcpTool("t", "acme", "x", {});
    expect(casWrite).toHaveBeenCalledTimes(2);
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it("rotation: a new refresh_token from the provider is saved", async () => {
    decrypt.mockReturnValue(JSON.stringify(expired));
    safeFetch.mockImplementation(async () =>
      new Response(JSON.stringify({ access_token: "A2-token-zzz", refresh_token: "ROTATED-REFRESH-2", expires_in: 60 }), { status: 200 }));
    await executeMcpTool("t", "acme", "x", {});
    expect(JSON.parse(encrypt.mock.calls[0]![0] as string).refreshToken).toBe("ROTATED-REFRESH-2");
  });

  it("revoke race: CAS count 0 rejects, nothing revived, no token upstream", async () => {
    decrypt.mockReturnValue(JSON.stringify(expired));
    safeFetch.mockImplementation(async () => tokenOk());
    casWrite.mockResolvedValue({ count: 0 });
    const out = (await executeMcpTool("t", "acme", "x", {})) as { error: string };
    expect(out.error).toMatch(/yenilenemedi/);
    expect(callTool).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("revoked between read and refresh (re-read finds no row): no fetch, rejected", async () => {
    decrypt.mockReturnValue(JSON.stringify(expired));
    findFirst.mockResolvedValueOnce(mkInstall()).mockResolvedValueOnce(null);
    const out = (await executeMcpTool("t", "acme", "x", {})) as { error: string };
    expect(out.error).toMatch(/yenilenemedi/);
    expect(safeFetch).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
  });

  it("sequential stale read: second call re-reads the row and does not refresh again", async () => {
    // call 1 reads expired (executeMcpTool read + re-read), call 2 reads expired in executeMcpTool but the re-read is fresh
    const fresh = { ...expired, accessToken: "FRESH-ACCESS-1", expiresAt: String(Date.now() + 3_600_000) };
    decrypt
      .mockReturnValueOnce(JSON.stringify(expired)).mockReturnValueOnce(JSON.stringify(expired))
      .mockReturnValueOnce(JSON.stringify(expired)).mockReturnValueOnce(JSON.stringify(fresh));
    safeFetch.mockImplementation(async () => tokenOk());
    await executeMcpTool("t", "acme", "x", {});
    await executeMcpTool("t", "acme", "x", {});
    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(callTool.mock.calls[1]![2]).toMatchObject({ accessToken: "FRESH-ACCESS-1" });
  });

  it("failed refresh is cached negatively for 30s, then retried", async () => {
    decrypt.mockReturnValue(JSON.stringify(expired));
    safeFetch.mockImplementation(async () => new Response("no", { status: 500 }));
    await executeMcpTool("t", "acme", "x", {});
    await executeMcpTool("t", "acme", "x", {});
    expect(safeFetch).toHaveBeenCalledTimes(1);
    const real = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(real + 31_000);
    await executeMcpTool("t", "acme", "x", {});
    expect(safeFetch).toHaveBeenCalledTimes(2);
  });

  it("unparseable expiresAt on a refreshable credential is treated as expired", async () => {
    decrypt.mockReturnValue(JSON.stringify({ ...expired, expiresAt: "not-a-date" }));
    safeFetch.mockImplementation(async () => tokenOk());
    await executeMcpTool("t", "acme", "x", {});
    expect(safeFetch).toHaveBeenCalledTimes(1);
  });

  it("non-OAUTH2 method with a refreshToken field is left untouched", async () => {
    findFirst.mockResolvedValue({ ...mkInstall(), connector: { ...mkInstall().connector, authMethod: "API_KEY" } });
    decrypt.mockReturnValue(JSON.stringify({ apiKey: "k-123456", refreshToken: "r", expiresAt: "1", tokenUrl: "https://a.example/t" }));
    await executeMcpTool("t", "acme", "x", {});
    expect(safeFetch).not.toHaveBeenCalled();
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it("refuses http:// token endpoint and http:// mcpServerUrl without any fetch", async () => {
    decrypt.mockReturnValue(JSON.stringify({ ...expired, tokenUrl: "http://auth.acme.example/token" }));
    expect(await executeMcpTool("t", "acme", "x", {})).toMatchObject({ error: expect.stringMatching(/HTTPS/) });
    __resetOAuthRefreshState();
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
