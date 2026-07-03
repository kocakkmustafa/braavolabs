/**
 * E3/T3 — executor catch → automatic handoff trigger wiring (plan §2.3b —
 * B3/B6.2). The step's FAILED marking is authoritative; the handoff trigger is
 * a best-effort side-effect layered on top:
 *
 *   • a MARKED provider chain-exhaustion (ProviderExhaustedError, FAILOVER)
 *     calls maybeOpenAutoHandoff AND the step still returns FAILED,
 *   • an UNMARKED generic error never calls the trigger,
 *   • maybeOpenAutoHandoff THROWING is swallowed — the step still returns
 *     FAILED, the throw never propagates (a propagated throw would let BullMQ
 *     attempts:2 re-run the step).
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

// runAgentLoop mocked to THROW the marker (chain exhaustion). HandoffInterrupt
// stays real (executor imports it for the interrupt branch).
const runAgentLoopMock = vi.hoisted(() => vi.fn());
vi.mock("../../agent/claude", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agent/claude")>();
  return { ...actual, runAgentLoop: (...a: unknown[]) => runAgentLoopMock(...a) };
});

// maybeOpenAutoHandoff mocked — this test is about the WIRING (called? swallowed?),
// its internals are covered by handoff.test.ts.
const maybeOpenAutoHandoffMock = vi.hoisted(() => vi.fn());
vi.mock("../../run/handoff.trigger", () => ({
  maybeOpenAutoHandoff: (...a: unknown[]) => maybeOpenAutoHandoffMock(...a),
}));

import { executeStep } from "../executor";
import { ProviderExhaustedError } from "../../../services/provider-chain";

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

beforeEach(() => {
  vi.clearAllMocks();
  runFindUnique.mockResolvedValue(FULL_RUN);
  runStepCreate.mockResolvedValue({ id: "rs-1", startedAt: new Date() });
  runStepUpdate.mockResolvedValue({});
  handoffFindFirst.mockResolvedValue(null);
  maybeOpenAutoHandoffMock.mockResolvedValue("hl-1");
});

describe("executor catch → auto handoff trigger", () => {
  it("MARKED FAILOVER exhaustion → trigger called AND step returns FAILED", async () => {
    const marker = ProviderExhaustedError.wrap("FAILOVER", "ANTHROPIC", "claude", new Error("401"));
    runAgentLoopMock.mockRejectedValue(marker);

    const result = await executeStep("run-1", STEP_DEF, 0, {});

    expect(result.status).toBe("FAILED");
    expect(maybeOpenAutoHandoffMock).toHaveBeenCalledTimes(1);
    expect(maybeOpenAutoHandoffMock).toHaveBeenCalledWith("run-1", marker);
    // The step was FAILED-marked regardless of the handoff.
    const failedUpdate = runStepUpdate.mock.calls.find((c) => c[0]?.data?.status === "FAILED");
    expect(failedUpdate).toBeTruthy();
  });

  it("UNMARKED generic error → trigger NOT called, step FAILED", async () => {
    runAgentLoopMock.mockRejectedValue(new Error("No AI provider configured"));

    const result = await executeStep("run-1", STEP_DEF, 0, {});

    expect(result.status).toBe("FAILED");
    expect(maybeOpenAutoHandoffMock).not.toHaveBeenCalled();
  });

  it("trigger THROWING is swallowed — step still returns FAILED, no propagation (B6.2)", async () => {
    runAgentLoopMock.mockRejectedValue(ProviderExhaustedError.wrap("FAILOVER", "ANTHROPIC", "claude", new Error("402")));
    maybeOpenAutoHandoffMock.mockRejectedValue(new Error("ledger write blew up"));

    // Must NOT throw — if it did, the executeStep call would reject.
    const result = await executeStep("run-1", STEP_DEF, 0, {});

    expect(result.status).toBe("FAILED");
    expect(maybeOpenAutoHandoffMock).toHaveBeenCalledTimes(1);
  });
});
