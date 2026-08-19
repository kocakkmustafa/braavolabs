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
  /**
   * May use a self-hosted local model provider (Ollama / LM Studio) as a
   * BYOK route — desktop/CLI only. Distinct from, and NOT a proxy for, an
   * on-device MOBILE model: that entitlement appears on no plan until a
   * native adapter, model download and real-device quality evidence exist
   * (roadmap §1.4) — do not repurpose this field for it.
   */
  localProvider: boolean;
  /** Audit log retention window in days. -1 = negotiated by contract (ENTERPRISE only). */
  auditRetentionDays: number;
  /** SSO tier: no SSO, OIDC login, or OIDC + SCIM provisioning. */
  sso: "none" | "oidc" | "oidc_scim";
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
