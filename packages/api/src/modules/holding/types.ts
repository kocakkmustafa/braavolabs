/**
 * YULA Holding Orchestrator — shared module types.
 *
 * These mirror the `Holding*` Prisma models but stay string-literal based so
 * pure logic (charter linter, policy engine, cost guard) is testable without
 * a generated Prisma client.
 */

export type HoldingRiskClassStr = "R0" | "R1" | "R2" | "R3" | "R4" | "R5";
export type HoldingTrustLevelStr = "TRUSTED" | "UNTRUSTED";
export type HoldingSeverityStr = "SEV0" | "SEV1" | "SEV2" | "SEV3" | "INFO";

export const RISK_CLASSES: readonly HoldingRiskClassStr[] = [
  "R0",
  "R1",
  "R2",
  "R3",
  "R4",
  "R5",
];

/**
 * Charter (Kompanzasyon §5A): the immutable setpoint every hop is measured
 * against. Frozen at run creation; ≤500 estimated tokens; K0-linted.
 */
export interface HoldingCharter {
  /** 1-2 sentence goal. */
  goal: string;
  /** ≥1 entry; at least one must contain a measurable predicate. */
  successCriteria: string[];
  /** Constraints / forbidden moves. May be empty but must be present. */
  constraints: string[];
  riskClass: HoldingRiskClassStr;
  /** Source references (registry:/doc:/file:/https:) — kulaktan kulağa yasak. */
  sources: string[];
  /** Pre-flight cost estimate for the Cost Guard. Omitted = 0. */
  estCostUsd?: number;
}

/**
 * Closed set of executable step kinds. Anything not in this set is rejected
 * at run creation — DB rows can never smuggle new behaviour into the runner.
 * v1 is deliberately boring (deterministic golden-path proof); LLM/router
 * steps arrive with the model-key wiring in a later slice.
 */
export const STEP_KINDS = ["noop", "log", "approval"] as const;
export type HoldingStepKind = (typeof STEP_KINDS)[number];

export interface HoldingStepDef {
  name: string;
  kind: HoldingStepKind;
  /** Platform rule #2: every step records why it exists. Never empty. */
  reasoning: string;
  params?: Record<string, unknown>;
}

export type PolicyDecision = "ALLOW" | "REQUIRE_APPROVAL" | "DENY";

export interface PolicyResult {
  decision: PolicyDecision;
  reason: string;
}
