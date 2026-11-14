import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  generateSyntheticData,
  SYNTHETIC_MAX_COUNT,
  SYNTHETIC_MAX_SEED,
  type SyntheticRecord,
} from "../synthetic-data";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

describe("generateSyntheticData", () => {
  it("is deterministic: same seed+count gives identical JSON", () => {
    const a = generateSyntheticData({ seed: 42, count: 100 });
    const b = generateSyntheticData({ seed: 42, count: 100 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a).toEqual(b);
  });

  it("golden value: seed 42 first record and full-output hash are pinned", () => {
    const a = generateSyntheticData({ seed: 42, count: 100 });
    expect(a[0]).toEqual({
      id: "syn-001",
      kind: "customer",
      name: "Sahte Müşteri 001",
      company: "Sahte Yapay Mobilya",
      status: "iptal",
      amount: 66973.4,
      currency: "TRY",
      date: "2026-03-05",
    });
    expect(sha256(JSON.stringify(a))).toBe(
      "b6a3d98b52ef6cff677440bd2b04920bc7aaeb95e0aa450df7a662e0ae3b4e25",
    );
  });

  it("different seeds give different output (several pairs)", () => {
    const pairs: Array<[number, number]> = [[1, 2], [0, 1], [42, 43], [2 ** 31, 2 ** 31 + 1], [7, SYNTHETIC_MAX_SEED]];
    for (const [x, y] of pairs) {
      expect(generateSyntheticData({ seed: x, count: 50 })).not.toEqual(
        generateSyntheticData({ seed: y, count: 50 }),
      );
    }
  });

  it.each([0, 1, 100, SYNTHETIC_MAX_COUNT])("returns exactly %i records", (n) => {
    expect(generateSyntheticData({ seed: 7, count: n })).toHaveLength(n);
  });

  it.each([-1, 1001, NaN, 1.5, Infinity, null, undefined, "5"])("rejects count %s with RangeError", (n) => {
    expect(() => generateSyntheticData({ seed: 1, count: n as never })).toThrow(RangeError);
  });

  it.each([NaN, 1.5, Infinity, null, undefined, "1", -1, 2 ** 32, 2 ** 53, -(2 ** 31)])(
    "rejects seed %s with RangeError",
    (s) => {
      expect(() => generateSyntheticData({ seed: s as never, count: 1 })).toThrow(RangeError);
    },
  );

  it("accepts the full unsigned 32-bit seed range (0, 2**31, 2**32-1)", () => {
    for (const seed of [0, 2 ** 31, SYNTHETIC_MAX_SEED]) {
      expect(generateSyntheticData({ seed, count: 3 })).toHaveLength(3);
    }
  });

  it.each(["x", null, 5])("rejects kind %s with RangeError", (k) => {
    expect(() => generateSyntheticData({ seed: 1, count: 1, kind: k as never })).toThrow(RangeError);
  });

  it("honours kind filter; mixed yields both kinds", () => {
    const t = generateSyntheticData({ seed: 1, count: 20, kind: "task" });
    const c = generateSyntheticData({ seed: 1, count: 20, kind: "customer" });
    expect(t.every((r) => r.kind === "task" && r.name.startsWith("Sahte Görev"))).toBe(true);
    expect(c.every((r) => r.kind === "customer" && /^Sahte Müşteri \d{3}$/.test(r.name))).toBe(true);
    for (const seed of [1, 2, 3, 4, 5]) {
      const kinds = new Set(generateSyntheticData({ seed, count: 100 }).map((r) => r.kind));
      expect(kinds).toEqual(new Set(["task", "customer"]));
    }
  });

  it("is JSON-serializable and does not touch Date.now/Math.random", () => {
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

  describe("field shapes", () => {
    const recs = generateSyntheticData({ seed: 3, count: SYNTHETIC_MAX_COUNT });

    it("date is a valid 2026 calendar date", () => {
      for (const r of recs) {
        expect(r.date).toMatch(/^2026-\d{2}-\d{2}$/);
        const d = new Date(`${r.date}T00:00:00.000Z`);
        expect(Number.isNaN(d.getTime())).toBe(false);
        expect(d.toISOString().slice(0, 10)).toBe(r.date);
      }
    });

    it("amount is rounded to 2 decimals, < 100000, currency TRY", () => {
      for (const r of recs) {
        expect(Math.round(r.amount * 100) / 100).toBe(r.amount);
        expect(r.amount).toBeGreaterThanOrEqual(0);
        expect(r.amount).toBeLessThan(100000);
        expect(r.currency).toBe("TRY");
      }
    });

    it("company and name carry the Sahte label; ids are plain", () => {
      expect(recs.every((r) => r.company.startsWith("Sahte "))).toBe(true);
      expect(recs.every((r) => r.name.startsWith("Sahte "))).toBe(true);
      expect(recs.every((r) => /^syn-\d{3,4}$/.test(r.id))).toBe(true);
    });
  });

  describe.each([1, 42, 20260101, 2 ** 31, SYNTHETIC_MAX_SEED])(
    "no personal-data patterns in 1000 records (seed %i)",
    (seed) => {
      const recs = generateSyntheticData({ seed, count: SYNTHETIC_MAX_COUNT });
      // Structural: scan every field except `date` (checked separately above).
      const scanned = recs.map(({ date: _date, ...rest }: SyntheticRecord) => rest);
      const text = JSON.stringify(scanned);

      it("no e-mail / @ / URL / bare domain", () => {
        expect(text).not.toMatch(/@/);
        expect(text).not.toMatch(/[\w.-]+@[\w.-]+\.\w+/);
        expect(text).not.toMatch(/https?:\/\/|www\./i);
        expect(text).not.toMatch(/\b[a-z0-9-]+\.(com|net|org|io|tr)\b/i);
      });
      it("no phone-like or long digit runs", () => {
        expect(text).not.toMatch(/\+?\d[\d\s().-]{8,}\d/);
        expect(text).not.toMatch(/\d{7,}/);
        expect(text).not.toMatch(/\b\d{11}\b/);
      });
      it("no IBAN/card-like patterns (any case)", () => {
        expect(text).not.toMatch(/\b[a-z]{2}\d{2}[a-z0-9 ]{10,}\b/i);
        expect(text).not.toMatch(/\b(?:\d{4}[ -]?){3}\d{4}\b/);
      });
    },
  );
});
