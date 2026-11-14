import { describe, it, expect } from "vitest";
import { generateSyntheticData, SYNTHETIC_MAX_COUNT } from "../synthetic-data";

describe("generateSyntheticData", () => {
  it("is deterministic: same seed+count gives identical JSON", () => {
    const a = generateSyntheticData({ seed: 42, count: 100 });
    const b = generateSyntheticData({ seed: 42, count: 100 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a).toEqual(b);
  });

  it("different seed gives different output", () => {
    const a = generateSyntheticData({ seed: 1, count: 50 });
    const b = generateSyntheticData({ seed: 2, count: 50 });
    expect(a).not.toEqual(b);
  });

  it.each([0, 1, 100, SYNTHETIC_MAX_COUNT])("returns exactly %i records", (n) => {
    expect(generateSyntheticData({ seed: 7, count: n })).toHaveLength(n);
  });

  it.each([-1, 1001, NaN, 1.5, Infinity, "5" as unknown as number])("rejects count %s", (n) => {
    expect(() => generateSyntheticData({ seed: 1, count: n })).toThrow(RangeError);
  });

  it.each([NaN, 1.5, Infinity, "1" as unknown as number])("rejects seed %s", (s) => {
    expect(() => generateSyntheticData({ seed: s, count: 1 })).toThrow(RangeError);
  });

  it("rejects unknown kind and honours kind filter", () => {
    expect(() => generateSyntheticData({ seed: 1, count: 1, kind: "x" as never })).toThrow(RangeError);
    const t = generateSyntheticData({ seed: 1, count: 20, kind: "task" });
    const c = generateSyntheticData({ seed: 1, count: 20, kind: "customer" });
    expect(t.every((r) => r.kind === "task" && r.name.startsWith("Sahte Görev"))).toBe(true);
    expect(c.every((r) => r.kind === "customer" && /^Sahte Müşteri \d{3}$/.test(r.name))).toBe(true);
  });

  it("is JSON-serializable (round trip) and does not touch Date.now/Math.random", () => {
    const realRandom = Math.random;
    const realNow = Date.now;
    Math.random = () => {
      throw new Error("Math.random used");
    };
    Date.now = () => {
      throw new Error("Date.now used");
    };
    try {
      const a = generateSyntheticData({ seed: 9, count: 1000 });
      expect(JSON.parse(JSON.stringify(a))).toEqual(a);
    } finally {
      Math.random = realRandom;
      Date.now = realNow;
    }
  });

  describe("no personal-data patterns in 1000 records", () => {
    const recs = generateSyntheticData({ seed: 20260101, count: SYNTHETIC_MAX_COUNT });
    // Dates (YYYY-MM-DD) are structured and intentional; strip before digit scans.
    const text = JSON.stringify(recs).replace(/\d{4}-\d{2}-\d{2}/g, "DATE");

    it("no e-mail / @ / URL", () => {
      expect(text).not.toMatch(/@/);
      expect(text).not.toMatch(/[\w.-]+@[\w.-]+\.\w+/);
      expect(text).not.toMatch(/https?:\/\/|www\./i);
    });
    it("no phone-like or long digit runs", () => {
      expect(text).not.toMatch(/\+?\d[\d\s().-]{8,}\d/);
      expect(text).not.toMatch(/\d{7,}/);
      expect(text).not.toMatch(/\b\d{11}\b/);
    });
    it("no IBAN/card-like patterns", () => {
      expect(text).not.toMatch(/\b[A-Z]{2}\d{2}[A-Z0-9 ]{10,}\b/);
      expect(text).not.toMatch(/\b(?:\d{4}[ -]?){3}\d{4}\b/);
    });
    it("names are labelled fake and ids are plain", () => {
      expect(recs.every((r) => r.name.startsWith("Sahte "))).toBe(true);
      expect(recs.every((r) => /^syn-\d{3,4}$/.test(r.id))).toBe(true);
      expect(recs.every((r) => r.amount >= 0 && r.amount < 100000)).toBe(true);
    });
  });
});
