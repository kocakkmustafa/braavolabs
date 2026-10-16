/**
 * Local Claude Provider — uses the `claude` CLI (Claude Code)
 * instead of the Anthropic API. This allows local users to
 * leverage their existing Claude subscription without an API key.
 *
 * For published/production use, users provide their own API key
 * and the system uses the standard Anthropic SDK (claude.ts).
 */

import { spawn } from "node:child_process";
import { logger } from "../../lib/logger";
import { getTool } from "./registry";
import type { AgentTurnResult, AgentLoopResult } from "./claude";

interface ToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Build a tool description block for the system prompt.
 */
function buildToolPrompt(toolNames: string[]): string {
  const tools: ToolSchema[] = [];
  for (const name of toolNames) {
    const tool = getTool(name);
    if (tool) {
      tools.push({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      });
    }
  }

  if (tools.length === 0) return "";

  return `

## Available Tools

You have access to the following tools. To call a tool, respond with a JSON block in this exact format:

\`\`\`tool_call
{"tool": "tool_name", "input": {... parameters ...}}
\`\`\`

You may call multiple tools in one response. After each tool call block, the system will execute it and provide results. When you have enough information to give a final answer, respond with plain text (no tool_call blocks).

### Tools:
${tools.map((t) => `
**${t.name}**: ${t.description}
Parameters: \`${JSON.stringify(t.inputSchema)}\`
`).join("\n")}`;
}

/**
 * Parse tool calls from Claude CLI response text.
 */
function parseToolCalls(
  text: string,
): Array<{ name: string; input: unknown }> {
  const calls: Array<{ name: string; input: unknown }> = [];
  const regex = /```tool_call\s*\n([\s\S]*?)```/g;
  let match;

  while ((match = regex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      if (parsed.tool) {
        calls.push({ name: parsed.tool, input: parsed.input ?? {} });
      }
    } catch {
      logger.warn({ raw: match[1] }, "Failed to parse tool_call block");
    }
  }

  return calls;
}

/**
 * Strip tool_call blocks from text to get clean content.
 */
function stripToolCalls(text: string): string {
  return text.replace(/```tool_call\s*\n[\s\S]*?```/g, "").trim();
}

/**
 * Execute a prompt via Claude CLI.
 */
async function callClaudeCLI(
  prompt: string,
  systemPrompt?: string,
): Promise<{ result: string; costUsd: number; inputTokens: number; outputTokens: number }> {
  // Use stdin piping to avoid OS argument length limits with long prompts AND system prompts
  const args = ["-p", "-", "--output-format", "json"];

  // Embed system prompt into the user prompt via stdin to avoid argument length limits
  // (system prompts with tool schemas can exceed OS arg limits)
  const fullPrompt = systemPrompt
    ? `<system>\n${systemPrompt}\n</system>\n\n${prompt}`
    : prompt;

  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, {
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Claude CLI timed out after 300 seconds"));
    }, 300_000);

    child.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
    child.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });

    child.on("close", (code) => {
      clearTimeout(timeout);

      if (code !== 0) {
        const errMsg = stderr.trim() || `Process exited with code ${code}`;
        logger.error({ code, stderr: errMsg.slice(0, 500) }, "Claude CLI call failed");
        reject(new Error(`Claude CLI error (exit ${code}): ${errMsg.slice(0, 1000)}`));
        return;
      }

      try {
        const response = JSON.parse(stdout);
        resolve({
          result: response.result ?? "",
          costUsd: response.total_cost_usd ?? 0,
          inputTokens: response.usage?.input_tokens ?? 0,
          outputTokens: response.usage?.output_tokens ?? 0,
        });
      } catch (parseErr) {
        logger.error({ stdout: stdout.slice(0, 500) }, "Failed to parse Claude CLI JSON output");
        reject(new Error(`Claude CLI JSON parse error: ${stdout.slice(0, 500)}`));
      }
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      logger.error({ error: err.message }, "Claude CLI spawn failed");
      reject(new Error(`Claude CLI spawn error: ${err.message}`));
    });

    // Write full prompt (with embedded system prompt) to stdin and close
    child.stdin.write(fullPrompt);
    child.stdin.end();
  });
}

/**
 * Execute a single turn using Claude CLI with tool support.
 */
async function executeLocalTurn(
  systemPrompt: string,
  conversationHistory: string,
  toolNames: string[],
): Promise<AgentTurnResult> {
  const start = Date.now();
  const toolsForbidden = toolNames.length === 0;
  const toolPrompt = buildToolPrompt(toolNames);
  const fullSystem = systemPrompt + toolPrompt;

  const cliResult = await callClaudeCLI(conversationHistory, fullSystem);

  // Parse tool calls from response
  const parsedCalls = parseToolCalls(cliResult.result);
  if (toolsForbidden && parsedCalls.length > 0) {
    throw new Error("Tool calls are not allowed for this request");
  }
  const content = stripToolCalls(cliResult.result);

  // Execute tool calls
  const toolCallResults = await Promise.all(
    parsedCalls.map(async (call, index) => {
      const toolStart = Date.now();
      const registeredTool = getTool(call.name);

      if (!registeredTool) {
        return {
          id: `local_${Date.now()}_${index}`,
          name: call.name,
          input: call.input,
          output: null,
          durationMs: Date.now() - toolStart,
          error: `Tool "${call.name}" not found in registry`,
        };
      }

      // Local-CLI mode runs without a governance context — same defense
      // as the ungoverned path in claude.ts. Tools that touch tenant-
      // scoped data (anything with companyId or requiresApproval set)
      // must be invoked from a governed pipeline run, never from the
      // bare local agent loop.
      if (registeredTool.meta?.requiresApproval) {
        return {
          id: `local_${Date.now()}_${index}`,
          name: call.name,
          input: call.input,
          output: null,
          durationMs: Date.now() - toolStart,
          error: `Tool "${call.name}" requires spend approval and cannot run outside a governed pipeline run`,
        };
      }
      const callInputObj = (call.input ?? {}) as Record<string, unknown>;
      if ("companyId" in callInputObj) {
        return {
          id: `local_${Date.now()}_${index}`,
          name: call.name,
          input: call.input,
          output: null,
          durationMs: Date.now() - toolStart,
          error: `Tool "${call.name}" requires a tenant-scoped pipeline run (companyId in input)`,
        };
      }

      try {
        const output = await registeredTool.handler(call.input);
        return {
          id: `local_${Date.now()}_${index}`,
          name: call.name,
          input: call.input,
          output,
          durationMs: Date.now() - toolStart,
        };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        logger.error({ tool: call.name, error }, "Tool execution failed");
        return {
          id: `local_${Date.now()}_${index}`,
          name: call.name,
          input: call.input,
          output: null,
          durationMs: Date.now() - toolStart,
          error,
        };
      }
    }),
  );

  return {
    content,
    toolCalls: toolCallResults,
    inputTokens: cliResult.inputTokens,
    outputTokens: cliResult.outputTokens,
    costUsd: cliResult.costUsd,
    stopReason: toolCallResults.length > 0 ? "tool_use" : "end_turn",
  };
}

/**
 * Run the full agent loop using Claude CLI (local mode).
 */
export async function runLocalAgentLoop(config: {
  systemPrompt: string;
  userMessage: string;
  toolNames: string[];
  maxTurns?: number;
  budgetUsd?: number;
}): Promise<AgentLoopResult> {
  const {
    systemPrompt,
    userMessage,
    toolNames,
    maxTurns = 10,
    budgetUsd = 5.0,
  } = config;

  const turns: AgentTurnResult[] = [];
  let totalCost = 0;
  let conversationHistory = userMessage;

  for (let turn = 0; turn < maxTurns; turn++) {
    const result = await executeLocalTurn(systemPrompt, conversationHistory, toolNames);
    turns.push(result);
    totalCost += result.costUsd;

    // Budget check
    if (totalCost > budgetUsd) {
      logger.warn({ totalCost, budgetUsd }, "Local agent budget exceeded — stopping");
      break;
    }

    // If no tool calls, the agent is done
    if (result.toolCalls.length === 0) {
      break;
    }

    // Build conversation history with tool results for next turn
    const toolResultsText = result.toolCalls
      .map((tc) => {
        if (tc.error) {
          return `Tool "${tc.name}" failed: ${tc.error}`;
        }
        return `Tool "${tc.name}" result: ${JSON.stringify(tc.output)}`;
      })
      .join("\n\n");

    conversationHistory += `\n\nAssistant: ${result.content}\n\nTool Results:\n${toolResultsText}\n\nContinue based on the tool results above.`;
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
