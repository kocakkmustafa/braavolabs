import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { env } from "../../config/env";
import { logger } from "../../lib/logger";
import { getTool } from "./registry";
import { executeTool, type ToolExecResult } from "./tool-executor";
import { runLocalAgentLoop } from "./claude-local";
import {
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
import {
  buildTenantProviderChain,
  classifyProviderError,
  isFailoverEligible,
  isProviderTripped,
  recordProviderFailure,
  recordProviderSuccess,
  type ProviderChainLink,
  type ProviderChainSource,
} from "../../services/provider-chain";
import { priceForModel, FREE_PROVIDERS } from "../../lib/modelPricing";
import { commitTrialRun } from "../../services/trial-llm";
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
  /** Which chain link produced the FINAL answer (E2/T7). Only set when the
   * loop ran with a provider chain; runAgentLoop commits the trial counter
   * when this is "trial" (a trial link that failed over mid-run did NOT
   * serve the run and must not burn the slot). */
  servedBy?: ProviderChainSource;
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

/** Failover context for the unified loop (E2/T7). */
export interface ProviderFailoverOptions {
  /** Chain links AFTER the entry config — consumed left to right when a
   * turn dies with a failover-eligible error. */
  chain?: ProviderChainLink[];
  /** Source label of the entry aiConfig (chain head). */
  source?: ProviderChainSource;
  /** Tenant for circuit-breaker keying + the durable activity_log failover
   * record. Falls back to govContext.tenantId; hierarchical worker loops
   * run tenantful but ungoverned, hence the separate field. */
  tenantId?: string;
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
  failover?: ProviderFailoverOptions,
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
  let callConfig: AIClientConfig = { ...aiConfig, model };

  // ── Turn-boundary failover state (E2/T7, plan §2.2 Karar B) ──
  // The chain is consumed left to right; each switch re-projects the SAME
  // canonical transcript onto the next provider (one-way projection — no
  // bidirectional converters needed, plan A8).
  const pendingLinks: ProviderChainLink[] = [...(failover?.chain ?? [])];
  let activeSource: ProviderChainSource | undefined = failover?.source;
  const cbTenant = failover?.tenantId ?? govContext?.tenantId;
  let effectiveMaxTurns = maxTurns;

  const toolDefs = buildChatToolDefs(toolNames);
  let toolUseMode: "native" | "prompt-fallback" = "native";
  let effectiveSystemPrompt = systemPrompt;

  /** Advance to the next chain link. Prefers the first link whose circuit
   * breaker is closed; when EVERY remaining link is tripped, takes the
   * head anyway as a half-open probe (a run must not die purely because
   * the breaker is pessimistic). Publishes PROVIDER_FAILOVER on the run
   * stream and writes the durable activity_log record (run events are
   * Redis-only — plan A5). Returns false when the chain is exhausted. */
  const switchToNextProvider = async (reason: string, turn: number): Promise<boolean> => {
    let idx = pendingLinks.findIndex((l) => !isProviderTripped(cbTenant, l.provider));
    if (idx === -1) idx = pendingLinks.length > 0 ? 0 : -1;
    if (idx === -1) return false;
    const [next] = pendingLinks.splice(idx, 1);
    const from = callConfig.provider;

    callConfig = {
      ...next.config,
      // Re-run the §2.4 hierarchy against the NEW provider — the agent's
      // model may be compatible with one link and not the next.
      model: resolveModelForProvider(next.provider, config.model, next.config.model),
    };
    activeSource = next.source;
    // A fresh provider gets a fresh chance at NATIVE tool-calling even if
    // the previous one had degraded to prompt-embedding (the transcript
    // carries no tool_use blocks in that case, so this is always safe).
    toolUseMode = "native";
    effectiveSystemPrompt = systemPrompt;
    // Trial economics (plan T4/A8): a trial link taking over mid-run may
    // serve at most TRIAL_MAX_TURNS turns — the CURRENT (retried) turn
    // counts as its first.
    if (next.source === "trial") {
      effectiveMaxTurns = Math.min(effectiveMaxTurns, turn + TRIAL_MAX_TURNS);
    }

    const truncatedReason = reason.slice(0, 300);
    logger.warn(
      { from, to: next.provider, source: next.source, reason: truncatedReason, turn },
      "Provider failover — advancing to the next link in the tenant chain",
    );
    if (govContext) {
      await publishRunEvent(govContext.runId, {
        type: "PROVIDER_FAILOVER",
        stepId: govContext.runStepId,
        from,
        to: next.provider,
        reason: truncatedReason,
      });
    }
    if (cbTenant) {
      // Durable audit copy (K2 evidence lives here, not in Redis).
      try {
        await prisma.activityLog.create({
          data: {
            tenantId: cbTenant,
            actor: "system",
            action: "run.provider_failover",
            resource: "run",
            resourceId: govContext?.runId ?? null,
            details: { from, to: next.provider, source: next.source, reason: truncatedReason, turn },
          },
        });
      } catch (err) {
        logger.warn(
          { tenantId: cbTenant, err: (err as Error).message },
          "provider_failover activity log write failed (non-fatal)",
        );
      }
    }
    return true;
  };

  // Canonical transcript — normalized, provider-independent (plan §2.2/A8).
  const messages: ChatMessage[] = [
    ...projectContextMessages(config.context),
    { role: "user", content: userMessage },
  ];

  const turns: AgentTurnResult[] = [];
  let totalCost = 0;

  // Pre-flight breaker check: don't dial a head provider that just burned
  // 3 failures when a healthy alternative sits in the chain.
  if (
    pendingLinks.length > 0 &&
    isProviderTripped(cbTenant, callConfig.provider) &&
    pendingLinks.some((l) => !isProviderTripped(cbTenant, l.provider))
  ) {
    await switchToNextProvider("circuit breaker open (3 failures / 5min)", 0);
  }

  for (let turn = 0; turn < effectiveMaxTurns; turn++) {
    // Mid-run steering (v2 moat) — now on EVERY provider path, not just
    // Anthropic (E2/T4 parity).
    const steering = await drainSteeringText(govContext);
    if (steering) injectSteering(messages, steering);

    /** One turn against the ACTIVE provider, with the ToolsUnsupported →
     * prompt-embedding downgrade handled inline so provider errors from
     * either dial funnel into the failover catch below. */
    const attemptTurn = async (): Promise<ChatCompletionResult> => {
      const wantNativeTools = toolUseMode === "native" && toolDefs.length > 0;
      try {
        return await callProvider(
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
          return await callProvider(callConfig, effectiveSystemPrompt, messages, maxTokens);
        }
        throw err;
      }
    };

    let result: ChatCompletionResult;
    // Failover at the TURN BOUNDARY (plan §2.2): a turn that dies with a
    // failover-eligible error retries the SAME turn — same canonical
    // transcript — on the next chain link. Bounded: every iteration either
    // succeeds or permanently consumes a link.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        result = await attemptTurn();
        recordProviderSuccess(cbTenant, callConfig.provider);
        break;
      } catch (err) {
        const cls = classifyProviderError(err);
        // FATAL = request-shape error; says nothing about provider health
        // and would replay identically elsewhere — never breaker-counted,
        // never chained (plan risk table).
        if (cls !== "FATAL") recordProviderFailure(cbTenant, callConfig.provider);
        if (!isFailoverEligible(cls) || pendingLinks.length === 0) throw err;
        const reason = `${cls}: ${err instanceof Error ? err.message : String(err)}`;
        const switched = await switchToNextProvider(reason, turn);
        if (!switched) throw err;
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
    // Actually-used provider/model (E2/T5) — post-hierarchy resolution on
    // the FINAL active link, i.e. what really went on the wire last.
    provider: callConfig.provider,
    model: callConfig.model,
    ...(activeSource ? { servedBy: activeSource } : {}),
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
    return await runProviderAgentLoop(config, config.aiConfigOverride);
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

  // Tenant resolution — REBUILT in T7 (closes D-009). The pre-T7 order was
  // effectively "BYOK → system → (only if no system key) trial" because
  // getTenantAIConfig returned the SYSTEM config instead of throwing, so a
  // BYOK-less FREE tenant burned the uncounted system Anthropic key and the
  // trial path was dead code. The chain builder enforces the corrected,
  // privacy-honouring order:
  //
  //   BYOK default → tenant fallbackOrder links → trial Groq (FREE,
  //   counted) → system Anthropic (opt-in allowSystemFallback only;
  //   BYOK-less PAID tenants keep the system entry — see provider-chain.ts).
  //
  // The old un-awaited `return runProviderAgentLoop(...)` inside try{} let
  // every LOOP error bypass the catch (D-009 second leg) — resolution and
  // failover now both live where the `await`s are explicit.
  if (config.tenantId) {
    const chain = await buildTenantProviderChain(config.tenantId);
    if (chain.length === 0) {
      // Nothing may serve: no usable BYOK links, trial ineligible/spent,
      // system not permitted. Explicit failure — never a silent fall-through
      // to the system wallet (the D-009 bleed).
      throw new Error(
        "No AI provider configured. Please add an API key in Settings → AI Provider.",
      );
    }
    const [head, ...rest] = chain;
    if (head.source === "trial") {
      logger.info(
        { tenantId: config.tenantId },
        "Routing pipeline run through trial Groq",
      );
    }
    const result = await runProviderAgentLoop(
      // Trial economics guard at entry (plan T4/A8) — mid-run failover to a
      // trial link is clamped inside the loop instead.
      head.source === "trial"
        ? { ...config, maxTurns: Math.min(config.maxTurns ?? TRIAL_MAX_TURNS, TRIAL_MAX_TURNS) }
        : config,
      head.config,
      { chain: rest, source: head.source, tenantId: config.tenantId },
    );
    // Run-based trial counter: commit ONLY when the trial link actually
    // served the run to completion (a trial link that failed over mid-run
    // didn't — the slot is refunded, same contract as before).
    if (result.servedBy === "trial") {
      try {
        await commitTrialRun(config.tenantId);
      } catch (err) {
        // A counter miss is cheaper than failing a successful run — the
        // race-window comment in trial-llm.ts already accepts ±1 accuracy.
        logger.warn(
          { tenantId: config.tenantId, err: (err as Error).message },
          "commitTrialRun failed after a successful trial-served run (non-fatal)",
        );
      }
    }
    return result;
  }

  // Tenant-less invocations (onboarding, composer, NL builder — no BYOK
  // context exists): system Anthropic key, exactly as before. The loop
  // throws the historical "not initialized" error when the key is absent.
  return await runProviderAgentLoop(config, {
    provider: "ANTHROPIC",
    model: env.CLAUDE_MODEL,
    apiKey: env.ANTHROPIC_API_KEY ?? "",
  });
}
