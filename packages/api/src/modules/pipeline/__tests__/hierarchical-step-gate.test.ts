/**
 * BRA-P0-03d — hiyerarşik yürütücü adım config'ini (needsApproval) zorlayamaz: kapı AÇIKKEN gated adımlı
 * pipeline çalışmadan FAILED (fail-closed); kapalıyken eski yol (yönetici döngüsü) çalışır.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const m = vi.hoisted(() => ({ runAgentLoop: vi.fn(), writeLifecycle: vi.fn(), agentFindUnique: vi.fn() }));
vi.mock("../../agent/claude", () => ({ runAgentLoop: (...a: unknown[]) => m.runAgentLoop(...a) }));
vi.mock("../../../lib/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../../../lib/db", () => ({
  prisma: {
    agent: { findUnique: (...a: unknown[]) => m.agentFindUnique(...a) },
    run: { update: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() },
    runStep: { create: vi.fn(), update: vi.fn(), findFirst: vi.fn() },
    activityLog: { create: vi.fn() },
  },
}));
vi.mock("../../run/write-lifecycle", () => ({ writeLifecycle: (...a: unknown[]) => m.writeLifecycle(...a) }));
vi.mock("../../run/heartbeat", () => ({ beatRun: vi.fn() }));
vi.mock("../hierarchical", () => ({
  buildManagerContext: () => "ctx", loadWorkers: async () => [], recordManagerDispatch: async () => {},
  resolveWorker: async () => null, trackDelegation: () => {}, clearDelegationCounter: () => {},
}));

import { processHierarchicalRun } from "../hierarchical-runner";

const pipeline = (steps: unknown) => ({ id: "p1", companyId: "co-1", managerAgentId: "mgr", maxDelegationDepth: 2, steps }) as any;
beforeEach(() => {
  vi.clearAllMocks();
  m.writeLifecycle.mockResolvedValue(true);
  m.agentFindUnique.mockResolvedValue({ id: "mgr", companyId: "co-1", systemPrompt: "s", tools: [], model: "m" });
  m.runAgentLoop.mockResolvedValue({ finalContent: "ok", turns: [], totalCostUsd: 0, totalToolCalls: 0 });
});
afterEach(() => vi.unstubAllEnvs());

describe("hiyerarşik pipeline × STEP_APPROVAL_GATE", () => {
  const gated = [{ name: "x", order: 0, config: { needsApproval: true, risk: "high" } }];

  it("kapı açık + gated adım: çalışmadan FAILED, yönetici döngüsü hiç çalışmaz", async () => {
    vi.stubEnv("STEP_APPROVAL_GATE", "true");
    await processHierarchicalRun({ runId: "r1", tenantId: "t1", pipeline: pipeline(gated), input: "x" });
    expect(m.writeLifecycle).toHaveBeenCalledWith("r1", "t1", "FAILED", expect.objectContaining({ error: expect.stringMatching(/cannot be enforced/) }));
    expect(m.runAgentLoop).not.toHaveBeenCalled();
  });

  it("kapı açık + 'TRUE' yazımlı adım da reddedilir", async () => {
    vi.stubEnv("STEP_APPROVAL_GATE", "true");
    await processHierarchicalRun({ runId: "r1", tenantId: "t1", pipeline: pipeline([{ name: "x", config: { needsApproval: "TRUE" } }]), input: "x" });
    expect(m.runAgentLoop).not.toHaveBeenCalled();
  });

  it("kapı kapalı: eski davranış (yönetici döngüsü çalışır, kapı reddi yok)", async () => {
    await processHierarchicalRun({ runId: "r1", tenantId: "t1", pipeline: pipeline(gated), input: "x" });
    expect(m.runAgentLoop).toHaveBeenCalledTimes(1);
    expect(m.writeLifecycle).not.toHaveBeenCalledWith("r1", "t1", "FAILED", expect.objectContaining({ error: expect.stringMatching(/cannot be enforced/) }));
  });

  it("kapı açık ama gated adım yok: normal çalışır", async () => {
    vi.stubEnv("STEP_APPROVAL_GATE", "true");
    await processHierarchicalRun({ runId: "r1", tenantId: "t1", pipeline: pipeline([{ name: "x", config: {} }]), input: "x" });
    expect(m.runAgentLoop).toHaveBeenCalledTimes(1);
  });
});
