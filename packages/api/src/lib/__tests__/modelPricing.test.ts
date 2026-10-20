import { describe, it, expect } from "vitest";
import {
  priceForModel,
  estimatePipelineCostUsd,
  MODEL_PRICES,
  LOW_MULTIPLIER,
  HIGH_MULTIPLIER,
} from "../modelPricing";

describe("priceForModel", () => {
  it("resolves an exact model id", () => {
    expect(priceForModel("gpt-4o")).toEqual(MODEL_PRICES["gpt-4o"]);
  });

  it("resolves a dated Anthropic variant to its family", () => {
    const p = priceForModel("claude-sonnet-4-20250514");
    expect(p).toEqual(MODEL_PRICES["claude-sonnet"]);
  });

  it("prefers the more specific gpt-4o-mini over gpt-4o", () => {
    expect(priceForModel("gpt-4o-mini-2024")).toEqual(MODEL_PRICES["gpt-4o-mini"]);
  });

  it("is case-insensitive", () => {
    expect(priceForModel("CLAUDE-HAIKU-4-5")).toEqual(MODEL_PRICES["claude-haiku"]);
  });

  it("returns null for an unknown model", () => {
    expect(priceForModel("totally-made-up-model")).toBeNull();
  });
});

describe("estimatePipelineCostUsd", () => {
  it("returns a low<high range for a known cloud model", () => {
    const est = estimatePipelineCostUsd(5, "ANTHROPIC", "claude-sonnet-4-20250514");
    expect(est.lowUsd).toBeGreaterThan(0);
    expect(est.highUsd).toBeGreaterThan(est.lowUsd);
    expect(est.isFree).toBe(false);
    expect(est.unknownModel).toBe(false);
    expect(est.stepCount).toBe(5);
  });

  it("scales roughly linearly with step count", () => {
    const one = estimatePipelineCostUsd(1, "OPENAI", "gpt-4o");
    const ten = estimatePipelineCostUsd(10, "OPENAI", "gpt-4o");
    // 10 steps ≈ 10× one step (within rounding).
    expect(ten.highUsd).toBeCloseTo(one.highUsd * 10, 4);
  });

  it("uses the configured low/high multipliers around the midpoint", () => {
    const est = estimatePipelineCostUsd(4, "OPENAI", "gpt-4o");
    const midpoint = est.perStepUsd * 4;
    expect(est.lowUsd).toBeCloseTo(midpoint * LOW_MULTIPLIER, 6);
    expect(est.highUsd).toBeCloseTo(midpoint * HIGH_MULTIPLIER, 6);
  });

  it("keeps arbitrary endpoint pricing unknown rather than asserting it is free", () => {
    for (const provider of ["OLLAMA", "LMSTUDIO", "CUSTOM"] as const) {
      const est = estimatePipelineCostUsd(8, provider, "gemma3:4b");
      expect(est.lowUsd).toBe(0);
      expect(est.highUsd).toBe(0);
      expect(est.isFree).toBe(false);
      expect(est.unknownModel).toBe(true);
    }
  });

  it("does not apply a public model rate to a paid custom operator's endpoint", () => {
    const est = estimatePipelineCostUsd(8, "CUSTOM", "gpt-4o");
    expect(est.unknownModel).toBe(true);
    expect(est.isFree).toBe(false);
    expect(est.lowUsd).toBe(0); // unchanged wire placeholder, never a free-price claim
    expect(est.highUsd).toBe(0);
  });

  it("flags unknown cloud models as unknownModel with zero cost", () => {
    const est = estimatePipelineCostUsd(3, "OPENAI", "some-future-model");
    expect(est.unknownModel).toBe(true);
    expect(est.lowUsd).toBe(0);
    expect(est.highUsd).toBe(0);
  });

  it("treats an empty pipeline as at least one step", () => {
    const est = estimatePipelineCostUsd(0, "ANTHROPIC", "claude-haiku-4-5");
    expect(est.stepCount).toBe(1);
    expect(est.highUsd).toBeGreaterThan(0);
  });

  it("cheaper models cost less than premium ones for the same steps", () => {
    const haiku = estimatePipelineCostUsd(5, "ANTHROPIC", "claude-haiku-4-5");
    const opus = estimatePipelineCostUsd(5, "ANTHROPIC", "claude-opus-4-20250514");
    expect(haiku.highUsd).toBeLessThan(opus.highUsd);
  });
});
