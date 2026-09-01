import { describe, expect, it } from "vitest";
import {
  LEGACY_PLAN_MIGRATION,
  NEW_SALE_PLAN_CATALOG,
  PLAN_LABEL,
  PLAN_LIMITS,
  PLAN_ORDER,
  PLAN_PRICING,
  isPlanUpgrade,
  normalizePlanForEntitlement,
} from "../constants/plans";

describe("canonical new-sale catalog", () => {
  it("contains exactly Individual and Team, with the accepted monthly price units", () => {
    expect(PLAN_ORDER).toEqual(["INDIVIDUAL", "TEAM"]);
    expect(NEW_SALE_PLAN_CATALOG).toEqual([
      {
        id: "INDIVIDUAL", label: "Individual", monthlyUsd: 19,
        billingUnit: "account", inferenceIncluded: false,
        billingCycle: "monthly", providerFunding: "tenant",
      },
      {
        id: "TEAM", label: "Team", monthlyUsd: 39,
        billingUnit: "active-seat", inferenceIncluded: false,
        billingCycle: "monthly", providerFunding: "tenant",
      },
    ]);
    expect(Object.keys(PLAN_LABEL)).toEqual(["INDIVIDUAL", "TEAM"]);
    expect(Object.keys(PLAN_PRICING)).toEqual(["INDIVIDUAL", "TEAM"]);
  });

  it("does not publish a free, trial, annual, token, cost, or hosted-inference entitlement", () => {
    const serialized = JSON.stringify(NEW_SALE_PLAN_CATALOG).toLowerCase();
    for (const forbidden of ["free", "trial", "yearly", "annual", "token", "credit", "managed", "system-funded"]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(NEW_SALE_PLAN_CATALOG.every((plan) => plan.inferenceIncluded === false)).toBe(true);
    expect(PLAN_LIMITS.INDIVIDUAL.maxRunsPerMonth).toBe(-1);
    expect(PLAN_LIMITS.TEAM.maxRunsPerMonth).toBe(-1);
  });

  it("keeps compatibility tiers out of runtime new-sale enumeration", () => {
    expect(PLAN_ORDER).toEqual(["INDIVIDUAL", "TEAM"]);
    expect(PLAN_ORDER).not.toContain("CREATOR");
    expect(PLAN_ORDER).not.toContain("PRO");
    expect(PLAN_ORDER).not.toContain("MANUAL_REVIEW");
  });
});

describe("additive legacy normalization", () => {
  it("maps only stable price-equivalent identities and fails every ambiguous tier closed", () => {
    expect(LEGACY_PLAN_MIGRATION).toEqual({
      FREE: "MANUAL_REVIEW", CREATOR: "INDIVIDUAL", PRO: "TEAM",
      BUSINESS: "MANUAL_REVIEW", ENTERPRISE: "MANUAL_REVIEW",
    });
    expect(normalizePlanForEntitlement("INDIVIDUAL")).toBe("INDIVIDUAL");
    expect(normalizePlanForEntitlement("TEAM")).toBe("TEAM");
    expect(normalizePlanForEntitlement("UNKNOWN_TIER")).toBe("MANUAL_REVIEW");
    expect(normalizePlanForEntitlement(null)).toBe("MANUAL_REVIEW");
  });

  it("retains compatibility limits without making legacy tiers saleable", () => {
    expect(Object.keys(PLAN_LIMITS).sort()).toEqual(
      ["INDIVIDUAL", "TEAM", "MANUAL_REVIEW", "FREE", "CREATOR", "PRO", "BUSINESS", "ENTERPRISE"].sort(),
    );
    expect(PLAN_LIMITS.CREATOR).toEqual(PLAN_LIMITS.INDIVIDUAL);
    expect(PLAN_LIMITS.PRO).toEqual(PLAN_LIMITS.TEAM);
    expect(PLAN_LIMITS.MANUAL_REVIEW.maxCompanies).toBe(0);
    expect(PLAN_LIMITS.FREE).toEqual(PLAN_LIMITS.MANUAL_REVIEW);
  });
});

describe("upgrade comparison", () => {
  it("compares canonical plans after normalization", () => {
    expect(isPlanUpgrade("INDIVIDUAL", "TEAM")).toBe(true);
    expect(isPlanUpgrade("CREATOR", "TEAM")).toBe(true);
    expect(isPlanUpgrade("TEAM", "INDIVIDUAL")).toBe(false);
    expect(isPlanUpgrade("PRO", "TEAM")).toBe(false);
  });

  it("lets a manual-review account explicitly choose either new-sale plan without guessing one", () => {
    expect(isPlanUpgrade("MANUAL_REVIEW", "INDIVIDUAL")).toBe(true);
    expect(isPlanUpgrade("BUSINESS", "TEAM")).toBe(true);
  });
});
