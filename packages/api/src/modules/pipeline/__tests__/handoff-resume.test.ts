/**
 * E3/T6 — takeover EXECUTION (plan §2.5). Two layers, mocked prisma + agent
 * loop, zero network:
 *
 *   1. takeover-config (resolveTakeoverConfig / assertKeylessLocalBaseUrl):
 *      • keyless-local → apiKey "" + claimBaseUrl from the checkpoint,
 *      • prod keyless-local WITHOUT a baseUrl → REJECTED (B4c),
 *      • cloud → the tenant's decrypted BYOK link for toProvider,
 *      • a claimed cloud provider that's no longer configured → hard error.
 *
 *   2. executor takeover branch:
 *      • a CLAIMED ledger for this run+stepIndex drives runAgentLoop with
 *        aiConfigOverride (which skips the tenant chain / trial resolution — the
 *        E2/T5 override contract) AND resumeMessages = frozen checkpoint +
 *        handoff note, and does NOT rely on userMessage for content,
 *      • step COMPLETED → ledger COMPLETED,
 *      • step FAILED → ledger FAILED,
 *      • no CLAIMED ledger → plain run, no override/resume.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks (declared before importing the SUT) ──

vi.mock("../../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const runFindUnique = vi.hoisted(() => vi.fn());
const runStepCreate = vi.hoisted(() => vi.fn());
const runStepUpdate = vi.hoisted(() => vi.fn());
const handoffFindFirst = vi.hoisted(() => vi.fn());
const handoffUpdate = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/db", () => ({
  prisma: {
    run: { findUnique: (...a: unknown[]) => runFindUnique(...a) },
    runStep: {
      create: (...a: unknown[]) => runStepCreate(...a),
      update: (...a: unknown[]) => runStepUpdate(...a),
    },
    handoffLedger: {
      findFirst: (...a: unknown[]) => handoffFindFirst(...a),
      update: (...a: unknown[]) => handoffUpdate(...a),
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

// runAgentLoop mocked — the executor branch is about HOW it's called (override,
// resumeMessages, no userMessage insertion). buildHandoffResumeNote /
// HandoffInterrupt stay real (the executor imports both).
const runAgentLoopMock = vi.hoisted(() => vi.fn());
vi.mock("../../agent/claude", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agent/claude")>();
  return { ...actual, runAgentLoop: (...a: unknown[]) => runAgentLoopMock(...a) };
});

// resolveTakeoverConfig mocked at the executor layer so the branch test is
// independent of decrypt internals (those are covered directly below).
const resolveTakeoverConfigMock = vi.hoisted(() => vi.fn());
vi.mock("../../../services/takeover-config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../services/takeover-config")>();
  return { ...actual, resolveTakeoverConfig: (...a: unknown[]) => resolveTakeoverConfigMock(...a) };
});

// The auto-trigger is irrelevant to the resume path — stub it so a takeover
// FAILURE doesn't drag in the trigger wiring (covered by its own test).
vi.mock("../../run/handoff.trigger", () => ({ maybeOpenAutoHandoff: vi.fn() }));

import { executeStep } from "../executor";
import type { AgentLoopResult } from "../../agent/claude";

const AGENT = {
  id: "agent-1",
  name: "Researcher",
  role: "researcher",
  systemPrompt: "sys",
  tools: [] as string[],
  model: null,
  maxTokens: null,
  autonomy: "BALANCED",
};
const FULL_RUN = {
  id: "run-1",
  budgetUsd: 1,
  pipeline: { company: { id: "co-1", name: "Acme", tenantId: "tenant-1", agents: [AGENT] } },
};
const STEP_DEF = { name: "research", agentRole: "researcher", order: 0 };

const OLLAMA_CFG = { provider: "OLLAMA" as const, model: "gemma3:4b", apiKey: "", baseUrl: "http://gpu:11434/v1" };

function loopResult(partial: Partial<AgentLoopResult> = {}): AgentLoopResult {
  return {
    finalContent: "## Reasoning\ndone\n\nresult",
    turns: [{ content: "result", toolCalls: [], inputTokens: 1, outputTokens: 1, costUsd: 0, stopReason: "stop" }],
    totalInputTokens: 1,
    totalOutputTokens: 1,
    totalCostUsd: 0,
    totalToolCalls: 0,
    toolUseMode: "prompt-fallback",
    provider: "OLLAMA",
    model: "gemma3:4b",
    ...partial,
  } as AgentLoopResult;
}

/** A CLAIMED ledger for run-1 / stepIndex 0 with a frozen 1-turn transcript. */
function claimedLedger(over: Record<string, unknown> = {}) {
  return {
    id: "hl-1",
    tenantId: "tenant-1",
    runId: "run-1",
    stepIndex: 0,
    status: "CLAIMED",
    fromProvider: "ANTHROPIC",
    fromModel: "claude-sonnet-4-5",
    toProvider: "OLLAMA",
    toModel: "gemma3:4b",
    contextSummary: "Completed steps: plan. Last provider left off: draft…",
    checkpoint: {
      messages: [
        { role: "user", content: "original step prompt" },
        { role: "assistant", content: "half-done", toolCalls: [] },
      ],
      turn: 1,
      toolUseMode: "native",
      costSoFarUsd: 0.02,
      claimBaseUrl: "http://gpu:11434/v1",
    },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  runFindUnique.mockResolvedValue(FULL_RUN);
  runStepCreate.mockResolvedValue({ id: "rs-new", startedAt: new Date() });
  runStepUpdate.mockResolvedValue({});
  handoffFindFirst.mockResolvedValue(null);
  handoffUpdate.mockResolvedValue({});
  runAgentLoopMock.mockResolvedValue(loopResult());
  resolveTakeoverConfigMock.mockResolvedValue({ ...OLLAMA_CFG });
});

// ── Executor takeover branch ──

describe("executor takeover branch — resumeMessages + aiConfigOverride, no userMessage", () => {
  it("drives runAgentLoop with the override config + resumed transcript ending in the handoff note", async () => {
    handoffFindFirst.mockResolvedValue(claimedLedger());

    await executeStep("run-1", STEP_DEF, 0, {});

    // The CLAIMED lookup used status:"CLAIMED" for this run+stepIndex.
    expect(handoffFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { runId: "run-1", stepIndex: 0, status: "CLAIMED" } }),
    );

    expect(runAgentLoopMock).toHaveBeenCalledTimes(1);
    const cfg = runAgentLoopMock.mock.calls[0][0] as {
      aiConfigOverride?: unknown;
      resumeMessages?: Array<{ role: string; content: string }>;
      userMessage: string;
    };

    // aiConfigOverride forces the takeover provider (skips tenant chain/trial).
    expect(cfg.aiConfigOverride).toEqual(OLLAMA_CFG);

    // resumeMessages = frozen checkpoint messages + a trailing user handoff note.
    expect(cfg.resumeMessages).toBeDefined();
    const rm = cfg.resumeMessages!;
    expect(rm.slice(0, 2)).toEqual([
      { role: "user", content: "original step prompt" },
      { role: "assistant", content: "half-done", toolCalls: [] },
    ]);
    const note = rm[rm.length - 1];
    expect(note.role).toBe("user");
    expect(note.content).toContain("[Handoff]");
    expect(note.content).toContain("ANTHROPIC"); // leaving provider
    expect(note.content).toContain("turn 1"); // checkpoint turn
    expect(note.content).toContain("Last provider left off"); // context summary embedded

    // userMessage is still passed (type requires it) but is NOT what the loop
    // resumes from — the resume note carries the continuation, and the step
    // prompt already lives inside resumeMessages[0]. Assert it's NOT appended as
    // an extra resume turn.
    expect(rm.some((m) => m.content === cfg.userMessage && m !== rm[0])).toBe(false);
  });

  it("marks the ledger COMPLETED when the takeover step completes", async () => {
    handoffFindFirst.mockResolvedValue(claimedLedger());

    const res = await executeStep("run-1", STEP_DEF, 0, {});

    expect(res.status).toBe("COMPLETED");
    expect(handoffUpdate).toHaveBeenCalledWith({
      where: { id: "hl-1" },
      data: { status: "COMPLETED", completedAt: expect.any(Date) },
    });
    // B6.5: the new RunStep row records the ledger id in its output meta.
    const completedUpdate = runStepUpdate.mock.calls.find(
      (c) => (c[0] as any)?.data?.status === "COMPLETED",
    );
    expect((completedUpdate![0] as any).data.output.handoffLedgerId).toBe("hl-1");
  });

  it("marks the ledger FAILED when the takeover step fails", async () => {
    handoffFindFirst.mockResolvedValue(claimedLedger());
    runAgentLoopMock.mockRejectedValue(new Error("takeover provider blew up"));

    const res = await executeStep("run-1", STEP_DEF, 0, {});

    expect(res.status).toBe("FAILED");
    expect(handoffUpdate).toHaveBeenCalledWith({
      where: { id: "hl-1" },
      data: { status: "FAILED", completedAt: expect.any(Date) },
    });
  });

  it("no CLAIMED ledger → plain run, no override / no resumeMessages", async () => {
    // beforeEach default: handoffFindFirst → null.
    await executeStep("run-1", STEP_DEF, 0, {});

    const cfg = runAgentLoopMock.mock.calls[0][0] as Record<string, unknown>;
    expect(cfg.aiConfigOverride).toBeUndefined();
    expect(cfg.resumeMessages).toBeUndefined();
    expect(resolveTakeoverConfigMock).not.toHaveBeenCalled();
    expect(handoffUpdate).not.toHaveBeenCalled();
  });

  it("a step-boundary handoff (empty frozen messages) resumes with NO messages (runs fresh under the takeover provider)", async () => {
    handoffFindFirst.mockResolvedValue(
      claimedLedger({ checkpoint: { messages: [], stepBoundary: true } }),
    );

    await executeStep("run-1", STEP_DEF, 0, {});

    const cfg = runAgentLoopMock.mock.calls[0][0] as { aiConfigOverride?: unknown; resumeMessages?: unknown[] };
    // Still a takeover (override applied) but no resume transcript → the loop
    // falls back to its normal [context, userMessage] seed.
    expect(cfg.aiConfigOverride).toEqual(OLLAMA_CFG);
    expect(cfg.resumeMessages).toEqual([]);
  });
});
