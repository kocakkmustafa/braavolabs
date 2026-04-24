import type { Plan, PlanLimits, PlanPricing } from "../types/billing";

/**
 * Braavolabs plan tiers (2026-04 revision).
 *
 * Philosophy:
 * - Free: Real taste — 1 company, hero use-case (TikTok+LinkedIn simplified)
 *   so every user sees meaningful output on day 1.
 * - Creator: Solopreneurs who want to run a handful of simple AI companies.
 * - Pro: Agencies / founders scaling across many brands.
 * - Business: Multi-user teams with volume needs.
 * - Enterprise: Custom (SSO, SLA, private deployment).
 *
 * No trial — Free plan already gives real value. Yearly billing offers 20% discount.
 */
export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  FREE: {
    maxCompanies: 1,
    maxRunsPerMonth: 10,
    maxAgentsPerCompany: 3,
    channels: ["tiktok", "linkedin"],
    features: ["basic_content", "basic_analytics", "hero_template"],
  },
  CREATOR: {
    maxCompanies: 5,
    maxRunsPerMonth: 100,
    maxAgentsPerCompany: 5,
    channels: ["tiktok", "linkedin", "twitter", "instagram", "email"],
    features: [
      "basic_content",
      "basic_analytics",
      "advanced_content",
      "memory",
      "custom_pipelines",
    ],
  },
  PRO: {
    maxCompanies: 20,
    maxRunsPerMonth: 500,
    maxAgentsPerCompany: 9,
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
    ],
  },
  BUSINESS: {
    maxCompanies: 100,
    maxRunsPerMonth: 2000,
    maxAgentsPerCompany: 15,
    channels: ["tiktok", "linkedin", "twitter", "instagram", "email", "youtube", "custom"],
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
      "governance",
      "audit_export",
    ],
  },
  ENTERPRISE: {
    maxCompanies: -1, // unlimited
    maxRunsPerMonth: -1,
    maxAgentsPerCompany: -1,
    channels: ["tiktok", "linkedin", "twitter", "instagram", "email", "youtube", "custom"],
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
      "governance",
      "audit_export",
      "white_label",
      "sso",
      "dedicated_support",
      "sla",
    ],
  },
};

/**
 * Plan pricing (USD). Yearly = monthly × 12 × 0.80 (20% annual discount).
 */
export const PLAN_PRICING: Record<Plan, PlanPricing> = {
  FREE: {
    monthlyUsd: 0,
    yearlyUsd: 0,
    yearlyMonthlyEquivalent: 0,
  },
  CREATOR: {
    monthlyUsd: 19,
    yearlyUsd: 182, // 19 × 12 × 0.80 = 182.4 → rounded
    yearlyMonthlyEquivalent: 15.2,
  },
  PRO: {
    monthlyUsd: 39,
    yearlyUsd: 374, // 39 × 12 × 0.80 = 374.4
    yearlyMonthlyEquivalent: 31.2,
  },
  BUSINESS: {
    monthlyUsd: 99,
    yearlyUsd: 950, // 99 × 12 × 0.80 = 950.4
    yearlyMonthlyEquivalent: 79.2,
  },
  ENTERPRISE: {
    monthlyUsd: 0, // custom pricing — contact sales
    yearlyUsd: 0,
    yearlyMonthlyEquivalent: 0,
  },
};

export const PLAN_LABEL: Record<Plan, string> = {
  FREE: "Free",
  CREATOR: "Creator",
  PRO: "Pro",
  BUSINESS: "Business",
  ENTERPRISE: "Enterprise",
};

/**
 * Ordered list — used for upgrade/downgrade comparison and marketing pages.
 */
export const PLAN_ORDER: Plan[] = ["FREE", "CREATOR", "PRO", "BUSINESS", "ENTERPRISE"];

/**
 * Returns true if targetPlan is an upgrade from currentPlan.
 */
export function isPlanUpgrade(currentPlan: Plan, targetPlan: Plan): boolean {
  return PLAN_ORDER.indexOf(targetPlan) > PLAN_ORDER.indexOf(currentPlan);
}
