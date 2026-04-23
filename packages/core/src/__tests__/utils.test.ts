import { describe, expect, it } from "vitest";
import { clamp, isUnlimited, isWithinLimit, sleep, slugify } from "../utils";

describe("slugify", () => {
  it("lowercases, trims, and replaces whitespace with hyphens", () => {
    expect(slugify("  Hello World  ")).toBe("hello-world");
  });

  it("strips punctuation, then collapses the surrounding whitespace into a single hyphen", () => {
    // Em dash (—) is removed first by [^\w\s-], leaving "acme inc  2026",
    // then [\s_]+ collapses any run of whitespace into a single hyphen.
    expect(slugify("Acme, Inc. — 2026!")).toBe("acme-inc-2026");
  });

  it("preserves existing hyphens already in the input", () => {
    expect(slugify("multi-word-thing")).toBe("multi-word-thing");
  });

  it("collapses underscores and runs of whitespace into single hyphens", () => {
    expect(slugify("foo___bar   baz")).toBe("foo-bar-baz");
  });

  it("strips leading and trailing hyphens", () => {
    expect(slugify("---hello---")).toBe("hello");
  });

  it("returns an empty string for input that is only punctuation", () => {
    expect(slugify("!!!???")).toBe("");
  });
});

describe("clamp", () => {
  it("returns the value when it sits inside [min, max]", () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });

  it("clamps below the minimum to the minimum", () => {
    expect(clamp(-3, 0, 10)).toBe(0);
  });

  it("clamps above the maximum to the maximum", () => {
    expect(clamp(42, 0, 10)).toBe(10);
  });

  it("supports negative ranges", () => {
    expect(clamp(-50, -20, -10)).toBe(-20);
    expect(clamp(0, -20, -10)).toBe(-10);
  });
});

describe("sleep", () => {
  it("resolves after at least the requested delay", async () => {
    const start = Date.now();
    await sleep(20);
    const elapsed = Date.now() - start;
    // Allow a small scheduling jitter — 15ms floor is generous on slow CI.
    expect(elapsed).toBeGreaterThanOrEqual(15);
  });
});

describe("isUnlimited", () => {
  it("treats -1 as the unlimited sentinel", () => {
    expect(isUnlimited(-1)).toBe(true);
  });

  it("returns false for any non -1 value, including zero", () => {
    expect(isUnlimited(0)).toBe(false);
    expect(isUnlimited(1)).toBe(false);
    expect(isUnlimited(100)).toBe(false);
  });
});

describe("isWithinLimit", () => {
  it("returns true when current is strictly below limit", () => {
    expect(isWithinLimit(9, 10)).toBe(true);
  });

  it("returns false when current equals the limit (limit is exclusive)", () => {
    // 10/10 means the next operation would overshoot — should be rejected.
    expect(isWithinLimit(10, 10)).toBe(false);
  });

  it("returns false when current exceeds the limit", () => {
    expect(isWithinLimit(11, 10)).toBe(false);
  });

  it("always returns true when limit is the unlimited sentinel (-1)", () => {
    expect(isWithinLimit(0, -1)).toBe(true);
    expect(isWithinLimit(1_000_000, -1)).toBe(true);
  });
});
