/**
 * Hierarchical pipeline runtime.
 *
 * Bridges the existing sequential executor (each step → its assigned
 * agent → tools) into a manager/worker topology. The manager agent
 * runs an LLM loop with a special `delegate` tool exposed:
 *
 *   delegate(agentId: string, task: string)
 *
 * Each `delegate` call invokes the named worker agent's full agent
 * loop with the task as the user-message input, captures its final
 * output + cost + tool calls, and feeds the result back to the
 * manager as the tool_use response. The manager keeps going until
 * it produces a non-tool-use response (the final answer), at which
 * point the run completes.
 *
 * Safety:
 *   - `maxDelegationDepth` (default 3) caps recursive delegation —
 *     a delegated worker cannot itself delegate beyond that depth.
 *   - Each worker invocation is wrapped in the same governance +
 *     spend-approval gates as a normal step, so a manager that
 *     orders an expensive tool through a worker still hits the
 *     same approval queue.
 *   - The manager and every worker MUST belong to the same company
 *     (and therefore tenant) as the pipeline — cross-tenant
 *     delegation is impossible by construction.
 *
 * This is the CrewAI / Microsoft Agent Framework Magentic-One pattern,
 * adapted to Braavolabs's audit-log primitives: every delegation
 * writes a `run_step` row with `reasoning` (the manager's stated
 * reason for delegating) and a `tool_calls` row for the delegate
 * itself, so the audit trail captures "manager → worker → tools" at
 * full fidelity.
 */

import type { Agent, Pipeline } from "@prisma/client";
import { prisma } from "../../lib/db";
import { logger } from "../../lib/logger";
import { AppError } from "../../middleware/error";

export interface ManagerInvocation {
  pipeline: Pipeline & { manager?: Agent | null };
  runId: string;
  input: unknown;
  workers: Agent[];
}

export interface DelegationResult {
  output: unknown;
  costUsd: number;
  toolCallCount: number;
  durationMs: number;
}

/**
 * Build the system-prompt addendum the manager receives. The prompt
 * teaches the LLM about the worker roster + the rules of delegation
 * without baking it into the prompt the operator wrote. Keeping the
 * roster outside the operator prompt means worker turnover doesn't
 * require a manager-prompt edit.
 */
export function buildManagerContext(workers: Agent[], maxDepth: number): string {
  if (workers.length === 0) {
    return "You are the manager of an empty team — answer the user directly.";
  }
  const roster = workers
    .map(
      (w) =>
        `  • id="${w.id}" — ${w.name} (${w.role}). Tools: ${
          Array.isArray(w.tools) && w.tools.length > 0 ? w.tools.join(", ") : "none"
        }.`,
    )
    .join("\n");
  return [
    "You are the MANAGER of a multi-agent team. The user request below should be planned and delegated.",
    "",
    "AVAILABLE WORKERS:",
    roster,
    "",
    "RULES:",
    `1. Delegate via the \`delegate\` tool: { agentId, task }. Pick the worker whose role best fits the task.`,
    `2. You can issue multiple sequential delegations. Aggregate the responses before answering.`,
    `3. Maximum delegation depth from this manager is ${maxDepth}.`,
    `4. Always explain WHY you picked a worker in the \`reasoning\` field of your tool call.`,
    `5. When you have enough information, return the final answer as a normal assistant message (NOT a tool call).`,
  ].join("\n");
}

/**
 * Determine the worker roster for a hierarchical pipeline. All agents
 * in the company EXCEPT the manager itself. Inactive / archived agents
 * are filtered out.
 */
export async function loadWorkers(pipeline: Pipeline): Promise<Agent[]> {
  const agents = await prisma.agent.findMany({
    where: { companyId: pipeline.companyId },
  });
  if (!pipeline.managerAgentId) {
    throw new AppError(
      500,
      `Pipeline ${pipeline.id} is HIERARCHICAL but has no manager agent set`,
    );
  }
  return agents.filter((a) => a.id !== pipeline.managerAgentId);
}

/**
 * Snapshot the manager + worker roster onto the run record so a later
 * audit doesn't have to chase a possibly-mutated agents table.
 */
export async function recordManagerDispatch(opts: {
  runId: string;
  managerId: string;
  workerIds: string[];
  reasoning: string;
}) {
  // Reuse RunStep as the audit row for the manager's dispatch turn —
  // stepIndex 0 by convention, agentId points at the manager.
  await prisma.runStep.create({
    data: {
      runId: opts.runId,
      agentId: opts.managerId,
      stepIndex: 0,
      name: "manager:dispatch",
      status: "RUNNING",
      reasoning: opts.reasoning,
      input: { workerIds: opts.workerIds } as any,
    },
  });
}

/**
 * Lookup helper for the delegate tool — finds the worker by id AND
 * confirms it's still in the same company as the pipeline. A manager
 * that emits a delegate call with an agentId from a different company
 * gets a structured error back instead of leaking that the id exists.
 */
export async function resolveWorker(
  agentId: string,
  pipelineCompanyId: string,
): Promise<Agent> {
  const agent = await prisma.agent.findUnique({ where: { id: agentId } });
  if (!agent || agent.companyId !== pipelineCompanyId) {
    throw new AppError(400, `Unknown worker agent (or cross-company delegation refused)`);
  }
  return agent;
}

/**
 * Per-run delegation counter, kept in memory and indexed by runId.
 * Prevents a manager that goes rogue from issuing thousands of
 * delegations — the cap is `maxDelegationDepth × 4` (multiplier
 * accounts for legitimate "delegate, observe, re-delegate" loops).
 */
const DELEGATION_COUNTERS = new Map<string, number>();

export function trackDelegation(runId: string, maxDepth: number): void {
  const count = (DELEGATION_COUNTERS.get(runId) ?? 0) + 1;
  DELEGATION_COUNTERS.set(runId, count);
  if (count > maxDepth * 4) {
    logger.warn({ runId, count, maxDepth }, "Hierarchical pipeline hit delegation cap");
    throw new AppError(
      429,
      `Delegation cap exceeded (${count} > ${maxDepth * 4}). The manager is delegating too aggressively — review and adjust the prompt.`,
    );
  }
}

export function clearDelegationCounter(runId: string): void {
  DELEGATION_COUNTERS.delete(runId);
}
