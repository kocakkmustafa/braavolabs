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
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
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

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface ChatCompletionResult {
  content: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
  provider: AIProviderType;
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
  OLLAMA:     ["gemma3:4b", "gemma3:12b", "gemma3:27b", "llama3.2:3b", "llama3.3:70b", "qwen2.5:14b", "qwen2.5-coder:14b", "deepseek-r1:8b", "phi3:14b"],
  LMSTUDIO:   ["google/gemma-3-4b-it", "google/gemma-3-12b-it", "meta-llama/llama-3.2-3b-instruct", "qwen/qwen2.5-14b-instruct"],
  CUSTOM:     [],
};

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
  OLLAMA:     { label: "Ollama (local Gemma)",   cost: "free",       privacy: "local", setupHint: "Install ollama.com → run `ollama pull gemma3:4b` → set base URL to http://localhost:11434/v1" },
  LMSTUDIO:   { label: "LM Studio (local)",      cost: "free",       privacy: "local", setupHint: "Install lmstudio.ai → load Gemma 3 4B → start server → use http://localhost:1234/v1" },
  CUSTOM:     { label: "Custom OpenAI-compatible", cost: "byok-local", privacy: "local", setupHint: "Any OpenAI-compatible endpoint (LiteLLM, vLLM, Together, etc)" },
};

// ─── Anthropic implementation ─────────────────────────────

async function callAnthropic(
  config: AIClientConfig,
  systemPrompt: string,
  messages: MessageParam[],
  maxTokens: number,
): Promise<ChatCompletionResult> {
  const client = new Anthropic({ apiKey: config.apiKey });
  const response = await client.messages.create({
    model: config.model,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages,
  });

  const content = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  return {
    content,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    model: config.model,
    provider: "ANTHROPIC",
  };
}

// ─── OpenAI-compatible implementation (OpenAI, Groq, Mistral, OpenRouter) ──

async function callOpenAICompatible(
  config: AIClientConfig,
  systemPrompt: string,
  messages: ChatMessage[],
  maxTokens: number,
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

  const requestMessages = [
    { role: "system", content: systemPrompt },
    ...messages,
  ];

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

  // OpenRouter requires additional headers
  if (config.provider === "OPENROUTER") {
    headers["HTTP-Referer"] = "https://ai-company-os.app";
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
        body: JSON.stringify({
          model: config.model,
          messages: requestMessages,
          max_tokens: maxTokens,
        }),
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
    throw new Error(`${config.provider} API error ${response.status}: ${errorText.slice(0, 300)}`);
  }

  const data = await response.json() as any;
  const content = data.choices?.[0]?.message?.content ?? "";
  const usage = data.usage ?? {};

  return {
    content,
    // Ollama returns prompt_eval_count / eval_count in /api/chat but the
    // /v1/chat/completions OpenAI-shim populates prompt_tokens /
    // completion_tokens. Some local servers omit usage entirely → 0.
    inputTokens: usage.prompt_tokens ?? usage.prompt_eval_count ?? 0,
    outputTokens: usage.completion_tokens ?? usage.eval_count ?? 0,
    model: config.model,
    provider: config.provider,
  };
}

// ─── Google Gemini implementation ─────────────────────────

async function callGoogle(
  config: AIClientConfig,
  systemPrompt: string,
  messages: ChatMessage[],
  maxTokens: number,
): Promise<ChatCompletionResult> {
  // Convert to Gemini format
  const contents = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent?key=${config.apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents,
        generationConfig: { maxOutputTokens: maxTokens },
      }),
    },
  );

  if (!response.ok) {
    const errorText = await response.text().catch(() => "unknown error");
    throw new Error(`Google Gemini API error ${response.status}: ${errorText.slice(0, 300)}`);
  }

  const data = await response.json() as any;
  const content = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  const usage = data.usageMetadata ?? {};

  return {
    content,
    inputTokens: usage.promptTokenCount ?? 0,
    outputTokens: usage.candidatesTokenCount ?? 0,
    model: config.model,
    provider: "GOOGLE",
  };
}

// ─── Public interface ─────────────────────────────────────

/**
 * Unified chat completion — handles all supported providers.
 * Pass `messages` as plain ChatMessage[] (role + content strings).
 * For Anthropic, the system prompt is sent separately.
 */
export async function chatCompletion(
  config: AIClientConfig,
  systemPrompt: string,
  messages: ChatMessage[],
  maxTokens = 4096,
): Promise<ChatCompletionResult> {
  logger.debug({ provider: config.provider, model: config.model }, "AI chat completion");

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
      // Convert ChatMessage[] to Anthropic MessageParam[]
      const anthropicMessages: MessageParam[] = messages
        .filter((m) => m.role !== "system")
        .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
      return callAnthropic(config, systemPrompt, anthropicMessages, maxTokens);
    }

    case "GOOGLE":
      return callGoogle(config, systemPrompt, messages.filter((m) => m.role !== "system"), maxTokens);

    case "OPENAI":
    case "MISTRAL":
    case "GROQ":
    case "OPENROUTER":
    case "DEEPSEEK":
    case "KIMI":
    case "QWEN":
    // Local-first / self-hosted — same OpenAI Chat Completions wire format,
    // user-supplied baseUrl resolves to localhost or any LiteLLM-style
    // proxy. apiKey is optional (Ollama default = no auth).
    case "OLLAMA":
    case "LMSTUDIO":
    case "CUSTOM":
      return callOpenAICompatible(config, systemPrompt, messages.filter((m) => m.role !== "system"), maxTokens);

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
 */
export async function getTenantAIConfig(tenantId: string): Promise<AIClientConfig> {
  const aiConfig = await prisma.userAIConfig.findUnique({
    where: { tenantId },
  });

  if (aiConfig) {
    const provider = aiConfig.provider as AIProviderType;
    const isLocal = LOCAL_PROVIDERS.has(provider);
    // Local providers don't need an API key (Ollama default = no auth).
    // Cloud providers do; fall through to the system default if missing.
    if (isLocal || aiConfig.encryptedApiKey) {
      let apiKey = "";
      if (aiConfig.encryptedApiKey) {
        try {
          apiKey = decryptForTenant(aiConfig.encryptedApiKey, tenantId);
        } catch (err) {
          logger.warn({ tenantId, err }, "Failed to decrypt tenant AI key — proceeding without it (local provider) or falling back to system default");
          if (!isLocal) {
            // Cloud provider with corrupted key → fall through.
            // (Behavior unchanged from pre-2026-04-28.)
            // … fall through past this if block.
          }
        }
      }
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
 * Azure-OpenAI proxies). apiKey is optional for local providers. */
export async function saveTenantAIConfig(
  tenantId: string,
  provider: AIProviderType,
  model: string,
  apiKey: string,
  baseUrl?: string,
): Promise<void> {
  const encryptedApiKey = apiKey ? encryptForTenant(apiKey, tenantId) : null;
  const trimmedBaseUrl = baseUrl?.trim() || null;

  await prisma.userAIConfig.upsert({
    where: { tenantId },
    update: { provider, model, encryptedApiKey, baseUrl: trimmedBaseUrl },
    create: { tenantId, provider, model, encryptedApiKey, baseUrl: trimmedBaseUrl },
  });
}
