export type RiskStopType =
  | "hard_stop"
  | "loop_stop"
  | "cost_anomaly_stop"
  | "spam_stop"
  | "brand_violation_stop";

export interface RiskEvent {
  type: RiskStopType;
  runId: string;
  companyId: string;
  reason: string;
  details: Record<string, unknown>;
  triggeredAt: Date;
}

export interface GovernanceConfig {
  maxConsecutiveFailures: number; // loop detection threshold (default: 5)
  maxUnansweredOutreach: number;  // spam protection (default: 3)
  costAnomalyThreshold: number;  // percentage of budget (default: 0.2)
  enabledStops: RiskStopType[];
}
