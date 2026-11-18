/**
 * BRA-P0-06c — executeStep, adım çıktısına fiilen çalışan provider/model'i yazar
 * (makbuz `step` kanıtı bunu okur). Alanlar yoksa anahtar hiç eklenmez.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const runFindUnique = vi.hoisted(() => vi.fn());
const runStepCreate = vi.hoisted(() => vi.fn());
const runStepUpdate = vi.hoisted(() => vi.fn());
const handoffFindFirst = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/db", () => ({
  prisma: {
    run: { findUnique: (...a: unknown[]) => runFindUnique(...a) },
    runStep: {
      create: (...a: unknown[]) => runStepCreate(...a),
      update: (...a: unknown[]) => runStepUpdate(...a),
    },
    handoffLedger: {
      findFirst: (...a: unknown[]) => handoffFindFirst(...a),
      update: vi.fn(() => Promise.resolve({})),
    },
    toolCall: { createMany: vi.fn(), findMany: vi.fn(() => Promise.resolve([])) },
  },
}));

vi.mock("../../../lib/runEvents", () => ({ publishRunEvent: vi.fn() }));
vi.mock("../../../lib/telemetry", () => ({
  withSpan: async (_n: string, fn: () => unknown) => fn(),
  toolCallCounter: { add: vi.fn() },
  stepDurationHistogram: { record: vi.fn() },
}));

const runAgentLoopMock = vi.hoisted(() => vi.fn());
vi.mock("../../agent/claude", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agent/claude")>();
  return { ...actual, runAgentLoop: (...a: unknown[]) => runAgentLoopMock(...a) };
});
vi.mock("../../../services/takeover-config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../services/takeover-config")>();
  return { ...actual, resolveTakeoverConfig: async () => ({ provider: "OLLAMA", model: "gemma3:4b", apiKey: "", baseUrl: "http://gpu:11434/v1" }) };
});
vi.mock("../../run/handoff.trigger", () => ({ maybeOpenAutoHandoff: vi.fn() }));

import { executeStep } from "../executor";

const AGENT = {
  id: "agent-1", name: "Researcher", role: "researcher", systemPrompt: "sys",
  tools: [] as string[], model: null, maxTokens: null, autonomy: "BALANCED",
};
const FULL_RUN = {
  id: "run-1", budgetUsd: 1,
  pipeline: { company: { id: "co-1", name: "Acme", tenantId: "tenant-1", agents: [AGENT] } },
};
const STEP_DEF = { name: "research", agentRole: "researcher", order: 0 };

const loopResult = (extra: Record<string, unknown>) => ({
  finalContent: "ok", turns: [], totalInputTokens: 1, totalOutputTokens: 1,
  totalCostUsd: 0.1, totalToolCalls: 0, ...extra,
});
const completedOutput = () => runStepUpdate.mock.calls.find((c) => c[0]?.data?.status === "COMPLETED")![0].data.output;

beforeEach(() => {
  vi.clearAllMocks();
  runFindUnique.mockResolvedValue(FULL_RUN);
  runStepCreate.mockResolvedValue({ id: "rs-1", startedAt: new Date() });
  runStepUpdate.mockResolvedValue({});
  handoffFindFirst.mockResolvedValue(null);
});

describe("executor → RunStep.output provider/model", () => {
  it("loop sonucundaki provider/model adım çıktısına yazılır", async () => {
    runAgentLoopMock.mockResolvedValue(loopResult({ provider: "ANTHROPIC", model: "claude-x" }));
    const r = await executeStep("run-1", STEP_DEF, 0, {});
    expect(r.status).toBe("COMPLETED");
    expect(completedOutput()).toMatchObject({ provider: "ANTHROPIC", model: "claude-x" });
  });
  it("provider/model yoksa anahtarlar eklenmez", async () => {
    runAgentLoopMock.mockResolvedValue(loopResult({}));
    await executeStep("run-1", STEP_DEF, 0, {});
    const out = completedOutput();
    expect("provider" in out).toBe(false);
    expect("model" in out).toBe(false);
  });
});

const completedData = () => runStepUpdate.mock.calls.find((c) => c[0]?.data?.status === "COMPLETED")![0].data;

describe("executor → RunStep.modelMode/modeDetail (BRA-P0-06a-2)", () => {
  it("varsayılan DIRECT yazılır", async () => {
    runAgentLoopMock.mockResolvedValue(loopResult({ provider: "ANTHROPIC", model: "claude-x" }));
    await executeStep("run-1", STEP_DEF, 0, {});
    const d = completedData();
    expect(d.modelMode).toBe("DIRECT");
    expect(d.modeDetail).toMatchObject({ requested: "DIRECT", effective: "DIRECT", source: "default" });
    expect(runAgentLoopMock).toHaveBeenCalledTimes(1);
  });
  it("ajan COMPARE ama araçsız + 2 aday: aday modelleri çalışır, toplam maliyet yazılır, output seçilenin modeli", async () => {
    const agent = { ...AGENT, modelMode: "COMPARE", modelModeConfig: { compareModels: ["m-a", "m-b"] } };
    runFindUnique.mockResolvedValue({ ...FULL_RUN, pipeline: { company: { ...FULL_RUN.pipeline.company, agents: [agent] } } });
    runAgentLoopMock.mockImplementation(async (p: any) => loopResult({ model: p.model, provider: "ANTHROPIC", totalCostUsd: 0.1 }));
    await executeStep("run-1", STEP_DEF, 0, {});
    const d = completedData();
    expect(runAgentLoopMock).toHaveBeenCalledTimes(2);
    expect(d.modelMode).toBe("COMPARE");
    expect(d.costUsd).toBeCloseTo(0.2);
    expect(d.output.model).toBe("m-a");
  });
  const withAgent = (a: Record<string, unknown>) =>
    runFindUnique.mockResolvedValue({ ...FULL_RUN, pipeline: { company: { ...FULL_RUN.pipeline.company, agents: [{ ...AGENT, ...a }] } } });

  it("(a) takeover varken kip DIRECT zorlanır", async () => {
    withAgent({ modelMode: "COMPARE", modelModeConfig: { compareModels: ["m-a", "m-b"] } });
    handoffFindFirst.mockImplementation(async (q: any) =>
      q?.where?.status === "CLAIMED"
        ? { id: "hl-1", stepIndex: 0, status: "CLAIMED", fromProvider: "ANTHROPIC", contextSummary: "x", checkpoint: { messages: [{ role: "user", content: "p" }], turn: 1 } }
        : null);
    runAgentLoopMock.mockResolvedValue(loopResult({ provider: "OLLAMA", model: "gemma3:4b" }));
    await executeStep("run-1", STEP_DEF, 0, {});
    const d = completedData();
    expect(runAgentLoopMock).toHaveBeenCalledTimes(1);
    expect(runAgentLoopMock.mock.calls[0][0].aiConfigOverride).toBeTruthy();
    expect(d.modelMode).toBe("DIRECT");
    expect(d.modeDetail).toMatchObject({ requested: "COMPARE", fallback: "takeover" });
  });
  it("(b) CASCADE ajan executor'dan geçer: modelMode CASCADE, costUsd toplam", async () => {
    withAgent({ model: "claude-sonnet-5-5", modelMode: "CASCADE", modelModeConfig: { cheapModel: "cheap-x" } });
    runAgentLoopMock.mockImplementation(async (p: any) =>
      p.model === "cheap-x"
        ? loopResult({ finalContent: "I cannot answer that.", model: "cheap-x", provider: "ANTHROPIC", totalCostUsd: 0.01 })
        : loopResult({ model: p.model, provider: "ANTHROPIC", totalCostUsd: 0.05 }));
    await executeStep("run-1", STEP_DEF, 0, {});
    const d = completedData();
    expect(runAgentLoopMock).toHaveBeenCalledTimes(2);
    expect(d.modelMode).toBe("CASCADE");
    expect(d.modeDetail).toMatchObject({ escalated: true, cheapModel: "cheap-x" });
    expect(d.costUsd).toBeCloseTo(0.06);
    expect(d.output.model).toBe("claude-sonnet-5-5");
  });
  it("(c) COMPARE araçlı ajan DIRECT fallback ile geçer", async () => {
    withAgent({ tools: ["web_search"], modelMode: "COMPARE", modelModeConfig: { compareModels: ["m-a", "m-b"] } });
    runAgentLoopMock.mockResolvedValue(loopResult({ provider: "ANTHROPIC", model: "claude-x" }));
    await executeStep("run-1", STEP_DEF, 0, {});
    const d = completedData();
    expect(runAgentLoopMock).toHaveBeenCalledTimes(1);
    expect(d.modelMode).toBe("DIRECT");
    expect(d.modeDetail).toMatchObject({ requested: "COMPARE", fallback: "compare_requires_toolless_agent" });
  });
});
