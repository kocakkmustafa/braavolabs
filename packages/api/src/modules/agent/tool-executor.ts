/**
 * Tool Executor — executes tool calls with approval gates,
 * rate limiting, and audit logging.
 */

import { prisma } from "../../lib/db";
import { logger } from "../../lib/logger";
import { getTool, getToolMeta, type ToolMeta } from "./registry";

export interface ToolExecResult {
  output: unknown;
  status: "COMPLETED" | "FAILED" | "PENDING_APPROVAL";
  durationMs: number;
  error?: string;
  approvalId?: string;
}

/**
 * Execute a tool call with governance checks.
 */
export async function executeTool(
  toolName: string,
  input: unknown,
  context: {
    runId?: string;
    runStepId?: string;
    companyId: string;
    tenantId: string;
  },
): Promise<ToolExecResult> {
  const start = Date.now();
  const tool = getTool(toolName);
  const meta = getToolMeta(toolName);

  if (!tool) {
    return {
      output: null,
      status: "FAILED",
      durationMs: Date.now() - start,
      error: `Tool "${toolName}" not found in registry`,
    };
  }

  // --- Approval gate ---
  if (meta?.requiresApproval) {
    const approval = await prisma.approval.create({
      data: {
        runId: context.runId!,
        type: "SPEND",
        description: `Approval required for tool: ${toolName}`,
        metadata: { toolName, input } as any,
        status: "PENDING",
      },
    });

    await prisma.activityLog.create({
      data: {
        tenantId: context.tenantId,
        actor: "system",
        action: "approval.requested",
        resource: "tool_call",
        details: { toolName, approvalId: approval.id } as any,
      },
    });

    logger.info({ toolName, approvalId: approval.id }, "Tool requires approval — paused");
    return {
      output: null,
      status: "PENDING_APPROVAL",
      durationMs: Date.now() - start,
      approvalId: approval.id,
    };
  }

  // --- Rate limit check ---
  if (meta?.rateLimit) {
    const oneMinuteAgo = new Date(Date.now() - 60_000);
    const recentCalls = await prisma.toolCall.count({
      where: {
        toolName,
        runStep: { run: { pipeline: { companyId: context.companyId } } },
        createdAt: { gte: oneMinuteAgo },
      },
    });
    if (recentCalls >= meta.rateLimit) {
      return {
        output: null,
        status: "FAILED",
        durationMs: Date.now() - start,
        error: `Rate limit exceeded: ${recentCalls}/${meta.rateLimit} calls/min for "${toolName}"`,
      };
    }
  }

  // --- Execute ---
  try {
    const output = await tool.handler(input);
    const durationMs = Date.now() - start;

    // Log tool call
    if (context.runStepId) {
      await prisma.toolCall.create({
        data: {
          runStepId: context.runStepId,
          toolName,
          input: input as any,
          output: output as any,
          status: "COMPLETED",
          durationMs,
        },
      });
    }

    return { output, status: "COMPLETED", durationMs };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const durationMs = Date.now() - start;

    if (context.runStepId) {
      await prisma.toolCall.create({
        data: {
          runStepId: context.runStepId,
          toolName,
          input: input as any,
          output: {} as any,
          status: "FAILED",
          durationMs,
          error,
        },
      });
    }

    logger.error({ toolName, error }, "Tool execution failed");
    return { output: null, status: "FAILED", durationMs, error };
  }
}
