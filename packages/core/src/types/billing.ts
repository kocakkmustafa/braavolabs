export type Plan = "FREE" | "CREATOR" | "PRO" | "BUSINESS" | "ENTERPRISE";
export type BillingCycle = "monthly" | "yearly";

export interface PlanLimits {
  maxCompanies: number;
  maxRunsPerMonth: number;
  maxAgentsPerCompany: number;
  channels: string[];
  features: string[];
}

export interface PlanPricing {
  monthlyUsd: number;
  yearlyUsd: number; // yearly total (monthly × 12 × 0.80 for 20% discount)
  yearlyMonthlyEquivalent: number;
}

export interface UsageMeterInput {
  tenantId: string;
  metric: string;
  value: number;
  periodStart: Date;
  periodEnd: Date;
}
