/**
 * Hierarchical pipeline runner.
 *
 * Called by the standard pipeline runner when `pipeline.pipelineType
 * === "HIERARCHICAL"`. Drives the manager agent through one LLM loop
 * with a `delegate` tool exposed; each delegation triggers a nested
 * worker-agent loop. The whole thing is wrapped in the same
 * tenant-isolation + cost-budget + activity-log guards as a regular
 * sequential run.
 *
 * Output of the run is whatever the manager agent finally answers
 * (its non-tool-use response). That output goes onto the `Run.output`
 * column verbatim.
 */

import type { Pipeline } from "@prisma/client";
import { prisma } from "../../lib/db";
import { logger } from "../../lib/logger";
import { runAgentLoop } from "../agent/claude";
import { registerTool, getTool } from "../agent/registry";
import {
  buildManagerContext,
  loadWorkers,
  recordManagerDispatch,
  resolveWorker,
  trackDelegation,
  clearDelegationCounter,
} from "./hierarchical";

// Register the `delegate` tool exactly once on module load. The
// underlying implementation is keyed on a per-run AsyncLocalStorage
// context (see DELEGATION_CTX below) — the run's hierarchical
// dispatcher seeds the context before invoking the manager loop.
import { AsyncLocalStorage } from "node:async_hooks";

interface DelegationContext {
  runId: string;
  tenantId: string;
  pipelineCompanyId: string;
  managerAgentId: string;
  maxDepth: number;
  stepCounter: { value: number };
  totalCost: { value: number };
}

const DELEGATION_CTX = new AsyncLocalStorage<DelegationContext>();

let delegateToolRegistered = false;

function ensureDelegateToolRegistered(): void {
  if (delegateToolRegistered) return;
  registerTool({
    name: "delegate",
    description:
      "Delegate a task to a worker agent on your team. Use this from a HIERARCHICAL pipeline only.",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string" },
        task: { type: "string" },
      },
      required: ["agentId", "task"],
    },
    handler: async (input) => {
      const ctx = DELEGATION_CTX.getStore();
      if (!ctx) {
        return {
          error:
            "The `delegate` tool can only be called from within a HIERARCHICAL pipeline run.",
        };
      }
      const args = input as { agentId: string; task: string };
      trackDelegation(ctx.runId, ctx.maxDepth);

      const worker = await resolveWorker(args.agentId, ctx.pipelineCompanyId);
      // Refuse re-delegating to the manager — protects against an
      // LLM that decides to talk to itself recursively.
      if (worker.id === ctx.managerAgentId) {
        return { error: "Cannot delegate back to the manager agent." };
      }
      const stepIndex = ++ctx.stepCounter.value;
      const startedAt = new Date();
      await prisma.runStep.create({
        data: {
          runId: ctx.runId,
          agentId: worker.id,
          stepIndex,
          name: `delegate:${worker.name}`,
          status: "RUNNING",
          reasoning: `Manager delegated task: ${args.task.slice(0, 200)}`,
          input: args as any,
          startedAt,
        },
      });

      // Spawn the worker loop. AsyncLocalStorage.exit() drops the
      // context for this nested invocation so a worker can't itself
      // call `delegate` and silently inherit the manager's
      // counter — but it CAN if its toolNames include "delegate"
      // explicitly. The default worker has no delegate tool so this
      // is the safe path.
      // D-011 fix (E2/T4): worker loops used to run with tenantId:undefined,
      // which silently routed a BYOK tenant's data to the SYSTEM Anthropic
      // key on every delegated step — a live violation of the BYOK privacy
      // contract (plan §2.2). Workers now resolve the SAME tenant AI config
      // as the manager. Tool governance stays as before (ungoverned path
      // with its fail-closed approval/tenant-scope guards).
      const workerResult = await runAgentLoop({
        systemPrompt: worker.systemPrompt,
        userMessage: args.task,
        toolNames: (worker.tools as string[] | null) ?? [],
        model: worker.model ?? undefined,
        tenantId: ctx.tenantId,
      });
      ctx.totalCost.value += workerResult.totalCostUsd ?? 0;

      const lastTurn = workerResult.turns[workerResult.turns.length - 1];
      const workerError =
        workerResult.turns.find((t) => t.toolCalls.some((tc) => tc.error))
          ?.toolCalls.find((tc) => tc.error)?.error;
      await prisma.runStep.update({
        where: {
          id: (await prisma.runStep.findFirst({
            where: { runId: ctx.runId, stepIndex },
            select: { id: true },
          }))!.id,
        },
        data: {
          status: workerError ? "FAILED" : "COMPLETED",
          output: {
            text: workerResult.finalContent,
            turns: workerResult.turns.length,
            toolCalls: workerResult.totalToolCalls,
          } as any,
          costUsd: workerResult.totalCostUsd ?? 0,
          // Forge P1: real per-call token counts, same call site as
          // cost_usd — see run_steps.prompt_tokens doc comment in schema.
          promptTokens: workerResult.totalInputTokens,
          completionTokens: workerResult.totalOutputTokens,
          error: workerError ?? null,
          completedAt: new Date(),
        },
      });

      return {
        agent: worker.name,
        output: workerResult.finalContent,
        toolCalls: workerResult.totalToolCalls,
        costUsd: workerResult.totalCostUsd ?? 0,
      };
    },
  });
  delegateToolRegistered = true;
}

export async function processHierarchicalRun(opts: {
  runId: string;
  tenantId: string;
  pipeline: Pipeline;
  input: unknown;
}): Promise<void> {
  ensureDelegateToolRegistered();
  const { runId, tenantId, pipeline, input } = opts;

  if (!pipeline.managerAgentId) {
    logger.error({ runId, pipelineId: pipeline.id }, "Hierarchical pipeline missing managerAgentId");
    await prisma.run.update({
      where: { id: runId },
      data: {
        status: "FAILED",
        error: "Hierarchical pipeline is missing its manager agent.",
        completedAt: new Date(),
      },
    });
    return;
  }

  const manager = await prisma.agent.findUnique({ where: { id: pipeline.managerAgentId } });
  if (!manager || manager.companyId !== pipeline.companyId) {
    await prisma.run.update({
      where: { id: runId },
      data: {
        status: "FAILED",
        error: "Manager agent not found or moved to a different company.",
        completedAt: new Date(),
      },
    });
    return;
  }

  const workers = await loadWorkers(pipeline);
  const dispatchReasoning = `Hierarchical pipeline dispatched: ${workers.length} worker(s) available, max delegation depth ${pipeline.maxDelegationDepth}.`;
  await recordManagerDispatch({
    runId,
    managerId: manager.id,
    workerIds: workers.map((w) => w.id),
    reasoning: dispatchReasoning,
  });

  const ctx: DelegationContext = {
    runId,
    tenantId,
    pipelineCompanyId: pipeline.companyId,
    managerAgentId: manager.id,
    maxDepth: pipeline.maxDelegationDepth,
    stepCounter: { value: 0 },
    totalCost: { value: 0 },
  };

  let finalOutput: string;
  try {
    finalOutput = await DELEGATION_CTX.run(ctx, async () => {
      const result = await runAgentLoop({
        systemPrompt: [
          manager.systemPrompt,
          "",
          "─── TEAM CONTEXT ───",
          buildManagerContext(workers, pipeline.maxDelegationDepth),
        ].join("\n"),
        userMessage: typeof input === "string" ? input : JSON.stringify(input ?? ""),
        toolNames: [...((manager.tools as string[] | null) ?? []), "delegate"],
        model: manager.model ?? undefined,
        tenantId,
      });
      ctx.totalCost.value += result.totalCostUsd ?? 0;
      return result.finalContent;
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.run.update({
      where: { id: runId },
      data: {
        status: "FAILED",
        error: message,
        costUsd: ctx.totalCost.value,
        completedAt: new Date(),
      },
    });
    await prisma.activityLog.create({
      data: {
        tenantId,
        actor: "system",
        action: "run.hierarchical_failed",
        resource: "run",
        resourceId: runId,
        details: { error: message.slice(0, 500) },
      },
    });
    return;
  } finally {
    clearDelegationCounter(runId);
  }

  await prisma.run.update({
    where: { id: runId },
    data: {
      status: "COMPLETED",
      output: { text: finalOutput } as any,
      costUsd: ctx.totalCost.value,
      completedAt: new Date(),
    },
  });
  await prisma.activityLog.create({
    data: {
      tenantId,
      actor: "system",
      action: "run.hierarchical_completed",
      resource: "run",
      resourceId: runId,
      details: { stepCount: ctx.stepCounter.value, costUsd: ctx.totalCost.value },
    },
  });
}

// Re-export `getTool` so the agent loop can resolve `delegate` from
// the registry without the runner needing to import the registry
// directly (avoids a dependency cycle).
export { getTool };
