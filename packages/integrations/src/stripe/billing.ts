/**
 * Stripe Billing — Faz 5
 *
 * Usage-based metering + subscription management.
 */

export interface StripeConfig {
  secretKey: string;
  webhookSecret: string;
}

export async function reportUsage(
  _config: StripeConfig,
  _customerId: string,
  _metric: string,
  _quantity: number,
): Promise<void> {
  // TODO: Faz 5
  throw new Error("Not implemented — Faz 5");
}

export async function createCustomerPortalSession(
  _config: StripeConfig,
  _customerId: string,
): Promise<string> {
  // TODO: Faz 5
  throw new Error("Not implemented — Faz 5");
}
