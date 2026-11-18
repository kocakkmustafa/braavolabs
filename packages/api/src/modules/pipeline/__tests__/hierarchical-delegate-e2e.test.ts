/**
 * SEC-BRA-06c: END-TO-END delegate through the UNGOVERNED guard. Unlike the
 * other hierarchical*.test.ts (they mock agent/claude, so the guard never ran
 * and a delegate/agentId regression slipped through), this uses the REAL
 * hierarchical runner, REAL runAgentLoop/executeToolCalls, REAL registry and
 * REAL tool-executor guard. Only prisma, the provider and push are synthetic.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../config/env", () => ({ env: { LLM_PROVIDER: "api", ANTHROPIC_API_KEY: "k", CLAUDE_MODEL: "m", OFFLINE_MODE: false } }));
vi.mock("../../../lib/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const m = vi.hoisted(() => ({
  agentFindFirst: vi.fn(), agentFindUnique: vi.fn(), agentFindMany: vi.fn(), aiCfgFindMany: vi.fn(), tenantFindUnique: vi.fn(),
  run: { update: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() },
  runStep: { create: vi.fn(), update: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
}));
vi.mock("../../../lib/db", () => {
  const base: any = {
    agent: { findFirst: m.agentFindFirst, findUnique: m.agentFindUnique, findMany: m.agentFindMany },
    run: m.run, runStep: m.runStep,
    activityLog: { create: vi.fn() },
    userAIConfig: { findMany: m.aiCfgFindMany, findUnique: vi.fn(), upsert: vi.fn() },
    tenant: { findUnique: m.tenantFindUnique },
  };
  return { prisma: new Proxy(base, { get: (t, k: string) => t[k] ?? new Proxy({}, { get: () => vi.fn().mockResolvedValue(null) }) }) };
});
vi.mock("../../../services/push", () => ({ notifyTenantUsers: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../../lib/runEvents", () => ({ publishRunEvent: vi.fn() }));
vi.mock("../../../lib/ssrf", () => ({ assertSafeExternalUrl: async () => {}, SsrfError: class extends Error {} }));
vi.mock("../../../lib/encryption", () => ({ decryptForTenant: vi.fn((b: string) => b.replace("enc:", "")), encryptForTenant: vi.fn() }));
// Tenant provider chain: a single BYOK GROQ row (real chain builder).
vi.mock("../../../services/trial-llm", () => ({ tryConsumeTrialRun: vi.fn(), commitTrialRun: vi.fn(), refundTrialReservation: vi.fn() }));
const chat = vi.hoisted(() => vi.fn());
vi.mock("../../../services/ai-client", async (orig) => ({
  ...(await orig<typeof import("../../../services/ai-client")>()),
  chatCompletion: (...a: unknown[]) => chat(...a),
}));

import { processHierarchicalRun } from "../hierarchical-runner";

const T = "tenant-A";
const resp = (over: object) => ({ content: "", inputTokens: 1, outputTokens: 1, model: "llama-3.3-70b-versatile", provider: "GROQ", stopReason: "stop", ...over });

beforeEach(async () => {
  vi.clearAllMocks();
  m.aiCfgFindMany.mockResolvedValue([{
    id: "cfg", tenantId: T, provider: "GROQ", model: "llama-3.3-70b-versatile", encryptedApiKey: "enc:k",
    baseUrl: null, isDefault: true, fallbackOrder: null, allowSystemFallback: false, createdAt: new Date(2026, 0, 1),
  }]);
  m.tenantFindUnique.mockResolvedValue({ plan: "PRO" });
  m.agentFindUnique.mockImplementation(async ({ where }: any) =>
    where.id === "mgr-1"
      ? { id: "mgr-1", companyId: "co-1", name: "Mgr", systemPrompt: "mgr", tools: [], model: null }
      : { id: where.id, companyId: "co-1", name: "Worker", systemPrompt: "w", tools: [], model: null });
  m.agentFindMany.mockResolvedValue([]);
  m.run.update.mockResolvedValue({}); m.run.findFirst.mockResolvedValue({ status: "RUNNING" });
  m.run.updateMany.mockResolvedValue({ count: 1 });
  m.run.findUnique.mockResolvedValue({ id: "run-1", jobBudget: null, tenantId: null, workspaceId: null, retryCount: 0, startedAt: null, steps: [], pipeline: { company: { id: "co-1", tenantId: T } } });
  m.runStep.create.mockResolvedValue({ id: "rs" }); m.runStep.findMany.mockResolvedValue([]);
  m.runStep.update.mockResolvedValue({}); m.runStep.findFirst.mockResolvedValue({ id: "rs" });
});

async function runManager(agentId: string) {
  // call 1 = manager asks to delegate; call 2 = worker answers; call 3 = manager final.
  let n = 0;
  chat.mockReset().mockImplementation(async () => {
    n++;
    if (n === 1) return resp({ stopReason: "tool_calls", toolCalls: [{ id: "d1", name: "delegate", argumentsJson: JSON.stringify({ agentId, task: "research" }) }] });
    return resp({ content: "ok" });
  });
  await processHierarchicalRun({
    runId: "run-1", tenantId: T,
    pipeline: { id: "p", companyId: "co-1", managerAgentId: "mgr-1", maxDelegationDepth: 2, steps: [] } as never,
    input: "go",
  });
  // the manager's second provider call carries the delegate tool_result
  const second = JSON.stringify(chat.mock.calls[1]?.[2] ?? "");
  return { second, calls: chat.mock.calls.length };
}

describe("hierarchical manager → delegate through the real ungoverned guard", () => {
  it("delegate WORKS for an agentId in the acting tenant (was: 'Unrecognised ... agentId')", async () => {
    m.agentFindFirst.mockResolvedValue({ id: "worker-1" });
    const { second, calls } = await runManager("worker-1");
    expect(m.agentFindFirst).toHaveBeenCalledWith({ where: { id: "worker-1", company: { tenantId: T } }, select: { id: true } });
    expect(second).not.toMatch(/Unrecognised|Tenant isolation/);
    expect(calls).toBe(3); // manager, worker, manager-final
    expect(m.runStep.create.mock.calls.length).toBeGreaterThan(1); // dispatch + delegation step
  });
  it("delegate to another tenant's agentId is refused before any worker runs", async () => {
    m.agentFindFirst.mockResolvedValue(null);
    const { second, calls } = await runManager("foreign-agent");
    expect(second).toMatch(/Tenant isolation violation: agentId/);
    expect(calls).toBe(2); // manager + manager-final; no worker loop
    expect(m.runStep.create.mock.calls.some((c: any) => String(c[0]?.data?.name ?? "").startsWith("delegate:"))).toBe(false);
  });
});
