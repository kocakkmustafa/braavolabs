/**
 * BRA-P0-04j — hiyerarşik koşuda retry: aynı koşunun önceki denemesinde COMPLETED olan delegasyonlar
 * atlanır (çıktı yeniden kullanılır), maliyet onlardan tohumlanır, retry idempotent, başka koşu/kiracı
 * satırı asla kullanılmaz, kapı-gated pipeline fail-closed kalır.
 * NOT covered: gerçek LLM, gerçek veritabanı (sentetik runStep deposu), BullMQ.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runAgentLoopMock = vi.hoisted(() => vi.fn());
vi.mock("../../agent/claude", () => ({ runAgentLoop: (...a: unknown[]) => runAgentLoopMock(...a) }));
vi.mock("../../../lib/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../../../services/push", () => ({ notifyTenantUsers: vi.fn().mockResolvedValue(undefined) }));

type Row = {
  id: string; runId: string; tenantId: string; stepIndex: number; name: string; status: string;
  agentId: string | null; input: unknown; output: unknown; costUsd: number | null;
};
const store = vi.hoisted(() => ({ rows: [] as any[], seq: 0, runCost: null as number | null }));

const prismaMock = vi.hoisted(() => ({
  agent: { findUnique: vi.fn() },
  run: { update: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() },
  runStep: { create: vi.fn(), update: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
  activityLog: { create: vi.fn() },
}));
vi.mock("../../../lib/db", () => ({ prisma: prismaMock }));

vi.mock("../hierarchical", () => ({
  buildManagerContext: () => "team context",
  loadWorkers: async () => [],
  recordManagerDispatch: async () => {},
  resolveWorker: async (id: string) => ({ id, name: id, systemPrompt: "w", tools: [], model: "m", companyId: "co-1" }),
  trackDelegation: () => {},
  clearDelegationCounter: () => {},
}));

import { processHierarchicalRun } from "../hierarchical-runner";
import { planDelegationResume, startingCost } from "../hierarchical-resume";
import { getTool } from "../../agent/registry";

const pipeline = (extra: Record<string, unknown> = {}) =>
  ({ id: "p-1", companyId: "co-1", managerAgentId: "mgr-1", maxDelegationDepth: 3, steps: [], ...extra }) as never;

const loop = (cost: number, content = "done") => ({
  finalContent: content, turns: [], totalInputTokens: 1, totalOutputTokens: 1, totalCostUsd: cost, totalToolCalls: 0,
});

const seedRow = (r: Partial<Row> & { stepIndex: number; status: string }) => {
  const row: Row = {
    id: `old-${++store.seq}`, runId: "run-1", tenantId: "tenant-1", name: "delegate:w",
    agentId: "w-a", input: { agentId: "w-a", task: "A" }, output: { text: "out-A", turns: 1, toolCalls: 2 },
    costUsd: 0.4, ...r,
  };
  store.rows.push(row);
  return row;
};

/** Yönetici, sırayla verilen delegasyonları ister; sonuçları döndürür. Worker maliyeti: workerCost. */
async function runManager(delegations: Array<{ agentId: string; task: string }>, opts: { workerCost?: number; managerCost?: number; runId?: string } = {}) {
  const results: any[] = [];
  runAgentLoopMock.mockImplementation(async (cfg: { toolNames: string[] }) => {
    if (cfg.toolNames.includes("delegate")) {
      const delegate = getTool("delegate")!;
      for (const d of delegations) results.push(await delegate.handler(d));
      return loop(opts.managerCost ?? 0.1, "final");
    }
    return loop(opts.workerCost ?? 0.3, "worker-out");
  });
  await processHierarchicalRun({ runId: opts.runId ?? "run-1", tenantId: "tenant-1", pipeline: pipeline(), input: "go" });
  return results;
}

const workerLoops = () => runAgentLoopMock.mock.calls.filter((c) => !(c[0] as any).toolNames.includes("delegate")).length;
const lastRunUpdate = () => prismaMock.run.updateMany.mock.calls.at(-1)![0].data;

beforeEach(() => {
  vi.clearAllMocks();
  store.rows = [];
  store.seq = 0;
  store.runCost = null;
  prismaMock.agent.findUnique.mockResolvedValue({ id: "mgr-1", companyId: "co-1", systemPrompt: "m", tools: [], model: "x" });
  prismaMock.run.update.mockResolvedValue({});
  // `select: { costUsd }` (retry maliyet tabanı, kiracı kapsamlı) ayrı; diğer okumalar eski gibi.
  prismaMock.run.findFirst.mockImplementation(async (args: any) =>
    args?.select?.costUsd ? { costUsd: store.runCost } : { status: "RUNNING", state: null },
  );
  prismaMock.run.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.run.findUnique.mockResolvedValue({
    id: "run-1", jobBudget: null, tenantId: null, workspaceId: null, retryCount: 1, startedAt: null, steps: [],
    pipeline: { company: { id: "co-1", tenantId: "tenant-1" } },
  });
  prismaMock.activityLog.create.mockResolvedValue({});
  prismaMock.runStep.findMany.mockImplementation(async ({ where }: any) =>
    store.rows.filter(
      (r) =>
        r.runId === where.runId &&
        r.tenantId === where.run.pipeline.company.tenantId &&
        r.stepIndex > where.stepIndex.gt &&
        r.name.startsWith(where.name.startsWith),
    ),
  );
  prismaMock.runStep.create.mockImplementation(async ({ data }: any) => {
    const row = { id: `new-${++store.seq}`, tenantId: "tenant-1", costUsd: null, output: null, ...data };
    store.rows.push(row);
    return { id: row.id };
  });
  prismaMock.runStep.update.mockImplementation(async ({ where, data }: any) => {
    Object.assign(store.rows.find((r) => r.id === where.id)!, data);
    return {};
  });
  prismaMock.runStep.findFirst.mockResolvedValue({ id: "should-not-be-used" });
});
afterEach(() => vi.unstubAllEnvs());

describe("hiyerarşik retry — COMPLETED delegasyon atla + maliyet tohumla (BRA-P0-04j)", () => {
  it("(a) 2 delegasyon: biri COMPLETED biri FAILED → yalnız FAILED olan çalışır, COMPLETED çıktısı kullanılır", async () => {
    seedRow({ stepIndex: 1, status: "COMPLETED" });
    seedRow({ stepIndex: 2, status: "FAILED", agentId: "w-b", input: { agentId: "w-b", task: "B" }, output: null, costUsd: 0.2 });
    const res = await runManager([{ agentId: "w-a", task: "A" }, { agentId: "w-b", task: "B" }]);
    expect(workerLoops()).toBe(1);
    expect(res[0]).toMatchObject({ output: "out-A", toolCalls: 2, costUsd: 0, reused: true });
    expect(res[1]).toMatchObject({ output: "worker-out" });
    // Yeni satır yalnız çalıştırılan delegasyon için, önceki satırların stepIndex'inden sonra (çakışma yok).
    expect(prismaMock.runStep.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.runStep.create.mock.calls[0][0].data.stepIndex).toBe(3);
    expect(lastRunUpdate()).toMatchObject({ status: "COMPLETED" });
  });

  it("(b) maliyet: tohum (önceki COMPLETED) + yeni; atlanan delegasyon çift sayılmaz, FAILED önceki maliyet atlamaya girmez ama taban olur", async () => {
    seedRow({ stepIndex: 1, status: "COMPLETED", costUsd: 0.4 });
    seedRow({ stepIndex: 2, status: "FAILED", agentId: "w-b", input: { agentId: "w-b", task: "B" }, output: null, costUsd: 0.9 });
    await runManager([{ agentId: "w-a", task: "A" }, { agentId: "w-b", task: "B" }], { workerCost: 0.3, managerCost: 0.1 });
    // taban = tüm delegasyon satırları 0.4 + 0.9 = 1.3; + 0 (atlanan) + 0.3 (yeni worker) + 0.1 (yönetici) = 1.7
    expect(lastRunUpdate().costUsd).toBeCloseTo(1.7, 10);
  });

  it("(k) çökme: run.costUsd 0, FAILED worker 0.4 + COMPLETED 0.3 → taban 0.7; hiçbir yazım 0.7'nin altına düşmez", async () => {
    store.runCost = 0;
    seedRow({ stepIndex: 1, status: "COMPLETED", costUsd: 0.3 });
    seedRow({ stepIndex: 2, status: "FAILED", agentId: "w-b", input: { agentId: "w-b", task: "B" }, output: null, costUsd: 0.4 });
    await runManager([{ agentId: "w-a", task: "A" }, { agentId: "w-b", task: "B" }], { workerCost: 0.3, managerCost: 0.1 });
    expect(workerLoops()).toBe(1); // yalnız FAILED olan yeniden çalışır; COMPLETED atlanır
    expect(lastRunUpdate().costUsd).toBeCloseTo(1.1, 10); // 0.7 + 0.3 + 0.1
    expect(writtenCosts().length).toBeGreaterThan(0);
    expect(Math.min(...writtenCosts())).toBeGreaterThanOrEqual(0.7);
  });

  it("(k2) çökme sonrası maxUsd sıfırlanmaz: run.costUsd 0 ama satırlar 0.7 > maxUsd 0.5 → yeni delegasyon reddedilir", async () => {
    store.runCost = 0;
    seedRow({ stepIndex: 1, status: "COMPLETED", costUsd: 0.3 });
    seedRow({ stepIndex: 2, status: "FAILED", agentId: "w-b", input: { agentId: "w-b", task: "B" }, output: null, costUsd: 0.4 });
    prismaMock.run.findUnique.mockResolvedValue({
      id: "run-1", jobBudget: { maxUsd: 0.5 }, tenantId: null, workspaceId: null, retryCount: 1, startedAt: null, steps: [],
      pipeline: { company: { id: "co-1", tenantId: "tenant-1" } },
    });
    const res = await runManager([{ agentId: "w-b", task: "B" }]);
    expect(workerLoops()).toBe(0);
    expect(res[0]).toMatchObject({ error: expect.stringMatching(/^Delegation refused/) });
    expect(writtenCosts().length).toBeGreaterThan(0);
    expect(Math.min(...writtenCosts())).toBeGreaterThanOrEqual(0.7);
  });

  it("(b2) bütçe kontrolü tohumlu toplamı kullanır: önceki harcama maxUsd'yi doldurduysa yeni delegasyon reddedilir", async () => {
    seedRow({ stepIndex: 1, status: "COMPLETED", costUsd: 0.6 });
    prismaMock.run.findUnique.mockResolvedValue({
      id: "run-1", jobBudget: { maxUsd: 0.5 }, tenantId: null, workspaceId: null, retryCount: 1, startedAt: null, steps: [],
      pipeline: { company: { id: "co-1", tenantId: "tenant-1" } },
    });
    const res = await runManager([{ agentId: "w-b", task: "B" }]);
    expect(workerLoops()).toBe(0);
    expect(res[0]).toMatchObject({ error: expect.stringMatching(/^Delegation refused/) });
    expect(lastRunUpdate()).toMatchObject({ status: "FAILED" });
  });

  it("(c) retry iki kez → idempotent: ikinci denemede hepsi atlanır, çift iş/çift maliyet yok", async () => {
    seedRow({ stepIndex: 1, status: "COMPLETED", costUsd: 0.4 });
    seedRow({ stepIndex: 2, status: "FAILED", agentId: "w-b", input: { agentId: "w-b", task: "B" }, output: null, costUsd: 0 });
    const dels = [{ agentId: "w-a", task: "A" }, { agentId: "w-b", task: "B" }];
    await runManager(dels, { workerCost: 0.3, managerCost: 0.1 });
    expect(workerLoops()).toBe(1);
    const cost1 = lastRunUpdate().costUsd; // 0.4 + 0.3 + 0.1
    expect(cost1).toBeCloseTo(0.8, 10);
    store.runCost = cost1; // updateMany mock kalıcı yazmaz: gerçek akıştaki run.costUsd kalıcılığını simüle et
    runAgentLoopMock.mockReset();
    const res2 = await runManager(dels, { workerCost: 0.3, managerCost: 0.1 });
    expect(workerLoops()).toBe(0); // A önceki, B birinci retry'da COMPLETED → ikisi de atlandı
    expect(res2.every((r) => r.reused === true)).toBe(true);
    // taban max(run.costUsd 0.8, satırlar 0.7) = 0.8 + atlananlar 0 + yönetici tekrar harcar 0.1 = 0.9; satır sayısı artmadı
    expect(lastRunUpdate().costUsd).toBeCloseTo(0.9, 10);
    expect(store.rows.filter((r) => r.name.startsWith("delegate:") && r.status === "COMPLETED")).toHaveLength(2);
  });

  it("aynı (worker,task) iki kez istenirse tek COMPLETED satır yalnız bir kez tüketilir", async () => {
    seedRow({ stepIndex: 1, status: "COMPLETED" });
    const res = await runManager([{ agentId: "w-a", task: "A" }, { agentId: "w-a", task: "A" }]);
    expect(res[0].reused).toBe(true);
    expect(res[1].reused).toBeUndefined();
    expect(workerLoops()).toBe(1);
  });

  it("görev metni farklıysa atlanmaz (tam eşleşme)", async () => {
    seedRow({ stepIndex: 1, status: "COMPLETED" });
    await runManager([{ agentId: "w-a", task: "A (başka)" }]);
    expect(workerLoops()).toBe(1);
  });

  it("(e) başka koşunun / başka kiracının COMPLETED delegasyonu asla yeniden kullanılmaz ve tohuma girmez", async () => {
    seedRow({ stepIndex: 1, status: "COMPLETED", runId: "run-OTHER" });
    seedRow({ stepIndex: 1, status: "COMPLETED", tenantId: "tenant-OTHER" });
    await runManager([{ agentId: "w-a", task: "A" }], { workerCost: 0.3, managerCost: 0.1 });
    expect(workerLoops()).toBe(1);
    expect(lastRunUpdate().costUsd).toBeCloseTo(0.4, 10);
    expect(prismaMock.runStep.create.mock.calls[0][0].data.stepIndex).toBe(1); // eski davranış: 1'den başlar
    const where = prismaMock.runStep.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ runId: "run-1", run: { pipeline: { company: { tenantId: "tenant-1" } } } });
  });

  it("(f) kapı açık + gated adımlı pipeline: retry'da da fail-closed, önceki COMPLETED hiç okunmaz/kullanılmaz", async () => {
    vi.stubEnv("STEP_APPROVAL_GATE", "true");
    seedRow({ stepIndex: 1, status: "COMPLETED" });
    await processHierarchicalRun({
      runId: "run-1", tenantId: "tenant-1", input: "go",
      pipeline: pipeline({ steps: [{ name: "x", order: 0, config: { needsApproval: true } }] }),
    });
    expect(runAgentLoopMock).not.toHaveBeenCalled();
    expect(prismaMock.runStep.findMany).not.toHaveBeenCalled();
    expect(lastRunUpdate()).toMatchObject({ status: "FAILED", error: expect.stringMatching(/cannot be enforced/) });
  });

  it("(g) hiç COMPLETED delegasyon yok (yalnız FAILED/RUNNING, maliyetsiz) → atlama yok, taban 0, hepsi çalışır", async () => {
    seedRow({ stepIndex: 1, status: "FAILED", output: null, costUsd: 0 });
    seedRow({ stepIndex: 2, status: "RUNNING", output: null, costUsd: 0 });
    await runManager([{ agentId: "w-a", task: "A" }], { workerCost: 0.3, managerCost: 0.1 });
    expect(workerLoops()).toBe(1);
    expect(lastRunUpdate().costUsd).toBeCloseTo(0.4, 10);
    expect(prismaMock.runStep.create.mock.calls[0][0].data.stepIndex).toBe(3); // satır çakışması yok
  });

  it("(g3) RUNNING/INTERRUPTED satırın sıfır olmayan maliyeti tabana girer, atlanmaz", async () => {
    store.runCost = 0;
    seedRow({ stepIndex: 1, status: "RUNNING", output: null, costUsd: 0.25 });
    seedRow({ stepIndex: 2, status: "INTERRUPTED", agentId: "w-b", input: { agentId: "w-b", task: "B" }, output: null, costUsd: 0.15 });
    await runManager([{ agentId: "w-a", task: "A" }], { workerCost: 0.3, managerCost: 0.1 });
    expect(workerLoops()).toBe(1); // COMPLETED yok → atlama yok
    expect(lastRunUpdate().costUsd).toBeCloseTo(0.8, 10); // 0.4 taban + 0.3 + 0.1
    expect(Math.min(...writtenCosts())).toBeGreaterThanOrEqual(0.4);
  });

  it("planDelegationResume: satır maliyeti null / Decimal-string / Infinity / negatif / NaN → taban toplamı bozulmaz", () => {
    const row = (stepIndex: number, status: string, costUsd: unknown) => ({
      id: `r${stepIndex}`, stepIndex, status, agentId: "w-a", input: { agentId: "w-a", task: `T${stepIndex}` }, output: null, costUsd,
    });
    const plan = planDelegationResume([
      row(1, "FAILED", null),
      row(2, "FAILED", "0.400000"),
      row(3, "FAILED", Number.POSITIVE_INFINITY),
      row(4, "FAILED", -5),
      row(5, "FAILED", Number.NaN),
      row(6, "COMPLETED", "0.100000"),
    ]);
    expect(plan.delegationCost).toBeCloseTo(0.5, 10);
    expect(plan.seededCost).toBeCloseTo(0.1, 10);
    expect(startingCost(plan)).toBeCloseTo(0.5, 10);
  });

  it("(g2) hiç önceki satır yok (ilk koşu) → birebir eski: stepIndex 1'den, tohum 0", async () => {
    await runManager([{ agentId: "w-a", task: "A" }], { workerCost: 0.3, managerCost: 0.1 });
    expect(prismaMock.runStep.create.mock.calls[0][0].data.stepIndex).toBe(1);
    expect(lastRunUpdate().costUsd).toBeCloseTo(0.4, 10);
  });
});

/** Yazılan tüm run.costUsd değerleri (updateMany data.costUsd). */
const writtenCosts = () =>
  prismaMock.run.updateMany.mock.calls
    .map((c) => (c[0] as any).data.costUsd)
    .filter((v) => typeof v === "number") as number[];

describe("hiyerarşik retry — run.costUsd hiçbir yolda düşmez, bütçe kümülatif (BRA-P0-04j reviewer bulgusu)", () => {
  it("(h) regresyon: önceki deneme yönetici + FAILED worker harcadı (run.costUsd 1.5 > COMPLETED tohumu 0.4) → retry sonrası maliyet düşmez", async () => {
    store.runCost = 1.5; // önceki denemeler: COMPLETED 0.4 + FAILED worker 0.9 + yönetici 0.2
    seedRow({ stepIndex: 1, status: "COMPLETED", costUsd: 0.4 });
    seedRow({ stepIndex: 2, status: "FAILED", agentId: "w-b", input: { agentId: "w-b", task: "B" }, output: null, costUsd: 0.9 });
    await runManager([{ agentId: "w-a", task: "A" }, { agentId: "w-b", task: "B" }], { workerCost: 0.3, managerCost: 0.1 });
    // Eski hata: 0.4 + 0.3 + 0.1 = 0.8 (< 1.5) yazılırdı. Şimdi taban 1.5: 1.5 + 0.3 + 0.1.
    expect(lastRunUpdate()).toMatchObject({ status: "COMPLETED" });
    expect(lastRunUpdate().costUsd).toBeCloseTo(1.9, 10);
    expect(writtenCosts().length).toBeGreaterThan(0);
    expect(Math.min(...writtenCosts())).toBeGreaterThanOrEqual(1.5);
  });

  it("(h2) regresyon: bütçe aşımı engellenir — run.costUsd zaten maxUsd'yi aştıysa yeni delegasyon çalışmaz, FAILED yazılan maliyet düşmez", async () => {
    store.runCost = 1.2; // maxUsd 1.0'ı aştı; COMPLETED tohumu yalnız 0.4 (eski kod: 0.4 < 1.0 → delegasyona izin verirdi)
    seedRow({ stepIndex: 1, status: "COMPLETED", costUsd: 0.4 });
    prismaMock.run.findUnique.mockResolvedValue({
      id: "run-1", jobBudget: { maxUsd: 1.0 }, tenantId: null, workspaceId: null, retryCount: 1, startedAt: null, steps: [],
      pipeline: { company: { id: "co-1", tenantId: "tenant-1" } },
    });
    const res = await runManager([{ agentId: "w-b", task: "B" }]);
    expect(workerLoops()).toBe(0);
    expect(res[0]).toMatchObject({ error: expect.stringMatching(/^Delegation refused/) });
    expect(lastRunUpdate()).toMatchObject({ status: "FAILED" });
    expect(writtenCosts().length).toBeGreaterThan(0);
    expect(Math.min(...writtenCosts())).toBeGreaterThanOrEqual(1.2);
  });

  it("(h3) COMPLETED tohumu run.costUsd'den büyükse taban tohumdur (max); kayıtlı değer bayatsa da maliyet düşmez", async () => {
    store.runCost = 0.1;
    seedRow({ stepIndex: 1, status: "COMPLETED", costUsd: 0.4 });
    await runManager([{ agentId: "w-a", task: "A" }], { managerCost: 0.1 });
    expect(lastRunUpdate().costUsd).toBeCloseTo(0.5, 10); // 0.4 (tohum) + 0 (atlanan) + 0.1 (yönetici)
  });

  it("(i) düz koşu (retry'sız): run.costUsd 0/null, önceki satır yok → maliyet birebir eski (worker + yönetici)", async () => {
    for (const rc of [null, 0]) {
      vi.clearAllMocks();
      store.rows = [];
      store.runCost = rc;
      prismaMock.run.updateMany.mockResolvedValue({ count: 1 });
      await runManager([{ agentId: "w-a", task: "A" }], { workerCost: 0.3, managerCost: 0.1 });
      expect(lastRunUpdate().costUsd).toBeCloseTo(0.4, 10);
      expect(workerLoops()).toBe(1);
    }
  });

  it("(j) kiracı izolasyonu: run.costUsd okuması kiracı kapsamlı; başka kiracının run'ı (null) → taban 0, tohum yalnız kendi COMPLETED satırlarından", async () => {
    store.runCost = null;
    prismaMock.run.findFirst.mockImplementation(async (args: any) => (args?.select?.costUsd ? null : { status: "RUNNING", state: null }));
    seedRow({ stepIndex: 1, status: "COMPLETED", costUsd: 0.4 });
    await runManager([{ agentId: "w-a", task: "A" }], { managerCost: 0.1 });
    const call = prismaMock.run.findFirst.mock.calls.map((c) => c[0] as any).find((a) => a?.select?.costUsd);
    expect(call.where).toMatchObject({ id: "run-1", pipeline: { company: { tenantId: "tenant-1" } } });
    expect(lastRunUpdate().costUsd).toBeCloseTo(0.5, 10); // 0.4 tohum + 0.1 yönetici; başka kiracı değeri sızmadı
  });

  it("startingCost: max(run.costUsd, tüm delegasyon toplamı); NaN/negatif/Infinity 0 sayılır", () => {
    expect(startingCost({ priorRunCost: 1.5, delegationCost: 0.4 })).toBe(1.5);
    expect(startingCost({ priorRunCost: 0.1, delegationCost: 0.4 })).toBe(0.4);
    expect(startingCost({ priorRunCost: Number.NaN, delegationCost: -2 })).toBe(0);
    expect(startingCost({ priorRunCost: Number.POSITIVE_INFINITY, delegationCost: 0.3 })).toBe(0.3);
  });
});
