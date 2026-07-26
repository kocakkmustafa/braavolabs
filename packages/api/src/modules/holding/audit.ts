import { prisma } from "../../lib/db";

/**
 * Append-only audit writer (FABLE_PLAN §3: kurulur İLK fazda; sonraki tüm
 * denetim buna dayanır). The table itself rejects UPDATE/DELETE via a DB
 * trigger, so this module only ever INSERTs.
 *
 * Deliberately throws on failure: a governance mutation whose audit write
 * failed must NOT proceed silently — callers sequence audit() before/with
 * the action they are recording.
 */
export interface AuditEntry {
  actor: string;
  action: string;
  entity?: string;
  entityId?: string;
  runId?: string;
  payload?: Record<string, unknown>;
}

export async function audit(entry: AuditEntry): Promise<void> {
  await prisma.holdingAuditLog.create({
    data: {
      actor: entry.actor,
      action: entry.action,
      entity: entry.entity,
      entityId: entry.entityId,
      runId: entry.runId,
      payload: (entry.payload ?? {}) as object,
    },
  });
}
