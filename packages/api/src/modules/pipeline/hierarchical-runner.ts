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
import { writeLifecycle } from "../run/write-lifecycle";
import { beatRun } from "../run/heartbeat";
import { runAgentLoop } from "../agent/claude";
import { isStepApprovalGateEnabled, pipelineHasGatedSteps } from "./step-approval";
import { registerTool, getTool } from "../agent/registry";
import {
  buildManagerContext,
  loadWorkers,
  recordManagerDispatch,
  resolveWorker,
  trackDelegation,
  clearDelegationCounter,
} from "./hierarchical";
import { loadDelegationResumePlan, startingCost, takeReusable, type DelegationResumePlan } from "./hierarchical-resume";

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
  /** Set when a delegation was refused by the job budget (BRA-P0-08). */
  budgetStop: { reason: string | null };
  /** Tail of the serialized budget-check chain (02c-5: parallel delegate calls must not race). */
  budgetGate: { tail: Promise<unknown> };
  /** BRA-P0-04j: önceki denemenin COMPLETED delegasyonları (retry'da atlanır); ilk koşuda boş. */
  resume: DelegationResumePlan;
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
      // BRA-P0-04j: aynı koşunun önceki denemesinde bu (worker, task) zaten COMPLETED ise
      // yeniden çalıştırma: kayıtlı çıktıyı yönetici'ye ver. Yeni satır yok, maliyet yok
      // (maliyeti tohumda; çift sayma yok), bütçe kontrolü gereksiz (harcama yok).
      const reused = takeReusable(ctx.resume, worker.id, args.task);
      if (reused) {
        logger.info(
          { runId: ctx.runId, reusedStepId: reused.id, reusedStepIndex: reused.stepIndex, agentId: worker.id },
          "Retry: delegation already COMPLETED in a previous attempt — skipped, output reused",
        );
        const prev = (reused.output ?? {}) as { text?: unknown; toolCalls?: unknown };
        return {
          agent: worker.name,
          output: typeof prev.text === "string" ? prev.text : (reused.output ?? null),
          toolCalls: typeof prev.toolCalls === "number" ? prev.toolCalls : 0,
          costUsd: 0,
          reused: true,
        };
      }
      // BRA-P0-08: a delegation is the unit of spend here, so the job budget
      // (and its tenant/workspace gate) is checked before each one. Refused
      // delegations return an error to the manager; the final check below
      // marks the run FAILED. Inert for a run with no job budget.
      // 02c-5: budget decisions are serialized per run (runAgentLoop executes up to 5
      // `delegate` calls in parallel). The first refusal is recorded; every later call
      // (waiting on the chain) is refused from memory, so one run yields ONE
      // governance.job_budget row + ONE push. An allowed check lets the next one run its
      // own check; if a check throws, only that call rejects (as before) and the
      // waiting calls run their own check, same as the pre-02c-5 behaviour.
      const decide = async (): Promise<string | null> => {
        if (ctx.budgetStop.reason !== null) return ctx.budgetStop.reason;
        const { runJobBudgetCheck } = await import("../governance/engine");
        const budget = await runJobBudgetCheck(ctx.runId, ctx.totalCost.value);
        if (budget.allowed) return null;
        ctx.budgetStop.reason ??= budget.reason ?? "Job budget exhausted";
        return ctx.budgetStop.reason;
      };
      const mine = ctx.budgetGate.tail.then(decide, decide);
      ctx.budgetGate.tail = mine.catch(() => undefined);
      const refusal = await mine;
      if (refusal !== null) return { error: `Delegation refused: ${refusal}` };
      await beatRun(ctx.runId, ctx.tenantId); // BRA-P0-04d: delegasyon başı
      const stepIndex = ++ctx.stepCounter.value;
      const startedAt = new Date();
      const created = await prisma.runStep.create({
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
          // 04j: önceki denemelerin satırlarıyla aynı stepIndex çakışmasın diye kimlik satır id'si.
          id: created?.id ?? (await prisma.runStep.findFirst({
            where: { runId: ctx.runId, stepIndex },
            select: { id: true },
            orderBy: { createdAt: "desc" },
          }))!.id,
        },
        data: {
          status: workerError ? "FAILED" : "COMPLETED",
          output: {
            text: workerResult.finalContent,
            turns: workerResult.turns.length,
            toolCalls: workerResult.totalToolCalls,
            // BRA-P0-06c: adımı fiilen sunan sağlayıcı/model (makbuz `step` kanıtı okur).
            ...(workerResult.provider ? { provider: workerResult.provider } : {}),
            ...(workerResult.model ? { model: workerResult.model } : {}),
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

      await beatRun(ctx.runId, ctx.tenantId); // BRA-P0-04d: delegasyon sonu
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
    await writeLifecycle(runId, tenantId, "FAILED", {
      error: "Hierarchical pipeline is missing its manager agent.",
      completedAt: new Date(),
    });
    return;
  }

  // BRA-P0-03d: hiyerarşik yürütücü adım yapılandırmasını (config.needsApproval) zorlayamaz
  // (yönetici serbest delegasyon yapar). Kapı açıkken gated adımlı pipeline sessizce
  // atlanmasın diye fail-closed: koşu çalışmadan FAILED.
  if (isStepApprovalGateEnabled() && pipelineHasGatedSteps(pipeline.steps)) {
    await writeLifecycle(runId, tenantId, "FAILED", {
      error: "Step approval gate cannot be enforced in hierarchical pipelines; run refused.",
      completedAt: new Date(),
    });
    return;
  }

  const manager = await prisma.agent.findUnique({ where: { id: pipeline.managerAgentId } });
  if (!manager || manager.companyId !== pipeline.companyId) {
    await writeLifecycle(runId, tenantId, "FAILED", {
      error: "Manager agent not found or moved to a different company.",
      completedAt: new Date(),
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

  // BRA-P0-04j: önceki denemeden COMPLETED delegasyonlar + maliyet tohumu. İlk koşuda satır
  // yoktur → sayaç 0, eski davranış. Bayraktan bağımsız (yalnız mevcut satırları okur).
  const resume = await loadDelegationResumePlan(runId, tenantId);
  if (resume.completedCount > 0) {
    logger.info(
      { runId, restoredDelegations: resume.completedCount, seededCost: resume.seededCost, delegationCost: resume.delegationCost, priorRunCost: resume.priorRunCost, startingCost: startingCost(resume), startStepIndex: resume.maxStepIndex },
      "Retry: seeding hierarchical run from previous COMPLETED delegations (no re-execution, cost carried)",
    );
  }

  const ctx: DelegationContext = {
    runId,
    tenantId,
    pipelineCompanyId: pipeline.companyId,
    managerAgentId: manager.id,
    maxDepth: pipeline.maxDelegationDepth,
    stepCounter: { value: resume.maxStepIndex },
    // Taban max(run.costUsd, tohum): sayaç yalnız artar, run.costUsd hiçbir yazımda düşmez.
    totalCost: { value: startingCost(resume) },
    budgetStop: { reason: null },
    budgetGate: { tail: Promise.resolve() },
    resume,
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
    // 02c-5: CAS lost (run changed from outside) → do not overwrite, no activity row.
    const landed = await writeLifecycle(runId, tenantId, "FAILED", {
      error: message,
      costUsd: ctx.totalCost.value,
      completedAt: new Date(),
    });
    if (!landed) return;
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

  // BRA-P0-08: if a delegation was refused by the job budget (or scope gate) the
  // manager could not finish its plan — never report that as COMPLETED. A run
  // that merely reached its limit while finishing its last step is a success.
  // The manager's own cost is only known now (runAgentLoop returns it at the
  // end), so re-check the FINAL total strictly: a real overshoot also fails the run.
  if (ctx.budgetStop.reason === null) {
    const { runJobBudgetCheck } = await import("../governance/engine");
    const finalBudget = await runJobBudgetCheck(runId, ctx.totalCost.value, undefined, { finalCheck: true });
    if (!finalBudget.allowed) ctx.budgetStop.reason = finalBudget.reason ?? "Job budget exceeded";
  }
  if (ctx.budgetStop.reason !== null) {
    const landed = await writeLifecycle(runId, tenantId, "FAILED", {
      error: ctx.budgetStop.reason,
      costUsd: ctx.totalCost.value,
      completedAt: new Date(),
    });
    if (!landed) return;
    // 02c-5: same audit row as the exception path (was missing here; ADR-0002).
    await prisma.activityLog.create({
      data: {
        tenantId,
        actor: "system",
        action: "run.hierarchical_failed",
        resource: "run",
        resourceId: runId,
        details: { error: ctx.budgetStop.reason.slice(0, 500), cause: "job_budget" },
      },
    });
    return;
  }

  const completed = await writeLifecycle(runId, tenantId, "COMPLETED", {
    output: { text: finalOutput } as any,
    costUsd: ctx.totalCost.value,
    completedAt: new Date(),
  });
  if (!completed) return;
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
