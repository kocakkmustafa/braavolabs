import { describe, it, expect } from "vitest";
import { lintCharter, charterHash, estimateTokens, CHARTER_TOKEN_CAP } from "../charter";
import type { HoldingCharter } from "../types";

const valid: HoldingCharter = {
  goal: "GP1 duman testi: deterministik akışın uçtan uca kanıtı.",
  successCriteria: ["Tüm adımlar SUCCEEDED ve audit kaydı sayısı >= 3"],
  constraints: ["Dış yüzeye yazma yok"],
  riskClass: "R1",
  sources: ["doc:holding/plans/MOTOR-KICKOFF-2026-07-26.md"],
  estCostUsd: 0,
};

describe("charter K0 linter", () => {
  it("accepts a well-formed charter", () => {
    expect(lintCharter(valid)).toEqual({ ok: true, errors: [] });
  });

  it("rejects non-object charters outright", () => {
    expect(lintCharter(null).ok).toBe(false);
    expect(lintCharter([]).ok).toBe(false);
    expect(lintCharter("charter").ok).toBe(false);
  });

  it("requires a non-empty goal", () => {
    const res = lintCharter({ ...valid, goal: "  " });
    expect(res.ok).toBe(false);
    expect(res.errors.join()).toContain("goal");
  });

  it("requires at least one MEASURABLE success criterion", () => {
    const res = lintCharter({ ...valid, successCriteria: ["iyi olsun", "güzel çalışsın"] });
    expect(res.ok).toBe(false);
    expect(res.errors.join()).toContain("measurable");
  });

  it("rejects unresolvable source references", () => {
    const res = lintCharter({ ...valid, sources: ["bir yerde yazıyordu"] });
    expect(res.ok).toBe(false);
    expect(res.errors.join()).toContain("unresolvable");
  });

  it("rejects unknown risk classes (fail-closed)", () => {
    const res = lintCharter({ ...valid, riskClass: "R9" as never });
    expect(res.ok).toBe(false);
  });

  it("enforces the ~500 token cap", () => {
    const res = lintCharter({
      ...valid,
      constraints: [
        // Single constraint far beyond the cap (500 tokens ≈ 2000 chars).
        "x".repeat(4 * CHARTER_TOKEN_CAP + 100),
      ],
    });
    expect(res.ok).toBe(false);
    expect(res.errors.join()).toContain("too large");
  });

  it("estimates tokens at ~4 chars each", () => {
    expect(estimateTokens("abcd".repeat(10))).toBe(10);
  });
});

describe("charterHash", () => {
  it("is stable across key order", () => {
    const reordered = {
      estCostUsd: valid.estCostUsd,
      sources: valid.sources,
      riskClass: valid.riskClass,
      constraints: valid.constraints,
      successCriteria: valid.successCriteria,
      goal: valid.goal,
    } as HoldingCharter;
    expect(charterHash(reordered)).toBe(charterHash(valid));
  });

  it("changes when content changes", () => {
    expect(charterHash({ ...valid, goal: valid.goal + "!" })).not.toBe(charterHash(valid));
  });
});
