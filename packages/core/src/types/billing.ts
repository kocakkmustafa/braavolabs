export type Plan = "FREE" | "CREATOR" | "PRO" | "BUSINESS" | "ENTERPRISE";
export type BillingCycle = "monthly" | "yearly";

export interface PlanLimits {
  /** Max workspaces (the `Company` model — "workspace" at the label layer). -1 = unlimited. */
  maxCompanies: number;
  maxRunsPerMonth: number;
  maxAgentsPerCompany: number;
  /** v2: max connected external automations (n8n/Make/Zapier/generic). -1 = unlimited. */
  maxConnectedAutomations: number;
  /** v2: max team members on the tenant. -1 = unlimited. */
  maxSeats: number;
  /** v2: may use on-device / offline inference (mobile Gemma, desktop local). */
  onDeviceOffline: boolean;
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
