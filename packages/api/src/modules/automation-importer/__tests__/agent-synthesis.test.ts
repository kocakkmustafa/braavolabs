/**
 * E5/T1 — deriveAgentsFromSteps + finalizeSteps + roleForSourceType are
 * deterministic and cover all 5 adapters' source types with the fixed 2 roles.
 */
import { describe, it, expect } from "vitest";
import {
  finalizeSteps,
  deriveAgentsFromSteps,
  roleForSourceType,
  IMPORTED_LLM_ROLE,
  IMPORTED_OPERATOR_ROLE,
} from "../agent-synthesis";
import type { RawStep } from "../adapters/types";

describe("roleForSourceType — deterministic fixed-2-role map", () => {
  it("LLM/prompt/routine → imported_llm", () => {
    expect(roleForSourceType("llm")).toBe(IMPORTED_LLM_ROLE);
    expect(roleForSourceType("prompt")).toBe(IMPORTED_LLM_ROLE);
    expect(roleForSourceType("claude-routine-step")).toBe(IMPORTED_LLM_ROLE);
  });

  it("tool/http/mcp/script/branch/transform + unknown → imported_operator", () => {
    for (const t of ["http", "tool", "mcp.invoke", "script", "branch", "transform", "mystery"]) {
      expect(roleForSourceType(t)).toBe(IMPORTED_OPERATOR_ROLE);
    }
  });
});

describe("finalizeSteps", () => {
  it("assigns monotonic order, non-empty name, and sourceType=type", () => {
    const raw: RawStep[] = [
      { id: "a", type: "http", config: { url: "x" } },
      { id: "b", type: "llm", name: "Reason", config: {} },
    ];
    const steps = finalizeSteps(raw);
    expect(steps.map((s) => s.order)).toEqual([0, 1]);
    expect(steps[0].name).toBe("Http"); // title-cased default
    expect(steps[1].name).toBe("Reason"); // provided name kept
    expect(steps.every((s) => s.sourceType === s.type)).toBe(true);
    expect(steps[0].agentRole).toBe(IMPORTED_OPERATOR_ROLE);
    expect(steps[1].agentRole).toBe(IMPORTED_LLM_ROLE);
  });
});

describe("deriveAgentsFromSteps", () => {
  it("returns distinct fixed-role agents for a mixed pipeline", () => {
    const steps = finalizeSteps([
      { id: "1", type: "llm", config: {} },
      { id: "2", type: "http", config: {} },
      { id: "3", type: "tool", config: {} },
    ]);
    const { agents, agentRoleByStepIndex } = deriveAgentsFromSteps(steps);
    const roles = agents.map((a) => a.role).sort();
    expect(roles).toEqual([IMPORTED_LLM_ROLE, IMPORTED_OPERATOR_ROLE]);
    // every agent has a non-empty systemPrompt (Agent.systemPrompt is @db.Text NOT NULL)
    expect(agents.every((a) => a.systemPrompt.trim().length > 0)).toBe(true);
    expect(agentRoleByStepIndex).toEqual([
      IMPORTED_LLM_ROLE,
      IMPORTED_OPERATOR_ROLE,
      IMPORTED_OPERATOR_ROLE,
    ]);
  });

  it("returns a single agent when only one role is used", () => {
    const steps = finalizeSteps([
      { id: "1", type: "http", config: {} },
      { id: "2", type: "mcp.invoke", config: {} },
    ]);
    const { agents } = deriveAgentsFromSteps(steps);
    expect(agents.length).toBe(1);
    expect(agents[0].role).toBe(IMPORTED_OPERATOR_ROLE);
  });

  it("every synthesized step.agentRole exact-matches a synthesized agent role", () => {
    const steps = finalizeSteps([
      { id: "1", type: "llm", config: {} },
      { id: "2", type: "branch", config: {} },
    ]);
    const { agents } = deriveAgentsFromSteps(steps);
    const agentRoles = new Set(agents.map((a) => a.role));
    for (const s of steps) {
      expect(agentRoles.has(s.agentRole)).toBe(true);
    }
  });
});
