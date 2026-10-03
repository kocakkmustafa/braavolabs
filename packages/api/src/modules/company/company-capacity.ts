import type { Prisma } from "@prisma/client";
import { PLAN_LIMITS } from "@ai-company-os/core";
import { AppError } from "../../middleware/error";
import { getEffectivePlan } from "../billing/entitlement-ledger.service";

/**
 * Call immediately before a company INSERT inside tenantTx. The tenant row
 * lock serializes all user-facing creation paths for this tenant; the count
 * includes archived companies, matching POST /companies' existing contract.
 */
export async function assertCompanyCapacity(
  tx: Prisma.TransactionClient,
  tenantId: string,
): Promise<void> {
  const tenants = await tx.$queryRaw<Array<{ plan: string }>>`
    SELECT plan FROM tenants WHERE id = ${tenantId} FOR UPDATE
  `;
  if (tenants.length !== 1) throw new AppError(401, "Tenant not found");

  const plan = await getEffectivePlan(tenantId, tenants[0].plan, { client: tx });
  const limit = PLAN_LIMITS[plan].maxCompanies;
  const count = await tx.company.count({ where: { tenantId } });
  if (limit !== -1 && count >= limit) {
    throw new AppError(402, `Company limit reached for ${plan} plan (${limit}). Upgrade to add more.`);
  }
}
