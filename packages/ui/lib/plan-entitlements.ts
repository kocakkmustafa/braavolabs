import { PLAN_LIMITS } from "@ai-company-os/core";

/** UI affordance only; API remains authoritative for entitlement. */
export function planAllowsLocalProvider(plan: string): boolean {
  return Object.prototype.hasOwnProperty.call(PLAN_LIMITS, plan)
    && PLAN_LIMITS[plan as keyof typeof PLAN_LIMITS].localProvider;
}
