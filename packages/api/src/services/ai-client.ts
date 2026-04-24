/**
 * Unified AI Client — routes to the correct provider based on tenant config.
 *
 * Supported providers:
 *   ANTHROPIC   — @anthropic-ai/sdk (already installed)
 *   OPENAI      — fetch → api.openai.com (Chat Completions)
 *   GOOGLE      — fetch → generativelanguage.googleapis.com (Gemini)
 *   MISTRAL     — fetch → api.mistral.ai (OpenAI-compatible)
 *   GROQ        — fetch → api.groq.com (OpenAI-compatible)
 *   OPENROUTER  — fetch → openrouter.ai (OpenAI-compatible)
 */

import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { logger } from "../lib/logger";
import { encrypt, decrypt } from "../lib/encryption";

// ─── Types ────────────────────────────────────────────────

export type AIProviderType = "ANTHROPIC" | "OPENAI" | "GOOGLE" | "MISTRAL" | "GROQ" | "OPENROUTER";

export interface AIClientConfig {
  provider: AIProviderType;
  model: string;
  /** Plaintext API key (decrypt before passing in) */
  apiKey: string;
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
};

// Valid Anthropic model IDs as of 2026-04. Invalid IDs like
// "claude-opus-4-6" and "claude-sonnet-4-6" removed (they return 400 from API).
export const PROVIDER_MODELS: Record<AIProviderType, string[]> = {
  ANTHROPIC:  ["claude-opus-4-20250514", "claude-sonnet-4-5-20250929", "claude-sonnet-4-20250514", "claude-haiku-4-5-20251001"],
  OPENAI:     ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "o1", "o1-mini"],
  GOOGLE:     ["gemini-1.5-pro", "gemini-1.5-flash", "gemini-pro"],
  MISTRAL:    ["mistral-large-latest", "mistral-medium-latest", "mistral-small-latest", "open-mistral-7b"],
  GROQ:       ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "mixtral-8x7b-32768"],
  OPENROUTER: ["openai/gpt-4o", "anthropic/claude-sonnet-4-5", "meta-llama/llama-3.3-70b-instruct", "google/gemini-pro-1.5"],
};

export const PROVIDER_BASE_URLS: Record<Exclude<AIProviderType, "ANTHROPIC" | "GOOGLE">, string> = {
  OPENAI:     "https://api.openai.com/v1",
  MISTRAL:    "https://api.mistral.ai/v1",
  GROQ:       "https://api.groq.com/openai/v1",
  OPENROUTER: "https://openrouter.ai/api/v1",
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
  const baseUrl = PROVIDER_BASE_URLS[config.provider as keyof typeof PROVIDER_BASE_URLS];

  const requestMessages = [
    { role: "system", content: systemPrompt },
    ...messages,
  ];

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${config.apiKey}`,
  };

  // OpenRouter requires additional headers
  if (config.provider === "OPENROUTER") {
    headers["HTTP-Referer"] = "https://ai-company-os.app";
    headers["X-Title"] = "Braavolabs";
  }

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: config.model,
      messages: requestMessages,
      max_tokens: maxTokens,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "unknown error");
    throw new Error(`${config.provider} API error ${response.status}: ${errorText.slice(0, 300)}`);
  }

  const data = await response.json() as any;
  const content = data.choices?.[0]?.message?.content ?? "";
  const usage = data.usage ?? {};

  return {
    content,
    inputTokens: usage.prompt_tokens ?? 0,
    outputTokens: usage.completion_tokens ?? 0,
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
      return callOpenAICompatible(config, systemPrompt, messages.filter((m) => m.role !== "system"), maxTokens);

    default:
      throw new Error(`Unsupported AI provider: ${config.provider}`);
  }
}

// ─── Tenant config helpers ────────────────────────────────

import { prisma } from "../lib/db";
import { env } from "../config/env";

/**
 * Load the AI config for a tenant, falling back to system defaults.
 * Returns a ready-to-use AIClientConfig with decrypted API key.
 */
export async function getTenantAIConfig(tenantId: string): Promise<AIClientConfig> {
  const aiConfig = await prisma.userAIConfig.findUnique({
    where: { tenantId },
  });

  if (aiConfig?.encryptedApiKey) {
    try {
      const apiKey = decrypt(aiConfig.encryptedApiKey);
      return {
        provider: aiConfig.provider as AIProviderType,
        model: aiConfig.model,
        apiKey,
      };
    } catch (err) {
      logger.warn({ tenantId, err }, "Failed to decrypt tenant AI key — falling back to system default");
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

/** Encrypt and save tenant AI config. */
export async function saveTenantAIConfig(
  tenantId: string,
  provider: AIProviderType,
  model: string,
  apiKey: string,
): Promise<void> {
  const encryptedApiKey = encrypt(apiKey);

  await prisma.userAIConfig.upsert({
    where: { tenantId },
    update: { provider, model, encryptedApiKey },
    create: { tenantId, provider, model, encryptedApiKey },
  });
}
