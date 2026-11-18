import { describe, expect, it } from "vitest";
import { sameUtcMonth } from "../period";

const d = (y: number, m: number, day: number, h = 0, mi = 0, s = 0) => Date.UTC(y, m, day, h, mi, s);

describe("sameUtcMonth", () => {
  it("aynı ay içinde true (Date ve ms karışık)", () => {
    expect(sameUtcMonth(d(2026, 10, 1), new Date(d(2026, 10, 30, 23, 59, 59)))).toBe(true);
  });
  it("ay sınırı: 31 Eki 23:59:59 vs 1 Kas 00:00:00 UTC → false", () => {
    expect(sameUtcMonth(d(2026, 9, 31, 23, 59, 59), d(2026, 10, 1, 0, 0, 0))).toBe(false);
  });
  it("aynı ay numarası, farklı yıl → false", () => {
    expect(sameUtcMonth(d(2025, 10, 5), d(2026, 10, 5))).toBe(false);
  });
  it("yıl sınırı: 31 Ara → 1 Oca false", () => {
    expect(sameUtcMonth(d(2026, 11, 31, 23, 59, 59), d(2027, 0, 1))).toBe(false);
  });
  it("simetrik", () => {
    expect(sameUtcMonth(d(2026, 10, 1), d(2026, 9, 31))).toBe(sameUtcMonth(d(2026, 9, 31), d(2026, 10, 1)));
  });
});
