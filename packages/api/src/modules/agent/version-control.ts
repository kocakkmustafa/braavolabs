import { prisma } from "../../lib/db";
import { logger } from "../../lib/logger";
import type { AgentDiff } from "@ai-company-os/core";

/**
 * Take a snapshot of the current agent config and store it as a new version.
 * Version numbers auto-increment per agent.
 */
export async function createVersion(
  agentId: string,
  opts?: { label?: string; changeSummary?: string; createdBy?: string },
) {
  const agent = await prisma.agent.findUnique({ where: { id: agentId } });
  if (!agent) throw new Error(`Agent ${agentId} not found`);

  // Determine next version number
  const latest = await prisma.agentVersion.findFirst({
    where: { agentId },
    orderBy: { version: "desc" },
  });
  const nextVersion = (latest?.version ?? 0) + 1;

  // Build snapshot from current agent state
  const snapshot: Record<string, any> = {
    name: agent.name,
    role: agent.role,
    systemPrompt: agent.systemPrompt,
    tools: agent.tools,
    model: agent.model,
    maxTokens: agent.maxTokens,
  };

  const version = await prisma.agentVersion.create({
    data: {
      agentId,
      version: nextVersion,
      label: opts?.label ?? null,
      snapshot,
      changeSummary: opts?.changeSummary ?? null,
      createdBy: opts?.createdBy ?? null,
    },
  });

  logger.info({ agentId, version: nextVersion }, "Agent version created");
  return version;
}

/**
 * List all versions for an agent, ordered newest-first.
 */
export async function listVersions(agentId: string) {
  return prisma.agentVersion.findMany({
    where: { agentId },
    orderBy: { version: "desc" },
    select: {
      id: true,
      version: true,
      label: true,
      changeSummary: true,
      createdBy: true,
      createdAt: true,
    },
  });
}

/**
 * Get a specific version's full detail including snapshot.
 */
export async function getVersion(agentId: string, version: number) {
  return prisma.agentVersion.findUnique({
    where: { agentId_version: { agentId, version } },
  });
}

/**
 * Compare two versions of an agent and return field-level diffs.
 */
export async function diffVersions(
  agentId: string,
  v1: number,
  v2: number,
): Promise<AgentDiff[]> {
  const [ver1, ver2] = await Promise.all([
    getVersion(agentId, v1),
    getVersion(agentId, v2),
  ]);

  if (!ver1) throw new Error(`Version ${v1} not found for agent ${agentId}`);
  if (!ver2) throw new Error(`Version ${v2} not found for agent ${agentId}`);

  const snap1 = ver1.snapshot as Record<string, any>;
  const snap2 = ver2.snapshot as Record<string, any>;

  const allKeys = new Set([...Object.keys(snap1), ...Object.keys(snap2)]);
  const diffs: AgentDiff[] = [];

  for (const key of allKeys) {
    const old = snap1[key];
    const cur = snap2[key];
    if (JSON.stringify(old) !== JSON.stringify(cur)) {
      diffs.push({ field: key, oldValue: old ?? null, newValue: cur ?? null });
    }
  }

  return diffs;
}

/**
 * Rollback an agent to a previous version.
 * This restores the agent fields from the target version's snapshot
 * and creates a new version documenting the rollback.
 */
export async function rollbackToVersion(
  agentId: string,
  targetVersion: number,
  userId?: string,
) {
  const target = await getVersion(agentId, targetVersion);
  if (!target) throw new Error(`Version ${targetVersion} not found for agent ${agentId}`);

  const snap = target.snapshot as Record<string, any>;

  // Update agent to the target snapshot's values
  const updated = await prisma.agent.update({
    where: { id: agentId },
    data: {
      name: snap.name,
      role: snap.role,
      systemPrompt: snap.systemPrompt,
      tools: snap.tools,
      model: snap.model,
      maxTokens: snap.maxTokens,
    },
  });

  // Create a new version documenting the rollback
  const rollbackVersion = await createVersion(agentId, {
    label: `Rollback to v${targetVersion}`,
    changeSummary: `Rolled back to version ${targetVersion}`,
    createdBy: userId,
  });

  logger.info(
    { agentId, targetVersion, newVersion: rollbackVersion.version },
    "Agent rolled back",
  );

  return { agent: updated, version: rollbackVersion };
}
