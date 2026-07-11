/**
 * Unified AI Client — routes to the correct provider based on tenant config.
 *
 * Supported providers:
 *   ANTHROPIC   — @anthropic-ai/sdk
 *   OPENAI      — fetch → api.openai.com (Chat Completions)
 *   GOOGLE      — fetch → generativelanguage.googleapis.com (Gemini)
 *   MISTRAL     — fetch → api.mistral.ai (OpenAI-compatible)
 *   GROQ        — fetch → api.groq.com (OpenAI-compatible)
 *   OPENROUTER  — fetch → openrouter.ai (OpenAI-compatible)
 *   OLLAMA      — fetch → user-supplied URL (default localhost:11434/v1) — local Gemma/Llama
 *   LMSTUDIO    — fetch → user-supplied URL (default localhost:1234/v1)  — LM Studio server
 *   CUSTOM      — fetch → user-supplied URL — any OpenAI-compatible endpoint (LiteLLM, Together, vLLM, etc)
 *
 * The last three are "local-first" — they don't require an API key and
 * the user controls the endpoint. Cost = $0 (own hardware) and full
 * data privacy. The `apiKey` field is optional for these (some local
 * setups still want a token for auth).
 */

import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam, Tool } from "@anthropic-ai/sdk/resources/messages";
import { logger } from "../lib/logger";
import { encryptForTenant, decryptForTenant } from "../lib/encryption";
import { assertSafeExternalUrl, SsrfError } from "../lib/ssrf";
import { env } from "../config/env";

// ─── Types ────────────────────────────────────────────────

export type AIProviderType =
  | "ANTHROPIC"
  | "OPENAI"
  | "GOOGLE"
  | "MISTRAL"
  | "GROQ"
  | "OPENROUTER"
  | "DEEPSEEK"
  | "KIMI"
  | "QWEN"
  | "CEREBRAS"
  | "ZHIPU"
  | "OLLAMA"
  | "LMSTUDIO"
  | "CUSTOM";

/** Providers that only require a base URL (no API key). */
export const LOCAL_PROVIDERS: ReadonlySet<AIProviderType> = new Set(["OLLAMA", "LMSTUDIO", "CUSTOM"]);

export interface AIClientConfig {
  provider: AIProviderType;
  model: string;
  /** Plaintext API key (decrypt before passing in). Optional for local providers. */
  apiKey: string;
  /** Override base URL (used by OLLAMA / LMSTUDIO / CUSTOM, optional for OPENAI proxies). */
  baseUrl?: string;
}

/**
 * Normalized tool definition (E2/T3). One shape for every provider —
 * translated at call time into the provider's native wire format:
 *   OpenAI-compatible → `{ type:"function", function:{ name, description, parameters } }`
 *   Google Gemini     → `{ functionDeclarations:[{ name, description, parameters }] }`
 *   Anthropic         → `{ name, description, input_schema }`
 * `parameters` is a JSON Schema object — the exact shape the agent tool
 * registry already stores (registry.ts `ToolDefinition.inputSchema`).
 */
export interface ChatToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** Normalized tool invocation requested by the model. `argumentsJson` is the
 * raw JSON string — callers parse it (and validate through the registry's
 * Zod schema) before executing anything. */
export interface ChatToolCall {
  id: string;
  name: string;
  argumentsJson: string;
}

export interface ChatMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  /** role:"tool" only — id of the ChatToolCall this message answers. */
  toolCallId?: string;
  /** role:"assistant" only — tool calls the model requested in that turn. */
  toolCalls?: ChatToolCall[];
}

/** Normalized stop reason across providers. */
export type ChatStopReason = "stop" | "tool_calls" | "length" | "unknown";

export interface ChatCompletionResult {
  content: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
  provider: AIProviderType;
  /** Tool invocations requested by the model (normalized). Set only when non-empty. */
  toolCalls?: ChatToolCall[];
  stopReason?: ChatStopReason;
  /** How tools reached the model. "native" = provider function-calling;
   * "prompt-fallback" is set by the agent loop (T4) when it downgrades. */
  toolUseMode?: "native" | "prompt-fallback";
}

export interface ChatCompletionOptions {
  /** Normalized tool definitions. When the provider/model cannot do native
   * function-calling, chatCompletion throws ToolsUnsupportedError — the
   * agent loop catches it and downgrades to prompt-embedding (T4). */
  tools?: ChatToolDef[];
}

/**
 * Thrown when native tool-use cannot be used for this provider/model —
 * either pre-flight (TOOL_INCAPABLE_MODEL_PREFIXES match, or the provider
 * was removed from the NATIVE_TOOLUSE_PROVIDERS kill-switch) or at runtime
 * (provider rejected the `tools` payload with a 400). Callers downgrade to
 * the legacy prompt-embedding path on this error; it must NOT trigger
 * cross-provider failover (same model would fail again elsewhere too).
 */
export class ToolsUnsupportedError extends Error {
  readonly provider: AIProviderType;
  readonly model: string;
  constructor(provider: AIProviderType, model: string, detail?: string) {
    super(
      `${provider} model "${model}" cannot use native tool-calling` +
        (detail ? `: ${detail}` : ""),
    );
    this.name = "ToolsUnsupportedError";
    this.provider = provider;
    this.model = model;
  }
}

// ─── Provider model defaults ──────────────────────────────

export const PROVIDER_DEFAULT_MODELS: Record<AIProviderType, string> = {
  ANTHROPIC:  "claude-sonnet-4-20250514",
  OPENAI:     "gpt-4o",
  GOOGLE:     "gemini-1.5-pro",
  MISTRAL:    "mistral-large-latest",
  GROQ:       "llama-3.3-70b-versatile",
  OPENROUTER: "openai/gpt-4o",
  DEEPSEEK:   "deepseek-chat",
  KIMI:       "moonshot-v1-128k",
  QWEN:       "qwen-max",
  CEREBRAS:   "gpt-oss-120b",
  ZHIPU:      "glm-4.7-flash",
  // Local-first defaults — Gemma 3 4B is the sweet spot for 16GB MacBooks
  // (runs at ~30 tok/s, ~3GB RAM footprint, beats Llama 3.2 3B on agents).
  OLLAMA:     "gemma3:4b",
  LMSTUDIO:   "google/gemma-3-4b-it",
  CUSTOM:     "gpt-4o",
};

// Valid Anthropic model IDs as of 2026-04. Invalid IDs like
// "claude-opus-4-6" and "claude-sonnet-4-6" removed (they return 400 from API).
//
// Local provider model lists are *suggestions* — the actual catalogue is
// whatever the user has pulled into their Ollama/LM Studio instance. The
// UI lets them type any tag.
export const PROVIDER_MODELS: Record<AIProviderType, string[]> = {
  ANTHROPIC:  ["claude-opus-4-20250514", "claude-sonnet-4-5-20250929", "claude-sonnet-4-20250514", "claude-haiku-4-5-20251001"],
  OPENAI:     ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "o1", "o1-mini"],
  GOOGLE:     ["gemini-1.5-pro", "gemini-1.5-flash", "gemini-pro"],
  MISTRAL:    ["mistral-large-latest", "mistral-medium-latest", "mistral-small-latest", "open-mistral-7b"],
  GROQ:       ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "mixtral-8x7b-32768"],
  OPENROUTER: ["openai/gpt-4o", "anthropic/claude-sonnet-4-5", "meta-llama/llama-3.3-70b-instruct", "google/gemini-pro-1.5"],
  DEEPSEEK:   ["deepseek-chat", "deepseek-reasoner", "deepseek-coder"],
  KIMI:       ["moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k", "moonshot-v1-auto"],
  QWEN:       ["qwen-max", "qwen-plus", "qwen-turbo", "qwen-long", "qwen2.5-72b-instruct", "qwen2.5-32b-instruct"],
  CEREBRAS:   ["gpt-oss-120b", "glm-4.7"],
  ZHIPU:      ["glm-4.7-flash", "glm-4.5-flash", "glm-4.6v-flash", "glm-4.7", "glm-4.6"],
  OLLAMA:     ["gemma3:4b", "gemma3:12b", "gemma3:27b", "llama3.2:3b", "llama3.3:70b", "qwen2.5:14b", "qwen2.5-coder:14b", "deepseek-r1:8b", "phi3:14b"],
  LMSTUDIO:   ["google/gemma-3-4b-it", "google/gemma-3-12b-it", "meta-llama/llama-3.2-3b-instruct", "qwen/qwen2.5-14b-instruct"],
  CUSTOM:     [],
};

// ─── Model resolution hierarchy (E2/T4 — plan §2.4, F-020) ─

/** Strip Anthropic-style date suffixes so catalogue entries become family
 * prefixes (`claude-sonnet-4-20250514` → `claude-sonnet-4`). */
function modelFamily(entry: string): string {
  return entry.toLowerCase().replace(/-\d{8}$/, "");
}

/**
 * Is `model` plausibly served by `provider`?
 *
 *   Cloud providers — prefix match against the PROVIDER_MODELS catalogue
 *   (ANTHROPIC additionally accepts any `claude-*` id: the catalogue only
 *   lists current models but older ids like claude-3-5-sonnet are still
 *   valid API models and must not be silently swapped).
 *
 *   Local providers (OLLAMA / LMSTUDIO / CUSTOM) — the catalogue is open
 *   ended (whatever the user pulled), so any tag passes EXCEPT ids that
 *   clearly belong to a cloud provider's catalogue. Without that guard the
 *   composer default `claude-sonnet-4-…` on every Agent row would be sent
 *   verbatim to Ollama and 404 on each step (plan §2.4 guard rationale).
 */
export function isModelCompatibleWithProvider(provider: AIProviderType, model: string): boolean {
  const m = model.trim().toLowerCase();
  if (!m) return false;

  if (LOCAL_PROVIDERS.has(provider)) {
    for (const [p, entries] of Object.entries(PROVIDER_MODELS) as Array<[AIProviderType, string[]]>) {
      if (LOCAL_PROVIDERS.has(p)) continue;
      if (entries.some((e) => m.startsWith(modelFamily(e)))) return false;
    }
    // ANTHROPIC catalogue families don't cover legacy claude ids — treat the
    // whole `claude-` namespace as cloud-only.
    if (m.startsWith("claude-")) return false;
    return true;
  }

  if (provider === "ANTHROPIC") return m.startsWith("claude-");
  return PROVIDER_MODELS[provider].some((e) => m.startsWith(modelFamily(e)));
}

/**
 * Model selection hierarchy (plan §2.4 / F-020):
 *   1. Agent.model — when catalogue-compatible with the RESOLVED provider,
 *   2. tenant UserAIConfig.model,
 *   3. PROVIDER_DEFAULT_MODELS[provider].
 * Incompatible agent models downgrade predictably with a log line instead
 * of a silent 400 from the provider (the composer default is claude-*, so
 * every non-Anthropic tenant would otherwise fail on each step).
 */
export function resolveModelForProvider(
  provider: AIProviderType,
  agentModel?: string | null,
  tenantModel?: string | null,
): string {
  const agent = agentModel?.trim();
  if (agent) {
    if (isModelCompatibleWithProvider(provider, agent)) return agent;
    logger.info(
      { provider, agentModel: agent, tenantModel: tenantModel?.trim() || undefined },
      "Agent.model incompatible with resolved provider — falling back to tenant/default model",
    );
  }
  const tenant = tenantModel?.trim();
  if (tenant) return tenant;
  return PROVIDER_DEFAULT_MODELS[provider];
}

// ─── Native tool-use capability (E2/T3) ───────────────────

/**
 * Model-prefix catalogue of KNOWN native function-calling support
 * (lowercased startsWith match). Advisory: consumed by the Settings UI /
 * smoke matrix / T4 loop to pick sane defaults. The runtime gate is
 * deny-based — see TOOL_INCAPABLE_MODEL_PREFIXES and supportsNativeToolUse —
 * because an allow-only gate would wrongly block brand-new capable models.
 */
export const TOOL_CAPABLE_MODEL_PREFIXES: Record<AIProviderType, string[]> = {
  ANTHROPIC:  ["claude-"],
  OPENAI:     ["gpt-4", "gpt-3.5-turbo", "o1", "o3"],
  GOOGLE:     ["gemini-"],
  MISTRAL:    ["mistral-large", "mistral-medium", "mistral-small", "codestral"],
  GROQ:       ["llama-3.1-", "llama-3.3-", "mixtral-", "qwen"],
  OPENROUTER: [],   // passthrough — capability belongs to the routed model
  DEEPSEEK:   ["deepseek-chat"],
  KIMI:       ["moonshot-", "kimi-"],
  QWEN:       ["qwen-max", "qwen-plus", "qwen-turbo", "qwen2.5-"],
  CEREBRAS:   ["gpt-oss", "glm-"],
  ZHIPU:      ["glm-"],
  OLLAMA:     ["qwen2.5", "llama3.1", "llama3.2", "llama3.3", "mistral"],
  LMSTUDIO:   ["qwen/", "meta-llama/"],
  CUSTOM:     [],   // depends entirely on what sits behind the URL
};

/**
 * Models KNOWN to reject the native `tools` parameter with a 400 — checked
 * pre-flight so we never pay for a doomed request (plan §2.1). Prefix match,
 * lowercased. Kept deliberately short: unknown models attempt native
 * tool-use, and the runtime 400-"tool" → ToolsUnsupportedError catch is the
 * safety net.
 */
export const TOOL_INCAPABLE_MODEL_PREFIXES: readonly string[] = [
  "gemma",              // gemma2/gemma3 — our OLLAMA default; /v1 returns 400 "does not support tools"
  "google/gemma",       // same family, LM Studio catalogue naming
  "deepseek-reasoner",  // DeepSeek R1 endpoint — no function calling
  "deepseek-r1",        // R1 distills (Ollama / LM Studio naming)
  "o1-mini",            // OpenAI o1-mini lacks tool support (full o1 has it)
];

/** Default for the NATIVE_TOOLUSE_PROVIDERS kill-switch env: every
 * non-Anthropic provider enabled. Removing a provider from the env var
 * instantly restores the legacy prompt-embedding behavior for it (plan §2.1
 * rollback lever). */
export const DEFAULT_NATIVE_TOOLUSE_PROVIDERS =
  "OPENAI,GROQ,MISTRAL,DEEPSEEK,KIMI,QWEN,CEREBRAS,ZHIPU,OPENROUTER,GOOGLE,OLLAMA,LMSTUDIO,CUSTOM";

function nativeToolUseProviderEnabled(provider: AIProviderType): boolean {
  const raw = env.NATIVE_TOOLUSE_PROVIDERS ?? DEFAULT_NATIVE_TOOLUSE_PROVIDERS;
  return raw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
    .includes(provider);
}

/**
 * Pre-flight gate for native function-calling.
 * ANTHROPIC is never gated — its SDK tool path predates this translation
 * layer and is the reference behavior (kill-switching it would break the
 * primary agent loop, not roll anything back).
 */
export function supportsNativeToolUse(provider: AIProviderType, model: string): boolean {
  if (provider === "ANTHROPIC") return true;
  if (!nativeToolUseProviderEnabled(provider)) return false;
  const m = model.trim().toLowerCase();
  if (TOOL_INCAPABLE_MODEL_PREFIXES.some((p) => m.startsWith(p))) return false;
  // Known-capable (TOOL_CAPABLE_MODEL_PREFIXES) or unknown → attempt native.
  // Unknown models are treated optimistically on purpose: the runtime
  // 400-"tool" ToolsUnsupportedError catch downgrades them gracefully.
  return true;
}

/** Default base URLs. ANTHROPIC + GOOGLE use SDK / dedicated REST and have
 * no chat-completions URL here. Local providers default to localhost. */
export const PROVIDER_BASE_URLS: Record<Exclude<AIProviderType, "ANTHROPIC" | "GOOGLE">, string> = {
  OPENAI:     "https://api.openai.com/v1",
  MISTRAL:    "https://api.mistral.ai/v1",
  GROQ:       "https://api.groq.com/openai/v1",
  OPENROUTER: "https://openrouter.ai/api/v1",
  DEEPSEEK:   "https://api.deepseek.com/v1",
  KIMI:       "https://api.moonshot.ai/v1",       // International endpoint; mainland: api.moonshot.cn/v1
  QWEN:       "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",  // Alibaba DashScope OpenAI-compatible
  CEREBRAS:   "https://api.cerebras.ai/v1",              // OpenAI-compatible; free tier ~1M tok/day
  ZHIPU:      "https://api.z.ai/api/paas/v4",            // Z.ai GLM; OpenAI-compatible, Flash tiers free
  OLLAMA:     "http://localhost:11434/v1",
  LMSTUDIO:   "http://localhost:1234/v1",
  CUSTOM:     "",  // user must supply
};

/** Human-friendly provider summary used by /docs and the Settings UI. */
export const PROVIDER_INFO: Record<AIProviderType, {
  label: string;
  cost: "free" | "byok-cloud" | "byok-local";
  privacy: "cloud" | "local";
  setupHint: string;
}> = {
  ANTHROPIC:  { label: "Anthropic Claude", cost: "byok-cloud", privacy: "cloud", setupHint: "Get key at console.anthropic.com" },
  OPENAI:     { label: "OpenAI (GPT-4o, o1)", cost: "byok-cloud", privacy: "cloud", setupHint: "Get key at platform.openai.com" },
  GOOGLE:     { label: "Google Gemini",     cost: "byok-cloud", privacy: "cloud", setupHint: "Get key at aistudio.google.com" },
  MISTRAL:    { label: "Mistral",           cost: "byok-cloud", privacy: "cloud", setupHint: "Get key at console.mistral.ai" },
  GROQ:       { label: "Groq (fast Llama)", cost: "byok-cloud", privacy: "cloud", setupHint: "Get key at console.groq.com — fastest cloud inference" },
  OPENROUTER: { label: "OpenRouter (any model)", cost: "byok-cloud", privacy: "cloud", setupHint: "openrouter.ai — single key, 100+ models" },
  DEEPSEEK:   { label: "DeepSeek (Chat / R1 reasoner)", cost: "byok-cloud", privacy: "cloud", setupHint: "Get key at platform.deepseek.com — strong reasoning at low $/M tokens" },
  KIMI:       { label: "Kimi by Moonshot",  cost: "byok-cloud", privacy: "cloud", setupHint: "Get key at platform.moonshot.ai — 128k context, OpenAI-compatible" },
  QWEN:       { label: "Qwen by Alibaba",   cost: "byok-cloud", privacy: "cloud", setupHint: "Get key at modelstudio.console.alibabacloud.com (DashScope) — strong on multilingual + Chinese" },
  CEREBRAS:   { label: "Cerebras (fast, free tier)", cost: "byok-cloud", privacy: "cloud", setupHint: "Get key at cloud.cerebras.ai — free ~1M tokens/day (8k context); gpt-oss-120b + GLM-4.7" },
  ZHIPU:      { label: "Zhipu GLM (free Flash)", cost: "byok-cloud", privacy: "cloud", setupHint: "Get key at z.ai — GLM-4.x-Flash permanently free (text + vision); GLM-4.7/4.6 paid; OpenAI-compatible" },
  OLLAMA:     { label: "Ollama (local Gemma)",   cost: "free",       privacy: "local", setupHint: "Install ollama.com → run `ollama pull gemma3:4b` → set base URL to http://localhost:11434/v1" },
  LMSTUDIO:   { label: "LM Studio (local)",      cost: "free",       privacy: "local", setupHint: "Install lmstudio.ai → load Gemma 3 4B → start server → use http://localhost:1234/v1" },
  CUSTOM:     { label: "Custom OpenAI-compatible", cost: "byok-local", privacy: "local", setupHint: "Any OpenAI-compatible endpoint (LiteLLM, vLLM, Together, etc)" },
};

// ─── Normalized transcript projections (E2/T3) ────────────
//
// The agent loop keeps ONE canonical transcript (ChatMessage[]) and projects
// it one-way into each provider's wire format at call time — including
// Anthropic (plan §2.2 / A8 canonical-transcript ruling). One-way projection
// is what makes turn-boundary failover possible without bidirectional
// converters. Exported so the T4 unified loop reuses the same projections.

function safeParseArgs(argumentsJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(argumentsJson);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** OpenAI function-calling: normalized tools → `tools:[{type:"function",…}]`. */
export function toOpenAITools(tools: ChatToolDef[]): Array<Record<string, unknown>> {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

/** OpenAI function-calling: canonical transcript → Chat Completions messages.
 * Plain user/assistant messages keep the exact legacy `{role,content}` shape
 * (wire format unchanged for existing callers). */
export function toOpenAIMessages(
  systemPrompt: string,
  messages: ChatMessage[],
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [{ role: "system", content: systemPrompt }];
  for (const m of messages) {
    if (m.role === "system") continue; // system prompt travels separately
    if (m.role === "tool") {
      out.push({ role: "tool", tool_call_id: m.toolCallId ?? "", content: m.content });
    } else if (m.role === "assistant" && m.toolCalls?.length) {
      out.push({
        role: "assistant",
        // OpenAI allows null content alongside tool_calls; an empty string
        // trips some stricter shims, so normalize "" → null.
        content: m.content || null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.argumentsJson },
        })),
      });
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}

function normalizeOpenAIToolCalls(raw: unknown): ChatToolCall[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((tc: any) => tc && typeof tc === "object" && tc.function)
    .map((tc: any, i: number) => ({
      // Some local shims (Ollama) omit ids — synthesize a stable one.
      id: typeof tc.id === "string" && tc.id ? tc.id : `call_${i}`,
      name: String(tc.function?.name ?? ""),
      // Spec says `arguments` is a JSON string; a few providers hand back
      // an object — normalize both to a JSON string.
      argumentsJson:
        typeof tc.function?.arguments === "string"
          ? tc.function.arguments
          : JSON.stringify(tc.function?.arguments ?? {}),
    }))
    .filter((tc) => tc.name !== "");
}

function normalizeOpenAIFinishReason(reason: unknown): ChatStopReason {
  switch (reason) {
    case "stop": return "stop";
    case "tool_calls":
    case "function_call": return "tool_calls";
    case "length": return "length";
    default: return "unknown";
  }
}

/** Gemini: normalized tools → `tools:[{functionDeclarations}]`. */
export function toGeminiTools(tools: ChatToolDef[]): Array<Record<string, unknown>> {
  return [{
    functionDeclarations: tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    })),
  }];
}

/** Gemini: canonical transcript → `contents` with functionCall /
 * functionResponse parts. Gemini has no tool-call ids — functionResponse
 * needs the function NAME, resolved from the assistant turn that requested
 * the call (toolCallId → name lookup). */
export function toGeminiContents(messages: ChatMessage[]): Array<Record<string, unknown>> {
  const idToName = new Map<string, string>();
  const contents: Array<Record<string, unknown>> = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "assistant") {
      const parts: Array<Record<string, unknown>> = [];
      if (m.content) parts.push({ text: m.content });
      for (const tc of m.toolCalls ?? []) {
        idToName.set(tc.id, tc.name);
        parts.push({ functionCall: { name: tc.name, args: safeParseArgs(tc.argumentsJson) } });
      }
      if (parts.length === 0) parts.push({ text: "" });
      contents.push({ role: "model", parts });
    } else if (m.role === "tool") {
      const name = (m.toolCallId && idToName.get(m.toolCallId)) || "unknown_function";
      let response: Record<string, unknown>;
      try {
        const parsed = JSON.parse(m.content);
        response =
          parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : { result: m.content };
      } catch {
        response = { result: m.content };
      }
      contents.push({ role: "user", parts: [{ functionResponse: { name, response } }] });
    } else {
      // Same steering-after-tool-results case as the Anthropic projection:
      // fold a plain user turn into a directly preceding user content so
      // roles keep alternating (E2/T4 unified loop).
      const last = contents[contents.length - 1];
      if (last && last.role === "user" && Array.isArray(last.parts)) {
        (last.parts as Array<Record<string, unknown>>).push({ text: m.content });
      } else {
        contents.push({ role: "user", parts: [{ text: m.content }] });
      }
    }
  }
  return contents;
}

/** Anthropic: normalized tools → SDK Tool[] (`input_schema`). Same source
 * of truth as buildAnthropicTools (claude.ts) — the registry JSON Schema. */
export function toAnthropicTools(tools: ChatToolDef[]): Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as Tool["input_schema"],
  }));
}

/** Anthropic: canonical transcript → MessageParam[]. Assistant toolCalls
 * become tool_use blocks; consecutive role:"tool" results merge into ONE
 * user message of tool_result blocks (the API expects alternating roles). */
export function toAnthropicMessages(messages: ChatMessage[]): MessageParam[] {
  const out: MessageParam[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "tool") {
      const block = {
        type: "tool_result" as const,
        tool_use_id: m.toolCallId ?? "",
        content: m.content,
      };
      const last = out[out.length - 1];
      if (
        last &&
        last.role === "user" &&
        Array.isArray(last.content) &&
        last.content.every((b) => (b as { type?: string }).type === "tool_result")
      ) {
        (last.content as Array<typeof block>).push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
    } else if (m.role === "assistant" && m.toolCalls?.length) {
      const blocks: Array<Record<string, unknown>> = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const tc of m.toolCalls) {
        blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: safeParseArgs(tc.argumentsJson) });
      }
      out.push({ role: "assistant", content: blocks as unknown as MessageParam["content"] });
    } else {
      // Merge a plain user turn into a directly preceding user message
      // (tool_result batch or plain text). Keeps the strict user/assistant
      // alternation valid when the agent loop injects steering text right
      // after tool results (E2/T4 unified loop).
      const last = out[out.length - 1];
      if (m.role === "user" && last && last.role === "user") {
        if (typeof last.content === "string") {
          last.content = `${last.content}\n\n${m.content}`;
        } else if (Array.isArray(last.content)) {
          (last.content as unknown as Array<Record<string, unknown>>).push({ type: "text", text: m.content });
        } else {
          out.push({ role: m.role, content: m.content });
        }
      } else {
        out.push({ role: m.role, content: m.content });
      }
    }
  }
  return out;
}

function normalizeAnthropicStopReason(reason: string | null): ChatStopReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence": return "stop";
    case "tool_use": return "tool_calls";
    case "max_tokens": return "length";
    default: return "unknown";
  }
}

// ─── Anthropic implementation ─────────────────────────────

async function callAnthropic(
  config: AIClientConfig,
  systemPrompt: string,
  messages: MessageParam[],
  maxTokens: number,
  tools?: ChatToolDef[],
): Promise<ChatCompletionResult> {
  const client = new Anthropic({ apiKey: config.apiKey });
  const response = await client.messages.create({
    model: config.model,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages,
    ...(tools?.length ? { tools: toAnthropicTools(tools) } : {}),
  });

  const content = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  const toolCalls: ChatToolCall[] = response.content
    .filter((b) => b.type === "tool_use")
    .map((b) => ({
      id: b.id,
      name: b.name,
      argumentsJson: JSON.stringify(b.input ?? {}),
    }));

  return {
    content,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    // Report the model the API actually answered with (handles server-side
    // downgrades / tier overrides) — pricing consumers depend on it.
    model: response.model ?? config.model,
    provider: "ANTHROPIC",
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    stopReason:
      toolCalls.length > 0 ? "tool_calls" : normalizeAnthropicStopReason(response.stop_reason),
    ...(tools?.length ? { toolUseMode: "native" as const } : {}),
  };
}

// ─── OpenAI-compatible implementation (OpenAI, Groq, Mistral, OpenRouter) ──

async function callOpenAICompatible(
  config: AIClientConfig,
  systemPrompt: string,
  messages: ChatMessage[],
  maxTokens: number,
  tools?: ChatToolDef[],
): Promise<ChatCompletionResult> {
  // Resolve base URL: tenant-supplied override (Settings → AI Provider →
  // Custom base URL) wins over the per-provider hardcoded default. This
  // is what makes OLLAMA / LMSTUDIO / CUSTOM work — those providers don't
  // talk to a SaaS endpoint, they hit whatever URL the user pointed at.
  const defaultUrl = PROVIDER_BASE_URLS[config.provider as keyof typeof PROVIDER_BASE_URLS];
  const baseUrl = (config.baseUrl?.trim() || defaultUrl || "").replace(/\/+$/, "");
  if (!baseUrl) {
    throw new Error(
      `${config.provider} requires a base URL. Set it in Settings → AI Provider.`,
    );
  }

  // SSRF guard for tenant-controlled URLs. Local-first providers
  // (OLLAMA / LMSTUDIO / CUSTOM) and their default loopback URLs are
  // the whole point of those routes, so we permit loopback + private
  // ranges for them. Cloud providers' hardcoded SaaS URLs go through
  // the same check defensively (in case the user overrides them) but
  // with the strict policy — no loopback, no private network. Cloud
  // metadata IPs are refused for every provider, no exception.
  const isLocalProvider = LOCAL_PROVIDERS.has(config.provider);
  // Self-hosted deployments may legitimately point CUSTOM at an internal
  // VPC LLM (e.g. on-prem vLLM behind a private subnet). The OFFLINE_MODE
  // env knob signals an air-gapped deployment, and `allowPrivateNetworks`
  // tracks that. Anyone running the SaaS production deployment has
  // OFFLINE_MODE=false, so private ranges stay blocked there.
  try {
    await assertSafeExternalUrl(baseUrl, {
      allowLoopback: isLocalProvider,
      allowPrivateNetworks: isLocalProvider || env.OFFLINE_MODE,
    });
  } catch (err) {
    if (err instanceof SsrfError) {
      throw new Error(
        `Refusing to call ${config.provider} at ${baseUrl}: ${err.message}. ` +
          "Cloud-metadata, loopback, and private-network endpoints are blocked.",
      );
    }
    throw err;
  }

  const requestMessages = toOpenAIMessages(systemPrompt, messages);

  // o-series reasoning models (o1 / o3 …) reject `max_tokens` — they take
  // `max_completion_tokens` instead. OpenAI-only quirk; every other
  // compatible provider still expects `max_tokens`.
  const usesCompletionTokensParam =
    config.provider === "OPENAI" && /^o\d/.test(config.model.trim());

  const requestBody: Record<string, unknown> = {
    model: config.model,
    messages: requestMessages,
    ...(usesCompletionTokensParam
      ? { max_completion_tokens: maxTokens }
      : { max_tokens: maxTokens }),
  };
  if (tools?.length) {
    requestBody.tools = toOpenAITools(tools);
    requestBody.tool_choice = "auto";
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  // Local providers (Ollama, LM Studio) often run without auth — only
  // attach Authorization if the user supplied a key. Cloud providers
  // (OpenAI / Mistral / Groq / OpenRouter / Custom-cloud) require it
  // and the API call will fail with 401 if missing — that's fine.
  if (config.apiKey) {
    headers["Authorization"] = `Bearer ${config.apiKey}`;
  }

  // OpenRouter requires additional attribution headers — referer must be
  // the real brand domain, consistent with X-Title (D-003).
  if (config.provider === "OPENROUTER") {
    headers["HTTP-Referer"] = "https://braavolabs.com";
    headers["X-Title"] = "Braavolabs";
  }

  // Local providers can be slow on the first request (model load into
  // RAM) — give them a generous timeout. Cloud providers should respond
  // in <60s; if they don't something else is wrong.
  const timeoutMs = LOCAL_PROVIDERS.has(config.provider) ? 240_000 : 60_000;

  // Rate limits are a fact of life on shared/free tiers (the Groq trial
  // pool's tokens-per-minute window in particular) — a single 429 must
  // not fail a whole run step. Retry 429 + transient 5xx with backoff,
  // honoring Retry-After when the provider sends one. Local providers
  // don't rate-limit; they keep the single-shot path.
  const maxAttempts = LOCAL_PROVIDERS.has(config.provider) ? 1 : 3;
  let response!: Response;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(
          `${config.provider} timeout after ${timeoutMs / 1000}s. ` +
            (LOCAL_PROVIDERS.has(config.provider)
              ? "Local model may need to load — increase timeout or pre-warm with a small request."
              : "Provider unreachable."),
        );
      }
      if (LOCAL_PROVIDERS.has(config.provider)) {
        const e = err instanceof Error ? err.message : String(err);
        throw new Error(
          `${config.provider} unreachable at ${baseUrl}: ${e}. ` +
            "Verify the local server is running (e.g. `ollama serve`) and reachable from this machine.",
        );
      }
      throw err;
    }
    clearTimeout(timer);

    const retryable =
      response.status === 429 ||
      response.status === 502 ||
      response.status === 503 ||
      response.status === 529;
    if (response.ok || !retryable || attempt === maxAttempts) break;

    // Prefer the provider's own Retry-After (seconds); else back off
    // 20s → 40s, which spans a fresh tokens-per-minute window.
    const retryAfterRaw = Number(response.headers.get("retry-after"));
    const waitMs =
      Number.isFinite(retryAfterRaw) && retryAfterRaw > 0
        ? Math.min(retryAfterRaw * 1000 + 1000, 65_000)
        : attempt * 20_000;
    await response.text().catch(() => undefined); // drain before retry
    await new Promise((r) => setTimeout(r, waitMs));
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => "unknown error");
    // A 400 that mentions tools/functions while we sent a `tools` payload
    // means the MODEL cannot do native function-calling (gemma3,
    // deepseek-reasoner, …) — signal the caller to downgrade to
    // prompt-embedding instead of failing the run (plan §2.1).
    if (tools?.length && response.status === 400 && /tool|function/i.test(errorText)) {
      throw new ToolsUnsupportedError(config.provider, config.model, errorText.slice(0, 300));
    }
    throw new Error(`${config.provider} API error ${response.status}: ${errorText.slice(0, 300)}`);
  }

  const data = await response.json() as any;
  const choice = data.choices?.[0] ?? {};
  const message = choice.message ?? {};
  // `content` is null when the model answers with tool calls only.
  const content = typeof message.content === "string" ? message.content : "";
  const usage = data.usage ?? {};
  const toolCalls = normalizeOpenAIToolCalls(message.tool_calls);

  return {
    content,
    // Ollama returns prompt_eval_count / eval_count in /api/chat but the
    // /v1/chat/completions OpenAI-shim populates prompt_tokens /
    // completion_tokens. Some local servers omit usage entirely → 0.
    inputTokens: usage.prompt_tokens ?? usage.prompt_eval_count ?? 0,
    outputTokens: usage.completion_tokens ?? usage.eval_count ?? 0,
    model: config.model,
    provider: config.provider,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    // Some shims report finish_reason:"stop" even when tool_calls are
    // present — the presence of tool calls wins.
    stopReason:
      toolCalls.length > 0
        ? "tool_calls"
        : normalizeOpenAIFinishReason(choice.finish_reason),
    ...(tools?.length ? { toolUseMode: "native" as const } : {}),
  };
}

// ─── Google Gemini implementation ─────────────────────────

async function callGoogle(
  config: AIClientConfig,
  systemPrompt: string,
  messages: ChatMessage[],
  maxTokens: number,
  tools?: ChatToolDef[],
): Promise<ChatCompletionResult> {
  // Convert canonical transcript to Gemini format (functionCall /
  // functionResponse parts included — see toGeminiContents).
  const contents = toGeminiContents(messages);

  // API key travels in the x-goog-api-key header — NOT the URL query
  // string, which leaks into access logs and proxies (D-001).
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": config.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents,
        generationConfig: { maxOutputTokens: maxTokens },
        ...(tools?.length ? { tools: toGeminiTools(tools) } : {}),
      }),
    },
  );

  if (!response.ok) {
    const errorText = await response.text().catch(() => "unknown error");
    if (tools?.length && response.status === 400 && /tool|function/i.test(errorText)) {
      throw new ToolsUnsupportedError("GOOGLE", config.model, errorText.slice(0, 300));
    }
    throw new Error(`Google Gemini API error ${response.status}: ${errorText.slice(0, 300)}`);
  }

  const data = await response.json() as any;
  const candidate = data.candidates?.[0] ?? {};
  const parts: any[] = Array.isArray(candidate.content?.parts) ? candidate.content.parts : [];
  const content = parts
    .filter((p) => typeof p?.text === "string")
    .map((p) => p.text)
    .join("");
  const usage = data.usageMetadata ?? {};

  // Gemini has no tool-call ids — synthesize stable ones so the canonical
  // transcript (and the tool-result round trip) can reference them.
  const toolCalls: ChatToolCall[] = parts
    .filter((p) => p?.functionCall && typeof p.functionCall.name === "string")
    .map((p, i) => ({
      id: `gemini_call_${i}`,
      name: p.functionCall.name as string,
      argumentsJson: JSON.stringify(p.functionCall.args ?? {}),
    }));

  return {
    content,
    inputTokens: usage.promptTokenCount ?? 0,
    outputTokens: usage.candidatesTokenCount ?? 0,
    model: config.model,
    provider: "GOOGLE",
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    stopReason:
      toolCalls.length > 0
        ? "tool_calls"
        : candidate.finishReason === "STOP"
          ? "stop"
          : candidate.finishReason === "MAX_TOKENS"
            ? "length"
            : "unknown",
    ...(tools?.length ? { toolUseMode: "native" as const } : {}),
  };
}

// ─── Public interface ─────────────────────────────────────

/**
 * Unified chat completion — handles all supported providers.
 * Pass `messages` as plain ChatMessage[] (role + content strings; assistant
 * turns may carry `toolCalls`, tool results travel as role:"tool").
 * For Anthropic, the system prompt is sent separately.
 *
 * Tool use (E2/T3): pass `options.tools` to enable NATIVE function-calling.
 * The normalized ChatToolDef list is translated per provider (OpenAI
 * `tools/function`, Gemini `functionDeclarations`, Anthropic `input_schema`)
 * and the response is normalized back into `result.toolCalls`. Throws
 * ToolsUnsupportedError (pre-flight or on the provider's 400) when the
 * model can't do native tools — callers downgrade to prompt-embedding.
 */
export async function chatCompletion(
  config: AIClientConfig,
  systemPrompt: string,
  messages: ChatMessage[],
  maxTokens = 4096,
  options: ChatCompletionOptions = {},
): Promise<ChatCompletionResult> {
  const tools = options.tools?.length ? options.tools : undefined;
  logger.debug(
    { provider: config.provider, model: config.model, toolCount: tools?.length ?? 0 },
    "AI chat completion",
  );

  // Pre-flight capability gate (cheap): known-incapable models and
  // kill-switched providers never reach the wire with a `tools` payload.
  if (tools && !supportsNativeToolUse(config.provider, config.model)) {
    throw new ToolsUnsupportedError(
      config.provider,
      config.model,
      "blocked pre-flight (TOOL_INCAPABLE_MODEL_PREFIXES or NATIVE_TOOLUSE_PROVIDERS kill-switch)",
    );
  }

  // Air-gapped / offline mode: only LOCAL_PROVIDERS (Ollama, LM Studio,
  // Custom-with-localhost) are allowed. Cloud providers leak data and
  // need DNS that an air-gapped deployment doesn't have. Operators set
  // OFFLINE_MODE=true in env when running on segregated networks.
  if (envOfflineMode() && !LOCAL_PROVIDERS.has(config.provider)) {
    throw new Error(
      `OFFLINE_MODE blocks cloud LLM provider "${config.provider}". Switch the tenant to OLLAMA / LMSTUDIO / CUSTOM with a local base URL.`,
    );
  }

  switch (config.provider) {
    case "ANTHROPIC": {
      // Canonical transcript → Anthropic MessageParam[] projection
      // (tool_use / tool_result blocks included — plan §2.2 / A8).
      return callAnthropic(config, systemPrompt, toAnthropicMessages(messages), maxTokens, tools);
    }

    case "GOOGLE":
      return callGoogle(config, systemPrompt, messages.filter((m) => m.role !== "system"), maxTokens, tools);

    case "OPENAI":
    case "MISTRAL":
    case "GROQ":
    case "OPENROUTER":
    case "DEEPSEEK":
    case "KIMI":
    case "QWEN":
    case "CEREBRAS":
    case "ZHIPU":
    // Local-first / self-hosted — same OpenAI Chat Completions wire format,
    // user-supplied baseUrl resolves to localhost or any LiteLLM-style
    // proxy. apiKey is optional (Ollama default = no auth).
    case "OLLAMA":
    case "LMSTUDIO":
    case "CUSTOM":
      return callOpenAICompatible(config, systemPrompt, messages.filter((m) => m.role !== "system"), maxTokens, tools);

    default:
      throw new Error(`Unsupported AI provider: ${config.provider}`);
  }
}

// ─── Tenant config helpers ────────────────────────────────

import { prisma } from "../lib/db";

/** Lazy accessor so tests can mock env without re-importing. */
function envOfflineMode(): boolean {
  return env.OFFLINE_MODE === true;
}

/**
 * Load the AI config for a tenant, falling back to system defaults.
 * Returns a ready-to-use AIClientConfig with decrypted API key.
 *
 * Multi-key BYOK (E2/T6): a tenant now keeps one UserAIConfig row per
 * provider; this resolves to the DEFAULT row (isDefault=true). The
 * createdAt tiebreaker keeps legacy single-row tenants deterministic even
 * if a row somehow lost its default flag. Walking the OTHER rows as a
 * failover chain is T7's job — this function stays single-row semantics.
 */
export async function getTenantAIConfig(tenantId: string): Promise<AIClientConfig> {
  const aiConfig = await prisma.userAIConfig.findFirst({
    where: { tenantId },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
  });

  if (aiConfig) {
    const provider = aiConfig.provider as AIProviderType;
    const isLocal = LOCAL_PROVIDERS.has(provider);
    // Local providers don't need an API key (Ollama default = no auth).
    // Cloud providers do; fall through to the system default if missing.
    if (isLocal || aiConfig.encryptedApiKey) {
      let apiKey = "";
      let decryptFailed = false;
      if (aiConfig.encryptedApiKey) {
        try {
          apiKey = decryptForTenant(aiConfig.encryptedApiKey, tenantId);
        } catch (err) {
          decryptFailed = true;
          logger.warn({ tenantId, err }, "Failed to decrypt tenant AI key — proceeding without it (local provider) or falling back to system default");
        }
      }
      // A cloud provider with a corrupted/undecryptable key cannot work —
      // sending apiKey:"" just yields a 401 from the provider (D-002).
      // Skip the return and fall through to the system default below.
      // Local providers legitimately run keyless, so they keep their config.
      if (isLocal || !decryptFailed) {
        return {
          provider,
          model: aiConfig.model,
          apiKey,
          // Tenant-supplied custom base URL (Settings UI). Empty → adapter
          // falls back to PROVIDER_BASE_URLS default (e.g. localhost:11434
          // for Ollama). Trim to avoid trailing-slash double-slash issues.
          baseUrl: aiConfig.baseUrl?.trim() || undefined,
        };
      }
    }
  }

  // Fall back to system Anthropic key
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error("No AI provider configured. Please add an API key in Settings → AI Provider.");
  }

  return {
    provider: "ANTHROPIC",
    model: env.CLAUDE_MODEL,
    apiKey: env.ANTHROPIC_API_KEY,
  };
}

/** Encrypt and save tenant AI config. baseUrl is optional and only set
 * when present (used by OLLAMA / LMSTUDIO / CUSTOM, plus rare cases like
 * Azure-OpenAI proxies). apiKey is optional for local providers.
 *
 * Multi-key BYOK (E2/T6): upserts the (tenant, provider) row and promotes
 * it to the tenant's DEFAULT config — preserving the legacy contract of
 * PUT /settings/ai-config ("this is now my active provider"). Sibling
 * rows are demoted first inside the same transaction so the partial
 * unique index (one default per tenant) can never fire; the demoted rows
 * keep their encrypted keys and remain available as failover links (T7).
 */
export async function saveTenantAIConfig(
  tenantId: string,
  provider: AIProviderType,
  model: string,
  apiKey: string,
  baseUrl?: string,
  // E2/T7 — opt-in escape hatch (plan §2.2): may the run chain fall back to
  // trial/system providers once the tenant's own links are exhausted?
  // Evaluated from the DEFAULT row (this row becomes the default below).
  // undefined = leave the stored value untouched (default false in schema).
  allowSystemFallback?: boolean,
): Promise<void> {
  const encryptedApiKey = apiKey ? encryptForTenant(apiKey, tenantId) : null;
  const trimmedBaseUrl = baseUrl?.trim() || null;
  const fallbackPatch =
    allowSystemFallback === undefined ? {} : { allowSystemFallback };

  await prisma.$transaction([
    // Demote-then-promote: order matters — the one-default-per-tenant
    // partial unique index is checked per statement (non-deferrable).
    prisma.userAIConfig.updateMany({
      where: { tenantId, NOT: { provider }, isDefault: true },
      data: { isDefault: false },
    }),
    prisma.userAIConfig.upsert({
      where: { tenantId_provider: { tenantId, provider } },
      update: { model, encryptedApiKey, baseUrl: trimmedBaseUrl, isDefault: true, ...fallbackPatch },
      create: { tenantId, provider, model, encryptedApiKey, baseUrl: trimmedBaseUrl, isDefault: true, ...fallbackPatch },
    }),
  ]);
}
