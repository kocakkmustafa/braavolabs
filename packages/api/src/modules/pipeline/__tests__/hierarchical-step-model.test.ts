/**
 * BRA-P0-06c — hiyerarşik worker adımı (`delegate:*`) çıktısına provider/model yazar.
 * Yönetici döngüsünün RunStep satırı yoktur; yalnız worker adımları kayıtlıdır.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const runAgentLoopMock = vi.hoisted(() => vi.fn());
vi.mock("../../agent/claude", () => ({ runAgentLoop: (...a: unknown[]) => runAgentLoopMock(...a) }));
vi.mock("../../../lib/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../../../services/push", () => ({ notifyTenantUsers: vi.fn().mockResolvedValue(undefined) }));

const store = vi.hoisted(() => ({ rows: [] as any[], seq: 0 }));
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
import { getTool } from "../../agent/registry";

const loop = (extra: Record<string, unknown> = {}) => ({
  finalContent: "done", turns: [], totalInputTokens: 1, totalOutputTokens: 1, totalCostUsd: 0.1, totalToolCalls: 0, ...extra,
});

async function runWith(workerExtra: Record<string, unknown>) {
  runAgentLoopMock.mockImplementation(async (cfg: { toolNames: string[] }) => {
    if (cfg.toolNames.includes("delegate")) {
      await getTool("delegate")!.handler({ agentId: "w-a", task: "A" });
      return loop();
    }
    return loop(workerExtra);
  });
  await processHierarchicalRun({
    runId: "run-1", tenantId: "tenant-1", input: "go",
    pipeline: { id: "p-1", companyId: "co-1", managerAgentId: "mgr-1", maxDelegationDepth: 3, steps: [] } as never,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  store.rows = [];
  store.seq = 0;
  prismaMock.agent.findUnique.mockResolvedValue({ id: "mgr-1", companyId: "co-1", systemPrompt: "m", tools: [], model: "x" });
  prismaMock.run.update.mockResolvedValue({});
  prismaMock.run.findFirst.mockImplementation(async (args: any) => (args?.select?.costUsd ? { costUsd: null } : { status: "RUNNING", state: null }));
  prismaMock.run.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.run.findUnique.mockResolvedValue({
    id: "run-1", jobBudget: null, tenantId: null, workspaceId: null, retryCount: 0, startedAt: null, steps: [],
    pipeline: { company: { id: "co-1", tenantId: "tenant-1" } },
  });
  prismaMock.activityLog.create.mockResolvedValue({});
  prismaMock.runStep.findMany.mockResolvedValue([]);
  prismaMock.runStep.create.mockImplementation(async ({ data }: any) => {
    const row = { id: `new-${++store.seq}`, tenantId: "tenant-1", costUsd: null, output: null, ...data };
    store.rows.push(row);
    return { id: row.id };
  });
  prismaMock.runStep.update.mockImplementation(async ({ where, data }: any) => {
    Object.assign(store.rows.find((r) => r.id === where.id)!, data);
    return {};
  });
  prismaMock.runStep.findFirst.mockResolvedValue({ id: "x" });
});

describe("hiyerarşik worker adımı → output provider/model", () => {
  it("worker loop sonucundaki provider/model adım çıktısına yazılır; yönetici için satır yok", async () => {
    await runWith({ provider: "OPENAI", model: "gpt-x" });
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0].name.startsWith("delegate:")).toBe(true);
    expect(store.rows[0].output).toMatchObject({ provider: "OPENAI", model: "gpt-x" });
  });
  it("alan yoksa anahtar eklenmez", async () => {
    await runWith({});
    expect("provider" in store.rows[0].output).toBe(false);
    expect("model" in store.rows[0].output).toBe(false);
  });
});
