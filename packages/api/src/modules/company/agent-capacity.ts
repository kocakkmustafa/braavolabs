import type { Prisma } from "@prisma/client";
import { PLAN_LIMITS } from "@ai-company-os/core";
import { env } from "../../config/env";
import { prisma, tenantTx } from "../../lib/db";
import { AppError } from "../../middleware/error";
import { getEffectivePlan } from "../billing/entitlement-ledger.service";

/**
 * BRA-UX-API-03k: per-plan TENANT-wide agent quota mechanism. DEFAULT OFF (`AGENT_QUOTA_ENABLED`).
 *
 * The numbers are the founder's (karar 17, "plan başına ajan kotası sayıları"); NONE is invented here. A plan
 * with no entry has no agent cap, so turning the flag on before the founder fills this table changes nothing.
 * SCOPE: the three single-agent endpoints of the ticket (`POST /:id/agents`, `agents/compose`, `agents/compose/confirm`).
 * Batch / new-company creators (builder, templates, starter clone, onboarding, automation-importer) insert several
 * agents under the tenant lock they already hold and need a `count + N` rule: separate follow-up ticket, NOT covered here.
 * Keys are the EFFECTIVE plan name `getEffectivePlan` returns (it normalises legacy names: PRO -> TEAM, CREATOR ->
 * INDIVIDUAL). Add `PLAN: n` entries (n >= 0) only on the founder's word. Companies keep their own `maxAgentsPerCompany`
 * rules elsewhere; this is the total across the tenant's companies.
 */
export const AGENT_QUOTA_BY_PLAN: Partial<Record<keyof typeof PLAN_LIMITS, number>> = {};

/** Stable machine code for clients (message text is not a contract). */
export const AGENT_LIMIT_CODE = "AGENT_LIMIT_REACHED";

/**
 * Call immediately before an agent INSERT inside tenantTx. Same lock as `assertCompanyCapacity` (the tenant row,
 * FOR UPDATE) so concurrent agent creation for one tenant is serialized and company/agent creation cannot race
 * each other past a limit. The count spans every company of the tenant (archived ones included, like companies)
 * through the Agent -> Company -> tenantId join (rule #10).
 */
export async function assertAgentCapacity(
  tx: Prisma.TransactionClient,
  tenantId: string,
  quota: Partial<Record<string, number>> = AGENT_QUOTA_BY_PLAN,
): Promise<void> {
  const tenants = await tx.$queryRaw<Array<{ plan: string }>>`
    SELECT plan FROM tenants WHERE id = ${tenantId} FOR UPDATE
  `;
  if (tenants.length !== 1) throw new AppError(401, "Tenant not found");

  const plan = await getEffectivePlan(tenantId, tenants[0].plan, { client: tx });
  const limit = quota[plan];
  if (limit === undefined) return; // no founder number for this plan: unlimited
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error(`invalid agent quota for plan ${plan}`); // misconfiguration must not read as unlimited or as -1
  const count = await tx.agent.count({ where: { company: { tenantId } } });
  if (count >= limit) {
    throw new AppError(
      402,
      `Agent limit reached for ${plan} plan (${limit}). Upgrade to add more.`,
      { plan, limit, current: count },
      AGENT_LIMIT_CODE,
    );
  }
}

/** Delegate surface a creator may use: the transaction client's `agent` (the plain client is cast to it below). */
type AgentDb = Pick<Prisma.TransactionClient, "agent">;

/**
 * Single entry for agent creation. Flag OFF: runs `create` on the plain client, byte-for-byte the previous
 * behaviour (no transaction, no lock, no count). Flag ON: tenant-locked quota check then `create`, one transaction.
 */
export async function createAgentGuarded<T>(tenantId: string, create: (db: AgentDb) => Promise<T>): Promise<T> {
  // Typing-only cast: the extended client and the transaction client expose the same agent delegate at runtime.
  if (!env.AGENT_QUOTA_ENABLED) return create(prisma as unknown as Prisma.TransactionClient);
  return tenantTx(async (tx) => {
    await assertAgentCapacity(tx, tenantId);
    return create(tx);
  });
}

/**
 * Cheap pre-check for endpoints that spend money BEFORE the insert (compose calls an LLM first): a tenant already at
 * its limit is refused before any token is spent. Flag OFF: does nothing. The authoritative check still runs inside
 * `createAgentGuarded` (a concurrent create may win the last slot between the two).
 */
export async function precheckAgentCapacity(tenantId: string): Promise<void> {
  if (!env.AGENT_QUOTA_ENABLED) return;
  await tenantTx((tx) => assertAgentCapacity(tx, tenantId));
}
