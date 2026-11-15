import { describe, it, expect } from "vitest";
import { computeBudgetStatus, parseMonthlyBudget, validateBudgetInput } from "../budget";

describe("validateBudgetInput", () => {
  it.each([[100], [0], [0.5], [12.34], [1_000_000], [1e-2]])("kabul %s", (v) => {
    expect(validateBudgetInput(v)).toEqual({ ok: true, value: v });
  });
  it("0.1+0.2 gibi kayan nokta artığı 2 ondalığa yuvarlanır", () => {
    expect(validateBudgetInput(0.1 + 0.2)).toEqual({ ok: true, value: 0.3 });
    expect(validateBudgetInput(19.99)).toEqual({ ok: true, value: 19.99 });
  });
  it.each([[-1], [-0.01], [NaN], [Infinity], [-Infinity], ["100"], [""], [null], [undefined], [true], [{}], [[5]]])("ret %s", (v) => {
    const r = validateBudgetInput(v);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
  });
  it("3 ondalık ve üst sınır aşımı ret", () => {
    expect(validateBudgetInput(1.234).ok).toBe(false);
    expect(validateBudgetInput(1_000_000.01).ok).toBe(false);
    expect(validateBudgetInput(1e9).ok).toBe(false);
  });
});

describe("parseMonthlyBudget", () => {
  it("geçerli", () => expect(parseMonthlyBudget({ monthlyBudgetUsd: 250.5, other: 1 })).toBe(250.5));
  it("0 geçerli bir limittir", () => expect(parseMonthlyBudget({ monthlyBudgetUsd: 0 })).toBe(0));
  it("anahtar yok / null / config bozuk -> null", () => {
    for (const c of [{}, { monthlyBudgetUsd: null }, null, undefined, "x", 5, [], [1]]) {
      expect(parseMonthlyBudget(c)).toBeNull();
    }
  });
  it("bozuk değerler -> null, throw yok", () => {
    for (const v of [-5, NaN, Infinity, "10", 1.234, 2_000_000, {}, [], true]) {
      expect(parseMonthlyBudget({ monthlyBudgetUsd: v })).toBeNull();
    }
  });
  it("throw eden getter bile null döner", () => {
    const c = { get monthlyBudgetUsd(): number { throw new Error("boom"); } };
    expect(parseMonthlyBudget(c)).toBeNull();
  });
});

describe("computeBudgetStatus", () => {
  it("limit null -> none", () => {
    expect(computeBudgetStatus(null, 10)).toEqual({ limitUsd: null, spentUsd: 10, remainingUsd: null, usedPct: null, state: "none" });
  });
  it("spent null (kaynak yok) -> none, usedPct null", () => {
    expect(computeBudgetStatus(100, null)).toEqual({ limitUsd: 100, spentUsd: null, remainingUsd: null, usedPct: null, state: "none" });
  });
  it("ikisi de null", () => expect(computeBudgetStatus(null, null).state).toBe("none"));
  it("ok: %50", () => {
    expect(computeBudgetStatus(200, 100)).toEqual({ limitUsd: 200, spentUsd: 100, remainingUsd: 100, usedPct: 50, state: "ok" });
  });
  it("warn eşiği: %79.99 ok, %80 warn", () => {
    expect(computeBudgetStatus(10000, 7999).state).toBe("ok");
    expect(computeBudgetStatus(100, 80).state).toBe("warn");
    expect(computeBudgetStatus(100, 99.99).state).toBe("warn");
  });
  it("over eşiği: tam %100 over, kalan 0", () => {
    const s = computeBudgetStatus(100, 100);
    expect(s.state).toBe("over");
    expect(s.remainingUsd).toBe(0);
    expect(s.usedPct).toBe(100);
  });
  it("aşım: %150, kalan negatif", () => {
    expect(computeBudgetStatus(100, 150)).toMatchObject({ usedPct: 150, remainingUsd: -50, state: "over" });
  });
  it("limit 0 + spent>0 -> over, usedPct null, bölme-sıfır yok", () => {
    expect(computeBudgetStatus(0, 5)).toEqual({ limitUsd: 0, spentUsd: 5, remainingUsd: -5, usedPct: null, state: "over" });
  });
  it("limit 0 + spent 0 -> ok", () => {
    expect(computeBudgetStatus(0, 0)).toMatchObject({ usedPct: null, state: "ok" });
  });
  it("spent 0 -> %0 ok", () => expect(computeBudgetStatus(50, 0)).toMatchObject({ usedPct: 0, state: "ok" }));
  it("geçersiz girdiler (NaN/negatif/Infinity) none, throw yok", () => {
    expect(computeBudgetStatus(NaN, 1).state).toBe("none");
    expect(computeBudgetStatus(100, NaN).state).toBe("none");
    expect(computeBudgetStatus(-1, 1).state).toBe("none");
    expect(computeBudgetStatus(100, Infinity).state).toBe("none");
  });
});
