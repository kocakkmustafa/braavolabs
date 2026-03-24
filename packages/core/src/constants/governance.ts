import type { GovernanceConfig, RiskStopType } from "../types/governance";

export const DEFAULT_GOVERNANCE_CONFIG: GovernanceConfig = {
  maxConsecutiveFailures: 5,   // loop detection
  maxUnansweredOutreach: 3,    // spam protection
  costAnomalyThreshold: 0.2,  // 20% of budget
  enabledStops: [
    "hard_stop",
    "loop_stop",
    "cost_anomaly_stop",
    "spam_stop",
    "brand_violation_stop",
  ],
};

export const RISK_STOP_DESCRIPTIONS: Record<RiskStopType, string> = {
  hard_stop: "Forced stop by user or system policy",
  loop_stop: "Automatic stop after too many consecutive failures",
  cost_anomaly_stop: "Run cost exceeded budget threshold",
  spam_stop: "Too many unanswered messages to same target",
  brand_violation_stop: "Content flagged for brand safety violation",
};
