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
    handoffLedger: { findFirst: (...a: unknown[]) => handoffFindFirst(...a) },
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
