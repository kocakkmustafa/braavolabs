import {
  RISK_CLASSES,
  type HoldingRiskClassStr,
  type HoldingTrustLevelStr,
  type PolicyResult,
} from "./types";

/**
 * Central policy choke-point (FABLE_PLAN §3, Anayasa §1-§2).
 *
 * Every holding action passes through here exactly once, at run creation.
 * Rules are ordered most-restrictive-first and the default is DENY: an input
 * this function cannot classify never executes.
 *
 * Invariants this encodes (do not weaken without a founder Karar Kaydı):
 *  - R4/R5 never auto-execute, at ANY autonomy level ("bu sınır otonomiye
 *    hiç açılmaz").
 *  - UNTRUSTED input cannot drive anything above R1 without a human
 *    (prompt-injection gate).
 *  - Unknown/missing risk class → DENY (fail-closed), never "assume low".
 */
export interface PolicyInput {
  riskClass: HoldingRiskClassStr;
  trustLevel: HoldingTrustLevelStr;
  /** Autonomy level of the workflow DEFINITION (L0-L5), not of any agent. */
  autonomyLevel: number;
}

export function evaluatePolicy(input: PolicyInput): PolicyResult {
  const { riskClass, trustLevel, autonomyLevel } = input;

  if (!RISK_CLASSES.includes(riskClass)) {
    return { decision: "DENY", reason: `unknown risk class ${String(riskClass)} — fail-closed` };
  }
  if (trustLevel !== "TRUSTED" && trustLevel !== "UNTRUSTED") {
    return { decision: "DENY", reason: "unknown trust level — fail-closed" };
  }
  if (!Number.isInteger(autonomyLevel) || autonomyLevel < 0 || autonomyLevel > 5) {
    return { decision: "DENY", reason: `invalid autonomy level ${String(autonomyLevel)} — fail-closed` };
  }

  // R4/R5: always the founder, regardless of trust or autonomy history.
  if (riskClass === "R4" || riskClass === "R5") {
    return { decision: "REQUIRE_APPROVAL", reason: `${riskClass} is founder-only (Anayasa §1)` };
  }

  // Untrusted provenance caps autonomous action at R1.
  if (trustLevel === "UNTRUSTED" && riskClass !== "R0" && riskClass !== "R1") {
    return {
      decision: "REQUIRE_APPROVAL",
      reason: `untrusted input cannot drive ${riskClass} without a human (injection gate)`,
    };
  }

  if (riskClass === "R0" || riskClass === "R1") {
    return { decision: "ALLOW", reason: `${riskClass} is autonomous from day one (Anayasa §2)` };
  }

  // R2/R3: allowed only once the DEFINITION has earned L4+ (template approval
  // for R2, the 20-run ladder for R3 — both recorded as founder decisions).
  if (autonomyLevel >= 4) {
    return { decision: "ALLOW", reason: `${riskClass} at L${autonomyLevel} (earned autonomy)` };
  }
  return {
    decision: "REQUIRE_APPROVAL",
    reason: `${riskClass} at L${autonomyLevel} — approval required until the ladder promotes this workflow`,
  };
}
