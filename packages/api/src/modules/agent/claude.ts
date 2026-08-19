import { createHash } from "node:crypto";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { env } from "../../config/env";
import { logger } from "../../lib/logger";
import { getTool, type ToolDefinition } from "./registry";
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
  ProviderExhaustedError,
  recordProviderFailure,
  recordProviderSuccess,
  type ProviderChainLink,
  type ProviderChainSource,
} from "../../services/provider-chain";
import { priceForModel, FREE_PROVIDERS } from "../../lib/modelPricing";
import { commitTrialRun } from "../../services/trial-llm";
import { prisma } from "../../lib/db";
import { publishRunEvent } from "../../lib/runEvents";
import { buildContextSummary, NO_PRIOR_CONTEXT } from "../run/handoff-summary";

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
export function buildChatToolDefs(
  toolNames: string[],
  extraTools?: Map<string, ToolDefinition>,
): ChatToolDef[] {
  return toolNames
    .map((name) => {
      // D-005 (E5/T7): a connector tool lives ONLY in the request-scoped
      // extraTools map (never the global registry), so resolve there first.
      const tool = extraTools?.get(name) ?? getTool(name);
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
  extraTools?: Map<string, ToolDefinition>,
): Promise<AgentTurnResult["toolCalls"]> {
  return mapWithConcurrency(toolCalls, TOOL_PARALLELISM, async (call) => {
    const input = parseToolArgs(call.argumentsJson);

    // Governed path: approvals, tenant isolation, rate limits, audit log.
    if (govContext) {
      // D-005 (E5/T7): thread the request-scoped connector tools so the
      // executor resolves + gates them with their DERIVED meta.
      const result: ToolExecResult = await executeTool(call.name, input, {
        ...govContext,
        ...(extraTools ? { extraTools } : {}),
      });
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
    // Connector tools (extraTools) are per-tenant + credential-bearing and are
    // only ever spliced on the GOVERNED path; resolving them here for
    // completeness means an approval-required connector tool is blocked below
    // rather than silently missing.
    const start = Date.now();
    const registeredTool = extraTools?.get(call.name) ?? getTool(call.name);

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

// ─── E3/T2 — live turn-boundary checkpoint + handoff interrupt (§2.2/§2.3a) ───

/** Size cap for the persisted checkpoint JSON (plan §2.2-1): beyond 1MB the
 * oldest turns are dropped so run_steps.transcript can't balloon the DB. */
export const CHECKPOINT_MAX_BYTES = 1024 * 1024;

/** When truncating, keep the first user message (the step prompt) plus the
 * last N turns. Halved further (6 → 3 → 1) if a single giant tool output
 * still blows the cap. */
const CHECKPOINT_KEEP_TURNS = [6, 3, 1] as const;

/**
 * The canonical transcript checkpoint (§2.1 checkpoint contract). Written to
 * `run_steps.transcript` at the END of every governed turn (crash carrier)
 * and frozen — copied — into `handoff_ledger.checkpoint` at handoff time.
 */
export interface TranscriptCheckpoint {
  messages: ChatMessage[];
  /** Number of COMPLETED turns the messages cover. */
  turn: number;
  toolUseMode: "native" | "prompt-fallback";
  costSoFarUsd: number;
  /** sha256 (first 16 hex chars) of the BASE system prompt — lets a takeover
   * detect prompt drift between the leaving and the taking provider. */
  systemPromptHash: string;
  truncated: boolean;
}

/** Cut the transcript down to the first user message + the last `keepTurns`
 * turns. Turns are anchored on assistant messages, so assistant→tool-result
 * groups are never split apart. */
function truncateToLastTurns(messages: ChatMessage[], keepTurns: number): ChatMessage[] {
  const anchors: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "assistant") anchors.push(i);
  }
  if (anchors.length <= keepTurns) return messages;
  const cut = anchors[anchors.length - keepTurns];
  const firstUser = messages.find((m) => m.role === "user");
  const tail = messages.slice(cut);
  return firstUser ? [firstUser, ...tail] : tail;
}

/**
 * Build the checkpoint payload, enforcing the 1MB cap (§2.2-1): oversize
 * transcripts keep the first user message + the last 6 turns (then 3, then 1),
 * flagged `truncated:true`. A single turn that alone exceeds the cap is kept
 * whole — better an oversized checkpoint than a useless one.
 */
export function serializeCheckpoint(
  messages: ChatMessage[],
  turn: number,
  toolUseMode: "native" | "prompt-fallback",
  costSoFarUsd: number,
  systemPromptHash: string,
): TranscriptCheckpoint {
  const full: TranscriptCheckpoint = {
    messages,
    turn,
    toolUseMode,
    costSoFarUsd,
    systemPromptHash,
    truncated: false,
  };
  if (Buffer.byteLength(JSON.stringify(full), "utf8") <= CHECKPOINT_MAX_BYTES) return full;
  let candidate: TranscriptCheckpoint = full;
  for (const keep of CHECKPOINT_KEEP_TURNS) {
    candidate = { ...full, messages: truncateToLastTurns(messages, keep), truncated: true };
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") <= CHECKPOINT_MAX_BYTES) break;
  }
  return candidate;
}

/**
 * E3/T2 marker error (§2.3a-2). NOT a failure: thrown by the loop when the
 * turn-boundary check sees a PAUSED/CANCELLED run or an OPEN handoff ledger.
 * The pipeline executor catches it, resets the step to PENDING (error null,
 * transcript preserved), and the runner exits WITHOUT finalizing the run —
 * the run stays PAUSED/CANCELLED, claimable by a takeover.
 */
export class HandoffInterrupt extends Error {
  constructor(
    public readonly runId: string,
    public readonly runStatus: string,
    public readonly handoffLedgerId: string | null,
  ) {
    super(
      `Run ${runId} interrupted at a turn boundary (status=${runStatus}` +
        `${handoffLedgerId ? `, open handoff ${handoffLedgerId}` : ""})`,
    );
    this.name = "HandoffInterrupt";
  }
}

/** Persist the live checkpoint to run_steps.transcript. Errors are swallowed
 * (§2.2-1): a checkpoint miss must never kill the run — the next turn simply
 * retries the write. */
async function persistTurnCheckpoint(
  govContext: AgentGovContext,
  checkpoint: TranscriptCheckpoint,
): Promise<void> {
  try {
    await prisma.runStep.update({
      where: { id: govContext.runStepId },
      data: { transcript: checkpoint as any },
    });
  } catch (err) {
    logger.warn(
      { runId: govContext.runId, runStepId: govContext.runStepId, err: (err as Error).message },
      "turn checkpoint persist failed (non-fatal — next turn retries)",
    );
  }
}

/**
 * Turn-boundary interrupt check (§2.3a-2 — B2 fix). Runs at the START of
 * every governed turn, at the same point as the steering drain. Two cheap
 * SELECTs (≪ LLM latency): run.status and any OPEN handoff ledger. When the
 * run is PAUSED/CANCELLED or a handoff was requested:
 *
 *   1. persist the live checkpoint (crash carrier),
 *   2. FREEZE the OPEN ledger's checkpoint — the live loop is the SINGLE
 *      writer for RUNNING runs (§2.3a-3): claim only accepts a FULL
 *      checkpoint, so this freeze is what makes the handoff claimable.
 *      An already-frozen copy is never overwritten (immutable audit fact),
 *   3. throw HandoffInterrupt for a graceful exit.
 *
 * SELECT failures are swallowed: a DB hiccup must not kill a healthy run —
 * worst case the interrupt lands one turn later.
 */
async function checkTurnBoundaryInterrupt(
  govContext: AgentGovContext | undefined,
  buildCheckpoint: () => TranscriptCheckpoint,
): Promise<void> {
  if (!govContext) return;
  let runStatus: string | undefined;
  let openLedger: { id: string; checkpoint: unknown } | null = null;
  try {
    const [run, ledger] = await Promise.all([
      prisma.run.findUnique({
        where: { id: govContext.runId },
        select: { status: true },
      }),
      prisma.handoffLedger.findFirst({
        where: { runId: govContext.runId, status: "OPEN" },
        select: { id: true, checkpoint: true },
      }),
    ]);
    runStatus = run?.status;
    openLedger = ledger;
  } catch (err) {
    logger.warn(
      { runId: govContext.runId, err: (err as Error).message },
      "turn-boundary interrupt check failed (non-fatal — continuing the turn)",
    );
    return;
  }

  const interrupted =
    runStatus === "PAUSED" || runStatus === "CANCELLED" || openLedger !== null;
  if (!interrupted) return;

  const checkpoint = buildCheckpoint();
  await persistTurnCheckpoint(govContext, checkpoint);

  if (openLedger && openLedger.checkpoint === null) {
    // D-015: RE-derive contextSummary from the REAL frozen checkpoint here.
    // On the MANUAL early-handoff path createHandoff wrote its summary while
    // run_steps.transcript was still null (loop interrupted before its first
    // turn produced anything) → the placeholder NO_PRIOR_CONTEXT. This freeze
    // is the first moment the genuine mid-step transcript exists, so we replace
    // that placeholder with the real note built from the same messages we're
    // freezing. Same mechanical summariser as createHandoff → identical text
    // for the same transcript. Completed-step names are a cheap best-effort
    // read; its failure must never block the checkpoint freeze.
    let completedStepNames: string[] = [];
    try {
      const completed = await prisma.runStep.findMany({
        where: { runId: govContext.runId, status: "COMPLETED" },
        orderBy: { stepIndex: "asc" },
        select: { name: true },
      });
      completedStepNames = completed
        .map((s) => s.name)
        .filter(Boolean) as string[];
    } catch (err) {
      logger.warn(
        { runId: govContext.runId, err: (err as Error).message },
        "completed-step read for handoff summary failed (non-fatal — summary built from checkpoint only)",
      );
    }
    const contextSummary = buildContextSummary(completedStepNames, checkpoint);

    try {
      await prisma.handoffLedger.update({
        where: { id: openLedger.id },
        // Freeze the checkpoint AND refresh the summary in one write. The
        // summary is only ever rewritten here at the null→frozen transition
        // (never on an already-frozen ledger), so the audit copy stays as
        // immutable as the checkpoint itself. Skip the summary write only when
        // the checkpoint genuinely yields no context (keeps createHandoff's
        // own text — e.g. completed-step names — instead of clobbering it).
        data: {
          checkpoint: checkpoint as any,
          ...(contextSummary !== NO_PRIOR_CONTEXT ? { contextSummary } : {}),
        },
      });
    } catch (err) {
      logger.warn(
        { runId: govContext.runId, handoffId: openLedger.id, err: (err as Error).message },
        "handoff checkpoint freeze failed (non-fatal — claim's 120s stale path recovers from run_steps.transcript)",
      );
    }
  }

  throw new HandoffInterrupt(govContext.runId, runStatus ?? "RUNNING", openLedger?.id ?? null);
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
function embedToolsInPrompt(
  systemPrompt: string,
  toolNames: string[],
  extraTools?: Map<string, ToolDefinition>,
): string {
  const toolDescriptions = toolNames
    .map((name) => {
      const tool = extraTools?.get(name) ?? getTool(name);
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
  /**
   * E3/T6 handoff resume (§2.5): the frozen canonical transcript the LEAVING
   * provider left off at (handoff_ledger.checkpoint.messages). When present the
   * loop SEEDS its canonical transcript with these messages followed by a short
   * handoff-note user message — and does NOT append `userMessage` (the original
   * step prompt already lives in the resumed transcript). The takeover provider
   * picks up "from where the last one stopped" (K1). Absent on every normal
   * (non-handoff) invocation, so those keep today's [context, userMessage] seed.
   */
  resumeMessages?: ChatMessage[];
  /**
   * D-005 (E5/T7): request-scoped dynamic connector tools for the acting
   * tenant. Spliced into the model's tool set (buildChatToolDefs) and the
   * governed executor (executeToolCalls → executeTool.extraTools) alongside
   * the static registry — but NEVER written to the global registry, so
   * tenant-A's connector tools are invisible to tenant-B's loop. Absent on
   * every run that installs no connectors.
   */
  extraTools?: Map<string, ToolDefinition>;
}

/**
 * Build the handoff-note user message the resume leg appends after the resumed
 * transcript (§2.5). Verbatim format from plan §2.5: leaving provider + turn +
 * context summary + "resume from where you left off". Role alternation is folded
 * by the projection layer (injectSteering precedent), so a plain user turn after
 * the (possibly tool-ending) transcript is safe.
 */
export function buildHandoffResumeNote(
  fromProvider: string,
  turn: number,
  contextSummary: string,
): string {
  return (
    `[Handoff] The previous provider ${fromProvider} left this task at turn ${turn}. ` +
    `Summary: ${contextSummary} ` +
    `Continue from where it left off and complete the task.`
  );
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

  // D-005 (E5/T7): request-scoped connector tools. Their names are also
  // added to toolNames so the prompt-fallback path and buildChatToolDefs
  // surface them; resolution always prefers extraTools over the global
  // registry so nothing is registered globally.
  const extraTools = config.extraTools;
  const effectiveToolNames =
    extraTools && extraTools.size > 0
      ? [...toolNames, ...[...extraTools.keys()].filter((n) => !toolNames.includes(n))]
      : toolNames;
  const toolDefs = buildChatToolDefs(effectiveToolNames, extraTools);
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
  // E3/T6 handoff resume (§2.5): when resumeMessages is present the takeover
  // SEEDS the transcript from the leaving provider's frozen checkpoint (which
  // already ends with the handoff-note user turn the executor appended) and does
  // NOT add `userMessage` — the original step prompt is already inside those
  // messages. Normal (non-handoff) runs keep the historical [context, user] seed.
  const messages: ChatMessage[] =
    config.resumeMessages && config.resumeMessages.length > 0
      ? [...config.resumeMessages]
      : [...projectContextMessages(config.context), { role: "user", content: userMessage }];

  const turns: AgentTurnResult[] = [];
  let totalCost = 0;

  // E3/T2: base-prompt fingerprint — travels in every checkpoint (§2.1).
  const systemPromptHash = createHash("sha256").update(systemPrompt).digest("hex").slice(0, 16);
  const buildCheckpoint = (): TranscriptCheckpoint =>
    serializeCheckpoint(messages, turns.length, toolUseMode, totalCost, systemPromptHash);

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
    // E3/T2 (§2.3a-2): turn-boundary interrupt check — same point as the
    // steering drain. PAUSED/CANCELLED run or an OPEN handoff ledger →
    // persist the transcript, freeze the ledger checkpoint, exit gracefully
    // via HandoffInterrupt. Deliberately BEFORE the steering drain: an
    // interrupt must not consume pending steering — the takeover loop
    // drains it instead.
    await checkTurnBoundaryInterrupt(govContext, buildCheckpoint);

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
          effectiveSystemPrompt = embedToolsInPrompt(systemPrompt, effectiveToolNames, extraTools);
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
        // FATAL never chains — throw it raw (NOT handoff-eligible: the same
        // doomed request would die on any provider — B3).
        if (!isFailoverEligible(cls)) throw err;
        // Failover-eligible but no link left in the chain: the tenant's chain
        // is EXHAUSTED. Wrap in the ProviderExhaustedError marker (§2.3b/B3)
        // so the executor's catch can open an AUTOMATIC handoff — but ONLY on
        // a trustworthy classification (FAILOVER, or TRANSIENT with a real
        // status). isHandoffTriggerEligible() does that filtering downstream;
        // here we just record what the classifier saw. The message mirrors the
        // cause so every `.toThrow(/…/)` consumer reads exactly as before.
        if (pendingLinks.length === 0) {
          throw ProviderExhaustedError.wrap(cls, callConfig.provider, callConfig.model, err);
        }
        const reason = `${cls}: ${err instanceof Error ? err.message : String(err)}`;
        const switched = await switchToNextProvider(reason, turn);
        // switchToNextProvider returned false ⇒ every remaining link is gone
        // (idx === -1, pendingLinks emptied) ⇒ chain exhausted, same marker.
        if (!switched) {
          throw ProviderExhaustedError.wrap(cls, callConfig.provider, callConfig.model, err);
        }
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
    const toolCallResults = await executeToolCalls(requestedCalls, govContext, extraTools);

    turns.push({
      content: result.content,
      toolCalls: toolCallResults,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      costUsd,
      stopReason: toLegacyStopReason(result),
    });
    totalCost += costUsd;

    // Append the assistant turn + tool results to the canonical transcript —
    // exactly as in E2: ONLY when the loop continues (the live array is what
    // the next turn projects from; a final-turn append would change its
    // observable shape).
    const continuing = totalCost <= budgetUsd && requestedCalls.length > 0;
    const toolMessages: ChatMessage[] = toolCallResults.map((tc) => ({
      role: "tool" as const,
      toolCallId: tc.id,
      content: tc.error
        ? JSON.stringify({ error: tc.error })
        : JSON.stringify(tc.output ?? {}),
    }));
    if (continuing) {
      messages.push({ role: "assistant", content: result.content, toolCalls: requestedCalls });
      messages.push(...toolMessages);
    }

    // E3/T2 (§2.2-1): live checkpoint — the crash carrier. Written at the
    // END of every governed turn, tool results INCLUDED: if the process dies
    // right now, the last FULL turn is already in run_steps.transcript. On a
    // FINAL turn (budget stop / no tool calls) the closing assistant message
    // is folded into a checkpoint-only COPY, keeping the live transcript's
    // E2 shape untouched.
    if (govContext) {
      const checkpointMessages = continuing
        ? messages
        : [
            ...messages,
            {
              role: "assistant" as const,
              content: result.content,
              ...(requestedCalls.length > 0 ? { toolCalls: requestedCalls } : {}),
            },
            ...toolMessages,
          ];
      await persistTurnCheckpoint(
        govContext,
        serializeCheckpoint(checkpointMessages, turns.length, toolUseMode, totalCost, systemPromptHash),
      );
    }

    // Budget check
    if (totalCost > budgetUsd) {
      logger.warn({ totalCost, budgetUsd }, "Agent budget exceeded — stopping");
      break;
    }

    // If no tool calls, the agent is done
    if (requestedCalls.length === 0) {
      break;
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
   * runs never set it. The E3 takeover leg (T6) sets it to the resolved
   * takeover config so the handoff dials the tenant-chosen provider directly.
   */
  aiConfigOverride?: AIClientConfig;
  /**
   * E3/T6 handoff resume (§2.5): the frozen checkpoint transcript to seed the
   * takeover loop with (ending in the handoff-note user turn). Threaded straight
   * through to runProviderAgentLoop. Only ever set alongside aiConfigOverride on
   * the takeover leg.
   */
  resumeMessages?: ChatMessage[];
  /**
   * D-005 (E5/T7): the acting tenant's request-scoped dynamic connector
   * tools. Threaded straight through to runProviderAgentLoop, spliced into
   * the tool set alongside the static registry, and NEVER registered
   * globally (cross-tenant isolation). The pipeline executor resolves these
   * per run via listConnectorToolsForTenant(tenantId).
   */
  extraTools?: Map<string, ToolDefinition>;
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
        // totalCostUsd covers the whole run, not just the trial-served
        // turns (a mid-run failover could mix sources) — conservative by
        // construction: the hosted-trial bucket is charged at least what
        // the trial link caused, never less. Matches this counter's own
        // existing all-or-nothing granularity (servedBy is a single flag,
        // not a per-turn attribution either).
        await commitTrialRun(config.tenantId, result.totalCostUsd);
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
