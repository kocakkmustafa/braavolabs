/**
 * BRA-P0-03e — `enqueueRun(runId, { jobId })`: süpürücü sabit jobId verince BullMQ'ya geçer (aynı koşu için
 * ikinci ekleme yinelenen iş yaratmaz); jobId verilmeyen mevcut çağıranlar için otomatik id davranışı değişmez.
 * NOT covered: gerçek Redis/BullMQ (kuyruk sahte).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const runQueueMock = vi.hoisted(() => ({ add: vi.fn(), upsertJobScheduler: vi.fn(), removeJobScheduler: vi.fn(), getJobSchedulers: vi.fn() }));
vi.mock("../../../lib/queue", () => ({ runQueue: runQueueMock, scheduleQueue: runQueueMock, createWorker: vi.fn() }));

const prismaMock = vi.hoisted(() => ({ run: { findUnique: vi.fn() } }));
vi.mock("../../../lib/db", () => ({ prisma: prismaMock }));
vi.mock("../../billing/metering", () => ({ claimQuota: vi.fn(), incrementMeter: vi.fn(), checkQuota: vi.fn() }));
vi.mock("../../../lib/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../../../config/env", () => ({ env: { SCHEDULER_TZ: "UTC" } }));

import { enqueueRun } from "../runner";

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.run.findUnique.mockResolvedValue({ pipeline: { company: { tenantId: "tenant-1" } } });
  runQueueMock.add.mockResolvedValue({ id: "job-1" });
});

describe("enqueueRun jobId geçişi (BRA-P0-03e)", () => {
  it("jobId verilmezse BullMQ seçeneklerinde jobId YOK (mevcut çağıranlar: otomatik id)", async () => {
    await enqueueRun("run-1");
    const [name, data, opts] = runQueueMock.add.mock.calls[0]!;
    expect(name).toBe("execute-run");
    expect(data).toEqual({ runId: "run-1", tenantId: "tenant-1" });
    expect(opts).not.toHaveProperty("jobId");
    expect(opts).toMatchObject({ attempts: 2 });
  });

  it("jobId verilirse aynen BullMQ'ya geçer; kiracı yine DB'den türetilir", async () => {
    await enqueueRun("run-1", { jobId: "run-run-1" });
    const [, data, opts] = runQueueMock.add.mock.calls[0]!;
    expect(data).toEqual({ runId: "run-1", tenantId: "tenant-1" });
    expect(opts).toMatchObject({ jobId: "run-run-1", attempts: 2 });
  });

  it("kiracısı olmayan/bulunmayan koşu kuyruğa eklenmez", async () => {
    prismaMock.run.findUnique.mockResolvedValue(null);
    await expect(enqueueRun("run-x", { jobId: "run-run-x" })).rejects.toThrow(/not found or has no tenant/);
    expect(runQueueMock.add).not.toHaveBeenCalled();
  });
});
