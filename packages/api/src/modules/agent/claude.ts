import Anthropic from "@anthropic-ai/sdk";
import type {
  MessageParam,
  ContentBlockParam,
  ToolUseBlock,
  ToolResultBlockParam,
  Tool,
} from "@anthropic-ai/sdk/resources/messages";
import { env } from "../../config/env";
import { logger } from "../../lib/logger";
import { getTool } from "./registry";
import { executeTool, type ToolExecResult } from "./tool-executor";
import { runLocalAgentLoop } from "./claude-local";
import { getTenantAIConfig, chatCompletion, type AIClientConfig } from "../../services/ai-client";

/**
 * Governance context threaded from pipeline executor → agent loop → tool execution.
 * When present, every tool call runs through executeTool() with approval gate,
 * tenant isolation, rate limiting, and audit logging.
 *
 * When absent (bare invocations, e.g. onboarding clarification), tools run
 * directly against the registry — safer subset of tools should be used there.
 */
export interface AgentGovContext {
  tenantId: string;
  companyId: string;
  runId: string;
  runStepId: string;
}

const isLocalMode = env.LLM_PROVIDER === "local";
// Legacy system-level Anthropic client (used when no tenant config or for Anthropic provider)
const systemClient = isLocalMode ? null : (env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }) : null);

// Approximate pricing per 1M tokens (Claude Sonnet 4)
const INPUT_COST_PER_M = 3.0;
const OUTPUT_COST_PER_M = 15.0;

export interface AgentTurnResult {
  content: string;
  toolCalls: Array<{
    id: string;
    name: string;
    input: unknown;
    output: unknown;
    durationMs: number;
    error?: string;
  }>;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  stopReason: string;
}

export interface AgentLoopResult {
  finalContent: string;
  turns: AgentTurnResult[];
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  totalToolCalls: number;
}

/**
 * Convert registered tool names to Anthropic tool definitions.
 */
export function buildAnthropicTools(toolNames: string[]): Tool[] {
  return toolNames
    .map((name) => {
      const tool = getTool(name);
      if (!tool) return null;
      return {
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema as Tool["input_schema"],
      } as Tool;
    })
    .filter((t): t is Tool => t !== null);
}

/**
 * Retry a function with exponential backoff.
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  baseDelayMs = 1000,
): Promise<T> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const isRetryable =
        lastError.message.includes("overloaded") ||
        lastError.message.includes("529") ||
        lastError.message.includes("rate_limit") ||
        lastError.message.includes("429") ||
        lastError.message.includes("500") ||
        lastError.message.includes("503");
      if (!isRetryable || attempt === maxRetries) throw lastError;
      const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * 500;
      logger.warn({ attempt: attempt + 1, maxRetries, delayMs: delay }, "Retrying Claude API call");
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

/**
 * Execute a single Anthropic API call with tool use.
 * Returns the response and any tool call results.
 *
 * When govContext is provided, tool calls run through executeTool() which
 * enforces: approval gates, tenant isolation, rate limits, audit logging.
 * Otherwise tools run directly (used only for non-run contexts — e.g.
 * clarification loops that don't hit governed tools).
 */
async function executeTurn(
  systemPrompt: string,
  messages: MessageParam[],
  tools: Tool[],
  model: string,
  maxTokens: number,
  anthropicClient?: Anthropic,
  govContext?: AgentGovContext,
): Promise<AgentTurnResult> {
  const client = anthropicClient ?? systemClient;
  if (!client) {
    throw new Error("Anthropic API client not initialized. Configure an API key in Settings → AI Provider.");
  }

  const response = await withRetry(() =>
    client!.messages.create({
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages,
      tools: tools.length > 0 ? tools : undefined,
    }),
  );

  const inputTokens = response.usage.input_tokens;
  const outputTokens = response.usage.output_tokens;
  const costUsd =
    (inputTokens / 1_000_000) * INPUT_COST_PER_M +
    (outputTokens / 1_000_000) * OUTPUT_COST_PER_M;

  // Extract text content
  const textBlocks = response.content.filter((b) => b.type === "text");
  const content = textBlocks.map((b) => b.text).join("\n");

  // Execute tool calls
  const toolUseBlocks = response.content.filter(
    (b): b is ToolUseBlock => b.type === "tool_use",
  );

  const toolCallResults = await Promise.all(
    toolUseBlocks.map(async (block) => {
      // Governed path: approvals, tenant isolation, rate limits, audit log.
      if (govContext) {
        const result: ToolExecResult = await executeTool(block.name, block.input, govContext);
        const errorMsg =
          result.status === "PENDING_APPROVAL"
            ? `Action paused — waiting for spend approval (approval id ${result.approvalId})`
            : result.error;
        return {
          id: block.id,
          name: block.name,
          input: block.input,
          output: result.output,
          durationMs: result.durationMs,
          ...(errorMsg ? { error: errorMsg } : {}),
        };
      }

      // Ungoverned path — only used when no run context (e.g. onboarding,
      // natural-language builder). Approval-required tools block here for safety.
      const start = Date.now();
      const registeredTool = getTool(block.name);

      if (!registeredTool) {
        return {
          id: block.id,
          name: block.name,
          input: block.input,
          output: null,
          durationMs: Date.now() - start,
          error: `Tool "${block.name}" not found in registry`,
        };
      }

      if (registeredTool.meta?.requiresApproval) {
        return {
          id: block.id,
          name: block.name,
          input: block.input,
          output: null,
          durationMs: Date.now() - start,
          error: `Tool "${block.name}" requires spend approval and cannot run outside a governed pipeline run`,
        };
      }

      try {
        const output = await registeredTool.handler(block.input);
        return {
          id: block.id,
          name: block.name,
          input: block.input,
          output,
          durationMs: Date.now() - start,
        };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        logger.error({ tool: block.name, error }, "Tool execution failed");
        return {
          id: block.id,
          name: block.name,
          input: block.input,
          output: null,
          durationMs: Date.now() - start,
          error,
        };
      }
    }),
  );

  return {
    content,
    toolCalls: toolCallResults,
    inputTokens,
    outputTokens,
    costUsd,
    stopReason: response.stop_reason ?? "end_turn",
  };
}

/**
 * Run the full agent loop:
 * 1. Send message to Claude
 * 2. If Claude uses tools, execute them and feed results back
 * 3. Repeat until Claude produces a final text response or budget is exhausted
 */
export async function runAgentLoop(config: {
  systemPrompt: string;
  userMessage: string;
  toolNames: string[];
  model?: string;
  maxTokens?: number;
  maxTurns?: number;
  budgetUsd?: number;
  context?: MessageParam[];
  /** Tenant ID — used to load the tenant's configured AI provider */
  tenantId?: string;
  /**
   * Full governance context. When provided, every tool call goes through
   * executeTool() — approval gate, tenant isolation, rate limiting, audit.
   * REQUIRED for any loop invoked from a pipeline run.
   */
  govContext?: AgentGovContext;
}): Promise<AgentLoopResult> {
  // Route to local CLI if configured
  if (isLocalMode) {
    logger.info("Using local Claude CLI for agent loop");
    return runLocalAgentLoop({
      systemPrompt: config.systemPrompt,
      userMessage: config.userMessage,
      toolNames: config.toolNames,
      maxTurns: config.maxTurns,
      budgetUsd: config.budgetUsd,
    });
  }

  // For non-Anthropic providers, fall back to simple completion (no tool-use loop)
  if (config.tenantId) {
    try {
      const aiConfig = await getTenantAIConfig(config.tenantId);
      if (aiConfig.provider !== "ANTHROPIC") {
        return runNonAnthropicAgentLoop(config, aiConfig);
      }
      // For Anthropic, use the tenant's key
      const tenantClient = new Anthropic({ apiKey: aiConfig.apiKey });
      return runAnthropicLoop(config, tenantClient);
    } catch (err) {
      logger.warn({ err }, "Failed to load tenant AI config — using system default");
    }
  }

  return runAnthropicLoop(config, systemClient ?? undefined);
}

/**
 * Non-Anthropic providers don't support Anthropic's tool-use format.
 * We run a simplified loop: send the message, get a response, done.
 * Tool calls are serialized into the prompt so the model can reason about them.
 */
async function runNonAnthropicAgentLoop(
  config: {
    systemPrompt: string;
    userMessage: string;
    toolNames: string[];
    maxTurns?: number;
    budgetUsd?: number;
  },
  aiConfig: AIClientConfig,
): Promise<AgentLoopResult> {
  const toolDescriptions = config.toolNames.map((name) => {
    const tool = getTool(name);
    return tool ? `- ${tool.name}: ${tool.description}` : null;
  }).filter(Boolean).join("\n");

  const systemWithTools = toolDescriptions
    ? `${config.systemPrompt}\n\nAvailable tools:\n${toolDescriptions}`
    : config.systemPrompt;

  const result = await chatCompletion(
    aiConfig,
    systemWithTools,
    [{ role: "user", content: config.userMessage }],
    4096,
  );

  const inputCostPerM = 2.0; // conservative estimate for non-Anthropic
  const outputCostPerM = 8.0;
  const costUsd =
    (result.inputTokens / 1_000_000) * inputCostPerM +
    (result.outputTokens / 1_000_000) * outputCostPerM;

  const turn: AgentTurnResult = {
    content: result.content,
    toolCalls: [],
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    costUsd,
    stopReason: "end_turn",
  };

  return {
    finalContent: result.content,
    turns: [turn],
    totalInputTokens: result.inputTokens,
    totalOutputTokens: result.outputTokens,
    totalCostUsd: costUsd,
    totalToolCalls: 0,
  };
}

async function runAnthropicLoop(
  config: {
    systemPrompt: string;
    userMessage: string;
    toolNames: string[];
    model?: string;
    maxTokens?: number;
    maxTurns?: number;
    budgetUsd?: number;
    context?: MessageParam[];
    govContext?: AgentGovContext;
  },
  anthropicClient?: Anthropic,
): Promise<AgentLoopResult> {
  const {
    systemPrompt,
    userMessage,
    toolNames,
    model = env.CLAUDE_MODEL,
    maxTokens = 4096,
    maxTurns = 10,
    budgetUsd = 1.0,
    govContext,
  } = config;

  const tools = buildAnthropicTools(toolNames);
  const messages: MessageParam[] = [
    ...(config.context ?? []),
    { role: "user", content: userMessage },
  ];
  const turns: AgentTurnResult[] = [];
  let totalCost = 0;

  for (let turn = 0; turn < maxTurns; turn++) {
    const result = await executeTurn(systemPrompt, messages, tools, model, maxTokens, anthropicClient, govContext);
    turns.push(result);
    totalCost += result.costUsd;

    // Budget check
    if (totalCost > budgetUsd) {
      logger.warn({ totalCost, budgetUsd }, "Agent budget exceeded — stopping");
      break;
    }

    // If no tool calls, the agent is done
    if (result.toolCalls.length === 0) {
      break;
    }

    // Build assistant message with tool use blocks
    const assistantContent: ContentBlockParam[] = [];
    if (result.content) {
      assistantContent.push({ type: "text", text: result.content });
    }
    for (const tc of result.toolCalls) {
      assistantContent.push({
        type: "tool_use",
        id: tc.id,
        name: tc.name,
        input: tc.input as Record<string, unknown>,
      });
    }
    messages.push({ role: "assistant", content: assistantContent });

    // Build tool results message
    const toolResults: ToolResultBlockParam[] = result.toolCalls.map((tc) => ({
      type: "tool_result" as const,
      tool_use_id: tc.id,
      content: tc.error
        ? JSON.stringify({ error: tc.error })
        : JSON.stringify(tc.output ?? {}),
      is_error: !!tc.error,
    }));
    messages.push({ role: "user", content: toolResults });
  }

  const totalInputTokens = turns.reduce((s, t) => s + t.inputTokens, 0);
  const totalOutputTokens = turns.reduce((s, t) => s + t.outputTokens, 0);
  const totalToolCalls = turns.reduce((s, t) => s + t.toolCalls.length, 0);
  const lastTurn = turns[turns.length - 1];

  return {
    finalContent: lastTurn?.content ?? "",
    turns,
    totalInputTokens,
    totalOutputTokens,
    totalCostUsd: totalCost,
    totalToolCalls,
  };
}
