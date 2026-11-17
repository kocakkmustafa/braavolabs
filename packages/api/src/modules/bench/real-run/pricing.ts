/**
 * Real-run price table (BRA-P1-05-N3). The founder may edit this file.
 *
 * USD per 1,000,000 tokens (input / output). Sources: provider public price
 * pages as mirrored in `lib/modelPricing.ts` (captured 2026-11-01..18). They
 * are ESTIMATES used only for the pre-run cap check and the running total;
 * a wrong entry makes the estimate wrong, so verify before a live run.
 *
 * All cost math is integer micro-USD (1 USD = 1_000_000). A price of
 * P USD/1M tokens equals P micro-USD per token; prices are stored in
 * milli-micro (x1000) integers so fractional list prices stay exact.
 */

export interface RealRunPrice {
  /** USD per 1M input tokens. */
  inputPerM: number;
  /** USD per 1M output tokens. */
  outputPerM: number;
}

export const REAL_RUN_PRICES: Record<string, RealRunPrice> = {
  "ANTHROPIC/claude-sonnet-5-5": { inputPerM: 2, outputPerM: 10 },
  "OPENAI/gpt-4o": { inputPerM: 2.5, outputPerM: 10 },
  "GOOGLE/gemini-1.5-pro": { inputPerM: 1.25, outputPerM: 5 },
};

export const REAL_RUN_DEFAULT_MODELS: Record<string, string> = {
  ANTHROPIC: "claude-sonnet-5-5",
  OPENAI: "gpt-4o",
  GOOGLE: "gemini-1.5-pro",
};

export function priceFor(provider: string, model: string, table = REAL_RUN_PRICES): RealRunPrice | null {
  return table[`${provider}/${model}`] ?? null;
}

/** Conservative input-token estimate: 1 token per 3 characters, rounded up. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

/** Integer micro-USD for a token usage; always rounded UP (never under-counts). */
export function costMicroUsd(inputTokens: number, outputTokens: number, price: RealRunPrice): number {
  const inMilli = Math.round(price.inputPerM * 1000);
  const outMilli = Math.round(price.outputPerM * 1000);
  const i = Math.max(0, Math.floor(inputTokens));
  const o = Math.max(0, Math.floor(outputTokens));
  return Math.ceil((i * inMilli + o * outMilli) / 1000);
}

/** Worst case for ONE attempt: estimated input + the full maxTokens output. */
export function worstCaseMicroUsd(inputTokenEstimate: number, maxTokens: number, price: RealRunPrice): number {
  return costMicroUsd(inputTokenEstimate, maxTokens, price);
}

export const usdFromMicro = (micro: number): number => micro / 1_000_000;
