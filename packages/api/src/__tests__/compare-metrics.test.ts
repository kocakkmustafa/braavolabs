import { describe, it, expect } from "vitest";
import { summarizeCompareMetrics, readCompareMetrics, stripUntrustedMetrics } from "../services/compare-metrics";

const cand = (provider: string, model: string, i: number, o: number, c: number, d: number) => ({
  provider: provider as never, model, answer: "a", tokens: { input: i, output: o }, costUsd: c, durationMs: d,
});
const base = { failed: [], synthesizer: { costUsd: 0.01, durationMs: 300 }, budgetExceeded: false };

describe("summarizeCompareMetrics", () => {
  it("3 candidates normal", () => {
    const m = summarizeCompareMetrics(
      { ...base, perModel: [cand("a", "m1", 10, 20, 0.1, 100), cand("b", "m2", 5, 5, 0.2, 400), cand("c", "m3", 1, 2, 0.05, 250)], totalCostUsd: 0.36 },
      { maxCostUsd: 1 },
    );
    expect(m.totals).toMatchObject({ candidateCount: 3, succeeded: 3, failed: 0, inputTokens: 16, outputTokens: 27, maxCandidateDurationMs: 400, candidateDurationMs: 750, synthesizerCostUsd: 0.01, totalCostUsd: 0.36 });
    expect(m.totals.candidateCostUsd).toBeCloseTo(0.35);
    expect(m.budget).toEqual({ maxCostUsd: 1, exceeded: false });
  });

  it("1 candidate failed", () => {
    const m = summarizeCompareMetrics({
      ...base,
      perModel: [cand("a", "m1", 10, 20, 0.1, 100), cand("b", "m2", 5, 5, 0.2, 400)],
      failed: [{ provider: "c" as never, model: "m3", error: "timeout" }],
      totalCostUsd: 0.31,
    });
    expect(m.totals).toMatchObject({ candidateCount: 3, succeeded: 2, failed: 1 });
    const f = m.candidates.find((c) => !c.ok)!;
    expect(f).toMatchObject({ model: "m3", error: "timeout", durationMs: null, costUsd: null });
    expect(m.budget.maxCostUsd).toBeNull();
  });

  it("budget exceeded (flag and cost over cap)", () => {
    const flagged = summarizeCompareMetrics(
      { perModel: [cand("a", "m1", 1, 1, 1.2, 10)], failed: [], synthesizer: null, totalCostUsd: 1.2, budgetExceeded: true },
      { maxCostUsd: 1 },
    );
    expect(flagged.budget.exceeded).toBe(true);
    expect(flagged.totals.synthesizerCostUsd).toBe(0);
    const overCap = summarizeCompareMetrics({ ...base, perModel: [], totalCostUsd: 2 }, { maxCostUsd: 1 });
    expect(overCap.budget.exceeded).toBe(true);
    expect(overCap.totals.maxCandidateDurationMs).toBe(0);
  });

  it("is pure: input not mutated, repeat calls equal", () => {
    const input = { ...base, perModel: [cand("a", "m1", 1, 2, 0.1, 5)], totalCostUsd: 0.11 };
    const snap = JSON.stringify(input);
    Object.freeze(input.perModel[0]); Object.freeze(input.perModel); Object.freeze(input);
    const a = summarizeCompareMetrics(input, { maxCostUsd: 1 });
    const b = summarizeCompareMetrics(input, { maxCostUsd: 1 });
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    expect(JSON.stringify(input)).toBe(snap);
    expect(JSON.parse(JSON.stringify(a))).toEqual(a);
  });
});

describe("readCompareMetrics (back-compat)", () => {
  it("legacy findings without metrics read as null", () => {
    expect(readCompareMetrics({ summary: "s", claims: [], multiModel: {} })).toBeNull();
    expect(readCompareMetrics("text")).toBeNull();
    expect(readCompareMetrics(null)).toBeNull();
    expect(readCompareMetrics([])).toBeNull();
  });
  it("new findings expose metrics", () => {
    const metrics = summarizeCompareMetrics({ ...base, perModel: [], totalCostUsd: 0 });
    expect(readCompareMetrics({ summary: "s", metrics })).toEqual(metrics);
  });
});

describe("edge cases", () => {
  it("flag true with cost under cap stays exceeded", () => {
    expect(summarizeCompareMetrics({ ...base, perModel: [], totalCostUsd: 0.1, budgetExceeded: true }, { maxCostUsd: 1 }).budget.exceeded).toBe(true);
  });
  it("cost == cap is not exceeded", () => {
    expect(summarizeCompareMetrics({ ...base, perModel: [], totalCostUsd: 1 }, { maxCostUsd: 1 }).budget.exceeded).toBe(false);
  });
  it("maxCostUsd 0 and negative", () => {
    expect(summarizeCompareMetrics({ ...base, perModel: [], totalCostUsd: 0 }, { maxCostUsd: 0 }).budget).toEqual({ maxCostUsd: 0, exceeded: false });
    expect(summarizeCompareMetrics({ ...base, perModel: [], totalCostUsd: 0.5 }, { maxCostUsd: 0 }).budget.exceeded).toBe(true);
    expect(summarizeCompareMetrics({ ...base, perModel: [], totalCostUsd: 0 }, { maxCostUsd: -1 }).budget.exceeded).toBe(true);
  });
  it("NaN/undefined fields coerce to 0 and stay finite", () => {
    const bad = { provider: "a" as never, model: "m", answer: "", tokens: { input: NaN, output: undefined as never }, costUsd: undefined as never, durationMs: NaN };
    const m = summarizeCompareMetrics({ perModel: [bad], failed: [], synthesizer: null, totalCostUsd: NaN, budgetExceeded: false }, { maxCostUsd: NaN });
    expect(m.totals.inputTokens).toBe(0);
    expect(m.totals.totalCostUsd).toBe(0);
    expect(m.budget.maxCostUsd).toBeNull();
    expect(readCompareMetrics({ metrics: m })).toEqual(m);
  });
  it("failed candidate contributes nothing to sums", () => {
    const m = summarizeCompareMetrics({
      ...base, perModel: [cand("a", "m1", 1, 2, 0.1, 10)],
      failed: [{ provider: "b" as never, model: "m2", error: "x", tokens: { input: 99, output: 99 }, costUsd: 9, durationMs: 999 } as never],
      totalCostUsd: 0.11,
    });
    expect(m.totals).toMatchObject({ inputTokens: 1, outputTokens: 2, maxCandidateDurationMs: 10 });
    expect(m.totals.candidateCostUsd).toBeCloseTo(0.1);
  });
});

describe("forged metrics", () => {
  const good = summarizeCompareMetrics({ ...base, perModel: [cand("a", "m1", 1, 2, 0.1, 10)], totalCostUsd: 0.11 });
  it.each([
    ["not object", "x"],
    ["candidates not array", { ...good, candidates: "x" }],
    ["candidate bad field", { ...good, candidates: [{ ...good.candidates[0], costUsd: "1" }] }],
    ["totals missing key", { ...good, totals: { ...good.totals, totalCostUsd: undefined } }],
    ["totals string", { ...good, totals: { ...good.totals, inputTokens: "5" } }],
    ["budget bad", { ...good, budget: { maxCostUsd: null, exceeded: "no" } }],
  ])("rejects %s", (_n, metrics) => {
    expect(readCompareMetrics({ metrics })).toBeNull();
  });
  it("stripUntrustedMetrics drops the key, keeps the rest, no mutation", () => {
    const f = { summary: "s", claims: [], metrics: { forged: 1 } };
    expect(stripUntrustedMetrics(f)).toEqual({ summary: "s", claims: [] });
    expect(f.metrics).toEqual({ forged: 1 });
    expect(stripUntrustedMetrics("t")).toBe("t");
  });
});
