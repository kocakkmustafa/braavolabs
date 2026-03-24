export type Plan = "FREE" | "PRO" | "ENTERPRISE";

export interface PlanLimits {
  maxCompanies: number;
  maxRunsPerMonth: number;
  maxAgentsPerCompany: number;
  channels: string[];
  features: string[];
}

export interface UsageMeterInput {
  tenantId: string;
  metric: string;
  value: number;
  periodStart: Date;
  periodEnd: Date;
}
