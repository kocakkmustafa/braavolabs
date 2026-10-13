import type { Prisma } from "@prisma/client";
import { tenantTx } from "../../lib/db";
import { AppError } from "../../middleware/error";

type AgentChanges = Pick<Prisma.AgentUpdateInput,
  "name" | "role" | "systemPrompt" | "model" | "maxTokens" | "tools" | "autonomy">;

/** The snapshot, mutation and audit commit together on the RLS-bound connection. */
export function updateAgentWithHistory(input: {
  tenantId: string;
  companyId: string;
  agentId: string;
  actor: string;
  data: AgentChanges;
  kind: "update" | "nl-edit";
  updatedFields?: string[];
}) {
  return tenantTx(async (tx) => {
    const company = await tx.company.findFirst({
      where: { id: input.companyId, tenantId: input.tenantId },
    });
    if (!company) throw new AppError(404, "Company not found");

    // Serialize edits before reading the snapshot or assigning its version.
    // The explicit tenant join also protects the raw query when RLS is bypassed.
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT a.id FROM agents a JOIN companies c ON c.id = a.company_id
      WHERE a.id = ${input.agentId} AND c.id = ${input.companyId}
        AND c.tenant_id = ${input.tenantId}
      FOR UPDATE OF a
    `;
    if (locked.length === 0) throw new AppError(404, "Agent not found");
    const agent = await tx.agent.findFirst({
      where: { id: input.agentId, companyId: company.id, company: { tenantId: input.tenantId } },
    });
    if (!agent) throw new AppError(404, "Agent not found");
    const latest = await tx.agentVersion.findFirst({
      where: { agentId: agent.id, agent: { company: { tenantId: input.tenantId } } }, orderBy: { version: "desc" },
    });
    const version = (latest?.version ?? 0) + 1;
    await tx.agentVersion.create({
      data: {
        agentId: agent.id,
        version,
        label: input.kind === "nl-edit" ? `NL edit v${version}` : null,
        snapshot: {
          name: agent.name, role: agent.role, systemPrompt: agent.systemPrompt,
          model: agent.model, maxTokens: agent.maxTokens, tools: agent.tools,
          autonomy: agent.autonomy,
        },
        changeSummary: input.kind === "nl-edit"
          ? `Applied NL edit: name=${input.data.name}, role=${input.data.role}, model=${input.data.model}`
          : "Auto-snapshot before update",
        createdBy: input.actor,
      },
    });
    const updated = await tx.agent.update({ where: { id: agent.id, company: { tenantId: input.tenantId } }, data: input.data });
    await tx.activityLog.create({
      data: {
        tenantId: input.tenantId, actor: input.actor,
        action: input.kind === "nl-edit" ? "agent.nl-edit.apply" : "agent.update",
        resource: "agent", resourceId: agent.id,
        ...(input.kind === "nl-edit" ? {
          details: { version, updatedFields: input.updatedFields ?? [] },
        } : {}),
      },
    });
    return { agent: updated, version };
  });
}
