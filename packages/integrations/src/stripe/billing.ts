/**
 * Stripe Billing — Faz 5
 *
 * Usage-based metering + subscription management.
 * Uses Stripe's Billing Meter API for usage-based pricing.
 */

import Stripe from "stripe";

export interface StripeConfig {
  secretKey: string;
  webhookSecret: string;
}

let _stripe: Stripe | null = null;

function getStripe(config: StripeConfig): Stripe {
  if (!_stripe) {
    _stripe = new Stripe(config.secretKey, { apiVersion: "2025-02-24.acacia" });
  }
  return _stripe;
}

// ─── CUSTOMER MANAGEMENT ────────────────────────────────

export async function createCustomer(
  config: StripeConfig,
  tenantId: string,
  name: string,
  email: string,
): Promise<string> {
  const stripe = getStripe(config);
  const customer = await stripe.customers.create({
    name,
    email,
    metadata: { tenantId },
  });
  return customer.id;
}

export async function getCustomer(
  config: StripeConfig,
  customerId: string,
): Promise<Stripe.Customer | null> {
  const stripe = getStripe(config);
  try {
    const customer = await stripe.customers.retrieve(customerId);
    if (customer.deleted) return null;
    return customer as Stripe.Customer;
  } catch {
    return null;
  }
}

// ─── SUBSCRIPTION MANAGEMENT ────────────────────────────

export interface CreateSubscriptionParams {
  customerId: string;
  priceId: string; // Stripe price ID for the plan
}

export async function createSubscription(
  config: StripeConfig,
  params: CreateSubscriptionParams,
): Promise<Stripe.Subscription> {
  const stripe = getStripe(config);
  return stripe.subscriptions.create({
    customer: params.customerId,
    items: [{ price: params.priceId }],
    payment_behavior: "default_incomplete",
    expand: ["latest_invoice.payment_intent"],
  });
}

export async function getSubscription(
  config: StripeConfig,
  subscriptionId: string,
): Promise<Stripe.Subscription | null> {
  const stripe = getStripe(config);
  try {
    return await stripe.subscriptions.retrieve(subscriptionId);
  } catch {
    return null;
  }
}

export async function cancelSubscription(
  config: StripeConfig,
  subscriptionId: string,
): Promise<Stripe.Subscription> {
  const stripe = getStripe(config);
  return stripe.subscriptions.update(subscriptionId, {
    cancel_at_period_end: true,
  });
}

// ─── USAGE-BASED METERING ───────────────────────────────

/**
 * Report usage to Stripe via usage records on a metered subscription item.
 * Tracks: runs, tool_calls, tokens consumed.
 */
export async function reportUsage(
  config: StripeConfig,
  subscriptionItemId: string,
  quantity: number,
  timestamp?: number,
): Promise<Stripe.UsageRecord> {
  const stripe = getStripe(config);
  return stripe.subscriptionItems.createUsageRecord(subscriptionItemId, {
    quantity,
    timestamp: timestamp ?? Math.floor(Date.now() / 1000),
    action: "increment",
  });
}

/**
 * Get usage summary for a subscription item in the current billing period.
 */
export async function getUsageSummary(
  config: StripeConfig,
  subscriptionItemId: string,
): Promise<{ totalUsage: number }> {
  const stripe = getStripe(config);
  const records = await stripe.subscriptionItems.listUsageRecordSummaries(
    subscriptionItemId,
    { limit: 1 },
  );
  const total = records.data[0]?.total_usage ?? 0;
  return { totalUsage: total };
}

// ─── CUSTOMER PORTAL ────────────────────────────────────

export async function createCustomerPortalSession(
  config: StripeConfig,
  customerId: string,
  returnUrl: string,
): Promise<string> {
  const stripe = getStripe(config);
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
  });
  return session.url;
}

// ─── CHECKOUT SESSION ───────────────────────────────────

export async function createCheckoutSession(
  config: StripeConfig,
  customerId: string,
  priceId: string,
  successUrl: string,
  cancelUrl: string,
): Promise<string> {
  const stripe = getStripe(config);
  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
  });
  return session.url!;
}

// ─── WEBHOOK VERIFICATION ───────────────────────────────

export function constructWebhookEvent(
  config: StripeConfig,
  payload: string | Buffer,
  signature: string,
): Stripe.Event {
  const stripe = getStripe(config);
  return stripe.webhooks.constructEvent(payload, signature, config.webhookSecret);
}
