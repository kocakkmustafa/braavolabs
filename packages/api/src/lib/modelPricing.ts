/**
 * Approximate model pricing + pipeline cost estimation.
 *
 * ⚠️ THESE ARE ESTIMATES. Public list prices change often and actual
 * spend depends on real token counts, caching, and provider tiers. The
 * UI MUST label any number derived from here as an estimate (a range,
 * "typical token use") — never present it as the exact cost. The run's
 * live `costUsd` (metered from real usage) is the source of truth.
 *
 * Prices are USD per 1,000,000 tokens, captured ~2026-06. Local /
 * self-hosted providers (Ollama, LM Studio, Custom) cost $0 — the user
 * runs them on their own hardware.
 */

import type { AIProviderType } from "../services/ai-client";

/** USD per 1M tokens, split input / output. */
export interface ModelPrice {
  inputPerM: number;
  outputPerM: number;
}

/**
 * Per-model price map. Keys are matched case-insensitively against the
 * configured model id with a "starts-with" fallback so dated variants
 * (e.g. `claude-sonnet-4-20250514`) resolve to the `claude-sonnet`
 * family entry.
 */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  // ── Anthropic ──
  "claude-opus": { inputPerM: 15, outputPerM: 75 },
  "claude-sonnet": { inputPerM: 3, outputPerM: 15 },
  "claude-haiku": { inputPerM: 0.8, outputPerM: 4 },
  // ── OpenAI ──
  "gpt-4o-mini": { inputPerM: 0.15, outputPerM: 0.6 },
  "gpt-4o": { inputPerM: 2.5, outputPerM: 10 },
  "gpt-4-turbo": { inputPerM: 10, outputPerM: 30 },
  o1: { inputPerM: 15, outputPerM: 60 },
  "o1-mini": { inputPerM: 1.1, outputPerM: 4.4 },
  // ── Google Gemini ──
  "gemini-1.5-pro": { inputPerM: 1.25, outputPerM: 5 },
  "gemini-1.5-flash": { inputPerM: 0.075, outputPerM: 0.3 },
  "gemini-pro": { inputPerM: 1.25, outputPerM: 5 },
  "gemini-flash": { inputPerM: 0.075, outputPerM: 0.3 },
  // ── Mistral ──
  "mistral-large": { inputPerM: 2, outputPerM: 6 },
  "mistral-medium": { inputPerM: 0.4, outputPerM: 2 },
  "mistral-small": { inputPerM: 0.1, outputPerM: 0.3 },
  // ── Groq (Llama) ──
  "llama-3.3-70b": { inputPerM: 0.59, outputPerM: 0.79 },
  "llama-3.1-70b": { inputPerM: 0.59, outputPerM: 0.79 },
  "llama-3.1-8b": { inputPerM: 0.05, outputPerM: 0.08 },
  "llama-3.2-3b": { inputPerM: 0.05, outputPerM: 0.08 },
  "mixtral-8x7b": { inputPerM: 0.24, outputPerM: 0.24 },
  // ── DeepSeek / Kimi / Qwen (rough public list) ──
  "deepseek-chat": { inputPerM: 0.27, outputPerM: 1.1 },
  "deepseek-reasoner": { inputPerM: 0.55, outputPerM: 2.19 },
  "moonshot-v1": { inputPerM: 1.2, outputPerM: 1.2 },
  "qwen-max": { inputPerM: 1.6, outputPerM: 6.4 },
  "qwen-plus": { inputPerM: 0.4, outputPerM: 1.2 },
  // ── Cerebras (free tier ~1M tok/day; paid rate below for cost accounting) ──
  "gpt-oss-120b": { inputPerM: 0.35, outputPerM: 0.75 },
  // ── Zhipu GLM (Flash tiers permanently free = $0; GLM-4.7/4.6 paid) ──
  "glm-4.7-flash": { inputPerM: 0, outputPerM: 0 },
  "glm-4.5-flash": { inputPerM: 0, outputPerM: 0 },
  "glm-4.6v-flash": { inputPerM: 0, outputPerM: 0 },
  "glm-4.7": { inputPerM: 0.6, outputPerM: 2.2 },
  "glm-4.6": { inputPerM: 0.6, outputPerM: 2.2 },
};

/**
 * Local / self-hosted providers are free — the model runs on the user's
 * own hardware, so there is no per-token charge to estimate.
 */
export const FREE_PROVIDERS: ReadonlySet<AIProviderType> = new Set([
  "OLLAMA",
  "LMSTUDIO",
  "CUSTOM",
]);

/**
 * Baseline token assumptions per step. A typical agent turn reads a
 * system prompt + a little context (~1.5k in) and writes a short
 * reasoning + tool call (~0.8k out). These are deliberately modest and
 * exist only to produce a ballpark range, not a precise figure.
 */
export const BASELINE_INPUT_TOKENS_PER_STEP = 1500;
export const BASELINE_OUTPUT_TOKENS_PER_STEP = 800;

/** Range multipliers — convey uncertainty rather than a false-precise point. */
export const LOW_MULTIPLIER = 0.6;
export const HIGH_MULTIPLIER = 1.8;

/**
 * Look up the price for a model id. Tries an exact (lowercased) match,
 * then a prefix match against the family keys (so `claude-sonnet-4-...`
 * → `claude-sonnet`). Returns null when the model is unknown.
 */
export function priceForModel(model: string): ModelPrice | null {
  if (!model) return null;
  const key = model.toLowerCase().trim();
  if (MODEL_PRICES[key]) return MODEL_PRICES[key];
  // Longest-prefix-first so "gpt-4o-mini" wins over "gpt-4o".
  const families = Object.keys(MODEL_PRICES).sort((a, b) => b.length - a.length);
  for (const fam of families) {
    if (key.startsWith(fam)) return MODEL_PRICES[fam];
  }
  return null;
}

export interface PipelineCostEstimate {
  stepCount: number;
  provider: AIProviderType;
  model: string;
  /** Low end of the range, USD. */
  lowUsd: number;
  /** High end of the range, USD. */
  highUsd: number;
  /** Midpoint per-step cost, USD (for the "× steps" math the UI shows). */
  perStepUsd: number;
  /** True when the model price is unknown (estimate falls back to 0 / unknown). */
  unknownModel: boolean;
  /** True for local/self-hosted providers — cost is $0 on own hardware. */
  isFree: boolean;
}

/**
 * Estimate the USD cost of running a pipeline with `stepCount` steps on
 * the given provider/model. Returns a {low, high} range derived from a
 * baseline per-step token assumption. Local providers return all-zero.
 *
 * The result is intentionally approximate — see the file header.
 */
export function estimatePipelineCostUsd(
  stepCount: number,
  provider: AIProviderType,
  model: string,
): PipelineCostEstimate {
  // At least one step's worth of work even for an empty/hierarchical
  // pipeline (the manager turn still costs something).
  const steps = Math.max(1, Math.floor(stepCount) || 0);

  const isFree = FREE_PROVIDERS.has(provider);
  if (isFree) {
    return {
      stepCount: steps,
      provider,
      model,
      lowUsd: 0,
      highUsd: 0,
      perStepUsd: 0,
      unknownModel: false,
      isFree: true,
    };
  }

  const price = priceForModel(model);
  if (!price) {
    return {
      stepCount: steps,
      provider,
      model,
      lowUsd: 0,
      highUsd: 0,
      perStepUsd: 0,
      unknownModel: true,
      isFree: false,
    };
  }

  const inputCostPerStep = (BASELINE_INPUT_TOKENS_PER_STEP / 1_000_000) * price.inputPerM;
  const outputCostPerStep = (BASELINE_OUTPUT_TOKENS_PER_STEP / 1_000_000) * price.outputPerM;
  const perStepUsd = inputCostPerStep + outputCostPerStep;

  const midpoint = perStepUsd * steps;
  return {
    stepCount: steps,
    provider,
    model,
    lowUsd: round6(midpoint * LOW_MULTIPLIER),
    highUsd: round6(midpoint * HIGH_MULTIPLIER),
    perStepUsd: round6(perStepUsd),
    unknownModel: false,
    isFree: false,
  };
}

/** Round to 6 decimals (matches the DB Decimal(10,6) precision for costs). */
function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}
