/**
 * D-011 regression guard (E2/T4): delegated worker loops must run with the
 * parent run's tenant context. Before the fix, hierarchical-runner spawned
 * workers with `tenantId: undefined`, silently routing a BYOK tenant's data
 * to the SYSTEM Anthropic key on every delegated step — a live violation of
 * the BYOK privacy contract (plan §2.2 / findings D-011).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const runAgentLoopMock = vi.hoisted(() => vi.fn());
vi.mock("../../agent/claude", () => ({
  runAgentLoop: (...a: unknown[]) => runAgentLoopMock(...a),
}));

vi.mock("../../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const prismaMock = vi.hoisted(() => ({
  agent: { findUnique: vi.fn() },
  run: { update: vi.fn() },
  runStep: { create: vi.fn(), update: vi.fn(), findFirst: vi.fn() },
  activityLog: { create: vi.fn() },
}));
vi.mock("../../../lib/db", () => ({ prisma: prismaMock }));

vi.mock("../hierarchical", () => ({
  buildManagerContext: () => "team context",
  loadWorkers: async () => [],
  recordManagerDispatch: async () => {},
  resolveWorker: async () => ({
    id: "worker-1",
    name: "Researcher",
    systemPrompt: "You are a worker.",
    tools: ["web_search"],
    model: "llama-3.3-70b-versatile",
    companyId: "co-1",
  }),
  trackDelegation: () => {},
  clearDelegationCounter: () => {},
}));

import { processHierarchicalRun } from "../hierarchical-runner";
import { getTool } from "../../agent/registry";

const emptyLoopResult = {
  finalContent: "done",
  turns: [],
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCostUsd: 0.01,
  totalToolCalls: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.agent.findUnique.mockResolvedValue({
    id: "mgr-1",
    companyId: "co-1",
    systemPrompt: "You are the manager.",
    tools: [],
    model: "claude-sonnet-4-20250514",
  });
  prismaMock.run.update.mockResolvedValue({});
  prismaMock.runStep.create.mockResolvedValue({});
  prismaMock.runStep.update.mockResolvedValue({});
  prismaMock.runStep.findFirst.mockResolvedValue({ id: "rs-worker" });
  prismaMock.activityLog.create.mockResolvedValue({});
});

describe("hierarchical runner — worker tenant propagation (D-011)", () => {
  it("spawns delegated worker loops with the parent run's tenantId", async () => {
    runAgentLoopMock.mockImplementation(async (cfg: { toolNames: string[] }) => {
      if (cfg.toolNames.includes("delegate")) {
        // Manager turn — invoke the delegate tool exactly like the model would.
        const delegate = getTool("delegate");
        expect(delegate).toBeDefined();
        await delegate!.handler({ agentId: "worker-1", task: "research the EU market" });
      }
      return emptyLoopResult;
    });

    await processHierarchicalRun({
      runId: "run-1",
      tenantId: "tenant-1",
      pipeline: {
        id: "p-1",
        companyId: "co-1",
        managerAgentId: "mgr-1",
        maxDelegationDepth: 2,
      } as never,
      input: "kick off",
    });

    // Two loops ran: manager + delegated worker
    expect(runAgentLoopMock).toHaveBeenCalledTimes(2);

    const managerCall = runAgentLoopMock.mock.calls[0][0] as Record<string, unknown>;
    expect(managerCall.tenantId).toBe("tenant-1");

    // THE fix: the worker call carries the parent tenant context —
    // previously `tenantId: undefined` (system-Anthropic leak, D-011).
    const workerCall = runAgentLoopMock.mock.calls[1][0] as Record<string, unknown>;
    expect(workerCall.tenantId).toBe("tenant-1");
    expect(workerCall.systemPrompt).toBe("You are a worker.");
    expect(workerCall.model).toBe("llama-3.3-70b-versatile");

    // Run completes normally with the worker cost folded in
    expect(prismaMock.run.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "run-1" },
        data: expect.objectContaining({ status: "COMPLETED" }),
      }),
    );
  });
});
