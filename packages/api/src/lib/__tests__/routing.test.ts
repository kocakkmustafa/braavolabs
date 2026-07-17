import { describe, it, expect } from "vitest";
import {
  routeTask,
  escalate,
  tokensSaved,
  type ModelSpec,
  type RunEvent,
} from "../routing";
import { modelSpecFromPricing } from "../routing";

const local: ModelSpec = { id: "gemma-local", tier: "local", costPer1kIn: 0, costPer1kOut: 0, capabilities: ["summarize", "codegen"] };
const haiku: ModelSpec = { id: "haiku", tier: "cheap", costPer1kIn: 0.0008, costPer1kOut: 0.004, capabilities: ["summarize", "codegen", "tools"] };
const opus: ModelSpec = { id: "opus", tier: "frontier", costPer1kIn: 0.015, costPer1kOut: 0.075, capabilities: ["summarize", "codegen", "tools", "vision", "hard-reasoning"] };
const ALL = [opus, haiku, local];

describe("routeTask — cheapest capable, escalate-on-failure", () => {
  it("picks the cheapest (local) model for a task both cheap+local can do", () => {
    const r = routeTask({ taskType: "summarize-diff", requiredCapabilities: ["summarize"] }, ALL);
    expect(r.model.id).toBe("gemma-local");
    expect(r.rationale).toContain("escalate only on failure");
  });

  it("skips local when a required capability is missing there (needs tools → haiku, not opus)", () => {
    const r = routeTask({ taskType: "tool-call", requiredCapabilities: ["tools"] }, ALL);
    expect(r.model.id).toBe("haiku"); // cheapest capable of 'tools'
  });

  it("routes hard tasks straight to the cheapest capable FRONTIER model", () => {
    const r = routeTask({ taskType: "architecture", requiredCapabilities: ["hard-reasoning"], hard: true }, ALL);
    expect(r.model.id).toBe("opus");
    expect(r.rationale).toContain("hard task");
  });

  it("throws when no model satisfies the capabilities", () => {
    expect(() => routeTask({ taskType: "x", requiredCapabilities: ["quantum"] }, ALL)).toThrow(/No model satisfies/);
  });
});

describe("escalate — next tier up", () => {
  it("escalates local → cheap for a capability both share", () => {
    const e = escalate(local, { taskType: "codegen", requiredCapabilities: ["codegen"] }, ALL);
    expect(e?.model.id).toBe("haiku");
    expect(e?.rationale).toContain("local→cheap");
  });
  it("escalates cheap → frontier", () => {
    const e = escalate(haiku, { taskType: "codegen", requiredCapabilities: ["codegen"] }, ALL);
    expect(e?.model.id).toBe("opus");
  });
  it("returns null at the top tier", () => {
    const e = escalate(opus, { taskType: "codegen", requiredCapabilities: ["codegen"] }, ALL);
    expect(e).toBeNull();
  });
});

describe("tokensSaved — honest savings vs naive frontier/full-context baseline", () => {
  it("cheap-tier routing saves the frontier premium", () => {
    const events: RunEvent[] = [
      { model: haiku, promptTokens: 1000, completionTokens: 500 },
    ];
    const rep = tokensSaved(events, opus);
    // actual = 1*0.0008 + 0.5*0.004 = 0.0028 ; baseline = 1*0.015 + 0.5*0.075 = 0.0525
    expect(rep.actualUsd).toBeCloseTo(0.0028, 6);
    expect(rep.baselineUsd).toBeCloseTo(0.0525, 6);
    expect(rep.savedUsd).toBeCloseTo(0.0497, 6);
    expect(rep.savedPct).toBeGreaterThan(90);
    expect(rep.breakdown.cheapRoutingUsd).toBeCloseTo(0.0497, 6);
  });

  it("uses actualUsdOverride (the REAL billed cost) as actual, not the model list price", () => {
    // A failover/trial run: configured model = opus, but the real billed cost
    // (cost_usd) was cheap because it actually ran on a cheaper served model.
    // The report must use the real cost, not reprice tokens at opus's price.
    const events: RunEvent[] = [
      { model: opus, promptTokens: 1000, completionTokens: 500, actualUsdOverride: 0.0028 },
    ];
    const rep = tokensSaved(events, opus);
    // actual = the override (0.0028), NOT 1*0.015 + 0.5*0.075 = 0.0525.
    expect(rep.actualUsd).toBeCloseTo(0.0028, 6);
    // baseline still frontier×real-tokens = 0.0525 → savings are real, not ~0.
    expect(rep.baselineUsd).toBeCloseTo(0.0525, 6);
    expect(rep.savedUsd).toBeCloseTo(0.0497, 6);
  });

  it("counts prompt-cache + retrieval-avoided input as saved tokens", () => {
    const events: RunEvent[] = [
      {
        model: opus, // same model, so savings come purely from cache + retrieval
        promptTokens: 2000,
        completionTokens: 100,
        cachedInputTokens: 1500,
        retrievalAvoidedInputTokens: 4000,
      },
    ];
    const rep = tokensSaved(events, opus);
    expect(rep.savedTokens).toBe(5500); // 1500 cached + 4000 retrieval-avoided
    // billed input = 2000-1500 = 500; actual = 0.5*0.015 + 0.1*0.075 = 0.015
    expect(rep.actualUsd).toBeCloseTo(0.015, 6);
    // baseline input = 2000+4000 = 6000; baseline = 6*0.015 + 0.1*0.075 = 0.0975
    expect(rep.baselineUsd).toBeCloseTo(0.0975, 6);
    expect(rep.savedUsd).toBeCloseTo(0.0825, 6);
    expect(rep.breakdown.cacheUsd).toBeCloseTo(1.5 * 0.015, 6); // 1500 cached × frontier in-price
    expect(rep.breakdown.retrievalUsd).toBeCloseTo(4 * 0.015, 6); // 4000 avoided × frontier in-price
  });

  it("local model (zero cost) shows ~100% savings", () => {
    const rep = tokensSaved([{ model: local, promptTokens: 3000, completionTokens: 800 }], opus);
    expect(rep.actualUsd).toBe(0);
    expect(rep.savedPct).toBe(100);
  });

  it("handles an empty week without dividing by zero", () => {
    const rep = tokensSaved([], opus);
    expect(rep.savedUsd).toBe(0);
    expect(rep.savedPct).toBe(0);
  });
});

describe("modelSpecFromPricing — built on the real modelPricing.ts table", () => {
  it("derives per-1k costs from the per-1M pricing table (claude-haiku)", () => {
    const m = modelSpecFromPricing("claude-haiku", "cheap", ["summarize"]);
    // MODEL_PRICES claude-haiku = { inputPerM: 0.8, outputPerM: 4 }
    expect(m.costPer1kIn).toBeCloseTo(0.0008, 6);
    expect(m.costPer1kOut).toBeCloseTo(0.004, 6);
    expect(m.tier).toBe("cheap");
  });
  it("resolves dated variants via starts-with (claude-opus-4-...) and zero-costs local", () => {
    const opus = modelSpecFromPricing("claude-opus-4-20250514", "frontier", ["hard-reasoning"]);
    expect(opus.costPer1kIn).toBeCloseTo(0.015, 6); // opus 15/1M
    const local = modelSpecFromPricing("gemma-local-unknown", "local", ["summarize"]);
    expect(local.costPer1kIn).toBe(0);
    expect(local.costPer1kOut).toBe(0);
  });
});
