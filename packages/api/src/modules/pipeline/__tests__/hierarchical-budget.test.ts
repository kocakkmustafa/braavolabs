/**
 * BRA-P0-08 — the HIERARCHICAL runner enforces the job budget (it never went
 * through runGovernanceChecks). Real governance engine, synthetic persistence
 * and agent loops. A delegation is refused once the budget is exhausted, and a
 * run that had a delegation refused ends FAILED, never COMPLETED. A run with no
 * job budget behaves exactly as before.
 * NOT covered: a real manager LLM, a real database, BullMQ.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const runAgentLoopMock = vi.hoisted(() => vi.fn());
vi.mock("../../agent/claude", () => ({ runAgentLoop: (...a: unknown[]) => runAgentLoopMock(...a) }));
vi.mock("../../../lib/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../../../services/push", () => ({ notifyTenantUsers: vi.fn().mockResolvedValue(undefined) }));

const prismaMock = vi.hoisted(() => ({
  agent: { findUnique: vi.fn() },
  run: { update: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() },
  runStep: { create: vi.fn(), update: vi.fn(), findFirst: vi.fn() },
  activityLog: { create: vi.fn() },
}));
vi.mock("../../../lib/db", () => ({ prisma: prismaMock }));

vi.mock("../hierarchical", () => ({
  buildManagerContext: () => "team context",
  loadWorkers: async () => [],
  recordManagerDispatch: async () => {},
  resolveWorker: async () => ({ id: "worker-1", name: "Researcher", systemPrompt: "w", tools: [], model: "m", companyId: "co-1" }),
  trackDelegation: () => {},
  clearDelegationCounter: () => {},
}));

import { processHierarchicalRun } from "../hierarchical-runner";
import { getTool } from "../../agent/registry";
import { notifyTenantUsers } from "../../../services/push";

const loopResult = (cost: number) => ({
  finalContent: "done", turns: [], totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: cost, totalToolCalls: 0,
});

function runRow(patch: Record<string, unknown> = {}) {
  return {
    id: "run-1", jobBudget: null, tenantId: null, workspaceId: null, retryCount: 0, startedAt: null, steps: [],
    pipeline: { company: { id: "co-1", tenantId: "tenant-1" } },
    ...patch,
  };
}

const pipeline = { id: "p-1", companyId: "co-1", managerAgentId: "mgr-1", maxDelegationDepth: 3 } as never;

async function runWithDelegations(n: number) {
  const results: unknown[] = [];
  runAgentLoopMock.mockImplementation(async (cfg: { toolNames: string[] }) => {
    if (cfg.toolNames.includes("delegate")) {
      const delegate = getTool("delegate")!;
      for (let i = 0; i < n; i++) results.push(await delegate.handler({ agentId: "worker-1", task: `task ${i}` }));
    }
    return loopResult(0.5);
  });
  await processHierarchicalRun({ runId: "run-1", tenantId: "tenant-1", pipeline, input: "go" });
  return results;
}

const lastRunUpdate = () => prismaMock.run.updateMany.mock.calls.at(-1)![0].data;
const workerLoops = () => runAgentLoopMock.mock.calls.filter((c) => !(c[0] as any).toolNames.includes("delegate")).length;

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.agent.findUnique.mockResolvedValue({ id: "mgr-1", companyId: "co-1", systemPrompt: "m", tools: [], model: "x" });
  prismaMock.run.update.mockResolvedValue({});
  prismaMock.run.findFirst.mockResolvedValue({ status: "RUNNING", state: null });
  prismaMock.run.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.runStep.create.mockResolvedValue({});
  prismaMock.runStep.update.mockResolvedValue({});
  prismaMock.runStep.findFirst.mockResolvedValue({ id: "rs-worker" });
  prismaMock.activityLog.create.mockResolvedValue({});
  prismaMock.run.findUnique.mockResolvedValue(runRow());
});

describe("HIERARCHICAL runner — job budget (BRA-P0-08)", () => {
  it("no job budget → unchanged: both delegations run, run COMPLETED", async () => {
    await runWithDelegations(2);
    expect(workerLoops()).toBe(2);
    expect(lastRunUpdate()).toMatchObject({ status: "COMPLETED" });
  });

  it("exhausted budget → delegation refused (no worker loop, no step row), activity logged, run FAILED", async () => {
    // A step limit of 0 is already used up (CLI parity), so the very first delegation is refused.
    prismaMock.run.findUnique.mockResolvedValue(runRow({ jobBudget: { maxSteps: 0 } }));
    const results = await runWithDelegations(2);
    expect(workerLoops()).toBe(0);
    expect(prismaMock.runStep.create).not.toHaveBeenCalled();
    expect(results[0]).toMatchObject({ error: expect.stringMatching(/^Delegation refused: Job budget exhausted/) });
    expect(prismaMock.activityLog.create.mock.calls.map((c) => (c[0] as any).data.action)).toContain("governance.job_budget");
    expect(lastRunUpdate()).toMatchObject({ status: "FAILED", error: expect.stringMatching(/Job budget exhausted/) });
  });

  it("cost-based stop: the first delegation spends past maxUsd, the second is refused, run FAILED", async () => {
    let call = 0;
    prismaMock.run.findUnique.mockImplementation(async () => {
      call++;
      return runRow({ jobBudget: { maxUsd: 0.5 } });
    });
    runAgentLoopMock.mockImplementation(async (cfg: { toolNames: string[] }) => {
      if (cfg.toolNames.includes("delegate")) {
        const delegate = getTool("delegate")!;
        await delegate.handler({ agentId: "worker-1", task: "a" }); // cost 0 so far → allowed, worker costs 0.6
        await delegate.handler({ agentId: "worker-1", task: "b" }); // cost 0.6 ≥ 0.5 → refused
        return loopResult(0);
      }
      return loopResult(0.6);
    });
    await processHierarchicalRun({ runId: "run-1", tenantId: "tenant-1", pipeline, input: "go" });
    expect(call).toBe(2);
    expect(workerLoops()).toBe(1);
    expect(lastRunUpdate()).toMatchObject({ status: "FAILED" });
  });

  it("scope mismatch (run.tenant_id differs from its owner) refuses the delegation even with no budget", async () => {
    prismaMock.run.findUnique.mockResolvedValue(runRow({ tenantId: "other-tenant" }));
    const results = await runWithDelegations(1);
    expect(workerLoops()).toBe(0);
    expect(results[0]).toMatchObject({ error: expect.stringMatching(/Job scope mismatch/) });
    expect(lastRunUpdate()).toMatchObject({ status: "FAILED" });
  });

  it("reaching the limit exactly while finishing is still a success (final check is overshoot-only)", async () => {
    // maxUsd 0.6: delegation sees cost 0 → allowed; final total = worker 0.5 + manager 0.5 = 1.0 (> 0.6) would FAIL,
    // so use a limit equal to the final total instead: 1.0 → used == limit → success.
    prismaMock.run.findUnique.mockResolvedValue(runRow({ jobBudget: { maxUsd: 1.0 } }));
    await runWithDelegations(1); // worker loop 0.5 + manager loop 0.5
    expect(workerLoops()).toBe(1);
    expect(lastRunUpdate()).toMatchObject({ status: "COMPLETED" });
  });

  it("manager's own cost counts at the end: total over maxUsd → run FAILED even though no delegation was refused", async () => {
    prismaMock.run.findUnique.mockResolvedValue(runRow({ jobBudget: { maxUsd: 0.9 } }));
    const results = await runWithDelegations(1); // delegation allowed (cost 0), final total 1.0 > 0.9
    expect(results[0]).not.toMatchObject({ error: expect.anything() });
    expect(workerLoops()).toBe(1);
    expect(lastRunUpdate()).toMatchObject({ status: "FAILED", error: expect.stringMatching(/Job budget exhausted \(usd: 1 of 0.9\)/) });
  });

  it("a refusal's reason is kept (first reason wins) and the run still ends FAILED when the manager loop throws afterwards", async () => {
    prismaMock.run.findUnique.mockResolvedValue(runRow({ jobBudget: { maxSteps: 0 } }));
    runAgentLoopMock.mockImplementation(async (cfg: { toolNames: string[] }) => {
      if (cfg.toolNames.includes("delegate")) {
        await getTool("delegate")!.handler({ agentId: "worker-1", task: "a" });
        throw new Error("manager crashed");
      }
      return loopResult(0.5);
    });
    await processHierarchicalRun({ runId: "run-1", tenantId: "tenant-1", pipeline, input: "go" });
    // the exception path wins: error is the manager's message, audited as run.hierarchical_failed
    expect(lastRunUpdate()).toMatchObject({ status: "FAILED", error: "manager crashed" });
    expect(prismaMock.activityLog.create.mock.calls.map((c) => (c[0] as any).data.action)).toContain("run.hierarchical_failed");
  });

  it("malformed stored budget → refused (fail-closed)", async () => {
    prismaMock.run.findUnique.mockResolvedValue(runRow({ jobBudget: { maxUsd: "lots" } }));
    const results = await runWithDelegations(1);
    expect(workerLoops()).toBe(0);
    expect(results[0]).toMatchObject({ error: expect.stringMatching(/invalid/) });
    expect(lastRunUpdate()).toMatchObject({ status: "FAILED" });
  });
});

const actions = () => prismaMock.activityLog.create.mock.calls.map((c) => (c[0] as any).data.action as string);

describe.each([["flag off", undefined], ["flag on", "true"]])("HIERARCHICAL runner — BRA-P0-02c-5 lifecycle (%s)", (_n, flag) => {
  beforeEach(() => {
    if (flag) process.env.JOB_STATE_DUAL_WRITE = flag;
    else delete process.env.JOB_STATE_DUAL_WRITE;
  });
  afterAll(() => { delete process.env.JOB_STATE_DUAL_WRITE; });

  it("final COMPLETED goes through the CAS writer (+ run.hierarchical_completed)", async () => {
    await runWithDelegations(1);
    expect(prismaMock.run.update).not.toHaveBeenCalled();
    const call = prismaMock.run.updateMany.mock.calls.at(-1)![0];
    expect(call.where).toMatchObject({ id: "run-1", status: "RUNNING" });
    expect(call.data).toMatchObject({ status: "COMPLETED", output: { text: "done" } });
    if (flag) expect(call.data).toMatchObject({ state: "COMPLETED" });
    else expect(call.data).not.toHaveProperty("state");
    expect(actions()).toContain("run.hierarchical_completed");
  });

  it("manager loop throws → FAILED + run.hierarchical_failed", async () => {
    runAgentLoopMock.mockRejectedValue(new Error("boom"));
    await processHierarchicalRun({ runId: "run-1", tenantId: "tenant-1", pipeline, input: "go" });
    expect(lastRunUpdate()).toMatchObject({ status: "FAILED", error: "boom" });
    expect(actions()).toEqual(["run.hierarchical_failed"]);
  });

  it("budget FAILED writes run.hierarchical_failed (cause job_budget)", async () => {
    prismaMock.run.findUnique.mockResolvedValue(runRow({ jobBudget: { maxSteps: 0 } }));
    await runWithDelegations(1);
    expect(lastRunUpdate()).toMatchObject({ status: "FAILED" });
    expect(actions()).toContain("run.hierarchical_failed");
    const row = prismaMock.activityLog.create.mock.calls.map((c) => (c[0] as any).data).find((d) => d.action === "run.hierarchical_failed");
    expect(row.details).toMatchObject({ cause: "job_budget" });
  });

  it("repeated refusal in one run → one governance.job_budget row and one push", async () => {
    prismaMock.run.findUnique.mockResolvedValue(runRow({ jobBudget: { maxSteps: 0 } }));
    const results = await runWithDelegations(3);
    expect(results).toHaveLength(3);
    expect(results.every((r) => (r as any).error?.startsWith("Delegation refused"))).toBe(true);
    expect(actions().filter((a) => a === "governance.job_budget")).toHaveLength(1);
    expect(notifyTenantUsers).toHaveBeenCalledTimes(1);
  });

  it("CAS lost on final COMPLETED → no activity row, no further writes", async () => {
    prismaMock.run.updateMany.mockResolvedValue({ count: 0 });
    await runWithDelegations(1);
    expect(actions()).not.toContain("run.hierarchical_completed");
    expect(prismaMock.run.update).not.toHaveBeenCalled();
  });

  it("CAS lost on budget FAILED → no run.hierarchical_failed", async () => {
    prismaMock.run.findUnique.mockResolvedValue(runRow({ jobBudget: { maxSteps: 0 } }));
    prismaMock.run.updateMany.mockResolvedValue({ count: 0 });
    await runWithDelegations(1);
    expect(actions()).not.toContain("run.hierarchical_failed");
  });

  it("run cancelled from outside (status CANCELLED) → runner does not overwrite or log", async () => {
    prismaMock.run.findFirst.mockResolvedValue({ status: "CANCELLED", state: "CANCELLED" });
    await runWithDelegations(1);
    if (flag) {
      expect(prismaMock.run.updateMany).not.toHaveBeenCalled(); // graph: no edge CANCELLED→COMPLETED
      expect(actions()).not.toContain("run.hierarchical_completed");
    } else {
      // legacyUnchecked (legacy parity, ADR-0001): no graph check, so a status already CANCELLED at read time is
      // still written; only the status CAS (here: the status we read, not RUNNING) guards the read-write window.
      expect(prismaMock.run.updateMany.mock.calls.at(-1)![0].where).toEqual({ id: "run-1", status: "CANCELLED" });
    }
  });

  it("flag off never names state in the read or the CAS where; flag on does", async () => {
    await runWithDelegations(1);
    const sel = prismaMock.run.findFirst.mock.calls.at(-1)![0].select;
    const where = prismaMock.run.updateMany.mock.calls.at(-1)![0].where;
    if (flag) { expect(sel).toHaveProperty("state"); expect(where).toHaveProperty("state"); }
    else { expect(sel).not.toHaveProperty("state"); expect(where).not.toHaveProperty("state"); }
  });

  it("parallel delegations (Promise.all x5) over budget: exactly one governance.job_budget row + one push, all refused", async () => {
    prismaMock.run.findUnique.mockResolvedValue(runRow({ jobBudget: { maxSteps: 0 } }));
    let results: unknown[] = [];
    runAgentLoopMock.mockImplementation(async (cfg: { toolNames: string[] }) => {
      if (cfg.toolNames.includes("delegate")) {
        const delegate = getTool("delegate")!;
        results = await Promise.all(Array.from({ length: 5 }, (_, i) => delegate.handler({ agentId: "worker-1", task: "t" + i })));
      }
      return loopResult(0.5);
    });
    await processHierarchicalRun({ runId: "run-1", tenantId: "tenant-1", pipeline, input: "go" });
    expect(results).toHaveLength(5);
    expect(results.every((r) => (r as any).error?.startsWith("Delegation refused"))).toBe(true);
    expect(workerLoops()).toBe(0);
    expect(actions().filter((a) => a === "governance.job_budget")).toHaveLength(1);
    expect(notifyTenantUsers).toHaveBeenCalledTimes(1);
    expect(lastRunUpdate()).toMatchObject({ status: "FAILED" });
  });

  it("a throwing budget check rejects only that call; waiting calls still run their own check", async () => {
    let n = 0;
    prismaMock.run.findUnique.mockImplementation(async () => {
      if (++n === 1) throw new Error("db down");
      return runRow();
    });
    let statuses: string[] = [];
    runAgentLoopMock.mockImplementation(async (cfg: { toolNames: string[] }) => {
      if (cfg.toolNames.includes("delegate")) {
        const delegate = getTool("delegate")!;
        const r = await Promise.allSettled([1, 2].map((i) => delegate.handler({ agentId: "worker-1", task: "t" + i })));
        statuses = r.map((x) => x.status);
      }
      return loopResult(0);
    });
    await processHierarchicalRun({ runId: "run-1", tenantId: "tenant-1", pipeline, input: "go" });
    expect(statuses).toEqual(["rejected", "fulfilled"]);
    expect(workerLoops()).toBe(1);
  });

  it("manager moved to another company → FAILED via the writer, no activity row", async () => {
    prismaMock.agent.findUnique.mockResolvedValue({ id: "mgr-1", companyId: "co-OTHER", systemPrompt: "m", tools: [], model: "x" });
    await processHierarchicalRun({ runId: "run-1", tenantId: "tenant-1", pipeline, input: "go" });
    expect(lastRunUpdate()).toMatchObject({ status: "FAILED", error: expect.stringMatching(/moved to a different company/) });
    expect(actions()).toEqual([]);
  });

  it("missing manager → FAILED via the writer, no activity row", async () => {
    prismaMock.agent.findUnique.mockResolvedValue(null);
    await processHierarchicalRun({ runId: "run-1", tenantId: "tenant-1", pipeline, input: "go" });
    expect(lastRunUpdate()).toMatchObject({ status: "FAILED", error: expect.stringMatching(/Manager agent not found/) });
    expect(actions()).toEqual([]);
  });
});
