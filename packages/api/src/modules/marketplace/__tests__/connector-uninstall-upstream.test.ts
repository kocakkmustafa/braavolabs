/**
 * BRA-P1-02b-2 — uninstall revokes upstream (via revokeInstall) before deleting.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { row, connectorRow, activityCreate, fetchMock, logSink, deleteSpy, flags } = vi.hoisted(() => ({
  row: {} as Record<string, any>,
  connectorRow: { id: "conn-1", slug: "acme", mcpServerUrl: "https://mcp.acme.example/rpc", authMethod: "OAUTH2" },
  activityCreate: vi.fn(),
  fetchMock: vi.fn(),
  logSink: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  deleteSpy: vi.fn(),
  flags: { deleted: false },
}));

const dbMock = {
  connector: { findUnique: async () => connectorRow },
  tenantConnector: {
    findUnique: async ({ where }: any) =>
      where.tenantId_connectorId.tenantId === row.tenantId ? { ...row, connector: connectorRow } : null,
    updateMany: async ({ where, data }: any) => {
      if (where.tenantId === undefined) throw new Error("claim must be tenant-scoped");
      if (where.tenantId !== row.tenantId) return { count: 0 };
      if (where.encryptedCredentials !== undefined && where.encryptedCredentials !== row.encryptedCredentials) return { count: 0 };
      if (where.revokedAt === null && row.revokedAt) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    },
    deleteMany: async ({ where }: any) => {
      deleteSpy(where);
      if (where.tenantId !== row.tenantId) return { count: 0 };
      if (where.revokedAt?.not === null && !row.revokedAt) return { count: 0 };
      flags.deleted = true;
      return { count: 1 };
    },
  },
  activityLog: { create: (...a: unknown[]) => activityCreate(...a) },
};
vi.mock("../../../lib/db", () => ({
  get prisma() { return dbMock; },
  tenantTx: async (fn: (tx: unknown) => Promise<unknown>) => {
    const snap = { ...row };
    try {
      return await fn(dbMock);
    } catch (e) {
      Object.keys(row).forEach((k) => delete row[k]);
      Object.assign(row, snap);
      throw e;
    }
  },
}));
vi.mock("../../../lib/encryption", () => ({
  encrypt: (plain: string, aad: string) => "enc:" + aad + ":" + plain,
  decrypt: (blob: string, aad: string) => {
    const prefix = "enc:" + aad + ":";
    if (!blob.startsWith(prefix)) throw new Error("auth tag mismatch");
    return blob.slice(prefix.length);
  },
}));
vi.mock("../../../lib/mcp", () => ({ callTool: vi.fn(), listTools: vi.fn() }));
vi.mock("../../../lib/logger", () => ({ logger: logSink }));
vi.mock("../../../lib/ssrf", () => ({ safeExternalFetch: (...a: unknown[]) => fetchMock(...a) }));

import { uninstallInstall } from "../connector-lifecycle";

const AAD = "t1|tenant_connector|conn-1";
const setCreds = (c: Record<string, string>) => {
  row.encryptedCredentials = "enc:" + AAD + ":" + JSON.stringify(c);
};
const CREDS = { accessToken: "AT-SECRET", refreshToken: "RT-SECRET", revocationUrl: "https://idp.acme.example/revoke" };

beforeEach(() => {
  Object.keys(row).forEach((k) => delete row[k]);
  Object.assign(row, { id: "inst-1", tenantId: "t1", connectorId: "conn-1", isEnabled: true, revokedAt: null });
  setCreds(CREDS);
  flags.deleted = false;
  deleteSpy.mockReset();
  fetchMock.mockReset().mockResolvedValue({ ok: true, status: 200 });
  activityCreate.mockReset();
  Object.values(logSink).forEach((f) => f.mockReset());
});

describe("uninstall upstream revoke", () => {
  it("revokes upstream exactly once, then deletes tenant-scoped", async () => {
    await uninstallInstall("t1", "u1", "acme");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new URLSearchParams(fetchMock.mock.calls[0]![1].body).get("token")).toBe("RT-SECRET");
    expect(deleteSpy).toHaveBeenCalledWith({ tenantId: "t1", connectorId: "conn-1", revokedAt: { not: null } });
    expect(flags.deleted).toBe(true);
    expect(activityCreate).toHaveBeenCalledTimes(1);
    expect(activityCreate.mock.calls[0]![0].data.action).toBe("marketplace.revoke");
  });

  it.each([
    ["500", () => fetchMock.mockResolvedValue({ ok: false, status: 500 })],
    ["network", () => fetchMock.mockRejectedValue(new Error("ECONNRESET"))],
    ["timeout", () => fetchMock.mockRejectedValue(Object.assign(new Error("t"), { name: "TimeoutError" }))],
  ])("upstream %s does not block the delete", async (_n, arrange) => {
    arrange();
    await expect(uninstallInstall("t1", "u1", "acme")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(flags.deleted).toBe(true);
  });

  it("HTTP revocationUrl: no upstream call, still deleted", async () => {
    setCreds({ accessToken: "AT", revocationUrl: "http://idp.acme.example/revoke" });
    await uninstallInstall("t1", "u1", "acme");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(flags.deleted).toBe(true);
  });

  it("no revocationUrl (legacy): no upstream call, still deleted", async () => {
    setCreds({ accessToken: "AT" });
    await uninstallInstall("t1", "u1", "acme");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(flags.deleted).toBe(true);
  });

  it("fail-closed: double CAS loss -> 409, no delete, no upstream", async () => {
    const orig = dbMock.tenantConnector.updateMany;
    dbMock.tenantConnector.updateMany = async () => {
      setCreds({ ...CREDS, refreshToken: "RT-" + Math.random() });
      return { count: 0 };
    };
    try {
      await expect(uninstallInstall("t1", "u1", "acme")).rejects.toMatchObject({ statusCode: 409 });
    } finally {
      dbMock.tenantConnector.updateMany = orig;
    }
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(flags.deleted).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("re-install during upstream call: new install is NOT deleted, still success", async () => {
    fetchMock.mockImplementation(async () => {
      Object.assign(row, { revokedAt: null, isEnabled: true }); // install upsert
      return { ok: true, status: 200 };
    });
    await expect(uninstallInstall("t1", "u1", "acme")).resolves.toBeUndefined();
    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(flags.deleted).toBe(false);
    expect(row.revokedAt).toBeNull();
  });

  it("concurrent uninstall: revoke 404 -> idempotent success, no delete", async () => {
    const orig = dbMock.tenantConnector.findUnique;
    let n = 0;
    dbMock.tenantConnector.findUnique = async (a: any) => (n++ === 0 ? orig(a) : null);
    try {
      await expect(uninstallInstall("t1", "u1", "acme")).resolves.toBeUndefined();
    } finally {
      dbMock.tenantConnector.findUnique = orig;
    }
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it("tenant isolation: other tenant's install untouched, upstream not called", async () => {
    await uninstallInstall("t2", "u2", "acme");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(row.revokedAt).toBeNull();
    expect(flags.deleted).toBe(false);
  });

  it("claim is tenant-scoped (where.tenantId)", async () => {
    const spy = vi.spyOn(dbMock.tenantConnector, "updateMany");
    await uninstallInstall("t1", "u1", "acme");
    expect(spy.mock.calls[0]![0].where.tenantId).toBe("t1");
    spy.mockRestore();
  });

  it("never logs or audits token material", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    await uninstallInstall("t1", "u1", "acme");
    const dump = JSON.stringify([activityCreate.mock.calls, Object.values(logSink).map((f) => f.mock.calls)]);
    expect(dump).not.toMatch(/AT-SECRET|RT-SECRET/);
  });
});
