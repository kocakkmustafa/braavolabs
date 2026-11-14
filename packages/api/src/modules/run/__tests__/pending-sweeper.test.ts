/**
 * BRA-P0-03e — PENDING koşu süpürücüsü: enqueue öncesi süreç ölümünde kuyruksuz kalan PENDING koşu
 * yeniden kuyruğa alınır (≤24 sa) ya da FAILED yapılır (>24 sa); zaten kuyruktaki koşuya dokunulmaz;
 * ikinci süpürme etkisiz; başka kiracının koşusu görünmez; bayrak kapalıyken `state` adlandırılmaz.
 * NOT covered: gerçek Redis/BullMQ (sentetik kuyruk), gerçek veritabanı (sentetik run deposu), zamanlayıcı saati;
 * `releaseQuota` (gerçek sayaç/ay sınırı; hatayı yutar, süpürücü iade başarısızlığını bilmez), `tryWriteReceipt`
 * (gerçek makbuz yazımı) ve `enqueueRun` (gerçek BullMQ ekleme) mock'tur.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type RunRow = { id: string; tenantId: string; status: string; state: string | null; createdAt: Date };
type QJob = { id: string; data: { runId: string; tenantId: string }; state: string; remove: ReturnType<typeof vi.fn> };

const h = vi.hoisted(() => ({ runs: [] as any[], jobs: [] as any[], seq: 0 }));

const prismaMock = vi.hoisted(() => ({
  run: { findMany: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() },
  activityLog: { create: vi.fn() },
}));
const enqueueRunMock = vi.hoisted(() => vi.fn());
const queueMock = vi.hoisted(() => ({ getJobs: vi.fn(), getJob: vi.fn() }));
const releaseQuotaMock = vi.hoisted(() => vi.fn());
const receiptMock = vi.hoisted(() => vi.fn());

vi.mock("../../../lib/db", () => ({ prisma: prismaMock }));
vi.mock("../../../lib/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../../../lib/queue", () => ({ runQueue: queueMock }));
vi.mock("../../../lib/tenant-context", () => ({ runWithoutTenant: (_n: string, fn: () => unknown) => fn() }));
vi.mock("../../billing/metering", () => ({ releaseQuota: (...a: unknown[]) => releaseQuotaMock(...a) }));
vi.mock("../transition", async (orig) => ({
  ...(await orig<typeof import("../transition")>()),
  tryWriteReceipt: (...a: unknown[]) => receiptMock(...a),
}));
vi.mock("../../pipeline/runner", () => ({ enqueueRun: (...a: unknown[]) => enqueueRunMock(...a) }));

import {
  PENDING_GRACE_MS,
  PENDING_MAX_AGE_MS,
  PENDING_SWEEP_BATCH,
  sweepJobId,
  sweepPendingRuns,
  runPendingSweep,
  initPendingSweeper,
  stopPendingSweeper,
} from "../pending-sweeper";

const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);
const MIN = 60_000;

const addRun = (r: Partial<RunRow> & { id: string }): RunRow => {
  const row: RunRow = { tenantId: "tenant-1", status: "PENDING", state: null, createdAt: new Date(NOW - 30 * MIN), ...r };
  h.runs.push(row);
  return row;
};
const addJob = (runId: string, state = "waiting", id?: string): QJob => {
  const job: QJob = { id: id ?? String(++h.seq), data: { runId, tenantId: "tenant-1" }, state, remove: vi.fn() };
  h.jobs.push(job);
  return job;
};
const sweep = (extra: Record<string, unknown> = {}) => sweepPendingRuns({ now: NOW, dualWrite: false, ...extra });
const findManyWhere = () => prismaMock.run.findMany.mock.calls.at(-1)![0].where;

beforeEach(() => {
  vi.clearAllMocks();
  h.runs = [];
  h.jobs = [];
  h.seq = 0;

  prismaMock.run.findMany.mockImplementation(async ({ where, take }: any) => {
    const tenant = where.pipeline?.company?.tenantId;
    const dualOr = where.OR as Array<{ state: string | null }> | undefined;
    return h.runs
      .filter((r: RunRow) => r.status === where.status && r.createdAt < where.createdAt.lt)
      .filter((r: RunRow) => (tenant ? r.tenantId === tenant : true))
      .filter((r: RunRow) => (dualOr ? dualOr.some((c) => c.state === r.state) : true))
      .sort((a: RunRow, b: RunRow) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, take)
      .map((r: RunRow) => ({ id: r.id, createdAt: r.createdAt, pipeline: { company: { tenantId: r.tenantId } } }));
  });
  // transitionRun okuması (kiracı kapsamlı) + CAS yazımı
  prismaMock.run.findFirst.mockImplementation(async ({ where }: any) => {
    const t = where.pipeline.company.tenantId;
    const r = h.runs.find((x: RunRow) => x.id === where.id && x.tenantId === t);
    return r ? { status: r.status, state: r.state } : null;
  });
  prismaMock.run.updateMany.mockImplementation(async ({ where, data }: any) => {
    const r = h.runs.find(
      (x: RunRow) => x.id === where.id && x.status === where.status && (where.state === undefined ? true : x.state === where.state),
    );
    if (!r) return { count: 0 };
    Object.assign(r, data);
    return { count: 1 };
  });
  prismaMock.activityLog.create.mockResolvedValue({});
  releaseQuotaMock.mockResolvedValue(undefined);
  receiptMock.mockResolvedValue(undefined);

  queueMock.getJobs.mockImplementation(async () => h.jobs.filter((j: QJob) => ["waiting", "active", "delayed", "prioritized"].includes(j.state)));
  queueMock.getJob.mockImplementation(async (id: string) => {
    const j = h.jobs.find((x: QJob) => x.id === id);
    return j ? { ...j, getState: async () => j.state, remove: async () => { j.remove(); h.jobs = h.jobs.filter((x: QJob) => x !== j); } } : null;
  });
  // BullMQ davranışı: aynı jobId ikinci kez eklenirse mevcut iş döner (yinelenen iş yok).
  enqueueRunMock.mockImplementation(async (runId: string, opts: { jobId?: string } = {}) => {
    const existing = opts.jobId ? h.jobs.find((j: QJob) => j.id === opts.jobId) : undefined;
    if (existing) return existing.id;
    const job = addJob(runId, "waiting", opts.jobId);
    return job.id;
  });
});

describe("PENDING süpürücü — ölü PENDING koşu yeniden kuyruğa alınır (BRA-P0-03e)", () => {
  it("(1) ölü PENDING (kuyrukta iş yok, 30 dk) → sabit jobId ile yeniden kuyruğa alınır + denetim satırı", async () => {
    addRun({ id: "run-dead" });
    const res = await sweep();
    expect(res).toMatchObject({ scanned: 1, requeued: 1, failed: 0, skippedQueued: 0, errors: 0 });
    expect(enqueueRunMock).toHaveBeenCalledTimes(1);
    expect(enqueueRunMock).toHaveBeenCalledWith("run-dead", { jobId: sweepJobId("run-dead") });
    expect(prismaMock.activityLog.create.mock.calls[0][0].data).toMatchObject({
      tenantId: "tenant-1", actor: "system", action: "run.pending_requeued", resourceId: "run-dead",
    });
  });

  it("(2) zaten kuyruktaki koşuya dokunulmaz (waiting / active / delayed iş, otomatik id)", async () => {
    for (const state of ["waiting", "active", "delayed"]) {
      h.jobs = [];
      enqueueRunMock.mockClear();
      h.runs = [];
      addRun({ id: "run-queued" });
      addJob("run-queued", state, "42"); // orijinal enqueue: otomatik (sayısal) id
      const res = await sweep();
      expect(res).toMatchObject({ scanned: 1, requeued: 0, skippedQueued: 1 });
      expect(enqueueRunMock).not.toHaveBeenCalled();
    }
  });

  it("(3) ikinci süpürme etkisiz: tek iş, tek denetim satırı", async () => {
    addRun({ id: "run-dead" });
    const first = await sweep();
    const second = await sweep();
    expect(first.requeued).toBe(1);
    expect(second).toMatchObject({ requeued: 0, skippedQueued: 1 });
    expect(enqueueRunMock).toHaveBeenCalledTimes(1);
    expect(h.jobs.filter((j: QJob) => j.data.runId === "run-dead")).toHaveLength(1);
    expect(prismaMock.activityLog.create).toHaveBeenCalledTimes(1);
  });

  it("(3b) iki süreç yarışı: kuyruk taraması boş dönse bile aynı jobId ikinci iş yaratmaz (BullMQ dedupe)", async () => {
    addRun({ id: "run-dead" });
    queueMock.getJobs.mockResolvedValue([]); // iki süreç de "canlı iş yok" gördü
    await sweep();
    await sweep();
    expect(enqueueRunMock).toHaveBeenCalledTimes(2);
    expect(h.jobs.filter((j: QJob) => j.data.runId === "run-dead")).toHaveLength(1);
  });

  it("(3c) süpürücünün önceki BİTMİŞ işi (koşu hâlâ PENDING) kaldırılıp yeniden eklenir", async () => {
    addRun({ id: "run-dead" });
    const finished = addJob("run-dead", "failed", sweepJobId("run-dead"));
    const res = await sweep();
    expect(finished.remove).toHaveBeenCalledTimes(1);
    expect(res.requeued).toBe(1);
    expect(h.jobs.some((j: QJob) => j.id === sweepJobId("run-dead") && j.state === "waiting")).toBe(true);
  });

  it("(4) başka kiracının koşusu görünmez: kiracı verilince yalnız kendi koşusu; sorgu pipeline→company→tenantId kapsamlı", async () => {
    addRun({ id: "run-mine", tenantId: "tenant-1" });
    addRun({ id: "run-other", tenantId: "tenant-OTHER" });
    const res = await sweep({ tenantId: "tenant-1" });
    expect(findManyWhere().pipeline).toEqual({ company: { tenantId: "tenant-1" } });
    expect(res).toMatchObject({ scanned: 1, requeued: 1 });
    expect(enqueueRunMock).toHaveBeenCalledTimes(1);
    expect(enqueueRunMock).toHaveBeenCalledWith("run-mine", expect.anything());
    expect(prismaMock.activityLog.create.mock.calls.every((c) => (c[0] as any).data.tenantId === "tenant-1")).toBe(true);
  });

  it("(4b) kiracısız cron: her kiracının koşusu KENDİ kiracısıyla işlenir (denetim satırı koşunun kiracısına yazılır)", async () => {
    addRun({ id: "run-a", tenantId: "tenant-1" });
    addRun({ id: "run-b", tenantId: "tenant-2" });
    const res = await runPendingSweep({ now: NOW, dualWrite: false });
    expect(res.requeued).toBe(2);
    const byRun = Object.fromEntries(prismaMock.activityLog.create.mock.calls.map((c) => [(c[0] as any).data.resourceId, (c[0] as any).data.tenantId]));
    expect(byRun).toEqual({ "run-a": "tenant-1", "run-b": "tenant-2" });
  });

  it("bekleme payı: 10 dk'dan genç PENDING'e dokunulmaz (normal yaratım→kuyruk penceresi)", async () => {
    addRun({ id: "run-fresh", createdAt: new Date(NOW - PENDING_GRACE_MS + MIN) });
    const res = await sweep();
    expect(res).toMatchObject({ scanned: 0, requeued: 0 });
    expect(enqueueRunMock).not.toHaveBeenCalled();
  });

  it("PENDING dışı koşular (RUNNING/FAILED/WAITING_APPROVAL…) aday değildir", async () => {
    addRun({ id: "r1", status: "RUNNING" });
    addRun({ id: "r2", status: "FAILED" });
    addRun({ id: "r3", status: "WAITING_APPROVAL" });
    const res = await sweep();
    expect(res.scanned).toBe(0);
    expect(findManyWhere().status).toBe("PENDING");
  });

  it("(5) 24 saatten eski PENDING yeniden başlatılmaz: FAILED(pending_orphaned) + denetim satırı", async () => {
    addRun({ id: "run-old", createdAt: new Date(NOW - PENDING_MAX_AGE_MS - MIN) });
    const res = await sweep();
    expect(res).toMatchObject({ scanned: 1, failed: 1, requeued: 0 });
    expect(enqueueRunMock).not.toHaveBeenCalled();
    expect(h.runs[0]).toMatchObject({ status: "FAILED", error: "pending_orphaned" });
    expect(prismaMock.activityLog.create.mock.calls[0][0].data).toMatchObject({ action: "run.pending_orphaned", resourceId: "run-old" });
  });

  it("(5b) taze okuma: arada başlayan (RUNNING) koşu FAILED yapılmaz (bayrak kapalı: CAS yok, `status=PENDING` kapısı)", async () => {
    addRun({ id: "run-old", createdAt: new Date(NOW - PENDING_MAX_AGE_MS - MIN) });
    // aday listelendikten sonra işçi koşuyu aldı
    prismaMock.run.findFirst.mockImplementationOnce(async () => {
      h.runs[0].status = "RUNNING";
      return { status: "RUNNING", state: null };
    });
    const res = await sweep();
    expect(res.failed).toBe(0);
    expect(h.runs[0].status).toBe("RUNNING");
    expect(prismaMock.activityLog.create).not.toHaveBeenCalled();
  });

  it("(5b2) bayrak KAPALI: taze okuma select'i ve FAILED updateMany where/data `state` adlandırmaz", async () => {
    addRun({ id: "run-old", createdAt: new Date(NOW - PENDING_MAX_AGE_MS - MIN) });
    await sweep({ dualWrite: false });
    const sel = prismaMock.run.findFirst.mock.calls[0][0].select;
    expect(sel).toEqual({ status: true });
    const um = prismaMock.run.updateMany.mock.calls[0][0] as any;
    expect(um.where).toEqual({ id: "run-old", status: "PENDING" });
    expect(Object.keys(um.data)).not.toContain("state");
    expect(receiptMock).not.toHaveBeenCalled();
  });

  it("(5b3) bayrak AÇIK: taze okuma `state`i seçer ve CAS `state`e bağlıdır", async () => {
    addRun({ id: "run-old", state: "READY", createdAt: new Date(NOW - PENDING_MAX_AGE_MS - MIN) });
    await sweep({ dualWrite: true });
    expect(prismaMock.run.findFirst.mock.calls[0][0].select).toEqual({ status: true, state: true });
    expect((prismaMock.run.updateMany.mock.calls[0][0] as any).where).toEqual({ id: "run-old", status: "PENDING", state: "READY" });
  });

  it("(5c) CAS kaybı: okuma ile yazma arasında durum değişirse (updateMany count 0) FAILED sayılmaz, denetim satırı yok", async () => {
    addRun({ id: "run-old", createdAt: new Date(NOW - PENDING_MAX_AGE_MS - MIN) });
    prismaMock.run.updateMany.mockResolvedValueOnce({ count: 0 });
    const res = await sweep();
    expect(res).toMatchObject({ failed: 0, skippedChanged: 1, errors: 0 });
    expect(prismaMock.activityLog.create).not.toHaveBeenCalled();
  });

  it("(Q1) >24 sa FAILED + aynı UTC ay: kota iadesi (kiracı, 'runs') bir kez", async () => {
    addRun({ id: "run-old", createdAt: new Date(NOW - PENDING_MAX_AGE_MS - MIN) }); // NOW 10 Kas → 8-9 Kas, aynı ay
    await sweep();
    expect(releaseQuotaMock).toHaveBeenCalledTimes(1);
    expect(releaseQuotaMock).toHaveBeenCalledWith("tenant-1", "runs");
  });

  it("(Q2) ay dönümü: önceki ayda yaratılmış koşu için iade YOK (releaseQuota geçerli ayı düşer)", async () => {
    addRun({ id: "run-old", createdAt: new Date(Date.UTC(2026, 9, 31, 22, 0, 0)) });
    const res = await sweep();
    expect(res.failed).toBe(1);
    expect(releaseQuotaMock).not.toHaveBeenCalled();
  });

  it("(Q3) CAS kaybı / yeniden kuyruğa alma: iade YOK", async () => {
    addRun({ id: "run-lost", createdAt: new Date(NOW - PENDING_MAX_AGE_MS - MIN) });
    prismaMock.run.updateMany.mockResolvedValueOnce({ count: 0 });
    addRun({ id: "run-dead" });
    await sweep();
    expect(releaseQuotaMock).not.toHaveBeenCalled();
  });

  it("(R1) bayrak AÇIK + >24 sa FAILED: makbuz yazılır (FAILED, koşunun kiracısı)", async () => {
    addRun({ id: "run-old", createdAt: new Date(NOW - PENDING_MAX_AGE_MS - MIN) });
    await sweep({ dualWrite: true });
    expect(receiptMock).toHaveBeenCalledTimes(1);
    expect(receiptMock.mock.calls[0].slice(1)).toEqual(["run-old", "FAILED", "tenant-1"]);
  });

  it("(R2) CAS kaybında makbuz yazılmaz", async () => {
    addRun({ id: "run-old", createdAt: new Date(NOW - PENDING_MAX_AGE_MS - MIN) });
    prismaMock.run.updateMany.mockResolvedValueOnce({ count: 0 });
    await sweep({ dualWrite: true });
    expect(receiptMock).not.toHaveBeenCalled();
  });

  it("(A1) FAILED CAS sonrası activityLog.create hatası: koşu FAILED kalır, failed sayılır, errors artmaz, iade yapılır", async () => {
    addRun({ id: "run-old", createdAt: new Date(NOW - PENDING_MAX_AGE_MS - MIN) });
    prismaMock.activityLog.create.mockRejectedValueOnce(new Error("db hiccup"));
    const res = await sweep();
    expect(res).toMatchObject({ failed: 1, errors: 0 });
    expect(h.runs[0].status).toBe("FAILED");
    expect(releaseQuotaMock).toHaveBeenCalledTimes(1);
  });

  it("(A2) yeniden kuyruğa alma sonrası activityLog hatası: iş kuyrukta, requeued sayılır, errors artmaz", async () => {
    addRun({ id: "run-dead" });
    prismaMock.activityLog.create.mockRejectedValueOnce(new Error("db hiccup"));
    const res = await sweep();
    expect(res).toMatchObject({ requeued: 1, errors: 0 });
    expect(h.jobs).toHaveLength(1);
  });

  it("(E1) bayrak AÇIK + >24 sa: READY→FAILED grafik kenarı olmadan da kapanır (state null ve READY), state FAILED yazılır; parti aç kalmaz", async () => {
    const old = new Date(NOW - PENDING_MAX_AGE_MS - MIN);
    addRun({ id: "run-null", state: null, createdAt: old });
    addRun({ id: "run-ready", state: "READY", createdAt: old });
    const res = await sweep({ dualWrite: true });
    expect(res).toMatchObject({ scanned: 2, failed: 2, errors: 0 });
    for (const r of h.runs) expect(r).toMatchObject({ status: "FAILED", state: "FAILED", error: "pending_orphaned" });
    // CAS state'e de bağlı (null ya da READY okunan değer)
    const wheres = prismaMock.run.updateMany.mock.calls.map((c) => (c[0] as any).where);
    expect(wheres).toEqual(
      expect.arrayContaining([
        { id: "run-null", status: "PENDING", state: null },
        { id: "run-ready", status: "PENDING", state: "READY" },
      ]),
    );
    // Kapanan koşular sonraki süpürmede aday değil → parti başka koşulara kalır
    expect((await sweep({ dualWrite: true })).scanned).toBe(0);
  });

  it("(D2) bayat aday: listelendikten sonra işçi koşuyu aldı/bitirdi → yeniden kuyruğa ALINMAZ (taze okuma)", async () => {
    addRun({ id: "run-raced" });
    prismaMock.run.findFirst.mockImplementationOnce(async () => {
      h.runs[0].status = "COMPLETED"; // işçi saniyeler içinde bitirdi
      return { status: "COMPLETED", state: null };
    });
    const res = await sweep();
    expect(res).toMatchObject({ requeued: 0, skippedChanged: 1 });
    expect(enqueueRunMock).not.toHaveBeenCalled();
  });

  it("kuyruk taraması sweep başına BİR kez (50 aday × getJobs değil)", async () => {
    for (let i = 0; i < 5; i++) addRun({ id: `run-${i}`, createdAt: new Date(NOW - (40 + i) * MIN) });
    await sweep();
    expect(queueMock.getJobs).toHaveBeenCalledTimes(1);
    expect(enqueueRunMock).toHaveBeenCalledTimes(5);
  });

  it("tarama doldu (≥5000 canlı iş): canlı iş yokluğu kanıtlanamaz → yeniden kuyruğa alınmaz, skippedUnverified", async () => {
    addRun({ id: "run-dead" });
    queueMock.getJobs.mockResolvedValue(Array.from({ length: 5000 }, (_, i) => ({ id: String(i), data: { runId: `other-${i}`, tenantId: "t" } })));
    const res = await sweep();
    expect(res).toMatchObject({ requeued: 0, skippedUnverified: 1 });
    expect(enqueueRunMock).not.toHaveBeenCalled();
  });

  it("(6) bayrak KAPALI: sorgu `state` kolonunu adlandırmaz (migration öncesi şema güvenli)", async () => {
    addRun({ id: "run-dead" });
    await sweep({ dualWrite: false });
    expect(JSON.stringify(findManyWhere())).not.toContain("state");
  });

  it("(6b) bayrak AÇIK: yalnız state null/READY; DRAFT/PLANNED PENDING'ler başlatılmaz", async () => {
    addRun({ id: "run-ready", state: "READY" });
    addRun({ id: "run-null", state: null });
    addRun({ id: "run-draft", state: "DRAFT" });
    addRun({ id: "run-planned", state: "PLANNED" });
    const res = await sweep({ dualWrite: true });
    expect(res.scanned).toBe(2);
    expect(enqueueRunMock.mock.calls.map((c) => c[0]).sort()).toEqual(["run-null", "run-ready"]);
  });

  it("(7) bir koşunun hatası diğerlerini durdurmaz (errors sayılır)", async () => {
    addRun({ id: "run-1", createdAt: new Date(NOW - 40 * MIN) });
    addRun({ id: "run-2", createdAt: new Date(NOW - 30 * MIN) });
    enqueueRunMock.mockRejectedValueOnce(new Error("redis down"));
    const res = await sweep();
    expect(res).toMatchObject({ scanned: 2, requeued: 1, errors: 1 });
    expect(enqueueRunMock).toHaveBeenCalledTimes(2);
  });

  it("toplu sınır: tek süpürmede en çok PENDING_SWEEP_BATCH aday, en eskiden başlar", async () => {
    for (let i = 0; i < PENDING_SWEEP_BATCH + 5; i++) addRun({ id: `run-${i}`, createdAt: new Date(NOW - (60 + i) * MIN) });
    const res = await sweep();
    expect(res.scanned).toBe(PENDING_SWEEP_BATCH);
    expect(prismaMock.run.findMany.mock.calls[0][0]).toMatchObject({ take: PENDING_SWEEP_BATCH, orderBy: { createdAt: "asc" } });
  });

  it("zamanlayıcı: init tek kez kurulur, stop temizler", () => {
    vi.useFakeTimers();
    try {
      initPendingSweeper();
      initPendingSweeper(); // ikinci çağrı ikinci zamanlayıcı kurmaz
      expect(vi.getTimerCount()).toBe(1);
      stopPendingSweeper();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
