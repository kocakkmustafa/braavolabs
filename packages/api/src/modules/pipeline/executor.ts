import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/db";
import { logger } from "../../lib/logger";
import { publishRunEvent } from "../../lib/runEvents";
import { runAgentLoop, HandoffInterrupt, type AgentLoopResult } from "../agent/claude";
import { isHandoffTriggerEligible } from "../../services/provider-chain";
import { maybeOpenAutoHandoff } from "../run/handoff.trigger";
import { AppError } from "../../middleware/error";
import { withSpan, toolCallCounter, stepDurationHistogram } from "../../lib/telemetry";

export interface StepDef {
  name: string;
  agentRole: string;
  order: number;
  config?: Record<string, unknown>;
  /** If true, this step runs in parallel with other steps at the same order index */
  parallel?: boolean;
  /** Memory keys this step should read from shared run context */
  readMemoryKeys?: string[];
  /** Memory key to store this step's output under (for subsequent steps) */
  writeMemoryKey?: string;
}

export interface StepExecutionResult {
  stepId: string;
  /** INTERRUPTED (E3/T2 §2.3a-2): the loop exited gracefully at a turn
   * boundary (pause/handoff) — the step went back to PENDING, the run must
   * NOT be finalized. Neither a completion nor a failure. */
  status: "COMPLETED" | "FAILED" | "INTERRUPTED";
  reasoning: string;
  output: unknown;
  costUsd: number;
  toolCallIds: string[];
  memoryKey?: string;
}

/**
 * Resume idempotency contract (pure — unit-tested).
 *
 * When a run that paused on `ask_user` is re-enqueued, the runner restarts from
 * step 0. Given the run's already-COMPLETED steps, this returns which step
 * indexes to SKIP (restore from their persisted output instead of re-running —
 * so completed sends/spends/agent-calls don't repeat) and the cost to SEED so
 * already-incurred spend isn't double-counted.
 */
export function planResume(
  priorCompleted: Array<{ stepIndex: number; costUsd?: number | null }>,
): { skip: Set<number>; seededCost: number } {
  const skip = new Set<number>();
  let seededCost = 0;
  for (const ps of priorCompleted) {
    skip.add(ps.stepIndex);
    seededCost += Number(ps.costUsd ?? 0);
  }
  return { skip, seededCost };
}

/**
 * Execute a single pipeline step using the assigned agent.
 * Handles tool call logging, reasoning enforcement, and cost tracking.
 * Supports shared memory context between agents via sharedMemory map.
 */
export async function executeStep(
  runId: string,
  stepDef: StepDef,
  stepIndex: number,
  input: unknown,
  sharedMemory: Map<string, unknown> = new Map(),
): Promise<StepExecutionResult> {
  // Find the run and its pipeline/company
  const run = await prisma.run.findUnique({
    where: { id: runId },
    include: {
      pipeline: {
        include: {
          company: {
            include: { agents: true },
          },
        },
      },
    },
  });

  if (!run) throw new AppError(404, "Run not found");

  // Find the agent for this step — match by role, name, or case-insensitive partial match
  const agentRole = stepDef.agentRole;
  const stepLabel = stepDef.name ?? `step ${stepIndex + 1}`;
  if (!agentRole) {
    // A step without an agent assignment can't execute — and calling
    // .toLowerCase() on undefined below would crash with a worse error.
    throw new AppError(
      400,
      `Step "${stepLabel}" has no agent assigned. Open the pipeline editor and pick an agent for this step.`,
    );
  }
  const agent = run.pipeline.company.agents.find(
    (a) =>
      a.role === agentRole ||
      a.name === agentRole ||
      a.name.toLowerCase() === agentRole.toLowerCase() ||
      a.role.toLowerCase().startsWith(agentRole.toLowerCase()) ||
      agentRole.toLowerCase().includes(a.name.toLowerCase()),
  );
  if (!agent) {
    const available = run.pipeline.company.agents
      .map((a) => `${a.name} (${a.role.slice(0, 40)})`)
      .join(", ");
    throw new AppError(
      400,
      available.length > 0
        ? `Step "${stepLabel}" needs an agent matching "${agentRole}", but this workspace has: ${available}. Edit the step or rename an agent to match.`
        : `Step "${stepLabel}" needs an agent matching "${agentRole}", but this workspace has no agents yet. Add agents to the workspace, then re-run.`,
    );
  }

  // Create run step record
  const runStep = await prisma.runStep.create({
    data: {
      runId,
      agentId: agent.id,
      stepIndex,
      name: stepDef.name,
      status: "RUNNING",
      reasoning: "", // Will be updated after execution
      input: input as any,
      startedAt: new Date(),
    },
  });

  await publishRunEvent(runId, {
    type: "STEP_STARTED",
    stepId: runStep.id,
    stepIndex,
    name: stepDef.name,
    agentId: agent.id,
    agentRole: agent.role,
  });

  try {
    // Inject shared memory context from previous steps
    const memoryContext: Record<string, unknown> = {};
    if (stepDef.readMemoryKeys && stepDef.readMemoryKeys.length > 0) {
      for (const key of stepDef.readMemoryKeys) {
        if (sharedMemory.has(key)) {
          memoryContext[key] = sharedMemory.get(key);
        }
      }
    }

    // Build the step-specific prompt
    const stepPrompt = buildStepPrompt(stepDef, input, run.pipeline.company.name, memoryContext);

    // Execute agent loop — govContext threads through to every tool call so that
    // approvals, tenant isolation, rate limits, and audit logs are enforced.
    const result = await runAgentLoop({
      systemPrompt: agent.systemPrompt,
      userMessage: stepPrompt,
      toolNames: agent.tools as string[],
      model: agent.model,
      maxTokens: agent.maxTokens,
      maxTurns: 10,
      budgetUsd: Number(run.budgetUsd ?? 1),
      tenantId: run.pipeline.company.tenantId,
      govContext: {
        tenantId: run.pipeline.company.tenantId,
        companyId: run.pipeline.company.id,
        runId: run.id,
        runStepId: runStep.id,
        // Graduated autonomy (D6): the agent's own setting decides whether
        // non-money tool calls pause for approval. Money tools stay gated.
        autonomy: agent.autonomy,
      },
    });

    // Extract reasoning from agent response (MANDATORY)
    const reasoning = extractReasoning(result);
    if (!reasoning) {
      logger.warn({ runStepId: runStep.id }, "Agent did not provide reasoning — adding default");
    }

    // Log all tool calls
    const toolCallIds = await logToolCalls(runStep.id, result);
    toolCallCounter.add(toolCallIds.length, { step: stepDef.name });
    stepDurationHistogram.record(Date.now() - runStep.startedAt!.getTime(), { step: stepDef.name });

    // Update run step
    await prisma.runStep.update({
      where: { id: runStep.id },
      data: {
        status: "COMPLETED",
        reasoning: reasoning || "Agent completed step without explicit reasoning.",
        output: { content: result.finalContent, turns: result.turns.length } as any,
        costUsd: result.totalCostUsd,
        completedAt: new Date(),
        // E3/T2 hygiene (§2.2-3): the live checkpoint served its purpose —
        // a COMPLETED step's durable truth lives in output/tool_calls (and,
        // for handoffs, in the frozen ledger checkpoint). Nulling keeps
        // run_steps lean.
        transcript: Prisma.DbNull,
      },
    });

    // E3/T2 race guard (§2.2-3): a handoff requested exactly while this step
    // was FINISHING (OPEN ledger, checkpoint still null — the loop's
    // turn-start check never saw it). Freeze it as a STEP-BOUNDARY handoff:
    // empty messages signal "no mid-step context", the takeover runs the
    // NEXT step from scratch. The run was already set PAUSED by whoever
    // opened the ledger. Error-swallowed — never blocks the completed step.
    try {
      const openLedger = await prisma.handoffLedger.findFirst({
        where: { runId, status: "OPEN" },
        select: { id: true, checkpoint: true },
      });
      if (openLedger && openLedger.checkpoint === null) {
        await prisma.handoffLedger.update({
          where: { id: openLedger.id },
          data: { checkpoint: { messages: [], stepBoundary: true } as any },
        });
      }
    } catch (guardErr) {
      logger.warn(
        { runId, runStepId: runStep.id, err: (guardErr as Error).message },
        "step-boundary handoff freeze failed (non-fatal — claim's stale path recovers)",
      );
    }

    await publishRunEvent(runId, {
      type: "STEP_COMPLETED",
      stepId: runStep.id,
      reasoning: reasoning || undefined,
      costUsd: result.totalCostUsd,
    });

    // Write output to shared memory if a key is specified
    if (stepDef.writeMemoryKey) {
      sharedMemory.set(stepDef.writeMemoryKey, result.finalContent);
    }

    return {
      stepId: runStep.id,
      status: "COMPLETED",
      reasoning: reasoning || "No explicit reasoning provided.",
      output: result.finalContent,
      costUsd: result.totalCostUsd,
      toolCallIds,
      memoryKey: stepDef.writeMemoryKey,
    };
  } catch (err) {
    // E3/T2 (§2.3a-2): turn-boundary interrupt is NOT a failure. The step
    // goes back to PENDING — no error, `transcript` deliberately untouched
    // (it carries the checkpoint the takeover resumes from; planResume only
    // skips COMPLETED steps, so the step stays claimable). The run stays
    // PAUSED/CANCELLED; the runner exits without finalizing.
    if (err instanceof HandoffInterrupt) {
      const interruptNote =
        "Interrupted at a turn boundary (pause/handoff) — resumable from the persisted checkpoint.";
      try {
        await prisma.runStep.update({
          where: { id: runStep.id },
          data: {
            status: "PENDING",
            reasoning: interruptNote,
            error: null,
            startedAt: null,
            completedAt: null,
          },
        });
      } catch (updateErr) {
        // Swallow: propagating would fail the BullMQ job, and its retry
        // re-enters processRun which force-sets the run back to RUNNING —
        // un-pausing a paused run. The claim stale path recovers the step.
        logger.warn(
          { runId, runStepId: runStep.id, err: (updateErr as Error).message },
          "interrupt PENDING reset failed (non-fatal)",
        );
      }
      return {
        stepId: runStep.id,
        status: "INTERRUPTED",
        reasoning: interruptNote,
        output: null,
        // Cost burned before the interrupt travels in the checkpoint
        // (costSoFarUsd) — the takeover leg accounts for it (T6).
        costUsd: 0,
        toolCallIds: [],
      };
    }

    const errorMsg = err instanceof Error ? err.message : String(err);

    await prisma.runStep.update({
      where: { id: runStep.id },
      data: {
        status: "FAILED",
        reasoning: `Step failed: ${errorMsg}`,
        error: errorMsg,
        completedAt: new Date(),
      },
    });

    await publishRunEvent(runId, { type: "STEP_FAILED", stepId: runStep.id, error: errorMsg });

    // E3/T3 automatic handoff trigger (§2.3b — B3): ONLY a marked provider
    // chain-exhaustion with a trustworthy classification (FAILOVER, or a
    // TRANSIENT carrying a real HTTP status) opens a ledger. Generic failures
    // — "No AI provider configured", Prisma errors, plain code bugs, and
    // default-TRANSIENT guesses — never trigger. The whole call is
    // error-swallowing (B6.2): opening a ledger must NEVER re-throw and un-do
    // the FAILED marking above (a throw would let BullMQ attempts:2 re-run the
    // step). The step stays FAILED regardless of the handoff outcome.
    if (isHandoffTriggerEligible(err)) {
      try {
        await maybeOpenAutoHandoff(runId, err);
      } catch (handoffErr) {
        logger.warn(
          { runId, runStepId: runStep.id, err: (handoffErr as Error).message },
          "auto handoff trigger failed (non-fatal — step stays FAILED)",
        );
      }
    }

    return {
      stepId: runStep.id,
      status: "FAILED",
      reasoning: `Step failed: ${errorMsg}`,
      output: null,
      costUsd: 0,
      toolCallIds: [],
    };
  }
}

/**
 * Build a context-rich prompt for a pipeline step.
 * Includes shared memory context from previous agents.
 */
function buildStepPrompt(
  stepDef: StepDef,
  input: unknown,
  companyName: string,
  memoryContext: Record<string, unknown> = {},
): string {
  const parts = [
    `You are executing step "${stepDef.name}" for company "${companyName}".`,
    "",
    "IMPORTANT: You MUST explain your reasoning for every decision you make.",
    'Start your response with "## Reasoning" followed by why you chose this approach.',
    "",
    `Step: ${stepDef.name}`,
    `Your role: ${stepDef.agentRole}`,
  ];

  if (input && typeof input === "object" && Object.keys(input as object).length > 0) {
    parts.push("", "Input from previous step:", JSON.stringify(input, null, 2));
  }

  // Inject shared memory from other agents in this run
  if (Object.keys(memoryContext).length > 0) {
    parts.push("", "=== Shared context from other agents in this pipeline run ===");
    for (const [key, value] of Object.entries(memoryContext)) {
      parts.push(`\n[${key}]:`, typeof value === "string" ? value : JSON.stringify(value, null, 2));
    }
    parts.push("=== End of shared context ===");
  }

  if (stepDef.config) {
    parts.push("", "Step configuration:", JSON.stringify(stepDef.config, null, 2));
  }

  parts.push(
    "",
    "Use the tools available to you to complete this step.",
    "Provide your final output as structured text.",
  );

  return parts.join("\n");
}

/**
 * Extract reasoning from agent response.
 * Looks for "## Reasoning" section or first paragraph.
 */
function extractReasoning(result: AgentLoopResult): string {
  const content = result.finalContent;
  if (!content) return "";

  // Look for explicit reasoning section
  const reasoningMatch = content.match(/## Reasoning\s*\n([\s\S]*?)(?=\n## |\n---|\Z)/i);
  if (reasoningMatch) return reasoningMatch[1].trim();

  // Fallback: use first paragraph
  const firstPara = content.split("\n\n")[0];
  return firstPara?.trim() ?? "";
}

/**
 * Log all tool calls from an agent loop to the database in a single
 * `createMany` round-trip.
 *
 * Earlier this looped `await prisma.toolCall.create()` per tool call —
 * a 10-turn run with 5 tools/turn meant 50 sequential network round-
 * trips before the run could complete. Under the 20-connection Prisma
 * pool that's enough to wedge the whole API behind a single big run.
 *
 * `createMany` issues one INSERT regardless of size and `skipDuplicates`
 * is unnecessary because runStepId+toolName aren't unique.
 *
 * The returned id list is best-effort — `createMany` doesn't return
 * generated ids on Postgres without `createManyAndReturn`. Since the
 * existing callers only count tool calls and forward the ids to
 * telemetry tags, we re-fetch by runStepId to recover the ids without
 * extra round-trips per row.
 */
async function logToolCalls(
  runStepId: string,
  result: AgentLoopResult,
): Promise<string[]> {
  const rows: Array<{
    runStepId: string;
    toolName: string;
    input: unknown;
    output: unknown;
    status: "FAILED" | "COMPLETED";
    durationMs: number | null;
    error: string | null;
  }> = [];

  for (const turn of result.turns) {
    for (const tc of turn.toolCalls) {
      rows.push({
        runStepId,
        toolName: tc.name,
        input: tc.input,
        output: tc.output,
        status: tc.error ? "FAILED" : "COMPLETED",
        durationMs: tc.durationMs ?? null,
        error: tc.error ?? null,
      });
    }
  }

  if (rows.length === 0) return [];

  await prisma.toolCall.createMany({ data: rows as any });

  // Recover the ids in one round-trip so telemetry tags and any
  // downstream consumer that needs the row identifiers can still
  // function. Ordering by createdAt keeps the result aligned with the
  // input array under normal conditions.
  const created = await prisma.toolCall.findMany({
    where: { runStepId },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  return created.map((c) => c.id);
}

/**
 * Check governance rules during execution.
 * Delegates to the centralized governance engine.
 */
export async function checkGovernance(
  runId: string,
  currentCost: number,
): Promise<{ allowed: boolean; reason?: string }> {
  const { runGovernanceChecks } = await import("../governance/engine");
  const result = await runGovernanceChecks(runId, currentCost);
  return {
    allowed: result.allowed,
    reason: result.reason,
  };
}
