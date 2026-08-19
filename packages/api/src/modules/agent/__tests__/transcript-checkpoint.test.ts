/**
 * E3/T2 — live turn-boundary checkpoint + handoff interrupt (plan §2.2/§2.3a).
 * Mocked chatCompletion + prisma, zero network. Covers the plan's required
 * paths:
 *
 *   • turn-end persist: the canonical transcript lands in run_steps.transcript
 *     at the END of every governed turn (tool results included) — the crash
 *     carrier for "token ran out / session died mid-step",
 *   • 1MB truncation rule (first user message + last 6 turns, truncated:true),
 *   • ungoverned runs persist nothing and never touch the interrupt SELECTs,
 *   • turn-boundary interrupt (B2): PAUSED run / OPEN handoff ledger → the
 *     loop does NOT enter the next turn, freezes the ledger checkpoint
 *     (single writer), and exits via HandoffInterrupt,
 *   • executor: COMPLETED → transcript nulled (hygiene §2.2-3) + the
 *     step-boundary race guard; HandoffInterrupt → step back to PENDING with
 *     the transcript PRESERVED, result INTERRUPTED (never FAILED),
 *   • checkpoint writes/reads are error-swallowing — a DB hiccup must never
 *     kill a healthy run.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module mocks (declared before importing the SUT) ──

const envMock = vi.hoisted(() => ({
  LLM_PROVIDER: "api" as string | undefined,
  ANTHROPIC_API_KEY: "sk-ant-system-key" as string | undefined,
  CLAUDE_MODEL: "claude-sonnet-4-5-20250929",
  OFFLINE_MODE: false,
  NATIVE_TOOLUSE_PROVIDERS: undefined as string | undefined,
}));
vi.mock("../../../config/env", () => ({ env: envMock }));

vi.mock("../../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const steeringFindMany = vi.hoisted(() => vi.fn());
const steeringUpdateMany = vi.hoisted(() => vi.fn());
const aiConfigFindMany = vi.hoisted(() => vi.fn());
const tenantFindUnique = vi.hoisted(() => vi.fn());
const activityLogCreate = vi.hoisted(() => vi.fn());
const runFindUnique = vi.hoisted(() => vi.fn());
const runUpdate = vi.hoisted(() => vi.fn());
const runStepCreate = vi.hoisted(() => vi.fn());
const runStepUpdate = vi.hoisted(() => vi.fn());
const runStepFindMany = vi.hoisted(() => vi.fn());
const handoffFindFirst = vi.hoisted(() => vi.fn());
// OPEN-ledger behaviour, scripted per-test; the shared handoffFindFirst mock
// (beforeEach) routes non-CLAIMED lookups here so the T6 takeover resolver's
// CLAIMED query never consumes a test's OPEN script.
const handoffOpenFindFirst = vi.hoisted(() => vi.fn());
const handoffUpdate = vi.hoisted(() => vi.fn());
const toolCallCreateMany = vi.hoisted(() => vi.fn());
const toolCallFindMany = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/db", () => ({
  prisma: {
    steeringMessage: {
      findMany: (...a: unknown[]) => steeringFindMany(...a),
      updateMany: (...a: unknown[]) => steeringUpdateMany(...a),
    },
    userAIConfig: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      findMany: (...a: unknown[]) => aiConfigFindMany(...a),
    },
    tenant: { findUnique: (...a: unknown[]) => tenantFindUnique(...a) },
    activityLog: { create: (...a: unknown[]) => activityLogCreate(...a) },
    run: {
      findUnique: (...a: unknown[]) => runFindUnique(...a),
      update: (...a: unknown[]) => runUpdate(...a),
    },
    runStep: {
      create: (...a: unknown[]) => runStepCreate(...a),
      update: (...a: unknown[]) => runStepUpdate(...a),
      findMany: (...a: unknown[]) => runStepFindMany(...a),
    },
    handoffLedger: {
      findFirst: (...a: unknown[]) => handoffFindFirst(...a),
      update: (...a: unknown[]) => handoffUpdate(...a),
    },
    toolCall: {
      createMany: (...a: unknown[]) => toolCallCreateMany(...a),
      findMany: (...a: unknown[]) => toolCallFindMany(...a),
    },
  },
}));

const publishRunEventMock = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/runEvents", () => ({
  publishRunEvent: (...a: unknown[]) => publishRunEventMock(...a),
}));

vi.mock("../../../lib/telemetry", () => ({
  withSpan: async (_name: string, fn: () => unknown) => fn(),
  toolCallCounter: { add: vi.fn() },
  stepDurationHistogram: { record: vi.fn() },
}));

const decryptMock = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/encryption", () => ({
  decryptForTenant: (...a: unknown[]) => decryptMock(...a),
  encryptForTenant: vi.fn(() => "encrypted"),
}));

vi.mock("../../../lib/ssrf", () => ({
  assertSafeExternalUrl: async () => {},
  SsrfError: class SsrfError extends Error {},
}));

vi.mock("../registry", () => ({
  getTool: (name: string) =>
    name === "get_time"
      ? {
          name: "get_time",
          description: "Return the current time for a timezone",
          inputSchema: {
            type: "object",
            properties: { timezone: { type: "string" } },
            required: ["timezone"],
          },
          handler: async () => ({ time: "now" }),
        }
      : undefined,
}));

const executeToolMock = vi.hoisted(() => vi.fn());
vi.mock("../tool-executor", () => ({
  executeTool: (...a: unknown[]) => executeToolMock(...a),
}));

vi.mock("../claude-local", () => ({ runLocalAgentLoop: vi.fn() }));

const tryConsumeTrialRunMock = vi.hoisted(() => vi.fn());
const commitTrialRunMock = vi.hoisted(() => vi.fn());
const refundTrialReservationMock = vi.hoisted(() => vi.fn());
vi.mock("../../../services/trial-llm", () => ({
  tryConsumeTrialRun: (...a: unknown[]) => tryConsumeTrialRunMock(...a),
  commitTrialRun: (...a: unknown[]) => commitTrialRunMock(...a),
  refundTrialReservation: (...a: unknown[]) => refundTrialReservationMock(...a),
}));

// ai-client — ONLY chatCompletion mocked; everything else REAL.
const chatCompletionMock = vi.hoisted(() => vi.fn());
vi.mock("../../../services/ai-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../services/ai-client")>();
  return {
    ...actual,
    chatCompletion: (...a: unknown[]) => chatCompletionMock(...a),
  };
});

import { Prisma } from "@prisma/client";
import {
  runProviderAgentLoop,
  serializeCheckpoint,
  HandoffInterrupt,
  CHECKPOINT_MAX_BYTES,
  type AgentGovContext,
} from "../claude";
import { executeStep } from "../../pipeline/executor";
import {
  type ChatCompletionResult,
  type AIClientConfig,
  type ChatMessage,
} from "../../../services/ai-client";
import { resetProviderCircuits } from "../../../services/provider-chain";

const GROQ_CONFIG: AIClientConfig = {
  provider: "GROQ",
  model: "llama-3.3-70b-versatile",
  apiKey: "gsk-test",
};

const GOV: AgentGovContext = {
  tenantId: "tenant-1",
  companyId: "co-1",
  runId: "run-1",
  runStepId: "rs-1",
};

const AGENT = {
  id: "agent-1",
  name: "Researcher",
  role: "researcher",
  systemPrompt: "agent sys",
  tools: ["get_time"],
  model: null,
  maxTokens: null,
  autonomy: "BALANCED",
};

const FULL_RUN = {
  id: "run-1",
  budgetUsd: 1,
  pipeline: {
    company: { id: "co-1", name: "Acme", tenantId: "tenant-1", agents: [AGENT] },
  },
};

const STEP_DEF = { name: "research", agentRole: "researcher", order: 0 };

function completion(partial: Partial<ChatCompletionResult>): ChatCompletionResult {
  return {
    content: "",
    inputTokens: 10,
    outputTokens: 5,
    model: "llama-3.3-70b-versatile",
    provider: "GROQ",
    stopReason: "stop",
    ...partial,
  };
}

function seedTenantProvider(cfg: AIClientConfig): void {
  aiConfigFindMany.mockResolvedValue([
    {
      id: "cfg-1",
      tenantId: "tenant-1",
      provider: cfg.provider,
      model: cfg.model,
      encryptedApiKey: cfg.apiKey ? `enc:${cfg.apiKey}` : null,
      baseUrl: cfg.baseUrl ?? null,
      isDefault: true,
      fallbackOrder: null,
      allowSystemFallback: false,
      createdAt: new Date(2026, 0, 1),
    },
  ]);
  decryptMock.mockImplementation((blob: string) => {
    if (blob === `enc:${cfg.apiKey}`) return cfg.apiKey;
    throw new Error("decrypt failed");
  });
}

/** runStep.update calls that carry a NON-NULL transcript (live persists). */
function transcriptPersists(): Array<{ where: { id: string }; data: { transcript: any } }> {
  return runStepUpdate.mock.calls
    .map((c) => c[0] as { where: { id: string }; data: Record<string, unknown> })
    .filter(
      (c) =>
        c?.data &&
        "transcript" in c.data &&
        c.data.transcript !== null &&
        c.data.transcript !== Prisma.DbNull,
    ) as Array<{ where: { id: string }; data: { transcript: any } }>;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetProviderCircuits();
  envMock.ANTHROPIC_API_KEY = "sk-ant-system-key";
  seedTenantProvider({ ...GROQ_CONFIG });
  tenantFindUnique.mockResolvedValue({ plan: "PRO" });
  activityLogCreate.mockResolvedValue({});
  steeringFindMany.mockResolvedValue([]);
  steeringUpdateMany.mockResolvedValue({ count: 0 });
  executeToolMock.mockResolvedValue({ status: "SUCCESS", output: { ok: true }, durationMs: 3 });
  tryConsumeTrialRunMock.mockResolvedValue(null);
  runFindUnique.mockImplementation((args: any) =>
    Promise.resolve(args?.select?.status ? { status: "RUNNING" } : FULL_RUN),
  );
  runUpdate.mockResolvedValue({});
  runStepCreate.mockResolvedValue({ id: "rs-1", startedAt: new Date() });
  runStepUpdate.mockResolvedValue({});
  // D-015: the freeze path reads COMPLETED step names for the mechanical
  // summary. Default: none completed (single-step run) — tests that assert on
  // the summary's "Completed steps:" prefix script this per-case.
  runStepFindMany.mockResolvedValue([]);
  // handoffLedger.findFirst is queried by TWO distinct call sites with distinct
  // statuses: the T6 takeover resolver (status:"CLAIMED", at the top of
  // executeStep) and the T2 interrupt/race-guard checks (status:"OPEN"). These
  // T2 tests don't exercise takeover, so the CLAIMED lookup always resolves null
  // here; individual tests script the OPEN behaviour via handoffOpenFindFirst.
  handoffOpenFindFirst.mockResolvedValue(null);
  handoffFindFirst.mockImplementation((args: any) =>
    args?.where?.status === "CLAIMED" ? Promise.resolve(null) : handoffOpenFindFirst(args),
  );
  handoffUpdate.mockResolvedValue({});
  toolCallCreateMany.mockResolvedValue({ count: 0 });
  toolCallFindMany.mockResolvedValue([]);
});

// ── Turn-end persist (§2.2-1) ──

describe("live checkpoint — turn-end persist to run_steps.transcript", () => {
  it("persists the canonical transcript at the END of every governed turn, tool results included", async () => {
    chatCompletionMock
      .mockResolvedValueOnce(
        completion({
          content: "Checking the clock.",
          toolCalls: [{ id: "c1", name: "get_time", argumentsJson: '{"timezone":"UTC"}' }],
          stopReason: "tool_calls",
        }),
      )
      .mockResolvedValueOnce(completion({ content: "It is 14:00 UTC." }));

    await runProviderAgentLoop(
      { systemPrompt: "sys", userMessage: "what time?", toolNames: ["get_time"], govContext: GOV },
      { ...GROQ_CONFIG },
    );

    const persists = transcriptPersists();
    expect(persists).toHaveLength(2);
    expect(persists[0].where).toEqual({ id: "rs-1" });

    // Turn 1: user + assistant(toolCalls) + tool result — the FULL turn.
    const first = persists[0].data.transcript;
    expect(first.messages.map((m: ChatMessage) => m.role)).toEqual(["user", "assistant", "tool"]);
    expect(first.messages[2].content).toBe(JSON.stringify({ ok: true }));
    expect(first.turn).toBe(1);

    // Turn 2 (final): the closing assistant message travels in the
    // checkpoint too (folded into a checkpoint-only copy).
    const second = persists[1].data.transcript;
    expect(second.messages.map((m: ChatMessage) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(second.messages[3].content).toBe("It is 14:00 UTC.");
    expect(second.turn).toBe(2);
    expect(second.toolUseMode).toBe("native");
    expect(second.truncated).toBe(false);
    expect(second.systemPromptHash).toMatch(/^[0-9a-f]{16}$/);
    expect(second.costSoFarUsd).toBeGreaterThan(0);
  });

  it("persists NOTHING on ungoverned runs and never touches the interrupt SELECTs", async () => {
    chatCompletionMock.mockResolvedValue(completion({ content: "ok" }));

    await runProviderAgentLoop(
      { systemPrompt: "sys", userMessage: "go", toolNames: [] },
      { ...GROQ_CONFIG },
    );

    expect(runStepUpdate).not.toHaveBeenCalled();
    expect(runFindUnique).not.toHaveBeenCalled();
    expect(handoffFindFirst).not.toHaveBeenCalled();
  });

  it("swallows checkpoint-persist and interrupt-check DB errors — the run must not die", async () => {
    chatCompletionMock.mockResolvedValue(completion({ content: "fine" }));
    runFindUnique.mockRejectedValue(new Error("db down"));
    handoffFindFirst.mockRejectedValue(new Error("db down"));
    runStepUpdate.mockRejectedValue(new Error("db down"));

    const result = await runProviderAgentLoop(
      { systemPrompt: "sys", userMessage: "go", toolNames: [], govContext: GOV },
      { ...GROQ_CONFIG },
    );

    expect(result.finalContent).toBe("fine");
  });
});

// ── 1MB truncation rule (§2.2-1) ──

describe("serializeCheckpoint — 1MB cap", () => {
  function turnsOf(n: number, payload: string): ChatMessage[] {
    const messages: ChatMessage[] = [{ role: "user", content: "step prompt" }];
    for (let i = 0; i < n; i++) {
      messages.push({
        role: "assistant",
        content: `turn ${i}`,
        toolCalls: [{ id: `c${i}`, name: "t", argumentsJson: "{}" }],
      });
      messages.push({ role: "tool", toolCallId: `c${i}`, content: payload });
    }
    return messages;
  }

  it("keeps small transcripts whole (truncated:false)", () => {
    const messages = turnsOf(3, "small");
    const cp = serializeCheckpoint(messages, 3, "native", 0.01, "abcd1234abcd1234");
    expect(cp.truncated).toBe(false);
    expect(cp.messages).toEqual(messages);
    expect(cp.turn).toBe(3);
  });

  it("drops the oldest turns past 1MB: first user message + last 6 turns, truncated:true", () => {
    const messages = turnsOf(10, "x".repeat(120_000)); // ~1.2MB
    const cp = serializeCheckpoint(messages, 10, "native", 0.5, "abcd1234abcd1234");
    expect(cp.truncated).toBe(true);
    expect(cp.messages[0]).toEqual({ role: "user", content: "step prompt" });
    expect(cp.messages.filter((m) => m.role === "assistant")).toHaveLength(6);
    // The newest turn survives whole.
    expect(cp.messages[cp.messages.length - 2].content).toBe("turn 9");
    expect(Buffer.byteLength(JSON.stringify(cp), "utf8")).toBeLessThanOrEqual(
      CHECKPOINT_MAX_BYTES,
    );
  });

  it("halves further (6 → 3 turns) when the last 6 still exceed the cap", () => {
    const messages = turnsOf(8, "y".repeat(300_000)); // 6 turns alone = ~1.8MB
    const cp = serializeCheckpoint(messages, 8, "native", 0.5, "abcd1234abcd1234");
    expect(cp.truncated).toBe(true);
    expect(cp.messages.filter((m) => m.role === "assistant")).toHaveLength(3);
    expect(Buffer.byteLength(JSON.stringify(cp), "utf8")).toBeLessThanOrEqual(
      CHECKPOINT_MAX_BYTES,
    );
  });
});

// ── Turn-boundary interrupt (§2.3a-2 — B2) ──

describe("turn-boundary interrupt — PAUSED run / OPEN handoff ledger", () => {
  it("does NOT enter the next turn: persists, freezes the ledger checkpoint, throws HandoffInterrupt", async () => {
    chatCompletionMock.mockResolvedValue(
      completion({
        content: "Working.",
        toolCalls: [{ id: "c1", name: "get_time", argumentsJson: "{}" }],
        stopReason: "tool_calls",
      }),
    );
    // Turn-0 check: healthy. Turn-1 check: run PAUSED + OPEN ledger waiting
    // for its checkpoint to be frozen (the manual /handoff endpoint state).
    let statusChecks = 0;
    runFindUnique.mockImplementation((args: any) => {
      if (args?.select?.status) {
        statusChecks += 1;
        return Promise.resolve({ status: statusChecks >= 2 ? "PAUSED" : "RUNNING" });
      }
      return Promise.resolve(FULL_RUN);
    });
    handoffFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ id: "hl-1", checkpoint: null });

    await expect(
      runProviderAgentLoop(
        { systemPrompt: "sys", userMessage: "go", toolNames: ["get_time"], govContext: GOV },
        { ...GROQ_CONFIG },
      ),
    ).rejects.toBeInstanceOf(HandoffInterrupt);

    // The loop never dialed turn 2.
    expect(chatCompletionMock).toHaveBeenCalledTimes(1);

    // The OPEN ledger's checkpoint was FROZEN with the full turn-1 transcript.
    expect(handoffUpdate).toHaveBeenCalledTimes(1);
    const frozen = handoffUpdate.mock.calls[0][0];
    expect(frozen.where).toEqual({ id: "hl-1" });
    expect(frozen.data.checkpoint.messages.map((m: ChatMessage) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
    ]);
    expect(frozen.data.checkpoint.turn).toBe(1);

    // D-015: the freeze ALSO refreshes contextSummary from the REAL checkpoint
    // messages — the manual-early-handoff placeholder is replaced with the
    // genuine mid-step note (built from the same "Working." assistant turn).
    expect(frozen.data.contextSummary).toContain("Last provider left off: Working.");
    expect(frozen.data.contextSummary).not.toBe("No prior context captured.");

    // The interrupt also persisted the live transcript (crash carrier):
    // once at turn-1 end + once inside the interrupt handler.
    expect(transcriptPersists().length).toBeGreaterThanOrEqual(2);
  });

  it("D-015: refreshes contextSummary from checkpoint messages (with completed-step names) on freeze", async () => {
    chatCompletionMock.mockResolvedValue(
      completion({
        content: "Drafting the outline now.",
        toolCalls: [{ id: "c1", name: "get_time", argumentsJson: "{}" }],
        stopReason: "tool_calls",
      }),
    );
    let statusChecks = 0;
    runFindUnique.mockImplementation((args: any) => {
      if (args?.select?.status) {
        statusChecks += 1;
        return Promise.resolve({ status: statusChecks >= 2 ? "PAUSED" : "RUNNING" });
      }
      return Promise.resolve(FULL_RUN);
    });
    handoffFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ id: "hl-9", checkpoint: null });
    // Two earlier steps already completed — they must surface in the summary.
    runStepFindMany.mockResolvedValue([{ name: "research" }, { name: "gather" }]);

    await expect(
      runProviderAgentLoop(
        { systemPrompt: "sys", userMessage: "go", toolNames: ["get_time"], govContext: GOV },
        { ...GROQ_CONFIG },
      ),
    ).rejects.toBeInstanceOf(HandoffInterrupt);

    expect(handoffUpdate).toHaveBeenCalledTimes(1);
    const frozen = handoffUpdate.mock.calls[0][0];
    expect(frozen.where).toEqual({ id: "hl-9" });
    // Completed-step prefix + the real "left off" note, NOT the placeholder.
    expect(frozen.data.contextSummary).toBe(
      "Completed steps: research, gather. Last provider left off: Drafting the outline now. " +
        "Pending tool calls: get_time. (1 turn(s) into the step; " +
        `$${frozen.data.checkpoint.costSoFarUsd.toFixed(4)} spent.)`,
    );
  });

  it("D-015: freezes the checkpoint even when the completed-step read throws (summary from checkpoint only)", async () => {
    chatCompletionMock.mockResolvedValue(
      completion({
        content: "Halfway through the analysis.",
        toolCalls: [{ id: "c1", name: "get_time", argumentsJson: "{}" }],
        stopReason: "tool_calls",
      }),
    );
    let statusChecks = 0;
    runFindUnique.mockImplementation((args: any) => {
      if (args?.select?.status) {
        statusChecks += 1;
        return Promise.resolve({ status: statusChecks >= 2 ? "PAUSED" : "RUNNING" });
      }
      return Promise.resolve(FULL_RUN);
    });
    handoffFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ id: "hl-11", checkpoint: null });
    runStepFindMany.mockRejectedValue(new Error("db down")); // best-effort read fails

    await expect(
      runProviderAgentLoop(
        { systemPrompt: "sys", userMessage: "go", toolNames: ["get_time"], govContext: GOV },
        { ...GROQ_CONFIG },
      ),
    ).rejects.toBeInstanceOf(HandoffInterrupt);

    // Freeze still happened; summary built from the checkpoint alone (no
    // "Completed steps:" prefix), NOT the placeholder.
    expect(handoffUpdate).toHaveBeenCalledTimes(1);
    const frozen = handoffUpdate.mock.calls[0][0];
    expect(frozen.data.contextSummary).toContain(
      "Last provider left off: Halfway through the analysis.",
    );
    expect(frozen.data.contextSummary).not.toContain("Completed steps:");
    expect(frozen.data.contextSummary).not.toBe("No prior context captured.");
  });

  it("never overwrites an already-frozen ledger checkpoint (immutable audit copy)", async () => {
    handoffFindFirst.mockResolvedValue({
      id: "hl-3",
      checkpoint: { messages: [], stepBoundary: true },
    });

    await expect(
      runProviderAgentLoop(
        { systemPrompt: "sys", userMessage: "go", toolNames: [], govContext: GOV },
        { ...GROQ_CONFIG },
      ),
    ).rejects.toBeInstanceOf(HandoffInterrupt);

    expect(chatCompletionMock).not.toHaveBeenCalled(); // interrupted before the first dial
    expect(handoffUpdate).not.toHaveBeenCalled();
  });
});

// ── Executor integration (COMPLETED hygiene + race guard + PENDING reset) ──

describe("executor — COMPLETED hygiene and HandoffInterrupt handling", () => {
  it("nulls run_steps.transcript when the step COMPLETES (§2.2-3 hygiene)", async () => {
    chatCompletionMock.mockResolvedValue(completion({ content: "done" }));

    const res = await executeStep("run-1", STEP_DEF, 0, {});

    expect(res.status).toBe("COMPLETED");
    const completedCall = runStepUpdate.mock.calls.find(
      (c) => (c[0] as any)?.data?.status === "COMPLETED",
    );
    expect(completedCall).toBeDefined();
    expect((completedCall![0] as any).data.transcript).toBe(Prisma.DbNull);
    expect(publishRunEventMock).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({ type: "STEP_COMPLETED" }),
    );
    expect(handoffUpdate).not.toHaveBeenCalled(); // no OPEN ledger → no freeze
  });

  it("freezes a null-checkpoint OPEN ledger to a STEP-BOUNDARY handoff on the COMPLETED path (§2.2-3 race guard)", async () => {
    chatCompletionMock.mockResolvedValue(completion({ content: "done" }));
    // The T6 takeover resolver's CLAIMED lookup returns null (beforeEach); only
    // the OPEN lookups are scripted here.
    handoffOpenFindFirst
      .mockResolvedValueOnce(null) // turn-0 interrupt check: handoff not requested yet
      .mockResolvedValue({ id: "hl-2", checkpoint: null }); // appears as the step finishes

    const res = await executeStep("run-1", STEP_DEF, 0, {});

    expect(res.status).toBe("COMPLETED");
    expect(handoffUpdate).toHaveBeenCalledExactlyOnceWith({
      where: { id: "hl-2" },
      data: { checkpoint: { messages: [], stepBoundary: true } },
    });
  });

  it("resets the step to PENDING on HandoffInterrupt — no error, transcript PRESERVED, result INTERRUPTED", async () => {
    chatCompletionMock.mockResolvedValue(
      completion({
        content: "Working.",
        toolCalls: [{ id: "c1", name: "get_time", argumentsJson: "{}" }],
        stopReason: "tool_calls",
      }),
    );
    handoffOpenFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ id: "hl-1", checkpoint: null });

    const res = await executeStep("run-1", STEP_DEF, 0, {});

    expect(res.status).toBe("INTERRUPTED");
    expect(res.costUsd).toBe(0);
    expect(res.toolCallIds).toEqual([]);

    // Last write: PENDING reset — error/timestamps cleared, and crucially
    // NO transcript key (the checkpoint stays for the takeover).
    const last = runStepUpdate.mock.calls.at(-1)![0] as any;
    expect(last.where).toEqual({ id: "rs-1" });
    expect(last.data).toMatchObject({
      status: "PENDING",
      error: null,
      startedAt: null,
      completedAt: null,
    });
    expect("transcript" in last.data).toBe(false);

    // The ledger was frozen by the loop (single writer).
    expect(handoffUpdate).toHaveBeenCalledTimes(1);

    // Neither completed nor failed on the event stream.
    const types = publishRunEventMock.mock.calls.map((c) => (c[1] as any)?.type);
    expect(types).toContain("STEP_STARTED");
    expect(types).not.toContain("STEP_FAILED");
    expect(types).not.toContain("STEP_COMPLETED");
  });
});
