/**
 * Graduated autonomy (Feature D6) — pure unit tests for the approval decision.
 *
 * Guards the inviolable rule (#3): money-touching tools are gated at EVERY
 * autonomy level, and the per-level relaxation only applies to non-money tools.
 */
import { describe, it, expect } from "vitest";
import {
  requiresApprovalForAutonomy,
  isMoneyTouching,
  type ToolMeta,
} from "../registry";

const money: ToolMeta = { requiresApproval: true, riskLevel: "high", moneyTouching: true };
// requiresApproval=true with no explicit moneyTouching flag → treated as money
// by the safe-default fallback (historically requiresApproval marked spend),
// so it stays gated even under AUTONOMOUS.
const approvalNoFlag: ToolMeta = { requiresApproval: true, riskLevel: "medium" };
// An explicitly non-money but still-required action (e.g. a send that a tool
// author wants gated under SUPERVISED/BALANCED but freed under AUTONOMOUS).
const riskyActionNonMoney: ToolMeta = { requiresApproval: true, riskLevel: "medium", moneyTouching: false };
const mediumRead: ToolMeta = { requiresApproval: false, riskLevel: "medium" };
const lowGenerate: ToolMeta = { requiresApproval: false, riskLevel: "low" };
const highNoFlag: ToolMeta = { requiresApproval: false, riskLevel: "high" };

describe("isMoneyTouching", () => {
  it("explicit moneyTouching flag wins", () => {
    expect(isMoneyTouching(money)).toBe(true);
  });
  it("falls back to requiresApproval when flag absent", () => {
    expect(isMoneyTouching(approvalNoFlag)).toBe(true); // requiresApproval=true
    expect(isMoneyTouching(mediumRead)).toBe(false);
  });
  it("explicit moneyTouching:false overrides the requiresApproval fallback", () => {
    expect(isMoneyTouching(riskyActionNonMoney)).toBe(false);
  });
  it("undefined meta is not money", () => {
    expect(isMoneyTouching(undefined)).toBe(false);
  });
});

describe("requiresApprovalForAutonomy — money is always gated (rule #3)", () => {
  for (const level of ["SUPERVISED", "BALANCED", "AUTONOMOUS"] as const) {
    it(`money tool gated at ${level}`, () => {
      expect(requiresApprovalForAutonomy(money, level)).toBe(true);
    });
  }
});

describe("requiresApprovalForAutonomy — SUPERVISED", () => {
  it("pauses on any side-effecting / non-low-risk tool", () => {
    expect(requiresApprovalForAutonomy(riskyActionNonMoney, "SUPERVISED")).toBe(true);
    expect(requiresApprovalForAutonomy(mediumRead, "SUPERVISED")).toBe(true);
    expect(requiresApprovalForAutonomy(highNoFlag, "SUPERVISED")).toBe(true);
  });
  it("does NOT pause on pure low-risk generate/read tools", () => {
    expect(requiresApprovalForAutonomy(lowGenerate, "SUPERVISED")).toBe(false);
  });
});

describe("requiresApprovalForAutonomy — BALANCED (historical default)", () => {
  it("pauses on spend/action (requiresApproval) tools", () => {
    expect(requiresApprovalForAutonomy(riskyActionNonMoney, "BALANCED")).toBe(true);
  });
  it("pauses on high-risk tools even without the flag", () => {
    expect(requiresApprovalForAutonomy(highNoFlag, "BALANCED")).toBe(true);
  });
  it("does NOT pause on medium-risk non-approval tools", () => {
    expect(requiresApprovalForAutonomy(mediumRead, "BALANCED")).toBe(false);
  });
  it("does NOT pause on low-risk tools", () => {
    expect(requiresApprovalForAutonomy(lowGenerate, "BALANCED")).toBe(false);
  });
});

describe("requiresApprovalForAutonomy — AUTONOMOUS", () => {
  it("never pauses for non-money tools, even risky ones", () => {
    expect(requiresApprovalForAutonomy(riskyActionNonMoney, "AUTONOMOUS")).toBe(false);
    expect(requiresApprovalForAutonomy(highNoFlag, "AUTONOMOUS")).toBe(false);
    expect(requiresApprovalForAutonomy(mediumRead, "AUTONOMOUS")).toBe(false);
    expect(requiresApprovalForAutonomy(lowGenerate, "AUTONOMOUS")).toBe(false);
  });
  it("still gates money tools — explicit flag AND requiresApproval fallback (rule #3)", () => {
    expect(requiresApprovalForAutonomy(money, "AUTONOMOUS")).toBe(true);
    // requiresApproval=true with no explicit non-money flag stays money-gated.
    expect(requiresApprovalForAutonomy(approvalNoFlag, "AUTONOMOUS")).toBe(true);
  });
});
