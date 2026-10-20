import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  findMany: vi.fn(), update: vi.fn(), upsert: vi.fn(), fetch: vi.fn(), decrypt: vi.fn(),
}));
vi.mock("../../../lib/db", () => ({ prisma: {
  externalConnection: { findMany: m.findMany, update: m.update },
  externalRun: { upsert: m.upsert },
} }));
vi.mock("../../../lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../../../lib/encryption", () => ({ decrypt: m.decrypt }));
vi.mock("../adapters/n8n", () => ({ n8nAdapter: { fetchExecutions: m.fetch } }));
vi.mock("../adapters/make", () => ({ makeAdapter: { fetchExecutions: m.fetch } }));
vi.mock("../adapters/generic", () => ({ genericAdapter: { fetchExecutions: m.fetch } }));

import { initExternalPoller, pollConnection, stopExternalPoller } from "../poller";

function connection(id: string, lastPolledAt: Date | null = null) {
  return { id, tenantId: "tenant-fixture", platform: "GENERIC", baseUrl: "https://fixture.invalid",
    encryptedCredentials: "synthetic", cursor: null, enabled: true, pollIntervalSec: 3600, lastPolledAt };
}
function defer<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-19T00:00:00Z"));
  vi.clearAllMocks();
  m.findMany.mockResolvedValue([]);
  m.update.mockResolvedValue({}); m.upsert.mockResolvedValue({});
  m.decrypt.mockReturnValue("synthetic-key");
  m.fetch.mockResolvedValue({ executions: [], cursor: undefined });
});
afterEach(() => { stopExternalPoller(); vi.useRealTimers(); });

describe("external poller lifecycle (synthetic DB and adapter, no sockets)", () => {
  it("reaches the due 101st connection while the first 100 are not due", async () => {
    const rows = Array.from({ length: 101 }, (_, n) => connection(String(n + 1).padStart(4, "0"),
      n < 100 ? new Date() : null));
    m.findMany.mockImplementation(async (args) => rows
      .filter((c) => !args.where.id?.gt || c.id > args.where.id.gt).slice(0, args.take));
    initExternalPoller();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(m.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "0101" } }));
    expect(m.fetch).toHaveBeenCalledOnce();
  });

  it("does not start another tick while the current adapter is pending", async () => {
    const pending = defer<{ executions: []; cursor: undefined }>();
    m.findMany.mockResolvedValueOnce([connection("0001")]).mockResolvedValue([]);
    m.fetch.mockReturnValue(pending.promise);
    initExternalPoller();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(m.findMany).toHaveBeenCalledOnce();
    expect(m.fetch).toHaveBeenCalledOnce();
    pending.resolve({ executions: [], cursor: undefined });
    await vi.advanceTimersByTimeAsync(0);
  });

  it("coalesces a manual refresh with another poll of the same connection", async () => {
    const pending = defer<{ executions: []; cursor: undefined }>();
    m.fetch.mockReturnValue(pending.promise);
    const first = pollConnection(connection("same"));
    const second = pollConnection(connection("same"));
    expect(m.fetch).toHaveBeenCalledOnce();
    pending.resolve({ executions: [], cursor: undefined });
    await Promise.all([first, second]);
    expect(m.update).toHaveBeenCalledOnce();
  });

  it("keeps polling the next due connection when one adapter fails", async () => {
    m.findMany.mockResolvedValueOnce([connection("0001"), connection("0002")]).mockResolvedValue([]);
    m.fetch.mockRejectedValueOnce(new Error("synthetic timeout"));
    initExternalPoller();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(m.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "0001" },
      data: expect.objectContaining({ status: "ERROR" }) }));
    expect(m.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "0002" },
      data: expect.objectContaining({ status: "ACTIVE" }) }));
  });
  it("continues from the bounded page on the next tick instead of starving later rows", async () => {
    const rows = Array.from({ length: 201 }, (_, n) => connection(String(n + 1).padStart(4, "0")));
    m.findMany.mockImplementation(async (args) => rows
      .filter((c) => !args.where.id?.gt || c.id > args.where.id.gt).slice(0, args.take));
    initExternalPoller();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(m.fetch).toHaveBeenCalledTimes(201);
    expect(m.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "0201" } }));
  });
  it("stopping during a pending poll does not start the remaining connections", async () => {
    const pending = defer<{ executions: []; cursor: undefined }>();
    m.findMany.mockResolvedValueOnce([connection("0001"), connection("0002")]);
    m.fetch.mockReturnValue(pending.promise);
    initExternalPoller(); await vi.advanceTimersByTimeAsync(30_000);
    stopExternalPoller();
    pending.resolve({ executions: [], cursor: undefined });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(m.fetch).toHaveBeenCalledOnce();
  });
});
