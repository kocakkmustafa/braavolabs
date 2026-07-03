/**
 * E5/T1 — executor agentRole matcher is exact-match-FIRST (adversarial A3/B6).
 *
 * A shared "imported-automations" bucket can hold a short-named legacy agent
 * (e.g. name "op") alongside the synthesized `imported_operator`. The old loose
 * `.find()` (role/name/startsWith/includes, first match wins) could bind a step
 * to the WRONG agent depending on array order. This test seeds the legacy agent
 * FIRST and asserts the exact-role agent is still chosen.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const runFindUnique = vi.hoisted(() => vi.fn());
const runStepCreate = vi.hoisted(() => vi.fn());
const runStepUpdate = vi.hoisted(() => vi.fn());
const handoffLedgerFindFirst = vi.hoisted(() => vi.fn());
const runAgentLoopMock = vi.hoisted(() => vi.fn());
const publishRunEventMock = vi.hoisted(() => vi.fn());

vi.mock("../../../lib/db", () => ({
  prisma: {
    run: { findUnique: (...a: unknown[]) => runFindUnique(...a) },
    runStep: {
      create: (...a: unknown[]) => runStepCreate(...a),
      update: (...a: unknown[]) => runStepUpdate(...a),
    },
    handoffLedger: { findFirst: (...a: unknown[]) => handoffLedgerFindFirst(...a) },
  },
}));
vi.mock("../../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../../lib/runEvents", () => ({
  publishRunEvent: (...a: unknown[]) => publishRunEventMock(...a),
}));
vi.mock("../../agent/claude", () => ({
  runAgentLoop: (...a: unknown[]) => runAgentLoopMock(...a),
  HandoffInterrupt: class HandoffInterrupt extends Error {},
  buildHandoffResumeNote: vi.fn(),
}));
vi.mock("../../../services/provider-chain", () => ({ isHandoffTriggerEligible: () => false }));
vi.mock("../../../services/takeover-config", () => ({ resolveTakeoverConfig: vi.fn() }));
vi.mock("../../run/handoff.trigger", () => ({ maybeOpenAutoHandoff: vi.fn() }));
vi.mock("../../../lib/telemetry", () => ({
  withSpan: async (_n: string, fn: any) => fn({ end: vi.fn(), setAttribute: vi.fn() }),
  toolCallCounter: { add: vi.fn() },
  stepDurationHistogram: { record: vi.fn() },
}));

import { executeStep, type StepDef } from "../executor";
import { IMPORTED_OPERATOR_ROLE } from "../../automation-importer/agent-synthesis";

beforeEach(() => {
  vi.clearAllMocks();
  handoffLedgerFindFirst.mockResolvedValue(null);
  runStepCreate.mockResolvedValue({ id: "rs-1", startedAt: new Date() });
  runStepUpdate.mockResolvedValue({});
  runAgentLoopMock.mockResolvedValue({
    finalContent: "done",
    turns: [],
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostUsd: 0,
    totalToolCalls: 0,
  });
});

describe("executor matcher — exact-role-first", () => {
  it("binds imported_operator step to the exact agent, not a short-named legacy agent listed first", async () => {
    runFindUnique.mockResolvedValue({
      id: "run-1",
      budgetUsd: 1,
      input: {},
      pipeline: {
        company: {
          id: "co-1",
          name: "Imported automations",
          tenantId: "tenant-1",
          agents: [
            // Legacy agent FIRST — its lowercased name "op" is a substring of
            // "imported_operator", so the old includes() branch would match it.
            { id: "legacy", name: "op", role: "legacy", systemPrompt: "legacy", tools: [], model: "m", maxTokens: 100, autonomy: "SUPERVISED" },
            { id: "synth", name: "Imported Operator Agent", role: IMPORTED_OPERATOR_ROLE, systemPrompt: "operator", tools: [], model: "m", maxTokens: 100, autonomy: "SUPERVISED" },
          ],
        },
      },
    });

    const step: StepDef = { name: "Fetch", agentRole: IMPORTED_OPERATOR_ROLE, order: 0 };
    await executeStep("run-1", step, 0);

    // The RunStep must be created with the EXACT-role agent's id.
    expect(runStepCreate).toHaveBeenCalled();
    expect(runStepCreate.mock.calls[0][0].data.agentId).toBe("synth");
  });

  it("throws a clear error when agentRole is empty (no agent assigned)", async () => {
    runFindUnique.mockResolvedValue({
      id: "run-1",
      budgetUsd: 1,
      input: {},
      pipeline: { company: { id: "co-1", name: "c", tenantId: "t", agents: [] } },
    });
    const step = { name: "x", agentRole: "", order: 0 } as StepDef;
    await expect(executeStep("run-1", step, 0)).rejects.toThrow(/no agent assigned/i);
  });
});
