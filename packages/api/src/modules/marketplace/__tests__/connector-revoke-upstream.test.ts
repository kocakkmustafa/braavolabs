/**
 * BRA-P1-02b — upstream (RFC 7009) revoke on connector uninstall.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { row, connectorRow, activityCreate, fetchMock, logSink } = vi.hoisted(() => ({
  row: {} as Record<string, any>,
  connectorRow: { id: "conn-1", slug: "acme", mcpServerUrl: "https://mcp.acme.example/rpc", authMethod: "OAUTH2" },
  activityCreate: vi.fn(),
  fetchMock: vi.fn(),
  logSink: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const dbMock = {
  connector: { findUnique: async () => connectorRow },
  tenantConnector: {
    findUnique: async ({ where }: any) =>
      where.tenantId_connectorId.tenantId === row.tenantId ? { ...row, connector: connectorRow } : null,
    updateMany: async ({ where, data }: any) => {
      if (where.tenantId !== undefined && where.tenantId !== row.tenantId) return { count: 0 };
      if (where.revokedAt === null && row.revokedAt) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
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
vi.mock("../../../lib/mcp", () => ({ callTool: vi.fn(), listTools: vi.fn() }));
vi.mock("../../../lib/logger", () => ({ logger: logSink }));
vi.mock("../../../lib/ssrf", () => ({ safeExternalFetch: (...a: unknown[]) => fetchMock(...a) }));

import { revokeInstall } from "../connector-lifecycle";

const AAD = "t1|tenant_connector|conn-1";
const setCreds = (c: Record<string, string>) => {
  row.encryptedCredentials = `enc:${AAD}:${JSON.stringify(c)}`;
};

beforeEach(() => {
  Object.keys(row).forEach((k) => delete row[k]);
  Object.assign(row, { id: "inst-1", tenantId: "t1", connectorId: "conn-1", isEnabled: true, revokedAt: null });
  setCreds({ accessToken: "AT-SECRET", refreshToken: "RT-SECRET", revocationUrl: "https://idp.acme.example/revoke" });
  fetchMock.mockReset().mockResolvedValue({ ok: true, status: 200 });
  activityCreate.mockReset();
  Object.values(logSink).forEach((f) => f.mockReset());
});

describe("upstream revoke", () => {
  it("calls the provider once with the refresh token, SSRF-guarded", async () => {
    await revokeInstall("t1", "u1", "acme");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init, opts] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://idp.acme.example/revoke");
    const body = new URLSearchParams(init.body);
    expect(body.get("token")).toBe("RT-SECRET");
    expect(body.get("token_type_hint")).toBe("refresh_token");
    expect(opts).toMatchObject({ requireHttps: true, maxRedirects: 0 });
    expect(init.signal).toBeDefined();
    expect(row.revokedAt).toBeInstanceOf(Date);
  });

  it("falls back to the access token and accepts revokeUrl", async () => {
    setCreds({ accessToken: "AT-SECRET", revokeUrl: "https://idp.acme.example/r" });
    await revokeInstall("t1", "u1", "acme");
    const body = new URLSearchParams(fetchMock.mock.calls[0]![1].body);
    expect(body.get("token")).toBe("AT-SECRET");
    expect(body.get("token_type_hint")).toBe("access_token");
  });

  it("upstream 500 still revokes locally and wipes credentials", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    await revokeInstall("t1", "u1", "acme");
    expect(row.revokedAt).toBeInstanceOf(Date);
    expect(row.isEnabled).toBe(false);
    expect(row.encryptedCredentials).toBe(`enc:${AAD}:{}`);
    expect(activityCreate).toHaveBeenCalledTimes(1);
  });

  it("network error / timeout still revokes locally; no token in logs or audit", async () => {
    fetchMock.mockRejectedValue(new Error("boom RT-SECRET"));
    await revokeInstall("t1", "u1", "acme");
    expect(row.revokedAt).toBeInstanceOf(Date);
    expect(row.encryptedCredentials).toBe(`enc:${AAD}:{}`);
    const dump = JSON.stringify([logSink.warn.mock.calls, logSink.error.mock.calls, activityCreate.mock.calls]);
    expect(dump).not.toContain("RT-SECRET");
    expect(dump).not.toContain("AT-SECRET");
  });

  it("no revocationUrl or http URL means no call (legacy)", async () => {
    setCreds({ accessToken: "AT-SECRET" });
    await revokeInstall("t1", "u1", "acme");
    expect(fetchMock).not.toHaveBeenCalled();
    Object.assign(row, { revokedAt: null, isEnabled: true });
    setCreds({ accessToken: "AT-SECRET", revocationUrl: "http://idp.acme.example/revoke" });
    await revokeInstall("t1", "u1", "acme");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(row.revokedAt).toBeInstanceOf(Date);
  });

  it("concurrent and repeated revokes hit the upstream once", async () => {
    await Promise.all([revokeInstall("t1", "u1", "acme"), revokeInstall("t1", "u2", "acme")]);
    await revokeInstall("t1", "u1", "acme");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(activityCreate).toHaveBeenCalledTimes(1);
  });

  it("local revoke is committed before the upstream call", async () => {
    let seen: Record<string, any> = {};
    fetchMock.mockImplementation(async () => {
      seen = { ...row };
      return { ok: true, status: 200 };
    });
    await revokeInstall("t1", "u1", "acme");
    expect(seen.revokedAt).toBeInstanceOf(Date);
    expect(seen.isEnabled).toBe(false);
    expect(seen.encryptedCredentials).toBe(`enc:${AAD}:{}`);
    expect(activityCreate).toHaveBeenCalledTimes(1);
  });

  it("a losing claim returns the DB revokedAt and never calls upstream", async () => {
    const dbDate = new Date("2026-01-01T00:00:00Z");
    // Row looks unrevoked on the first read, but a concurrent revoke wins the claim.
    const orig = dbMock.tenantConnector.findUnique;
    let reads = 0;
    dbMock.tenantConnector.findUnique = async (a: any) => {
      reads++;
      const r = await orig(a);
      return reads === 1 ? r : { ...r, revokedAt: dbDate };
    };
    const origUpdate = dbMock.tenantConnector.updateMany;
    dbMock.tenantConnector.updateMany = async () => ({ count: 0 });
    try {
      const out = await revokeInstall("t1", "u1", "acme");
      expect(out.revokedAt).toBe(dbDate);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(activityCreate).not.toHaveBeenCalled();
    } finally {
      dbMock.tenantConnector.findUnique = orig;
      dbMock.tenantConnector.updateMany = origUpdate;
    }
  });

  it("tenant isolation: another tenant cannot revoke or trigger upstream", async () => {
    await expect(revokeInstall("t2", "u1", "acme")).rejects.toMatchObject({ statusCode: 404 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(row.revokedAt).toBeNull();
  });

  it("undecryptable credentials: local revoke proceeds, no upstream, warn without token", async () => {
    row.encryptedCredentials = "garbage-RT-SECRET";
    await revokeInstall("t1", "u1", "acme");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(row.revokedAt).toBeInstanceOf(Date);
    expect(logSink.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logSink.warn.mock.calls)).not.toContain("RT-SECRET");
  });

  it("empty revocationUrl falls through to revokeUrl", async () => {
    setCreds({ accessToken: "AT-SECRET", revocationUrl: "", revokeUrl: "https://idp.acme.example/r" });
    await revokeInstall("t1", "u1", "acme");
    expect(fetchMock.mock.calls[0]![0]).toBe("https://idp.acme.example/r");
  });

  it("sends client_id and client_secret in the body", async () => {
    setCreds({ refreshToken: "RT-SECRET", revocationUrl: "https://idp.acme.example/r", clientId: "cid", clientSecret: "csec" });
    await revokeInstall("t1", "u1", "acme");
    const body = new URLSearchParams(fetchMock.mock.calls[0]![1].body);
    expect(body.get("client_id")).toBe("cid");
    expect(body.get("client_secret")).toBe("csec");
  });
});
