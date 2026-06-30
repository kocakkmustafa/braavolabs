/**
 * external_control tool — registration + fail-safe gating (pure, no DB).
 *
 * The agent-approval gate for the external-automation control plane. The
 * executor intercepts meta.externalControl before any spend gate, but the meta
 * must ALSO be money-gated as defence-in-depth so the action is never ungated
 * if that branch is ever bypassed — at EVERY autonomy level (rule #3).
 */
import { describe, it, expect } from "vitest";
import { getTool, getToolMeta, requiresApprovalForAutonomy, type AgentAutonomyLevel } from "../registry";

describe("external_control tool registration", () => {
  it("is registered with the control-plane meta flags", () => {
    const tool = getTool("external_control");
    expect(tool).toBeDefined();
    const meta = getToolMeta("external_control");
    expect(meta?.externalControl).toBe(true);
    // Defence-in-depth: money-gated so it can never run ungated.
    expect(meta?.moneyTouching).toBe(true);
    expect(meta?.requiresApproval).toBe(true);
  });

  it("requires connectionId, action and targetId", () => {
    const schema = getTool("external_control")!.inputSchema as any;
    expect(schema.required).toEqual(expect.arrayContaining(["connectionId", "action", "targetId"]));
    expect(schema.properties.action.enum).toEqual(["TRIGGER", "PAUSE", "RESUME"]);
  });

  it("is gated at EVERY autonomy level (never ungated, even if the branch is bypassed)", () => {
    const meta = getToolMeta("external_control");
    for (const level of ["SUPERVISED", "BALANCED", "AUTONOMOUS"] as AgentAutonomyLevel[]) {
      expect(requiresApprovalForAutonomy(meta, level)).toBe(true);
    }
  });
});
