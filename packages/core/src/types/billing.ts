export type NewSalePlan = "INDIVIDUAL" | "TEAM";
export type LegacyPlan = "FREE" | "CREATOR" | "PRO" | "BUSINESS" | "ENTERPRISE";
export type ManualReviewPlan = "MANUAL_REVIEW";

/**
 * `Plan` remains additive for one compatibility release. Only NewSalePlan
 * values may be offered for checkout; legacy values are accepted as input
 * solely so historical rows and receipts can be replayed deterministically.
 */
export type Plan = NewSalePlan | LegacyPlan | ManualReviewPlan;
export type BillingCycle = "monthly";

export interface PlanLimits {
  maxCompanies: number;
  /** Operational telemetry only for canonical plans; never an inference entitlement. */
  maxRunsPerMonth: number;
  maxAgentsPerCompany: number;
  maxConnectedAutomations: number;
  maxSeats: number;
  localProvider: boolean;
  auditRetentionDays: number;
  sso: "none" | "oidc" | "oidc_scim";
  channels: string[];
  features: string[];
}

export interface PlanPricing {
  monthlyUsd: number;
  billingUnit: "account" | "active-seat";
  inferenceIncluded: false;
}

export interface UsageMeterInput {
  tenantId: string;
  metric: string;
  value: number;
  periodStart: Date;
  periodEnd: Date;
}
