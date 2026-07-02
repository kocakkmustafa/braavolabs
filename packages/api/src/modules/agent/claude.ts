import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { env } from "../../config/env";
import { logger } from "../../lib/logger";
import { getTool } from "./registry";
import { executeTool, type ToolExecResult } from "./tool-executor";
import { runLocalAgentLoop } from "./claude-local";
import {
  getTenantAIConfig,
  chatCompletion,
  resolveModelForProvider,
  ToolsUnsupportedError,
  type AIClientConfig,
  type AIProviderType,
  type ChatCompletionResult,
  type ChatMessage,
  type ChatToolCall,
  type ChatToolDef,
} from "../../services/ai-client";
import { priceForModel, FREE_PROVIDERS } from "../../lib/modelPricing";
import { tryConsumeTrialRun, commitTrialRun } from "../../services/trial-llm";
import { prisma } from "../../lib/db";
import { publishRunEvent } from "../../lib/runEvents";

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
  /**
   * Graduated autonomy (Feature D6) of the agent executing this step. Threaded
   * to executeTool() so the approval gate can relax NON-money pauses for more
   * autonomous agents. Money-touching tools stay gated regardless. Defaults to
   * BALANCED in the executor when absent (preserves historical behaviour).
   */
  autonomy?: "SUPERVISED" | "BALANCED" | "AUTONOMOUS";
}

const isLocalMode = env.LLM_PROVIDER === "local";

// HIGH-7 fix: per-model pricing. The previous flat $3/$15 (Sonnet) was
// applied to every response, including Opus runs at $15/$75 — making
// the reported `costUsd` 5× lower than reality and letting
// cost_anomaly_stop (CLAUDE.md rule #8: budget * 0.2 trigger) miss the
// actual overrun until 5× the budget had already burned. We fail
// EXPENSIVE on unknown models — better to over-report cost and stop
// early than the opposite.
const MODEL_PRICES: Record<string, { input: number; output: number }> = {
  // Claude 4 family
  "claude-opus-4-20250514": { input: 15.0, output: 75.0 },
  "claude-sonnet-4-5-20250929": { input: 3.0, output: 15.0 },
  "claude-sonnet-4": { input: 3.0, output: 15.0 },
  "claude-haiku-4-5-20251001": { input: 0.8, output: 4.0 },
  // Claude 3 family (legacy)
  "claude-3-5-sonnet-20241022": { input: 3.0, output: 15.0 },
  "claude-3-5-haiku-20241022": { input: 0.8, output: 4.0 },
  "claude-3-opus-20240229": { input: 15.0, output: 75.0 },
};

// Fallback when the model returned by the API isn't in our table —
// price as if it's Opus so cost_anomaly_stop can still gate cleanly.
const FALLBACK_PRICE = { input: 15.0, output: 75.0 };

function priceFor(model: string): { input: number; output: number } {
  if (MODEL_PRICES[model]) return MODEL_PRICES[model]!;
  // Heuristic for date-suffixed variants we forgot to enumerate.
  for (const key of Object.keys(MODEL_PRICES)) {
    if (model.startsWith(key.replace(/-\d{8}$/, ""))) {
      return MODEL_PRICES[key]!;
    }
  }
  logger.warn({ model }, "Unknown Claude model — pricing as Opus (fail-expensive)");
  return FALLBACK_PRICE;
}

// E2/T4 (plan §2.6): the flat $2/$8 guess for non-Anthropic providers is
// gone. Real prices come from lib/modelPricing.ts; unknown models are
// priced at the gpt-4-turbo class so cost_anomaly_stop (rule #8) trips
// EARLY, never late. Local/self-hosted providers cost $0 (own hardware).
const NON_ANTHROPIC_FALLBACK_PRICE = { inputPerM: 10.0, outputPerM: 30.0 };

function costForUsage(
  provider: AIProviderType,
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  if (provider === "ANTHROPIC") {
    const p = priceFor(model);
    return (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output;
  }
  if (FREE_PROVIDERS.has(provider)) return 0;
  const price = priceForModel(model);
  if (!price) {
    logger.warn(
      { provider, model },
      "Unknown non-Anthropic model — pricing at gpt-4-turbo class (fail-expensive)",
    );
  }
  const p = price ?? NON_ANTHROPIC_FALLBACK_PRICE;
  return (inputTokens / 1_000_000) * p.inputPerM + (outputTokens / 1_000_000) * p.outputPerM;
}

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
  /** How tools reached the model on this run (E2/T4): "native" =
   * provider function-calling; "prompt-fallback" = the model rejected the
   * tools payload and the loop downgraded to prompt-embedded descriptions. */
  toolUseMode?: "native" | "prompt-fallback";
  /** Provider that ACTUALLY served this loop (E2/T5 — D-010). Consumers
   * that persist run metadata (bench) record these instead of the values
   * they merely requested. */
  provider?: AIProviderType;
  /** Model that actually ran — after the §2.4 hierarchy resolution
   * (Agent.model > tenant model > provider default). */
  model?: string;
}

/**
 * Convert registered tool names to the normalized ChatToolDef contract
 * (E2/T3). Same source of truth as the old buildAnthropicTools — the
 * registry's JSON Schema — projected per provider at call time.
 */
export function buildChatToolDefs(toolNames: string[]): ChatToolDef[] {
  return toolNames
    .map((name) => {
      const tool = getTool(name);
      if (!tool) return null;
      return {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema as Record<string, unknown>,
      };
    })
    .filter((t): t is ChatToolDef => t !== null);
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
      // ToolsUnsupportedError is a capability verdict, not a transient
      // fault — retrying would send the same doomed payload again.
      if (lastError instanceof ToolsUnsupportedError) throw lastError;
      const isRetryable =
        lastError.message.includes("overloaded") ||
        lastError.message.includes("529") ||
        lastError.message.includes("rate_limit") ||
        lastError.message.includes("429") ||
        lastError.message.includes("500") ||
        lastError.message.includes("503");
      if (!isRetryable || attempt === maxRetries) throw lastError;
      const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * 500;
      logger.warn({ attempt: attempt + 1, maxRetries, delayMs: delay }, "Retrying AI provider call");
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

// Concurrency cap on parallel tool execution. A model can emit 20+
// tool calls in a single turn, each of which may hit an integration
// (HubSpot, Stripe, SendGrid, …) with its own per-second rate limit.
// Running them all in parallel with Promise.all triggers those limits,
// gets us throttled, and then the whole run fails. 5 parallel tool
// calls keeps each integration comfortably under its bucket while
// still leaving room for fast-completing tools.
const TOOL_PARALLELISM = 5;

async function mapWithConcurrency<TItem, TResult>(
  items: TItem[],
  limit: number,
  fn: (item: TItem, index: number) => Promise<TResult>,
): Promise<TResult[]> {
  const out: TResult[] = new Array(items.length);
  let cursor = 0;
  const workers: Promise<void>[] = [];
  const workerCount = Math.min(limit, items.length);
  for (let w = 0; w < workerCount; w++) {
    workers.push((async () => {
      while (true) {
        const i = cursor++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    })());
  }
  await Promise.all(workers);
  return out;
}

/** Parse the normalized tool-call arguments (raw JSON string) into the
 * object shape the registry's Zod validation expects. Malformed JSON
 * degrades to {} — the tool's own schema validation reports the miss. */
function parseToolArgs(argumentsJson: string): unknown {
  try {
    const parsed = JSON.parse(argumentsJson);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Execute the tool calls of one turn — provider-agnostic (E2/T4).
 *
 * Governed path (govContext present): every call goes through executeTool()
 * with approval gate, tenant isolation, rate limits, and audit logging.
 * Ungoverned path: registry direct, with the fail-closed guards for
 * approval-required and tenant-scoped (companyId-carrying) tools.
 */
async function executeToolCalls(
  toolCalls: ChatToolCall[],
  govContext?: AgentGovContext,
): Promise<AgentTurnResult["toolCalls"]> {
  return mapWithConcurrency(toolCalls, TOOL_PARALLELISM, async (call) => {
    const input = parseToolArgs(call.argumentsJson);

    // Governed path: approvals, tenant isolation, rate limits, audit log.
    if (govContext) {
      const result: ToolExecResult = await executeTool(call.name, input, govContext);
      const errorMsg =
        result.status === "PENDING_APPROVAL"
          ? `Action paused — waiting for spend approval (approval id ${result.approvalId})`
          : result.error;
      return {
        id: call.id,
        name: call.name,
        input,
        output: result.output,
        durationMs: result.durationMs,
        ...(errorMsg ? { error: errorMsg } : {}),
      };
    }

    // Ungoverned path — only used when no run context (e.g. onboarding,
    // natural-language builder). Approval-required tools block here for safety.
    const start = Date.now();
    const registeredTool = getTool(call.name);

    if (!registeredTool) {
      return {
        id: call.id,
        name: call.name,
        input,
        output: null,
        durationMs: Date.now() - start,
        error: `Tool "${call.name}" not found in registry`,
      };
    }

    if (registeredTool.meta?.requiresApproval) {
      return {
        id: call.id,
        name: call.name,
        input,
        output: null,
        durationMs: Date.now() - start,
        error: `Tool "${call.name}" requires spend approval and cannot run outside a governed pipeline run`,
      };
    }

    // Defense in depth: tools that take a companyId touch tenant-scoped
    // DB rows. The ungoverned path skips enforceTenantScopedCompany()
    // (it has no tenantId to compare against), so any tool with a
    // companyId field MUST run via a governed pipeline. Refusing here
    // means a future caller that omits govContext can never silently
    // escalate cross-tenant — they get an obvious error instead.
    const inputObj = (input ?? {}) as Record<string, unknown>;
    if ("companyId" in inputObj) {
      return {
        id: call.id,
        name: call.name,
        input,
        output: null,
        durationMs: Date.now() - start,
        error: `Tool "${call.name}" requires a tenant-scoped pipeline run (companyId in input)`,
      };
    }

    try {
      const output = await registeredTool.handler(input);
      return {
        id: call.id,
        name: call.name,
        input,
        output,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error({ tool: call.name, error }, "Tool execution failed");
      return {
        id: call.id,
        name: call.name,
        input,
        output: null,
        durationMs: Date.now() - start,
        error,
      };
    }
  });
}

/**
 * Mid-run steering (Phase 1 HITL — the v2 moat), extracted loop-independent
 * (E2/T4): drains any operator STEER/INPUT messages queued against this run
 * and returns them as a guidance string for the caller to inject into its
 * canonical transcript. Publishes STEERING_APPLIED run events. No-op
 * (returns null) outside a governed run.
 */
async function drainSteeringText(govContext?: AgentGovContext): Promise<string | null> {
  if (!govContext) return null;
  try {
    const pending = await prisma.steeringMessage.findMany({
      where: { runId: govContext.runId, kind: { in: ["STEER", "INPUT"] }, consumedAt: null },
      orderBy: { createdAt: "asc" },
    });
    if (pending.length === 0) return null;
    await prisma.steeringMessage.updateMany({
      where: { id: { in: pending.map((m) => m.id) } },
      data: { consumedAt: new Date() },
    });
    const text = pending
      .map((m) =>
        m.kind === "INPUT"
          ? `[Human-in-the-loop answer]: ${m.content}`
          : `[Operator steering${m.targetAgentId ? ` for agent ${m.targetAgentId}` : ""}]: ${m.content}`,
      )
      .join("\n\n");
    for (const m of pending) {
      await publishRunEvent(govContext.runId, {
        type: "STEERING_APPLIED",
        targetAgentId: m.targetAgentId ?? undefined,
        instruction: m.content.slice(0, 200),
      });
    }
    return text;
  } catch (err) {
    logger.warn(
      { runId: govContext.runId, err: (err as Error).message },
      "steering drain failed (non-fatal)",
    );
    return null;
  }
}

/** Inject steering guidance into the canonical transcript. Merges into a
 * trailing user message when present; otherwise appends a fresh user turn
 * (the per-provider projections keep role alternation valid — tool-result
 * runs followed by a user turn are folded at projection time). */
function injectSteering(messages: ChatMessage[], text: string): void {
  const last = messages[messages.length - 1];
  if (last && last.role === "user") {
    last.content = `${last.content}\n\n${text}`;
  } else {
    messages.push({ role: "user", content: text });
  }
}

/** Legacy prompt-embedding fallback (pre-E2 behaviour for non-Anthropic
 * providers): serialize tool names/descriptions into the system prompt so
 * models without native function-calling can still reason about them. */
function embedToolsInPrompt(systemPrompt: string, toolNames: string[]): string {
  const toolDescriptions = toolNames
    .map((name) => {
      const tool = getTool(name);
      return tool ? `- ${tool.name}: ${tool.description}` : null;
    })
    .filter(Boolean)
    .join("\n");
  return toolDescriptions
    ? `${systemPrompt}\n\nAvailable tools:\n${toolDescriptions}`
    : systemPrompt;
}

/** Project the (Anthropic-typed, legacy) context messages into the
 * canonical ChatMessage transcript. Text blocks are flattened; tool
 * blocks are dropped (no production caller passes them). */
function projectContextMessages(context?: MessageParam[]): ChatMessage[] {
  if (!context?.length) return [];
  const out: ChatMessage[] = [];
  for (const m of context) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    const content =
      typeof m.content === "string"
        ? m.content
        : m.content
            .filter((b): b is { type: "text"; text: string } => (b as { type?: string }).type === "text")
            .map((b) => b.text)
            .join("\n");
    if (content) out.push({ role: m.role, content });
  }
  return out;
}

/** Map the normalized stop reason back onto the legacy Anthropic-flavored
 * strings that AgentTurnResult consumers (and claude-local) already use. */
function toLegacyStopReason(result: ChatCompletionResult): string {
  if (result.toolCalls?.length) return "tool_use";
  switch (result.stopReason) {
    case "length":
      return "max_tokens";
    case "tool_calls":
      return "tool_use";
    default:
      return "end_turn";
  }
}

/** One wire call. OpenAI-compatible transports already retry 429/5xx
 * internally (ai-client.ts); the Anthropic SDK path and the Gemini REST
 * path don't — wrap those in the legacy exponential backoff. */
async function callProvider(
  config: AIClientConfig,
  systemPrompt: string,
  messages: ChatMessage[],
  maxTokens: number,
  tools?: ChatToolDef[],
): Promise<ChatCompletionResult> {
  const invoke = () =>
    chatCompletion(config, systemPrompt, messages, maxTokens, tools?.length ? { tools } : {});
  if (config.provider === "ANTHROPIC" || config.provider === "GOOGLE") {
    return withRetry(invoke);
  }
  return invoke();
}

/** Trial economics guard (plan T4/A8): the unified loop gives trial
 * tenants REAL tool-use turns — clamp the turn count so a single free run
 * can't burn ~10 tool-use turns of holding-funded Groq tokens. The trial
 * counter itself stays run-based (T7 owns any chain-order changes). */
const TRIAL_MAX_TURNS = 4;

export interface ProviderAgentLoopConfig {
  systemPrompt: string;
  userMessage: string;
  toolNames: string[];
  model?: string;
  maxTokens?: number;
  maxTurns?: number;
  budgetUsd?: number;
  context?: MessageParam[];
  govContext?: AgentGovContext;
}

/**
 * THE unified agent loop (E2/T4 — plan §2.2 Karar A). One skeleton for
 * every provider:
 *
 *   canonical transcript (normalized ChatMessage[]) → per-provider
 *   projection at call time (Anthropic included) → native tool-calls →
 *   governed executeTool (TOOL_PARALLELISM=5) → tool results appended →
 *   next turn. Steering drain before each turn; budget check after each.
 *
 * Replaces both runAnthropicLoop and the single-shot
 * runNonAnthropicAgentLoop. Providers/models that reject native tools
 * (ToolsUnsupportedError, pre-flight or runtime 400) downgrade to the
 * legacy prompt-embedded single shot and mark toolUseMode:"prompt-fallback".
 */
export async function runProviderAgentLoop(
  config: ProviderAgentLoopConfig,
  aiConfig: AIClientConfig,
): Promise<AgentLoopResult> {
  const {
    systemPrompt,
    userMessage,
    toolNames,
    maxTurns = 10,
    budgetUsd = 1.0,
    govContext,
  } = config;
  // A8: agent-configured maxTokens travels to the wire for EVERY provider
  // (the old non-Anthropic path hardcoded 4096).
  const maxTokens = config.maxTokens ?? 4096;

  if (aiConfig.provider === "ANTHROPIC" && !aiConfig.apiKey) {
    throw new Error(
      "Anthropic API client not initialized. Configure an API key in Settings → AI Provider.",
    );
  }

  // Model hierarchy (plan §2.4 / F-020): Agent.model when catalogue-
  // compatible with the resolved provider > tenant model > provider default.
  const model = resolveModelForProvider(aiConfig.provider, config.model, aiConfig.model);
  const callConfig: AIClientConfig = { ...aiConfig, model };

  const toolDefs = buildChatToolDefs(toolNames);
  let toolUseMode: "native" | "prompt-fallback" = "native";
  let effectiveSystemPrompt = systemPrompt;

  // Canonical transcript — normalized, provider-independent (plan §2.2/A8).
  const messages: ChatMessage[] = [
    ...projectContextMessages(config.context),
    { role: "user", content: userMessage },
  ];

  const turns: AgentTurnResult[] = [];
  let totalCost = 0;

  for (let turn = 0; turn < maxTurns; turn++) {
    // Mid-run steering (v2 moat) — now on EVERY provider path, not just
    // Anthropic (E2/T4 parity).
    const steering = await drainSteeringText(govContext);
    if (steering) injectSteering(messages, steering);

    const wantNativeTools = toolUseMode === "native" && toolDefs.length > 0;
    let result: ChatCompletionResult;
    try {
      result = await callProvider(
        callConfig,
        effectiveSystemPrompt,
        messages,
        maxTokens,
        wantNativeTools ? toolDefs : undefined,
      );
    } catch (err) {
      if (err instanceof ToolsUnsupportedError && wantNativeTools) {
        // Graceful degradation (plan §2.1): prompt-embedded single shot.
        // The model can't request tools in this mode, so the loop ends
        // naturally after this turn — same behaviour every such tenant
        // had before E2. Never triggers cross-provider failover (the same
        // model would reject tools elsewhere too).
        toolUseMode = "prompt-fallback";
        effectiveSystemPrompt = embedToolsInPrompt(systemPrompt, toolNames);
        logger.warn(
          { provider: callConfig.provider, model: callConfig.model, detail: err.message },
          "Native tool-use unsupported — downgrading to prompt-embedded tools",
        );
        result = await callProvider(callConfig, effectiveSystemPrompt, messages, maxTokens);
      } else {
        throw err;
      }
    }

    // Cost: real per-model pricing on every path (plan §2.6). Use the
    // model the provider actually answered with when reported.
    const costUsd = costForUsage(
      callConfig.provider,
      result.model || callConfig.model,
      result.inputTokens,
      result.outputTokens,
    );

    const requestedCalls = result.toolCalls ?? [];
    const toolCallResults = await executeToolCalls(requestedCalls, govContext);

    turns.push({
      content: result.content,
      toolCalls: toolCallResults,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      costUsd,
      stopReason: toLegacyStopReason(result),
    });
    totalCost += costUsd;

    // Budget check
    if (totalCost > budgetUsd) {
      logger.warn({ totalCost, budgetUsd }, "Agent budget exceeded — stopping");
      break;
    }

    // If no tool calls, the agent is done
    if (requestedCalls.length === 0) {
      break;
    }

    // Append the assistant turn + tool results to the canonical transcript.
    messages.push({ role: "assistant", content: result.content, toolCalls: requestedCalls });
    for (const tc of toolCallResults) {
      messages.push({
        role: "tool",
        toolCallId: tc.id,
        content: tc.error
          ? JSON.stringify({ error: tc.error })
          : JSON.stringify(tc.output ?? {}),
      });
    }
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
    toolUseMode,
    // Actually-used provider/model (E2/T5) — `model` is the post-hierarchy
    // resolution, i.e. what really went on the wire.
    provider: callConfig.provider,
    model,
  };
}

/**
 * Run the full agent loop:
 * 1. Send message to the resolved provider
 * 2. If the model uses tools, execute them and feed results back
 * 3. Repeat until it produces a final text response or budget is exhausted
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
  /**
   * Force this exact provider config (E2/T5 — D-010): skips tenant
   * resolution, the trial path AND the local-CLI mode. Used by consumers
   * that must hit the REAL provider×model they claim to measure — bench
   * (env-keyed, tenant-less) and the T8 compare mode. Tenant pipeline
   * runs never set it.
   */
  aiConfigOverride?: AIClientConfig;
}): Promise<AgentLoopResult> {
  // Forced provider config wins over everything, local-CLI mode included —
  // an override is an explicit "go to this wire" order (bench previously
  // ran tenant-less and always landed on system Anthropic while the
  // BenchRun row claimed opts.provider — D-010).
  if (config.aiConfigOverride) {
    return runProviderAgentLoop(config, config.aiConfigOverride);
  }

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

  // Resolution order for tenant AI config — PRESERVED VERBATIM in T4,
  // including the un-awaited returns (loop errors bypass the catch):
  // documented as D-009; the chain re-ordering (BYOK → trial → opt-in
  // system) and the `await` fix are T7's job, not this one's.
  if (config.tenantId) {
    try {
      const aiConfig = await getTenantAIConfig(config.tenantId);
      // Every provider — Anthropic included — goes through the ONE
      // unified loop with canonical-transcript projection (plan §2.2).
      return runProviderAgentLoop(config, aiConfig);
    } catch (err) {
      // No BYOK config? Try trial Groq before falling through to system.
      const trial = await tryConsumeTrialRun(config.tenantId);
      if (trial) {
        logger.info(
          { tenantId: config.tenantId, remainingBefore: trial.remainingBefore },
          "Routing pipeline run through trial Groq",
        );
        const result = await runProviderAgentLoop(
          {
            ...config,
            maxTurns: Math.min(config.maxTurns ?? TRIAL_MAX_TURNS, TRIAL_MAX_TURNS),
          },
          trial.config,
        );
        // Commit only after success — failures don't burn the slot.
        await commitTrialRun(config.tenantId);
        return result;
      }
      logger.warn({ err }, "Failed to load tenant AI config — using system default");
    }
  }

  // System Anthropic key (legacy / self-hosted operator). The loop throws
  // the historical "not initialized" error when the key is absent.
  return runProviderAgentLoop(config, {
    provider: "ANTHROPIC",
    model: env.CLAUDE_MODEL,
    apiKey: env.ANTHROPIC_API_KEY ?? "",
  });
}
