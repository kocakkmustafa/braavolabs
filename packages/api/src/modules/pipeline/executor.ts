import { prisma } from "../../lib/db";
import { logger } from "../../lib/logger";
import { runAgentLoop, type AgentLoopResult } from "../agent/claude";
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
  status: "COMPLETED" | "FAILED";
  reasoning: string;
  output: unknown;
  costUsd: number;
  toolCallIds: string[];
  memoryKey?: string;
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
  const agent = run.pipeline.company.agents.find(
    (a) =>
      a.role === agentRole ||
      a.name === agentRole ||
      a.name.toLowerCase() === agentRole.toLowerCase() ||
      a.role.toLowerCase().startsWith(agentRole.toLowerCase()) ||
      agentRole.toLowerCase().includes(a.name.toLowerCase()),
  );
  if (!agent) {
    throw new AppError(400, `No agent with role "${agentRole}" in company. Available: ${run.pipeline.company.agents.map(a => `${a.name} (${a.role.slice(0, 40)})`).join(", ")}`);
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

    // Execute agent loop
    const result = await runAgentLoop({
      systemPrompt: agent.systemPrompt,
      userMessage: stepPrompt,
      toolNames: agent.tools as string[],
      model: agent.model,
      maxTokens: agent.maxTokens,
      maxTurns: 10,
      budgetUsd: Number(run.budgetUsd ?? 1),
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
      },
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
 * Log all tool calls from an agent loop to the database.
 */
async function logToolCalls(
  runStepId: string,
  result: AgentLoopResult,
): Promise<string[]> {
  const ids: string[] = [];

  for (const turn of result.turns) {
    for (const tc of turn.toolCalls) {
      const record = await prisma.toolCall.create({
        data: {
          runStepId,
          toolName: tc.name,
          input: tc.input as any,
          output: tc.output as any,
          status: tc.error ? "FAILED" : "COMPLETED",
          durationMs: tc.durationMs,
          error: tc.error,
        },
      });
      ids.push(record.id);
    }
  }

  return ids;
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
