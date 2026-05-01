/**
 * Starter template catalog integrity — pure data tests, no DB.
 *
 * These tests are the "did you remember to wire it up" net for the
 * STARTER_TEMPLATES array. Adding a new template should be safe; CI
 * surfaces structural drift (e.g. a tool name that isn't in the safe
 * whitelist, a pipeline step referencing an agent role that doesn't
 * exist, two templates with the same id).
 */
import { describe, it, expect } from "vitest";
import {
  STARTER_TEMPLATES,
  STARTER_TEMPLATE_IDS,
  StarterTemplateSchema,
  SAFE_TOOL_SET,
  getStarterTemplate,
} from "../starter-templates";

describe("Starter template catalog", () => {
  it("has at least 4 templates (free-tier baseline)", () => {
    expect(STARTER_TEMPLATES.length).toBeGreaterThanOrEqual(4);
  });

  it("every template parses against StarterTemplateSchema", () => {
    for (const t of STARTER_TEMPLATES) {
      const result = StarterTemplateSchema.safeParse(t);
      if (!result.success) {
        console.error("Template", t.id, "failed:", result.error.issues);
      }
      expect(result.success, `Template "${t.id}" failed validation`).toBe(true);
    }
  });

  it("ids are unique kebab-case", () => {
    const ids = STARTER_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it("STARTER_TEMPLATE_IDS export matches the catalog", () => {
    expect(STARTER_TEMPLATE_IDS.sort()).toEqual(STARTER_TEMPLATES.map((t) => t.id).sort());
  });

  it("every agent's tools are in SAFE_TOOL_SET (no external-API tools)", () => {
    for (const t of STARTER_TEMPLATES) {
      for (const agent of t.agents) {
        for (const tool of agent.tools) {
          expect(SAFE_TOOL_SET.has(tool), `${t.id} → ${agent.name} → ${tool}`).toBe(true);
        }
      }
    }
  });

  it("every pipeline step references an agent role that exists in the same template", () => {
    for (const t of STARTER_TEMPLATES) {
      const roles = new Set(t.agents.map((a) => a.role));
      for (const pipeline of t.pipelines) {
        for (const step of pipeline.steps) {
          expect(
            roles.has(step.agentRole),
            `${t.id} → ${pipeline.name} → step "${step.name}" references unknown role "${step.agentRole}"`,
          ).toBe(true);
        }
      }
    }
  });

  it("pipeline step orders are sequential starting at 0 (no gaps)", () => {
    for (const t of STARTER_TEMPLATES) {
      for (const pipeline of t.pipelines) {
        const orders = pipeline.steps.map((s) => s.order).sort((a, b) => a - b);
        for (let i = 0; i < orders.length; i++) {
          expect(orders[i], `${t.id} → ${pipeline.name} step orders`).toBe(i);
        }
      }
    }
  });

  it("step writeMemoryKey ↔ readMemoryKeys handshake (every read has a prior write)", () => {
    for (const t of STARTER_TEMPLATES) {
      for (const pipeline of t.pipelines) {
        const sortedSteps = [...pipeline.steps].sort((a, b) => a.order - b.order);
        const writtenSoFar = new Set<string>();
        for (const step of sortedSteps) {
          for (const key of step.readMemoryKeys ?? []) {
            expect(
              writtenSoFar.has(key),
              `${t.id} → ${pipeline.name} → "${step.name}" reads "${key}" before any prior step writes it`,
            ).toBe(true);
          }
          if (step.writeMemoryKey) writtenSoFar.add(step.writeMemoryKey);
        }
      }
    }
  });

  it("getStarterTemplate returns the correct template + throws for unknown ids", () => {
    const known = STARTER_TEMPLATES[0]!;
    expect(getStarterTemplate(known.id).id).toBe(known.id);
    expect(() => getStarterTemplate("definitely-not-a-real-template")).toThrow();
  });

  it("system prompts are within the 40–600 char window (Groq-friendly)", () => {
    for (const t of STARTER_TEMPLATES) {
      for (const agent of t.agents) {
        expect(
          agent.systemPrompt.length,
          `${t.id} → ${agent.name} systemPrompt length`,
        ).toBeGreaterThanOrEqual(40);
        expect(
          agent.systemPrompt.length,
          `${t.id} → ${agent.name} systemPrompt length`,
        ).toBeLessThanOrEqual(600);
      }
    }
  });

  it("primitives are from the canonical 9-list (no typos)", () => {
    const allowed = new Set([
      "ACQUISITION", "SALES", "DELIVERY", "CONTENT", "OPERATIONS",
      "FINANCE", "ANALYTICS", "MEMORY", "GOVERNANCE",
    ]);
    for (const t of STARTER_TEMPLATES) {
      for (const p of t.primitives) {
        expect(allowed.has(p), `${t.id} unknown primitive "${p}"`).toBe(true);
      }
    }
  });
});
