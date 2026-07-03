/**
 * E5/T0 — every adapter emits the executor-aligned step shape while keeping
 * the `/preview` back-compat fields.
 *
 * Asserts, for all 5 adapters (n8n, generic, mcp, openclaw, claude-automation):
 *   • agentRole is one of the fixed 2 roles (never empty)
 *   • order is 0..n monotonic
 *   • name is non-empty
 *   • id AND type are still present (preview UI reads them — kabul #8)
 *   • sourceType equals the original type
 */
import { describe, it, expect } from "vitest";
import { fromN8n } from "../n8n";
import { fromGeneric } from "../generic";
import { fromMcp } from "../mcp";
import { fromOpenClaw } from "../openclaw";
import { fromClaudeAutomation } from "../claude-automation";
import {
  IMPORTED_LLM_ROLE,
  IMPORTED_OPERATOR_ROLE,
} from "../../agent-synthesis";
import type { ConvertedPipeline } from "../types";

const ROLES = new Set([IMPORTED_LLM_ROLE, IMPORTED_OPERATOR_ROLE]);

function assertContract(result: ConvertedPipeline) {
  const steps = result.pipeline.steps;
  expect(steps.length).toBeGreaterThan(0);
  steps.forEach((s, idx) => {
    // executor contract
    expect(ROLES.has(s.agentRole)).toBe(true);
    expect(s.agentRole.length).toBeGreaterThan(0);
    expect(s.order).toBe(idx); // monotonic 0..n
    expect(typeof s.name).toBe("string");
    expect(s.name.trim().length).toBeGreaterThan(0);
    // preview back-compat
    expect(typeof s.id).toBe("string");
    expect(s.id.length).toBeGreaterThan(0);
    expect(typeof s.type).toBe("string");
    expect(s.type.length).toBeGreaterThan(0);
    // sourceType tracks original type
    expect(s.sourceType).toBe(s.type);
  });
}

describe("n8n adapter — T0 step contract", () => {
  it("emits agentRole/order/name + preserves id/type", () => {
    const payload = JSON.stringify({
      name: "My n8n flow",
      nodes: [
        { id: "a", name: "Fetch", type: "n8n-nodes-base.httpRequest", parameters: { url: "https://x" } },
        { id: "b", name: "Think", type: "@n8n/n8n-nodes-langchain.lmChatAnthropic", parameters: {} },
        { id: "c", name: "Skip", type: "n8n-nodes-base.unknownThing", parameters: {} },
      ],
    });
    const result = fromN8n(payload);
    assertContract(result);
    // http → operator, llm → llm
    expect(result.pipeline.steps[0].agentRole).toBe(IMPORTED_OPERATOR_ROLE);
    expect(result.pipeline.steps[1].agentRole).toBe(IMPORTED_LLM_ROLE);
    // unknown node dropped, not stepped
    expect(result.dropped.some((d) => d.id === "c")).toBe(true);
    expect(result.pipeline.steps.length).toBe(2);
  });
});

describe("generic adapter — T0 step contract", () => {
  it("emits agentRole/order/name + preserves id/type", () => {
    const payload = JSON.stringify({
      name: "Graph",
      nodes: [
        { id: "n1", type: "http", config: {} },
        { id: "n2", type: "transform", config: {} },
      ],
      edges: [{ from: "n1", to: "n2" }],
    });
    const result = fromGeneric(payload);
    assertContract(result);
    expect(result.pipeline.steps.every((s) => s.agentRole === IMPORTED_OPERATOR_ROLE)).toBe(true);
  });
});

describe("mcp adapter — T0 step contract", () => {
  it("emits agentRole/order/name + preserves id/type", () => {
    const payload = JSON.stringify({
      name: "MCP srv",
      tools: [
        { name: "list_items", description: "list" },
        { name: "delete_record", description: "delete" },
      ],
      resources: [{ uri: "file://x" }],
    });
    const result = fromMcp(payload);
    assertContract(result);
    // mcp.invoke → operator
    expect(result.pipeline.steps.every((s) => s.agentRole === IMPORTED_OPERATOR_ROLE)).toBe(true);
    expect(result.dropped.length).toBe(1); // resource dropped
  });
});

describe("openclaw adapter — T0 step contract", () => {
  it("emits agentRole/order/name + preserves id/type; prompt→llm, tool→operator", () => {
    const payload = JSON.stringify({
      name: "Skill",
      prompts: { system: "You are helpful", user: "Do X" },
      tools: [{ name: "search", description: "search" }],
    });
    const result = fromOpenClaw(payload);
    assertContract(result);
    expect(result.pipeline.steps[0].agentRole).toBe(IMPORTED_LLM_ROLE); // prompt
    expect(result.pipeline.steps[1].agentRole).toBe(IMPORTED_OPERATOR_ROLE); // tool
  });
});

describe("claude-automation adapter — T0 step contract", () => {
  it("emits agentRole/order/name + preserves id/type; routine steps→llm", () => {
    const payload = "## Plan\nDo the plan.\n\n## Implementation\nWrite code.\n";
    const result = fromClaudeAutomation(payload);
    assertContract(result);
    expect(result.pipeline.steps.every((s) => s.agentRole === IMPORTED_LLM_ROLE)).toBe(true);
  });

  it("falls back to a single catch-all step for heading-less docs", () => {
    const result = fromClaudeAutomation("just a plain routine body with no headings");
    assertContract(result);
    expect(result.pipeline.steps.length).toBe(1);
  });
});
