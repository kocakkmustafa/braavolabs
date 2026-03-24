/**
 * Claude Client — Faz 1
 *
 * Wrapper around Anthropic API for agent execution.
 * Handles tool use, message history, and cost tracking.
 */

// TODO: Faz 1 — Implement Claude client
// import Anthropic from "@anthropic-ai/sdk";
// import { env } from "../../config/env";
// import { getTool } from "./registry";

export interface ClaudeResponse {
  content: string;
  toolCalls: Array<{
    name: string;
    input: unknown;
    output: unknown;
  }>;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/**
 * Execute a single agent turn with Claude.
 * Placeholder — will be implemented in Faz 1.
 */
export async function executeAgentTurn(
  _systemPrompt: string,
  _messages: Array<{ role: string; content: string }>,
  _tools: string[],
): Promise<ClaudeResponse> {
  // TODO: Faz 1
  throw new Error("Agent execution not yet implemented — coming in Faz 1");
}
