import { describe, expect, it } from "vitest";
import {
  PLAN_LABEL,
  PLAN_LIMITS,
  PLAN_ORDER,
  PLAN_PRICING,
  isPlanUpgrade,
} from "../constants/plans";

describe("isPlanUpgrade", () => {
  it("returns true when moving from a lower tier to a higher tier", () => {
    expect(isPlanUpgrade("FREE", "CREATOR")).toBe(true);
    expect(isPlanUpgrade("CREATOR", "PRO")).toBe(true);
    expect(isPlanUpgrade("FREE", "ENTERPRISE")).toBe(true);
  });

  it("returns false when moving from a higher tier to a lower tier", () => {
    expect(isPlanUpgrade("BUSINESS", "CREATOR")).toBe(false);
    expect(isPlanUpgrade("ENTERPRISE", "FREE")).toBe(false);
  });

  it("returns false when current and target are the same tier", () => {
    expect(isPlanUpgrade("PRO", "PRO")).toBe(false);
  });
});

describe("PLAN_ORDER", () => {
  it("contains exactly the five plan tiers in monotonically increasing value order", () => {
    expect(PLAN_ORDER).toEqual(["FREE", "CREATOR", "PRO", "BUSINESS", "ENTERPRISE"]);
  });

  it("matches the keys defined in PLAN_LIMITS / PLAN_PRICING / PLAN_LABEL", () => {
    expect(Object.keys(PLAN_LIMITS).sort()).toEqual([...PLAN_ORDER].sort());
    expect(Object.keys(PLAN_PRICING).sort()).toEqual([...PLAN_ORDER].sort());
    expect(Object.keys(PLAN_LABEL).sort()).toEqual([...PLAN_ORDER].sort());
  });
});

describe("PLAN_LIMITS", () => {
  it("uses the -1 sentinel for unlimited dimensions on ENTERPRISE", () => {
    expect(PLAN_LIMITS.ENTERPRISE.maxCompanies).toBe(-1);
    expect(PLAN_LIMITS.ENTERPRISE.maxRunsPerMonth).toBe(-1);
    expect(PLAN_LIMITS.ENTERPRISE.maxAgentsPerCompany).toBe(-1);
    expect(PLAN_LIMITS.ENTERPRISE.maxConnectedAutomations).toBe(-1);
    expect(PLAN_LIMITS.ENTERPRISE.maxSeats).toBe(-1);
  });

  it("v2 automation dims: connected-automations scale on metered tiers, unlimited above", () => {
    expect(PLAN_LIMITS.FREE.maxConnectedAutomations).toBe(1);
    expect(PLAN_LIMITS.CREATOR.maxConnectedAutomations).toBe(3);
    expect(PLAN_LIMITS.PRO.maxConnectedAutomations).toBe(10);
    expect(PLAN_LIMITS.FREE.maxConnectedAutomations).toBeLessThan(PLAN_LIMITS.CREATOR.maxConnectedAutomations);
    expect(PLAN_LIMITS.CREATOR.maxConnectedAutomations).toBeLessThan(PLAN_LIMITS.PRO.maxConnectedAutomations);
    expect(PLAN_LIMITS.BUSINESS.maxConnectedAutomations).toBe(-1); // unlimited
  });

  it("v2: seats grow with tier; on-device offline gated above Free", () => {
    expect(PLAN_LIMITS.FREE.maxSeats).toBe(1);
    expect(PLAN_LIMITS.PRO.maxSeats).toBeGreaterThan(PLAN_LIMITS.CREATOR.maxSeats);
    expect(PLAN_LIMITS.BUSINESS.maxSeats).toBeGreaterThan(PLAN_LIMITS.PRO.maxSeats);
    expect(PLAN_LIMITS.FREE.onDeviceOffline).toBe(false);
    for (const p of ["CREATOR", "PRO", "BUSINESS", "ENTERPRISE"] as const) {
      expect(PLAN_LIMITS[p].onDeviceOffline).toBe(true);
    }
  });

  it("keeps FREE plan within the documented free-tier shape", () => {
    expect(PLAN_LIMITS.FREE.maxCompanies).toBe(1);
    expect(PLAN_LIMITS.FREE.maxRunsPerMonth).toBe(10);
    expect(PLAN_LIMITS.FREE.channels).toEqual(["tiktok", "linkedin"]);
  });

  it("scales monotonically across paid tiers for the headline limits", () => {
    const tiers = ["CREATOR", "PRO", "BUSINESS"] as const;
    for (let i = 1; i < tiers.length; i++) {
      const prev = PLAN_LIMITS[tiers[i - 1]!]!;
      const curr = PLAN_LIMITS[tiers[i]!]!;
      expect(curr.maxCompanies).toBeGreaterThan(prev.maxCompanies);
      expect(curr.maxRunsPerMonth).toBeGreaterThan(prev.maxRunsPerMonth);
      expect(curr.maxAgentsPerCompany).toBeGreaterThanOrEqual(prev.maxAgentsPerCompany);
    }
  });
});

describe("PLAN_PRICING", () => {
  it("encodes the 20% annual discount within $1 of (monthly × 12 × 0.80)", () => {
    // FREE and ENTERPRISE are sentinel-priced (0) — skip them.
    const billable = ["CREATOR", "PRO", "BUSINESS"] as const;
    for (const plan of billable) {
      const { monthlyUsd, yearlyUsd } = PLAN_PRICING[plan];
      const expected = monthlyUsd * 12 * 0.8;
      expect(Math.abs(yearlyUsd - expected)).toBeLessThanOrEqual(1);
    }
  });

  it("keeps FREE and ENTERPRISE at price 0 (sentinel for free / contact-sales)", () => {
    expect(PLAN_PRICING.FREE.monthlyUsd).toBe(0);
    expect(PLAN_PRICING.FREE.yearlyUsd).toBe(0);
    expect(PLAN_PRICING.ENTERPRISE.monthlyUsd).toBe(0);
    expect(PLAN_PRICING.ENTERPRISE.yearlyUsd).toBe(0);
  });
});
