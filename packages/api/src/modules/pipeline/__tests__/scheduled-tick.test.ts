/**
 * E4/T2 — processScheduledTick fire-time behavior + idempotency.
 *
 * Covers the fire-time re-checks the old inline node-cron callback lacked (G3)
 * and the double-billing guard (A2): claimQuota has no rollback, so the tick
 * must run at most one claim per fire and must never be internally retried.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

const prismaMock = vi.hoisted(() => ({
  pipeline: { findUnique: vi.fn(), update: vi.fn() },
  // run.findUnique is used by enqueueRun to snapshot the run's tenantId.
  run: { create: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn() },
  activityLog: { create: vi.fn() },
}));
vi.mock("../../../lib/db", () => ({ prisma: prismaMock }));

const claimQuotaMock = vi.hoisted(() => vi.fn());
const incrementMeterMock = vi.hoisted(() => vi.fn());
const checkQuotaMock = vi.hoisted(() => vi.fn());
vi.mock("../../billing/metering", () => ({
  claimQuota: claimQuotaMock,
  incrementMeter: incrementMeterMock,
  checkQuota: checkQuotaMock,
}));

const enqueueRunMock = vi.hoisted(() => vi.fn());
// enqueueRun lives in the same module under test, so we can't vi.mock it.
// Instead we mock runQueue.add (what enqueueRun ultimately calls) and stub the
// tenant lookup enqueueRun performs.
const runQueueMock = vi.hoisted(() => ({
  add: vi.fn(),
  upsertJobScheduler: vi.fn(),
  removeJobScheduler: vi.fn(),
  getJobSchedulers: vi.fn(),
}));
const scheduleQueueMock = vi.hoisted(() => ({
  add: vi.fn(),
  upsertJobScheduler: vi.fn(),
  removeJobScheduler: vi.fn(),
  getJobSchedulers: vi.fn(),
}));
vi.mock("../../../lib/queue", () => ({
  runQueue: runQueueMock,
  scheduleQueue: scheduleQueueMock,
  createWorker: vi.fn(),
}));

vi.mock("../../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
const redisMock = vi.hoisted(() => ({ set: vi.fn() }));
vi.mock("../../../lib/redis", () => ({ redis: redisMock }));
vi.mock("../../../config/env", () => ({ env: { SCHEDULER_TZ: "UTC" } }));

import { logger } from "../../../lib/logger";
import { processScheduledTick, getTickDedupErrorCount } from "../runner";

// Slot-claim SETs only (excludes the tick-skip log dedup keys).
const slotKeyCalls = () =>
  redisMock.set.mock.calls.filter((c) => String(c[0]).startsWith("pipeline:tick:"));

function makeJob(pipelineId = "pipe-1", timestamp = 1_000_000, delay = 60_000) {
  return { name: "scheduled-run", data: { pipelineId }, timestamp, opts: { delay } } as any;
}

const activePipeline = {
  id: "pipe-1",
  enabled: true,
  trigger: "SCHEDULED",
  schedule: "0 9 * * *",
  companyId: "co-1",
  company: { status: "ACTIVE", tenantId: "tenant-1" },
};

beforeEach(() => {
  vi.clearAllMocks();
  // Real SET NX semantics: existing key -> null, else "OK".
  const store = new Map<string, string>();
  redisMock.set.mockImplementation(async (k: string, v: string) => {
    if (store.has(k)) return null;
    store.set(k, v);
    return "OK";
  });
  runQueueMock.add.mockResolvedValue({ id: "job-1" });
  prismaMock.pipeline.update.mockResolvedValue({});
  prismaMock.activityLog.create.mockResolvedValue({});
  // BRA-P1-04-N2 overlap guard: by default no run is waiting for approval.
  prismaMock.run.findFirst.mockReset().mockResolvedValue(null);
  // enqueueRun's tenant snapshot lookup.
  prismaMock.run.findUnique.mockResolvedValue({
    pipeline: { company: { tenantId: "tenant-1" } },
  });
});

describe("processScheduledTick — fire-time guards (G3)", () => {
  it("disabled pipeline → no run created", async () => {
    prismaMock.pipeline.findUnique.mockResolvedValue({ ...activePipeline, enabled: false });
    await processScheduledTick(makeJob());
    expect(claimQuotaMock).not.toHaveBeenCalled();
    expect(prismaMock.run.create).not.toHaveBeenCalled();
    expect(slotKeyCalls()).toHaveLength(0);
  });

  it("trigger no longer SCHEDULED → no run created", async () => {
    prismaMock.pipeline.findUnique.mockResolvedValue({ ...activePipeline, trigger: "MANUAL" });
    await processScheduledTick(makeJob());
    expect(prismaMock.run.create).not.toHaveBeenCalled();
  });

  it("schedule cleared → no run created", async () => {
    prismaMock.pipeline.findUnique.mockResolvedValue({ ...activePipeline, schedule: null });
    await processScheduledTick(makeJob());
    expect(prismaMock.run.create).not.toHaveBeenCalled();
  });

  it("deleted pipeline (null) → no run, no FK error path", async () => {
    prismaMock.pipeline.findUnique.mockResolvedValue(null);
    await processScheduledTick(makeJob());
    expect(prismaMock.run.create).not.toHaveBeenCalled();
  });

  it("company not ACTIVE → skip before claiming quota", async () => {
    prismaMock.pipeline.findUnique.mockResolvedValue({
      ...activePipeline,
      company: { status: "PAUSED", tenantId: "tenant-1" },
    });
    await processScheduledTick(makeJob());
    expect(claimQuotaMock).not.toHaveBeenCalled();
    expect(prismaMock.run.create).not.toHaveBeenCalled();
    expect(slotKeyCalls()).toHaveLength(0);
  });

  it("quota exhausted → no run created, slot key WAS taken (at-most-once)", async () => {
    prismaMock.pipeline.findUnique.mockResolvedValue(activePipeline);
    claimQuotaMock.mockResolvedValue({ claimed: false, value: 100, limit: 100 });
    await processScheduledTick(makeJob());
    expect(prismaMock.run.create).not.toHaveBeenCalled();
    expect(slotKeyCalls()).toHaveLength(1);
  });
});

describe("processScheduledTick — happy path", () => {
  it("creates exactly one run, enqueues it, and stamps lastRunAt", async () => {
    prismaMock.pipeline.findUnique.mockResolvedValue(activePipeline);
    claimQuotaMock.mockResolvedValue({ claimed: true, value: 1, limit: 100 });
    prismaMock.run.create.mockResolvedValue({ id: "run-1" });

    await processScheduledTick(makeJob());

    expect(claimQuotaMock).toHaveBeenCalledTimes(1);
    expect(prismaMock.run.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.run.create.mock.calls[0]![0].data).toMatchObject({
      pipelineId: "pipe-1",
      trigger: "scheduled",
      status: "PENDING",
      // BRA-P0-02c-1: owner comes from the already-loaded Pipeline → Company.
      tenantId: "tenant-1",
      workspaceId: "co-1",
    });
    // Scheduled ticks carry no body → no job budget key at all (NULL column).
    expect(prismaMock.run.create.mock.calls[0]![0].data).not.toHaveProperty("jobBudget");
    // enqueueRun → runQueue.add fired for run-1
    expect(runQueueMock.add).toHaveBeenCalledTimes(1);
    // lastRunAt stamped
    expect(prismaMock.pipeline.update).toHaveBeenCalledTimes(1);
    expect(prismaMock.pipeline.update.mock.calls[0]![0]).toMatchObject({
      where: { id: "pipe-1" },
      data: expect.objectContaining({ lastRunAt: expect.any(Date) }),
    });
  });
});

describe("processScheduledTick — idempotency / no double-claim (A2)", () => {
  it("claimQuota succeeds then run.create throws → exactly ONE claim, error propagates (no in-fn retry)", async () => {
    prismaMock.pipeline.findUnique.mockResolvedValue(activePipeline);
    claimQuotaMock.mockResolvedValue({ claimed: true, value: 1, limit: 100 });
    prismaMock.run.create.mockRejectedValue(new Error("db down"));

    await expect(processScheduledTick(makeJob())).rejects.toThrow("db down");

    // The critical assertion: quota was claimed exactly once. Because the tick
    // never retries internally (and the worker is registered attempts:1), a
    // post-claim failure cannot double-bill the tenant.
    expect(claimQuotaMock).toHaveBeenCalledTimes(1);
  });
});

describe("processScheduledTick — slot dedup (BRA-P1-04c)", () => {
  beforeEach(() => {
    prismaMock.pipeline.findUnique.mockResolvedValue(activePipeline);
    claimQuotaMock.mockResolvedValue({ claimed: true, value: 1, limit: 100 });
    prismaMock.run.create.mockResolvedValue({ id: "run-1" });
  });

  it("same slot fired twice → one run (second SET NX returns null)", async () => {
    await processScheduledTick(makeJob());
    await processScheduledTick(makeJob());
    expect(prismaMock.run.create).toHaveBeenCalledTimes(1);
    expect(claimQuotaMock).toHaveBeenCalledTimes(1);
    const [k1, , ex, ttl, nx] = redisMock.set.mock.calls[0]!;
    expect(k1).toBe(redisMock.set.mock.calls[1]![0]);
    expect([ex, nx]).toEqual(["EX", "NX"]);
    expect(ttl).toBe(25 * 3600);
  });

  it("sub-minute cron: two fires 30s apart → two runs (no minute rounding)", async () => {
    await processScheduledTick(makeJob("pipe-1", 1_000_000, 30_000));
    await processScheduledTick(makeJob("pipe-1", 1_030_000, 30_000));
    expect(prismaMock.run.create).toHaveBeenCalledTimes(2);
  });

  it("no job.timestamp → warn and run without dedup", async () => {
    const job = { name: "scheduled-run", data: { pipelineId: "pipe-1" }, opts: {} } as any;
    await processScheduledTick(job);
    expect(redisMock.set).not.toHaveBeenCalled();
    expect(prismaMock.run.create).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("different slots → separate keys and separate runs", async () => {
    await processScheduledTick(makeJob("pipe-1", 1_000_000, 60_000));
    await processScheduledTick(makeJob("pipe-1", 5_000_000, 60_000));
    expect(redisMock.set.mock.calls[0]![0]).not.toBe(redisMock.set.mock.calls[1]![0]);
    expect(prismaMock.run.create).toHaveBeenCalledTimes(2);
  });

  it("different pipelines, same slot → separate keys and separate runs", async () => {
    prismaMock.pipeline.findUnique
      .mockResolvedValueOnce(activePipeline)
      .mockResolvedValueOnce({ ...activePipeline, id: "pipe-2" });
    await processScheduledTick(makeJob("pipe-1"));
    await processScheduledTick(makeJob("pipe-2"));
    expect(redisMock.set.mock.calls[0]![0]).not.toBe(redisMock.set.mock.calls[1]![0]);
    expect(prismaMock.run.create).toHaveBeenCalledTimes(2);
  });

  it("Redis error → fail-closed: no quota claim, no run, error counted, tick does not throw", async () => {
    const before = getTickDedupErrorCount();
    redisMock.set.mockRejectedValue(new Error("redis down"));
    await expect(processScheduledTick(makeJob())).resolves.toBeUndefined();
    expect(claimQuotaMock).not.toHaveBeenCalled();
    expect(prismaMock.run.create).not.toHaveBeenCalled();
    expect(getTickDedupErrorCount()).toBe(before + 1);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("Redis never answers → times out after 3s, tick skipped (fail-closed)", async () => {
    vi.useFakeTimers();
    try {
      const before = getTickDedupErrorCount();
      redisMock.set.mockImplementation(() => new Promise(() => {}));
      const p = processScheduledTick(makeJob());
      await vi.advanceTimersByTimeAsync(3_001);
      await expect(p).resolves.toBeUndefined();
      expect(claimQuotaMock).not.toHaveBeenCalled();
      expect(prismaMock.run.create).not.toHaveBeenCalled();
      expect(getTickDedupErrorCount()).toBe(before + 1);
      expect(logger.warn).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("processScheduledTick — skip activity_log (BRA-P1-04-N1)", () => {
  const skipRows = () =>
    prismaMock.activityLog.create.mock.calls
      .map((c) => c[0].data)
      .filter((d: any) => d.action === "pipeline.schedule.skip");

  it("paused (disabled) pipeline → tenant-scoped skip row, reason paused, no content", async () => {
    prismaMock.pipeline.findUnique.mockResolvedValue({ ...activePipeline, enabled: false });
    await processScheduledTick(makeJob());
    expect(skipRows()).toEqual([
      expect.objectContaining({
        tenantId: "tenant-1",
        actor: "system",
        resource: "pipeline",
        resourceId: "pipe-1",
        details: { pipelineId: "pipe-1", reason: "paused" },
      }),
    ]);
  });

  it("trigger no longer SCHEDULED → reason not_scheduled", async () => {
    prismaMock.pipeline.findUnique.mockResolvedValue({ ...activePipeline, trigger: "MANUAL" });
    await processScheduledTick(makeJob());
    expect(skipRows()[0].details.reason).toBe("not_scheduled");
  });

  it("deleted pipeline → no tenant, no row", async () => {
    prismaMock.pipeline.findUnique.mockResolvedValue(null);
    await processScheduledTick(makeJob());
    expect(prismaMock.activityLog.create).not.toHaveBeenCalled();
  });

  it("company not ACTIVE → reason company_inactive with tenantId", async () => {
    prismaMock.pipeline.findUnique.mockResolvedValue({
      ...activePipeline,
      company: { status: "PAUSED", tenantId: "tenant-1" },
    });
    await processScheduledTick(makeJob());
    const rows = skipRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].tenantId).toBe("tenant-1");
    expect(rows[0].details).toEqual({
      pipelineId: "pipe-1",
      reason: "company_inactive",
      companyStatus: "PAUSED",
    });
  });

  it("quota exhausted → reason quota_exhausted", async () => {
    prismaMock.pipeline.findUnique.mockResolvedValue(activePipeline);
    claimQuotaMock.mockResolvedValue({ claimed: false, value: 1, limit: 1 });
    await processScheduledTick(makeJob());
    expect(skipRows()[0]).toMatchObject({ tenantId: "tenant-1" });
    expect(skipRows()[0].details.reason).toBe("quota_exhausted");
  });

  it("duplicate tick (same slot, delivered 3x) → exactly ONE skip row", async () => {
    prismaMock.pipeline.findUnique.mockResolvedValue(activePipeline);
    claimQuotaMock.mockResolvedValue({ claimed: true, value: 1, limit: 100 });
    await processScheduledTick(makeJob());
    await processScheduledTick(makeJob());
    await processScheduledTick(makeJob());
    expect(prismaMock.run.create).toHaveBeenCalledTimes(1);
    const rows = skipRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].tenantId).toBe("tenant-1");
    expect(rows[0].details.reason).toBe("duplicate_tick");
  });

  it("Redis error → dedup_unavailable row written, tick does not throw", async () => {
    prismaMock.pipeline.findUnique.mockResolvedValue(activePipeline);
    redisMock.set.mockRejectedValue(new Error("redis down"));
    await expect(processScheduledTick(makeJob())).resolves.toBeUndefined();
    expect(skipRows()[0].details.reason).toBe("dedup_unavailable");
    expect(prismaMock.run.create).not.toHaveBeenCalled();
  });

  it("activity_log failure is swallowed (warn) and the skip decision is unchanged", async () => {
    prismaMock.pipeline.findUnique.mockResolvedValue({ ...activePipeline, enabled: false });
    prismaMock.activityLog.create.mockRejectedValue(new Error("db down"));
    await expect(processScheduledTick(makeJob())).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
    expect(prismaMock.run.create).not.toHaveBeenCalled();
    expect(claimQuotaMock).not.toHaveBeenCalled();

    prismaMock.pipeline.findUnique.mockResolvedValue(activePipeline);
    claimQuotaMock.mockResolvedValue({ claimed: false, value: 1, limit: 1 });
    await expect(processScheduledTick(makeJob("pipe-1", 9_000_000))).resolves.toBeUndefined();
    expect(prismaMock.run.create).not.toHaveBeenCalled();
  });
});

describe("processScheduledTick — skip log rate limit (BRA-P1-04-N1)", () => {
  const skipRows = () =>
    prismaMock.activityLog.create.mock.calls
      .map((c) => c[0].data)
      .filter((d: any) => d.action === "pipeline.schedule.skip");
  const pausedCompany = {
    ...activePipeline,
    company: { status: "PAUSED", tenantId: "tenant-1" },
  };

  it("same reason over 3 ticks (different slots) -> 1 row", async () => {
    prismaMock.pipeline.findUnique.mockResolvedValue(pausedCompany);
    for (const ts of [1_000_000, 1_060_000, 1_120_000]) {
      await processScheduledTick(makeJob("pipe-1", ts));
    }
    expect(skipRows()).toHaveLength(1);
  });

  it("different reasons -> separate rows", async () => {
    prismaMock.pipeline.findUnique
      .mockResolvedValueOnce(pausedCompany)
      .mockResolvedValueOnce({ ...activePipeline, enabled: false })
      .mockResolvedValueOnce({ ...activePipeline, trigger: "MANUAL" });
    await processScheduledTick(makeJob("pipe-1", 1_000_000));
    await processScheduledTick(makeJob("pipe-1", 1_060_000));
    await processScheduledTick(makeJob("pipe-1", 1_120_000));
    expect(skipRows().map((r: any) => r.details.reason)).toEqual([
      "company_inactive",
      "paused",
      "not_scheduled",
    ]);
  });

  it("rewrites after the key expires (deleted in mock)", async () => {
    prismaMock.pipeline.findUnique.mockResolvedValue({ ...activePipeline, enabled: false });
    await processScheduledTick(makeJob("pipe-1", 1_000_000));
    await processScheduledTick(makeJob("pipe-1", 1_060_000));
    expect(skipRows()).toHaveLength(1);
    // Simulate TTL expiry: fresh store.
    const fresh = new Set<string>();
    redisMock.set.mockImplementation(async (k: string) => {
      if (fresh.has(k)) return null;
      fresh.add(k);
      return "OK";
    });
    await processScheduledTick(makeJob("pipe-1", 5_000_000));
    expect(skipRows()).toHaveLength(2);
  });

  it("coarse key: tenant-free name, SET NX EX 3600", async () => {
    prismaMock.pipeline.findUnique.mockResolvedValue({ ...activePipeline, enabled: false });
    await processScheduledTick(makeJob());
    const call = redisMock.set.mock.calls.find((c) => String(c[0]).startsWith("pipeline:tick-skip:"))!;
    expect(call).toEqual(["pipeline:tick-skip:pipe-1:paused", "1", "EX", 3600, "NX"]);
    expect(String(call[0])).not.toContain("tenant");
  });

  it("duplicate_tick keeps the per-slot key (25h TTL)", async () => {
    prismaMock.pipeline.findUnique.mockResolvedValue(activePipeline);
    claimQuotaMock.mockResolvedValue({ claimed: true, value: 1, limit: 100 });
    await processScheduledTick(makeJob());
    await processScheduledTick(makeJob());
    const call = redisMock.set.mock.calls.find((c) => String(c[0]).startsWith("pipeline:tick-skip:"))!;
    expect(call[0]).toBe("pipeline:tick-skip:pipe-1:1060000");
    expect(call[3]).toBe(25 * 3600);
  });

  it("Redis error on the dedup key -> fail-open: row still written, skip unchanged", async () => {
    prismaMock.pipeline.findUnique.mockResolvedValue(pausedCompany);
    redisMock.set.mockRejectedValue(new Error("redis down"));
    await expect(processScheduledTick(makeJob())).resolves.toBeUndefined();
    expect(skipRows()).toHaveLength(1);
    expect(prismaMock.run.create).not.toHaveBeenCalled();
    expect(claimQuotaMock).not.toHaveBeenCalled();
  });
});

describe("processScheduledTick — onay bekleyen koşu varken overlap (BRA-P1-04-N2)", () => {
  const skipRows = () =>
    prismaMock.activityLog.create.mock.calls
      .map((c) => c[0].data)
      .filter((d: any) => d.action === "pipeline.schedule.skip");

  beforeEach(() => {
    prismaMock.pipeline.findUnique.mockResolvedValue(activePipeline);
    claimQuotaMock.mockResolvedValue({ claimed: true, value: 1, limit: 100 });
    prismaMock.run.create.mockResolvedValue({ id: "run-new" });
  });

  it("WAITING_APPROVAL koşu varken: koşu açılmaz, kota yenmez, waiting_approval skip loglanır; sorgu tenant+pipeline kapsamlı", async () => {
    prismaMock.run.findFirst.mockResolvedValue({ id: "run-waiting", status: "WAITING_APPROVAL" });
    await processScheduledTick(makeJob());
    const where = prismaMock.run.findFirst.mock.calls[0]![0].where;
    expect(where.pipelineId).toBe("pipe-1");
    expect(where.tenantId).toBe("tenant-1");
    expect(where.status).toBe("WAITING_APPROVAL");
    expect(claimQuotaMock).not.toHaveBeenCalled();
    expect(prismaMock.run.create).not.toHaveBeenCalled();
    expect(runQueueMock.add).not.toHaveBeenCalled();
    expect(prismaMock.pipeline.update).not.toHaveBeenCalled();
    expect(skipRows()).toEqual([
      expect.objectContaining({
        tenantId: "tenant-1",
        resourceId: "pipe-1",
        details: { pipelineId: "pipe-1", reason: "waiting_approval", slotMs: 1_060_000, waitingRunId: "run-waiting" },
      }),
    ]);
  });

  it("at-most-once: atlanan tick slotu TÜKETİR; aynı slot tekrar gelip bekleyen çözülmüş olsa da koşu açmaz", async () => {
    prismaMock.run.findFirst.mockResolvedValueOnce({ id: "run-waiting", status: "WAITING_APPROVAL" });
    await processScheduledTick(makeJob());
    expect(slotKeyCalls()).toHaveLength(1);
    prismaMock.run.findFirst.mockResolvedValue(null); // onay çözüldü
    await processScheduledTick(makeJob()); // aynı slot yeniden teslim
    expect(prismaMock.run.create).not.toHaveBeenCalled();
    expect(claimQuotaMock).not.toHaveBeenCalled();
  });

  it("skip logu saatlik dedup'lı: art arda iki tick tek satır yazar", async () => {
    prismaMock.run.findFirst.mockResolvedValue({ id: "run-waiting", status: "WAITING_APPROVAL" });
    await processScheduledTick(makeJob("pipe-1", 1_000_000));
    await processScheduledTick(makeJob("pipe-1", 1_060_000));
    expect(skipRows()).toHaveLength(1);
    const call = redisMock.set.mock.calls.find((c) => c[0] === "pipeline:tick-skip:pipe-1:waiting_approval")!;
    expect(call).toEqual(["pipeline:tick-skip:pipe-1:waiting_approval", "1", "EX", 3600, "NX"]);
  });

  it("bekleyen koşu yoksa / çözülünce sonraki tick koşu açar", async () => {
    prismaMock.run.findFirst.mockResolvedValueOnce({ id: "run-waiting", status: "WAITING_APPROVAL" }).mockResolvedValueOnce(null);
    await processScheduledTick(makeJob("pipe-1", 1_000_000));
    expect(prismaMock.run.create).not.toHaveBeenCalled();
    await processScheduledTick(makeJob("pipe-1", 5_000_000));
    expect(prismaMock.run.create).toHaveBeenCalledTimes(1);
    expect(claimQuotaMock).toHaveBeenCalledTimes(1);
  });

  it("başka pipeline/tenant etkilenmez: sorgu her tick'te kendi pipelineId+tenantId'siyle yapılır", async () => {
    prismaMock.run.findFirst.mockImplementation(async ({ where }: any) =>
      where.pipelineId === "pipe-1" && where.tenantId === "tenant-1" ? { id: "run-waiting", status: "WAITING_APPROVAL" } : null,
    );
    prismaMock.pipeline.findUnique
      .mockResolvedValueOnce(activePipeline)
      .mockResolvedValueOnce({ ...activePipeline, id: "pipe-2" })
      .mockResolvedValueOnce({ ...activePipeline, id: "pipe-3", company: { status: "ACTIVE", tenantId: "tenant-2" } });
    await processScheduledTick(makeJob("pipe-1"));
    await processScheduledTick(makeJob("pipe-2"));
    await processScheduledTick(makeJob("pipe-3"));
    expect(prismaMock.run.create).toHaveBeenCalledTimes(2);
    expect(
      prismaMock.run.findFirst.mock.calls
        .filter((c) => c[0].where.status === "WAITING_APPROVAL")
        .map((c) => [c[0].where.pipelineId, c[0].where.tenantId]),
    ).toEqual([
      ["pipe-1", "tenant-1"],
      ["pipe-2", "tenant-1"],
      ["pipe-3", "tenant-2"],
    ]);
  });

  it("sorgu hatası: fail-closed — koşu/kota yok, hata yayılır (tick yeniden denenmez)", async () => {
    prismaMock.run.findFirst.mockRejectedValue(new Error("db down"));
    await expect(processScheduledTick(makeJob())).rejects.toThrow("db down");
    expect(claimQuotaMock).not.toHaveBeenCalled();
    expect(prismaMock.run.create).not.toHaveBeenCalled();
  });
});

describe("processScheduledTick — PENDING/RUNNING overlap (BRA-P2-06)", () => {
  const skipRows = () =>
    prismaMock.activityLog.create.mock.calls
      .map((c) => c[0].data)
      .filter((d: any) => d.action === "pipeline.schedule.skip");
  const savedFlag = process.env.JOB_STATE_DUAL_WRITE;
  const DAY = 24 * 60 * 60_000;
  /** Status-aware fake: independent of query order. */
  const givenRuns = (waiting: any, active: any) =>
    prismaMock.run.findFirst.mockImplementation(async ({ where }: any) =>
      where.status === "WAITING_APPROVAL" ? waiting : active,
    );
  const overlapCall = () => prismaMock.run.findFirst.mock.calls.find((c) => c[0].where.status !== "WAITING_APPROVAL")!;

  beforeEach(() => {
    delete process.env.JOB_STATE_DUAL_WRITE;
    prismaMock.pipeline.findUnique.mockResolvedValue(activePipeline);
    claimQuotaMock.mockResolvedValue({ claimed: true, value: 1, limit: 100 });
    prismaMock.run.create.mockResolvedValue({ id: "run-new" });
  });
  afterAll(() => {
    if (savedFlag === undefined) delete process.env.JOB_STATE_DUAL_WRITE;
    else process.env.JOB_STATE_DUAL_WRITE = savedFlag;
  });

  it("PENDING varken: koşu/kota yok, reason overlap, slot tüketilir", async () => {
    givenRuns(null, { id: "run-p", status: "PENDING" });
    await processScheduledTick(makeJob());
    expect(prismaMock.run.create).not.toHaveBeenCalled();
    expect(claimQuotaMock).not.toHaveBeenCalled();
    expect(runQueueMock.add).not.toHaveBeenCalled();
    expect(slotKeyCalls()).toHaveLength(1);
    expect(skipRows()).toEqual([
      expect.objectContaining({
        tenantId: "tenant-1",
        details: { pipelineId: "pipe-1", reason: "overlap", slotMs: 1_060_000, activeRunId: "run-p", activeRunStatus: "PENDING" },
      }),
    ]);
  });

  it("RUNNING varken: koşu/kota yok, reason overlap", async () => {
    givenRuns(null, { id: "run-r", status: "RUNNING" });
    await processScheduledTick(makeJob());
    expect(prismaMock.run.create).not.toHaveBeenCalled();
    expect(claimQuotaMock).not.toHaveBeenCalled();
    expect(skipRows()[0].details.reason).toBe("overlap");
  });

  it("ikisi birden varken waiting_approval loglanır (sorgu sırasından bağımsız), overlap sorgusu çalışmaz", async () => {
    givenRuns({ id: "run-w" }, { id: "run-r", status: "RUNNING" });
    await processScheduledTick(makeJob());
    expect(skipRows().map((r: any) => r.details.reason)).toEqual(["waiting_approval"]);
    expect(prismaMock.run.findFirst).toHaveBeenCalledTimes(1);
    expect(redisMock.set.mock.calls.some((c) => c[0] === "pipeline:tick-skip:pipe-1:waiting_approval")).toBe(true);
    expect(redisMock.set.mock.calls.some((c) => c[0] === "pipeline:tick-skip:pipe-1:overlap")).toBe(false);
  });

  it("at-most-once: overlap skip slotu tüketir; aynı slot çözülünce yeniden gelse de koşu açmaz", async () => {
    givenRuns(null, { id: "run-r", status: "RUNNING" });
    await processScheduledTick(makeJob());
    givenRuns(null, null);
    await processScheduledTick(makeJob());
    expect(prismaMock.run.create).not.toHaveBeenCalled();
    expect(claimQuotaMock).not.toHaveBeenCalled();
  });

  it("sıra: slot claim → waiting guard → overlap guard → kota", async () => {
    const order: string[] = [];
    redisMock.set.mockImplementation(async (k: string) => {
      if (String(k).startsWith("pipeline:tick:")) order.push("slot");
      return "OK";
    });
    prismaMock.run.findFirst.mockImplementation(async ({ where }: any) => {
      order.push(where.status === "WAITING_APPROVAL" ? "waiting" : "overlap");
      return null;
    });
    claimQuotaMock.mockImplementation(async () => {
      order.push("quota");
      return { claimed: true, value: 1, limit: 100 };
    });
    await processScheduledTick(makeJob());
    expect(order).toEqual(["slot", "waiting", "overlap", "quota"]);
  });

  it("iki sorgu da tenantId + pipelineId kapsamlı", async () => {
    await processScheduledTick(makeJob());
    expect(prismaMock.run.findFirst).toHaveBeenCalledTimes(2);
    for (const c of prismaMock.run.findFirst.mock.calls)
      expect(c[0].where).toMatchObject({ pipelineId: "pipe-1", tenantId: "tenant-1" });
    expect(prismaMock.run.findFirst.mock.calls[0]![0].where).toEqual({
      pipelineId: "pipe-1",
      tenantId: "tenant-1",
      status: "WAITING_APPROVAL",
    });
  });

  it("bayrak KAPALI: PENDING/RUNNING + updatedAt ≥ now-24sa; heartbeatAt/state adlandırılmaz", async () => {
    const before = Date.now();
    await processScheduledTick(makeJob());
    const where = overlapCall()[0].where;
    expect(where.status).toEqual({ in: ["PENDING", "RUNNING"] });
    expect(JSON.stringify(where)).not.toContain("heartbeatAt");
    expect(JSON.stringify(where)).not.toContain("state");
    const cutoff = where.updatedAt.gte.getTime();
    expect(cutoff).toBeGreaterThanOrEqual(before - DAY);
    expect(cutoff).toBeLessThanOrEqual(Date.now() - DAY);
  });

  it("bayrak AÇIK: RUNNING heartbeatAt eşiği 15 dk, NULL ise updatedAt 24 sa; PENDING yalnız state null/READY", async () => {
    process.env.JOB_STATE_DUAL_WRITE = "true";
    const before = Date.now();
    await processScheduledTick(makeJob());
    const where = overlapCall()[0].where;
    const running = where.OR.find((a: any) => a.status === "RUNNING");
    const hb = running.OR[0].heartbeatAt.gte.getTime();
    expect(hb).toBeGreaterThanOrEqual(before - 15 * 60_000);
    expect(hb).toBeLessThanOrEqual(Date.now() - 15 * 60_000);
    expect(running.OR[1].heartbeatAt).toBeNull();
    const pending = where.OR.find((a: any) => a.status === "PENDING");
    expect(pending.OR).toEqual([{ state: null }, { state: "READY" }]);
    expect(pending.updatedAt.gte).toBeInstanceOf(Date);
  });

  it("DRAFT/PLANNED PENDING koşu kümeye girmez", async () => {
    process.env.JOB_STATE_DUAL_WRITE = "true";
    await processScheduledTick(makeJob());
    const pending = overlapCall()[0].where.OR.find((a: any) => a.status === "PENDING");
    const allowed = pending.OR.map((c: any) => c.state);
    expect(allowed).not.toContain("DRAFT");
    expect(allowed).not.toContain("PLANNED");
  });

  it("stale RUNNING / taslak (sorgu eşleşmez → null) varken yeni koşu açılır ve kota yenir", async () => {
    givenRuns(null, null);
    await processScheduledTick(makeJob());
    expect(claimQuotaMock).toHaveBeenCalledTimes(1);
    expect(prismaMock.run.create).toHaveBeenCalledTimes(1);
  });

  it("tazelik eşiği JOB_HEARTBEAT_STALE_MS ile birlikte hareket eder (tek kaynak)", async () => {
    process.env.JOB_STATE_DUAL_WRITE = "true";
    process.env.JOB_HEARTBEAT_STALE_MS = "60000";
    try {
      const before = Date.now();
      await processScheduledTick(makeJob());
      const hb = overlapCall()[0].where.OR.find((a: any) => a.status === "RUNNING").OR[0].heartbeatAt.gte.getTime();
      expect(hb).toBeGreaterThanOrEqual(before - 60_000);
      expect(hb).toBeLessThanOrEqual(Date.now() - 60_000);
    } finally {
      delete process.env.JOB_HEARTBEAT_STALE_MS;
    }
  });

  it("başka pipeline/tenant etkilenmez: yalnız pipe-1/tenant-1 için overlap", async () => {
    prismaMock.run.findFirst.mockImplementation(async ({ where }: any) =>
      where.status !== "WAITING_APPROVAL" && where.pipelineId === "pipe-1" && where.tenantId === "tenant-1"
        ? { id: "run-r", status: "RUNNING" }
        : null,
    );
    prismaMock.pipeline.findUnique
      .mockResolvedValueOnce(activePipeline)
      .mockResolvedValueOnce({ ...activePipeline, id: "pipe-2" })
      .mockResolvedValueOnce({ ...activePipeline, id: "pipe-1", company: { status: "ACTIVE", tenantId: "tenant-2" } });
    await processScheduledTick(makeJob("pipe-1"));
    await processScheduledTick(makeJob("pipe-2"));
    await processScheduledTick(makeJob("pipe-1", 7_000_000));
    expect(prismaMock.run.create).toHaveBeenCalledTimes(2);
  });

  it("her iki sorgunun hatası da fail-closed (koşu/kota yok, hata yayılır)", async () => {
    prismaMock.run.findFirst.mockRejectedValue(new Error("db down"));
    await expect(processScheduledTick(makeJob())).rejects.toThrow("db down");
    prismaMock.run.findFirst.mockImplementation(async ({ where }: any) => {
      if (where.status === "WAITING_APPROVAL") return null;
      throw new Error("db down 2");
    });
    await expect(processScheduledTick(makeJob("pipe-1", 8_000_000))).rejects.toThrow("db down 2");
    expect(claimQuotaMock).not.toHaveBeenCalled();
    expect(prismaMock.run.create).not.toHaveBeenCalled();
  });

  it("skip logu dedup anahtarı reason'lı: overlap ve waiting_approval ayrı saatlik anahtar; log şişmez", async () => {
    givenRuns(null, { id: "run-r", status: "RUNNING" });
    for (let i = 0; i < 5; i++) await processScheduledTick(makeJob("pipe-1", 1_000_000 + i * 60_000));
    expect(skipRows()).toHaveLength(1);
    const call = redisMock.set.mock.calls.find((c) => c[0] === "pipeline:tick-skip:pipe-1:overlap")!;
    expect(call).toEqual(["pipeline:tick-skip:pipe-1:overlap", "1", "EX", 3600, "NX"]);
    givenRuns({ id: "run-w" }, null);
    await processScheduledTick(makeJob("pipe-1", 9_000_000));
    expect(skipRows().map((r: any) => r.details.reason)).toEqual(["overlap", "waiting_approval"]);
  });

  it("paused/disabled pipeline: guard'a hiç girilmez (davranış değişmedi)", async () => {
    prismaMock.pipeline.findUnique.mockResolvedValue({ ...activePipeline, enabled: false });
    await processScheduledTick(makeJob());
    expect(prismaMock.run.findFirst).not.toHaveBeenCalled();
    expect(slotKeyCalls()).toHaveLength(0);
  });
});
