/**
 * Tenant-context resolver for the `make_outbound_call` tool when
 * invoked outside a governed run (e.g. natural-language pipeline
 * builder dry-runs). Resolves the voiceAgentId to its company's
 * tenantId. The governed path passes tenantId in directly via the
 * tool input.
 */

import { prisma } from "../../lib/db";
import { AppError } from "../../middleware/error";

export async function getActiveTenantContext(voiceAgentId: string): Promise<string> {
  const agent = await prisma.voiceAgent.findUnique({
    where: { id: voiceAgentId },
    select: { company: { select: { tenantId: true } } },
  });
  if (!agent) throw new AppError(404, "Voice agent not found");
  return agent.company.tenantId;
}
