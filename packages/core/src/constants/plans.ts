import type { Plan, PlanLimits } from "../types/billing";

export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  FREE: {
    maxCompanies: 1,
    maxRunsPerMonth: 10,
    maxAgentsPerCompany: 3,
    channels: ["tiktok", "linkedin"],
    features: ["basic_content", "basic_analytics"],
  },
  PRO: {
    maxCompanies: 5,
    maxRunsPerMonth: 100,
    maxAgentsPerCompany: 10,
    channels: ["tiktok", "linkedin", "twitter", "email"],
    features: [
      "basic_content",
      "basic_analytics",
      "advanced_content",
      "crm_sync",
      "outreach",
      "memory",
      "custom_pipelines",
    ],
  },
  ENTERPRISE: {
    maxCompanies: -1, // unlimited
    maxRunsPerMonth: -1,
    maxAgentsPerCompany: -1,
    channels: ["tiktok", "linkedin", "twitter", "email", "custom"],
    features: [
      "basic_content",
      "basic_analytics",
      "advanced_content",
      "crm_sync",
      "outreach",
      "memory",
      "custom_pipelines",
      "governance",
      "white_label",
      "sso",
      "audit_export",
    ],
  },
};
