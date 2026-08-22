import type {
  LegacyPlan,
  NewSalePlan,
  Plan,
  PlanLimits,
  PlanPricing,
} from "../types/billing";

export const PLAN_ORDER: readonly NewSalePlan[] = ["INDIVIDUAL", "TEAM"] as const;

export const PLAN_PRICING: Record<NewSalePlan, PlanPricing> = {
  INDIVIDUAL: { monthlyUsd: 19, billingUnit: "account", inferenceIncluded: false },
  TEAM: { monthlyUsd: 39, billingUnit: "active-seat", inferenceIncluded: false },
};

export const PLAN_LABEL: Record<NewSalePlan, string> = {
  INDIVIDUAL: "Individual",
  TEAM: "Team",
};

export const NEW_SALE_PLAN_CATALOG = PLAN_ORDER.map((id) => ({
  id,
  label: PLAN_LABEL[id],
  ...PLAN_PRICING[id],
  billingCycle: "monthly" as const,
  providerFunding: "tenant" as const,
}));

/** Stable price-equivalent legacy identities migrate automatically. */
export const LEGACY_PLAN_MIGRATION: Record<LegacyPlan, NewSalePlan | "MANUAL_REVIEW"> = {
  FREE: "MANUAL_REVIEW",
  CREATOR: "INDIVIDUAL",
  PRO: "TEAM",
  BUSINESS: "MANUAL_REVIEW",
  ENTERPRISE: "MANUAL_REVIEW",
};

export function normalizePlanForEntitlement(
  value: string | null | undefined,
): NewSalePlan | "MANUAL_REVIEW" {
  if (value === "INDIVIDUAL" || value === "TEAM") return value;
  if (value && Object.prototype.hasOwnProperty.call(LEGACY_PLAN_MIGRATION, value)) {
    return LEGACY_PLAN_MIGRATION[value as LegacyPlan];
  }
  return "MANUAL_REVIEW";
}

const individualLimits: PlanLimits = {
  maxCompanies: 5,
  maxRunsPerMonth: -1,
  maxAgentsPerCompany: 5,
  maxConnectedAutomations: 3,
  maxSeats: 1,
  localProvider: true,
  auditRetentionDays: 90,
  sso: "none",
  channels: ["tiktok", "linkedin", "twitter", "instagram", "email"],
  features: ["basic_content", "basic_analytics", "advanced_content", "memory", "custom_pipelines"],
};

const teamLimits: PlanLimits = {
  maxCompanies: 20,
  maxRunsPerMonth: -1,
  maxAgentsPerCompany: 9,
  maxConnectedAutomations: 10,
  maxSeats: -1,
  localProvider: true,
  auditRetentionDays: 365,
  sso: "none",
  channels: ["tiktok", "linkedin", "twitter", "instagram", "email", "youtube"],
  features: [
    "basic_content",
    "basic_analytics",
    "advanced_content",
    "crm_sync",
    "outreach",
    "memory",
    "custom_pipelines",
    "priority_support",
    "team_seats",
  ],
};

const manualReviewLimits: PlanLimits = {
  maxCompanies: 0,
  maxRunsPerMonth: 0,
  maxAgentsPerCompany: 0,
  maxConnectedAutomations: 0,
  maxSeats: 0,
  localProvider: false,
  auditRetentionDays: 0,
  sso: "none",
  channels: [],
  features: [],
};

/**
 * Compatibility limits cover historical database values for one release.
 * New checkout code must enumerate PLAN_ORDER, never this record.
 */
export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  INDIVIDUAL: individualLimits,
  TEAM: teamLimits,
  MANUAL_REVIEW: manualReviewLimits,
  FREE: manualReviewLimits,
  CREATOR: individualLimits,
  PRO: teamLimits,
  BUSINESS: manualReviewLimits,
  ENTERPRISE: manualReviewLimits,
};

export function isPlanUpgrade(currentPlan: Plan, targetPlan: NewSalePlan): boolean {
  const current = normalizePlanForEntitlement(currentPlan);
  if (current === "MANUAL_REVIEW") return true;
  return PLAN_ORDER.indexOf(targetPlan) > PLAN_ORDER.indexOf(current);
}
