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

const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

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
      };
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
 * Execute a single Claude API call with tool use.
 * Returns the response and any tool call results.
 */
async function executeTurn(
  systemPrompt: string,
  messages: MessageParam[],
  tools: Tool[],
  model: string,
  maxTokens: number,
): Promise<AgentTurnResult> {
  const response = await withRetry(() =>
    client.messages.create({
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
}): Promise<AgentLoopResult> {
  const {
    systemPrompt,
    userMessage,
    toolNames,
    model = env.CLAUDE_MODEL,
    maxTokens = 4096,
    maxTurns = 10,
    budgetUsd = 1.0,
  } = config;

  const tools = buildAnthropicTools(toolNames);
  const messages: MessageParam[] = [
    ...(config.context ?? []),
    { role: "user", content: userMessage },
  ];
  const turns: AgentTurnResult[] = [];
  let totalCost = 0;

  for (let turn = 0; turn < maxTurns; turn++) {
    const result = await executeTurn(systemPrompt, messages, tools, model, maxTokens);
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
