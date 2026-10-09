import type { AIClientConfig } from "./ai-client";

/** Omission preserves provider defaults. No level implies a token budget. */
export type ReasoningEffort = "low" | "medium" | "high";

/** Exact positive profiles only; compatible protocols and model names are insufficient.
 * Verified 2026-10-06 against the official Chat Completions and Reasoning docs:
 * https://inference-docs.cerebras.ai/api-reference/chat-completions
 * https://inference-docs.cerebras.ai/capabilities/reasoning
 */
export const REASONING_EFFORT_CAPABILITIES = Object.freeze([
  Object.freeze({
    provider: "CEREBRAS", model: "gpt-oss-120b",
    baseUrl: "https://api.cerebras.ai/v1",
    transport: "chat-completions", wireField: "reasoning_effort",
    efforts: Object.freeze(["low", "medium", "high"] as const),
  }),
]);

/** A request-shape error: never retry on another provider or drop the option. */
export class UnsupportedReasoningEffortError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedReasoningEffortError";
  }
}

export function assertReasoningEffortSupported(config: AIClientConfig, effort: unknown): void {
  if (effort === undefined) return;
  if (effort !== "low" && effort !== "medium" && effort !== "high") {
    throw new UnsupportedReasoningEffortError("reasoningEffort must be low, medium or high");
  }
  if (!supportedReasoningEfforts(config).includes(effort)) {
    throw new UnsupportedReasoningEffortError(`Explicit reasoning effort is unavailable for ${config.provider}/${config.model} at this endpoint`);
  }
}

/** Discovery and inference share the same exact positive capability check. */
export function supportedReasoningEfforts(config: AIClientConfig): readonly ReasoningEffort[] {
  const profile = REASONING_EFFORT_CAPABILITIES.find(p => p.provider === config.provider && p.model === config.model);
  // Match the adapter's trimming/trailing-slash handling, without guessing proxy identity.
  const baseUrl = (config.baseUrl?.trim() || profile?.baseUrl || "").replace(/\/+$/, "");
  return profile && baseUrl === profile.baseUrl ? profile.efforts : [];
}
