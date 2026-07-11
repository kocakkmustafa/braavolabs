import { describe, it, expect } from "vitest";
import { estimateCall, estimateFanout, type Pricer } from "../costPreview";

// Injected pricer (USD per 1M tokens); null = free/local.
const pricer: Pricer = (id) =>
  (({
    opus: { inputPerM: 15, outputPerM: 75 },
    cheap: { inputPerM: 1, outputPerM: 2 },
    "glm-flash": null,
  } as Record<string, { inputPerM: number; outputPerM: number } | null>)[id] ?? null);

describe("estimateCall", () => {
  it("computes USD from per-1M pricing", () => {
    const e = estimateCall("opus", 1000, 1000, pricer);
    expect(e.usd).toBeCloseTo(0.09, 6); // 0.015 in + 0.075 out
    expect(e.free).toBe(false);
  });

  it("treats a model with no price entry as free ($0)", () => {
    const e = estimateCall("glm-flash", 5000, 5000, pricer);
    expect(e.usd).toBe(0);
    expect(e.free).toBe(true);
  });
});

describe("estimateFanout (ask-all preview)", () => {
  it("sums per-model cost and flags anyPaid", () => {
    const f = estimateFanout(["opus", "cheap"], 1000, 500, {}, pricer);
    expect(f.modelCount).toBe(2);
    expect(f.perModel.map((m) => m.modelId)).toEqual(["opus", "cheap"]);
    expect(f.totalUsd).toBeCloseTo(0.0545, 6); // opus 0.0525 + cheap 0.002
    expect(f.anyPaid).toBe(true);
    expect(f.synthesizer).toBeUndefined();
  });

  it("adds a synthesis pass reading every answer", () => {
    const f = estimateFanout(["glm-flash", "cheap"], 1000, 500, { synthesizerId: "opus" }, pricer);
    // synth input = 1000 + 500*2 = 2000, output = 500 → 0.03 + 0.0375 = 0.0675
    expect(f.synthesizer?.modelId).toBe("opus");
    expect(f.synthesizer?.usd).toBeCloseTo(0.0675, 6);
    expect(f.totalUsd).toBeCloseTo(0.0695, 6); // 0 + 0.002 + 0.0675
    expect(f.anyPaid).toBe(true);
  });

  it("reports a free fan-out as $0 with anyPaid=false", () => {
    const f = estimateFanout(["glm-flash", "glm-flash"], 2000, 2000, {}, pricer);
    expect(f.totalUsd).toBe(0);
    expect(f.anyPaid).toBe(false);
  });

  it("honors explicit synthesis token overrides", () => {
    const f = estimateFanout(["glm-flash"], 100, 100, {
      synthesizerId: "cheap",
      synthesisInputTokens: 1_000_000,
      synthesisOutputTokens: 1_000_000,
    }, pricer);
    expect(f.synthesizer?.usd).toBeCloseTo(3, 6); // 1*1 in + 1*2 out
    expect(f.totalUsd).toBeCloseTo(3, 6);
  });
});
