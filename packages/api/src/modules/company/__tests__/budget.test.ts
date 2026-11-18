import { describe, it, expect } from "vitest";
import { BUDGET_SUGGESTED_ALERT_AT_PCT, BUDGET_WARN_PCT, computeBudgetStatus, parseMonthlyBudget, validateBudgetInput } from "../budget";

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
  it("ondalık sınırı: 1e-10, 0.001, 0.005 ret; 0.01 ve artıklı değerler kabul", () => {
    for (const v of [1e-10, 0.001, 0.005, 0.009]) expect(validateBudgetInput(v).ok).toBe(false);
    expect(validateBudgetInput(0.01)).toEqual({ ok: true, value: 0.01 });
    expect(validateBudgetInput(0.1 + 0.2)).toEqual({ ok: true, value: 0.3 });
    expect(validateBudgetInput(1.1 * 3)).toEqual({ ok: true, value: 3.3 });
    expect(validateBudgetInput(999999.99)).toEqual({ ok: true, value: 999999.99 });
    expect(validateBudgetInput(0.57)).toEqual({ ok: true, value: 0.57 });
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
    expect(computeBudgetStatus(null, 10)).toEqual({ limitUsd: null, spentUsd: 10, remainingUsd: null, usedPct: null, state: "none", suggestedAlertAtPct: 80 });
  });
  it("spent null (kaynak yok) -> none, usedPct null", () => {
    expect(computeBudgetStatus(100, null)).toEqual({ limitUsd: 100, spentUsd: null, remainingUsd: null, usedPct: null, state: "none", suggestedAlertAtPct: 80 });
  });
  it("ikisi de null", () => expect(computeBudgetStatus(null, null).state).toBe("none"));
  it("ok: %50", () => {
    expect(computeBudgetStatus(200, 100)).toEqual({ limitUsd: 200, spentUsd: 100, remainingUsd: 100, usedPct: 50, state: "ok", suggestedAlertAtPct: 80 });
  });
  it("warn eşiği: %79.99 ok, %80 warn", () => {
    expect(computeBudgetStatus(10000, 7999).state).toBe("ok");
    expect(computeBudgetStatus(100, 80).state).toBe("warn");
    expect(computeBudgetStatus(100, 99.99).state).toBe("warn");
  });
  it("yuvarlanmamış eşik: 99.996/100 warn (usedPct<100), 79.996/100 ok", () => {
    const w = computeBudgetStatus(100, 99.996);
    expect(w.state).toBe("warn");
    expect(w.usedPct).toBeLessThan(100);
    const o = computeBudgetStatus(100, 79.996);
    expect(o.state).toBe("ok");
    expect(o.usedPct).toBeLessThan(80);
    expect(computeBudgetStatus(100, 80).state).toBe("warn");
    expect(computeBudgetStatus(100, 100).state).toBe("over");
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
    expect(computeBudgetStatus(0, 5)).toEqual({ limitUsd: 0, spentUsd: 5, remainingUsd: -5, usedPct: null, state: "over", suggestedAlertAtPct: 80 });
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

describe("computeBudgetStatus — BRA-P2-03d tam sayı para kuralı", () => {
  it("suggestedAlertAtPct yalnız öneri: sabit 80, durum eşiğiyle aynı değer, her durumda var", () => {
    for (const [l, s] of [[null, null], [100, 0], [100, 80], [100, 150], [0, 0]] as const) {
      expect(computeBudgetStatus(l, s).suggestedAlertAtPct).toBe(BUDGET_WARN_PCT);
    }
    expect(BUDGET_SUGGESTED_ALERT_AT_PCT).toBe(BUDGET_WARN_PCT);
  });
  it("alt-cent limit 0.004 -> 0 cente iner (limit-0 dalı; canlıda ulaşılamaz)", () => {
    expect(computeBudgetStatus(0.004, 0)).toMatchObject({ usedPct: null, state: "ok", remainingUsd: 0 });
    expect(computeBudgetStatus(0.004, 1)).toMatchObject({ usedPct: null, state: "over", remainingUsd: -1 });
  });
  it("büyük değer (≈1e9) over; MAX_SAFE yakını throw etmez", () => {
    expect(computeBudgetStatus(1_000_000, 1e9)).toMatchObject({ state: "over", usedPct: 100000, remainingUsd: -999000000 });
    expect(computeBudgetStatus(1_000_000, 1e9 + 0.5).state).toBe("over");
    expect(() => computeBudgetStatus(1_000_000, Number.MAX_SAFE_INTEGER / 1e6)).not.toThrow();
  });
  it("float birikim hatası yok: 0.3 - 0.1 = 0.2 tam; 10.1 - 0.1 = 10", () => {
    expect(computeBudgetStatus(0.3, 0.1).remainingUsd).toBe(0.2);
    expect(computeBudgetStatus(10.1, 0.1).remainingUsd).toBe(10);
    expect(computeBudgetStatus(1000000, 0.1).remainingUsd).toBe(999999.9);
  });
  it("harcama cente yarım-yukarı yuvarlanır (remaining); spentUsd ham kalır", () => {
    expect(computeBudgetStatus(10, 1.005).remainingUsd).toBe(8.99);
    expect(computeBudgetStatus(10, 1.004999).remainingUsd).toBe(9);
    expect(computeBudgetStatus(10, 1.005).spentUsd).toBe(1.005);
  });
  it("usedPct 2 ondalığa aşağı yuvarlanır; >100 mümkün", () => {
    expect(computeBudgetStatus(3, 1)).toMatchObject({ usedPct: 33.33, state: "ok" });
    expect(computeBudgetStatus(3, 2)).toMatchObject({ usedPct: 66.66 });
    expect(computeBudgetStatus(10, 25.5)).toMatchObject({ usedPct: 255, remainingUsd: -15.5, state: "over" });
  });
});
