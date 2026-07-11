/**
 * Cost preview (Forge — honesty mandate). Estimate the USD cost of a single
 * call, an ask-all fan-out, or a media generation BEFORE running it, so the
 * user always sees "this will cost ~$X" up front. Per the feasibility recon a
 * hard cost preview before any fan-out / media generation is non-negotiable
 * (image/video bill real money from the first call; Veo has no free tier).
 *
 * Pure functions over modelPricing.ts (the single price source). The pricer is
 * injectable (defaults to priceForModel) so this stays deterministic and
 * unit-testable with zero network / secrets.
 */

import { priceForModel } from "./modelPricing";

/** USD per 1M input / output tokens, or null/undefined for a free/local model. */
export type Pricer = (modelId: string) => { inputPerM: number; outputPerM: number } | null | undefined;

export interface CostEstimate {
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  usd: number;
  /** true when the model has no price entry (local / free tier). */
  free: boolean;
}

const round = (n: number): number => Math.round(n * 1e6) / 1e6;

export function estimateCall(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  pricer: Pricer = priceForModel,
): CostEstimate {
  const p = pricer(modelId);
  const usd = p
    ? round((inputTokens / 1e6) * p.inputPerM + (outputTokens / 1e6) * p.outputPerM)
    : 0;
  return { modelId, inputTokens, outputTokens, usd, free: !p };
}

export interface FanoutEstimate {
  perModel: CostEstimate[];
  /** Optional single synthesis pass over the combined answers (ask-all merge). */
  synthesizer?: CostEstimate;
  totalUsd: number;
  modelCount: number;
  /** true if any leg (or the synthesizer) is a paid model — drives the "this costs money" warning. */
  anyPaid: boolean;
}

/**
 * Ask-all preview: fan the same prompt out to each model, then (optionally) one
 * synthesis pass on the synthesizer model reading the combined answers. Lets the
 * UI show a total + per-model breakdown before the user opts into the fan-out.
 */
export function estimateFanout(
  modelIds: string[],
  inputTokens: number,
  outputTokens: number,
  opts: {
    synthesizerId?: string;
    synthesisInputTokens?: number;
    synthesisOutputTokens?: number;
  } = {},
  pricer: Pricer = priceForModel,
): FanoutEstimate {
  const perModel = modelIds.map((id) => estimateCall(id, inputTokens, outputTokens, pricer));

  let synthesizer: CostEstimate | undefined;
  if (opts.synthesizerId) {
    // Synthesis reads every answer (≈ prompt + each model's output) and emits a merged answer.
    const synthIn = opts.synthesisInputTokens ?? inputTokens + outputTokens * modelIds.length;
    const synthOut = opts.synthesisOutputTokens ?? outputTokens;
    synthesizer = estimateCall(opts.synthesizerId, synthIn, synthOut, pricer);
  }

  const totalUsd = round(
    perModel.reduce((s, e) => s + e.usd, 0) + (synthesizer?.usd ?? 0),
  );
  const anyPaid = perModel.some((e) => !e.free) || !!(synthesizer && !synthesizer.free);

  return { perModel, synthesizer, totalUsd, modelCount: modelIds.length, anyPaid };
}
