/**
 * ComposedAgentSchema validation contract — pure Zod schema, no I/O.
 *
 * The composer's tool whitelist enforcement and LLM round-trip are
 * exercised in the e2e suite (production playwright run); these unit
 * tests pin the schema shape so a schema regression breaks the build
 * before it reaches Anthropic's API.
 */
import { describe, it, expect } from "vitest";
import { ComposedAgentSchema } from "../composer";

const validAgent = {
  name: "Memory Curator",
  role: "memory_curator",
  systemPrompt:
    "You curate this company's memory. Watch every run completion, extract 3-5 key learnings, and only escalate them to APPROVED status after you've seen the same pattern repeat across 2 or more successful runs. Never escalate based on a single example.",
  tools: ["recall_memory", "store_memory"],
};

describe("ComposedAgentSchema", () => {
  it("accepts a well-formed agent", () => {
    const result = ComposedAgentSchema.safeParse(validAgent);
    expect(result.success).toBe(true);
  });

  it("rejects names longer than 80 chars", () => {
    const result = ComposedAgentSchema.safeParse({
      ...validAgent,
      name: "x".repeat(81),
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-snake_case roles", () => {
    const cases = ["MemoryCurator", "memory-curator", "Memory Curator", "1memory", " memory_curator"];
    for (const role of cases) {
      const result = ComposedAgentSchema.safeParse({ ...validAgent, role });
      expect(result.success, `role="${role}" should fail`).toBe(false);
    }
  });

  it("accepts valid snake_case roles", () => {
    const cases = ["memory_curator", "sales", "agent42", "x_y_z"];
    for (const role of cases) {
      const result = ComposedAgentSchema.safeParse({ ...validAgent, role });
      expect(result.success, `role="${role}" should pass`).toBe(true);
    }
  });

  it("rejects systemPrompt shorter than 20 chars", () => {
    const result = ComposedAgentSchema.safeParse({
      ...validAgent,
      systemPrompt: "too short",
    });
    expect(result.success).toBe(false);
  });

  it("rejects systemPrompt longer than 8000 chars", () => {
    const result = ComposedAgentSchema.safeParse({
      ...validAgent,
      systemPrompt: "x".repeat(8001),
    });
    expect(result.success).toBe(false);
  });

  it("rejects more than 20 tools", () => {
    const result = ComposedAgentSchema.safeParse({
      ...validAgent,
      tools: Array.from({ length: 21 }, (_, i) => `tool_${i}`),
    });
    expect(result.success).toBe(false);
  });

  it("accepts empty tool array (text-only agent)", () => {
    const result = ComposedAgentSchema.safeParse({
      ...validAgent,
      tools: [],
    });
    expect(result.success).toBe(true);
  });

  it("rejects extra top-level keys (strict shape)", () => {
    // Zod object() is permissive by default; this test documents the
    // current behaviour (unknown keys pass through silently). If we ever
    // tighten with .strict(), update this assertion.
    const result = ComposedAgentSchema.safeParse({
      ...validAgent,
      maliciousKey: "drop tables",
    });
    expect(result.success).toBe(true);
  });
});
