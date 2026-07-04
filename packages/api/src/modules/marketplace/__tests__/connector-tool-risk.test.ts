/**
 * D-005 (E5/T4) — pure risk derivation for dynamic connector tools.
 *
 * A remote connector tool has no static ToolMeta, so its approval / money
 * gate is derived from its name + description. These tests pin the
 * fail-safe contract: money verbs → moneyTouching (gated everywhere),
 * mutating verbs → high + approval, read verbs → low, ambiguous → medium +
 * approval (never low).
 */
import { describe, it, expect } from "vitest";
import {
  deriveConnectorToolMeta,
  type PublisherRiskHint,
} from "../connector-tool-risk";
import {
  isMoneyTouching,
  requiresApprovalForAutonomy,
} from "../../agent/registry";

describe("deriveConnectorToolMeta — money verbs → moneyTouching (rule #3)", () => {
  for (const name of [
    "charge_card",
    "transfer_funds",
    "wire_payment",
    "issue_refund",
    "create_payout",
    "purchase_item",
  ]) {
    it(`${name} is money-touching + high + approval`, () => {
      const meta = deriveConnectorToolMeta(name, "");
      expect(meta.moneyTouching).toBe(true);
      expect(meta.riskLevel).toBe("high");
      expect(meta.requiresApproval).toBe(true);
      expect(isMoneyTouching(meta)).toBe(true);
      // Gated at EVERY autonomy level.
      for (const lvl of ["SUPERVISED", "BALANCED", "AUTONOMOUS"] as const) {
        expect(requiresApprovalForAutonomy(meta, lvl)).toBe(true);
      }
    });
  }

  it("derives money from the DESCRIPTION even when the name is neutral", () => {
    const meta = deriveConnectorToolMeta("run_action", "Charges the customer's card for the order");
    expect(meta.moneyTouching).toBe(true);
  });
});

describe("deriveConnectorToolMeta — mutating verbs → high + approval", () => {
  for (const name of [
    "delete_record",
    "remove_user",
    "send_email",
    "post_message",
    "deploy_site",
    "create_ticket",
    "update_row",
    "revoke_key",
  ]) {
    it(`${name} is high risk + requiresApproval, not money`, () => {
      const meta = deriveConnectorToolMeta(name, "");
      expect(meta.riskLevel).toBe("high");
      expect(meta.requiresApproval).toBe(true);
      // Explicitly non-money so it isn't false-money-gated under AUTONOMOUS.
      expect(meta.moneyTouching).toBe(false);
      expect(isMoneyTouching(meta)).toBe(false);
      // Gated under SUPERVISED and BALANCED (high risk).
      expect(requiresApprovalForAutonomy(meta, "SUPERVISED")).toBe(true);
      expect(requiresApprovalForAutonomy(meta, "BALANCED")).toBe(true);
    });
  }
});

describe("deriveConnectorToolMeta — read verbs → low, no approval", () => {
  for (const name of [
    "list_items",
    "get_record",
    "read_file",
    "search_contacts",
    "fetch_status",
    "query_db",
  ]) {
    it(`${name} is low risk + no approval`, () => {
      const meta = deriveConnectorToolMeta(name, "");
      expect(meta.riskLevel).toBe("low");
      expect(meta.requiresApproval).toBe(false);
      expect(isMoneyTouching(meta)).toBe(false);
      // Runs freely even under SUPERVISED (loop must not stall on reads).
      expect(requiresApprovalForAutonomy(meta, "SUPERVISED")).toBe(false);
    });
  }
});

describe("deriveConnectorToolMeta — fail-safe defaults", () => {
  it("ambiguous verb (no read/high/money signal) → medium + approval", () => {
    const meta = deriveConnectorToolMeta("frobnicate_widget", "does a thing");
    expect(meta.riskLevel).toBe("medium");
    expect(meta.requiresApproval).toBe(true);
    // SUPERVISED pauses on medium; AUTONOMOUS lets it through (non-money).
    expect(requiresApprovalForAutonomy(meta, "SUPERVISED")).toBe(true);
    expect(requiresApprovalForAutonomy(meta, "AUTONOMOUS")).toBe(false);
  });

  it("empty name + empty description → medium + approval (never silently low)", () => {
    const meta = deriveConnectorToolMeta("", "");
    expect(meta.riskLevel).toBe("medium");
    expect(meta.requiresApproval).toBe(true);
  });

  it("does NOT falsely match a substring (undeletable ≠ delete)", () => {
    const meta = deriveConnectorToolMeta("mark_undeletable", "flag a row as protected");
    expect(meta.riskLevel).not.toBe("high");
  });

  it("splits camelCase so deleteRecord matches 'delete'", () => {
    const meta = deriveConnectorToolMeta("deleteRecord", "");
    expect(meta.riskLevel).toBe("high");
    expect(meta.requiresApproval).toBe(true);
  });
});

describe("deriveConnectorToolMeta — publisher hint only raises risk", () => {
  it("hint 'money' forces money-touching even on a neutral name", () => {
    const meta = deriveConnectorToolMeta("do_thing", "", undefined, "money" as PublisherRiskHint);
    expect(meta.moneyTouching).toBe(true);
  });

  it("hint 'high' forces high + approval", () => {
    const meta = deriveConnectorToolMeta("do_thing", "", undefined, "high");
    expect(meta.riskLevel).toBe("high");
    expect(meta.requiresApproval).toBe(true);
  });

  it("a money VERB wins even if the publisher hints 'low'", () => {
    const meta = deriveConnectorToolMeta("charge_card", "", undefined, "low");
    expect(meta.moneyTouching).toBe(true);
    expect(meta.riskLevel).toBe("high");
  });
});
