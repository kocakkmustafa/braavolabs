/**
 * Hosted trial funding is retired by BR-P0-002-D. The compatibility exports
 * remain for one release so older call sites compile, but every runtime entry
 * point fails closed before reading a Braavolabs-owned key or dialing a model.
 */
import { FREE_PROVIDERS, priceForModel } from "../../lib/modelPricing";
import { logger } from "../../lib/logger";
import type { AIProviderType, ChatCompletionResult } from "../../services/ai-client";

export const TRIAL_CALL_RESERVATION_USD = 0.02;
export const MIN_TRIAL_UNIT_USD = 0.0001;

export interface TrialCreditReservation {
  reservationUsd: number;
}

export interface ForgeTrialCreditStatus {
  enabled: boolean;
  capUsd: number;
  spentUsd: number;
  remainingUsd: number;
  exhausted: boolean;
}

export function hasSystemHeldKey(_provider: AIProviderType): boolean {
  return false;
}

export function trialCreditEnabled(): boolean {
  return false;
}

export async function reserveTrialCredit(
  _tenantId: string,
  _reservationUsd = TRIAL_CALL_RESERVATION_USD,
): Promise<TrialCreditReservation | null> {
  return null;
}

export async function settleTrialCredit(
  _tenantId: string,
  _reservationUsd: number,
  _actualCostUsd: number,
): Promise<void> {
  return undefined;
}

export async function refundTrialCredit(
  _tenantId: string,
  _reservationUsd: number,
): Promise<void> {
  return undefined;
}

export async function getForgeTrialCreditStatus(
  _tenantId: string,
): Promise<ForgeTrialCreditStatus> {
  return { enabled: false, capUsd: 0, spentUsd: 0, remainingUsd: 0, exhausted: false };
}

/** Historical accounting helper only; it does not confer an entitlement. */
export function costForTrialUsage(
  provider: AIProviderType,
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  if (FREE_PROVIDERS.has(provider)) return 0;
  const price = priceForModel(model);
  if (!price) {
    logger.warn(
      { provider, model },
      "Historical trial accounting: unknown model price",
    );
    return 0;
  }
  return (inputTokens / 1_000_000) * price.inputPerM
    + (outputTokens / 1_000_000) * price.outputPerM;
}

export class TrialCreditExhaustedError extends Error {
  constructor(public readonly tenantId: string) {
    super("Hosted trial inference is disabled — configure a tenant BYOK or local provider.");
    this.name = "TrialCreditExhaustedError";
  }
}

export class NoSystemHeldKeyError extends Error {
  constructor(public readonly provider: AIProviderType) {
    super(`System-funded ${provider} inference is disabled — tenant BYOK or local configuration is required.`);
    this.name = "NoSystemHeldKeyError";
  }
}

export async function runForgeTrialCompletion(
  _tenantId: string,
  provider: AIProviderType,
  _model: string,
  _systemPrompt: string,
  _messages: Array<{ role: string; content: string }>,
  _maxTokens = 16,
): Promise<ChatCompletionResult & { costUsd: number }> {
  throw new NoSystemHeldKeyError(provider);
}
