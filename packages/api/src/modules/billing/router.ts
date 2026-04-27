/**
 * Billing Router — Faz 5
 *
 * Stripe usage metering + subscription management.
 */

import { Router, raw } from "express";
import { z } from "zod";
import { authMiddleware } from "../../middleware/auth";
import { prisma } from "../../lib/db";
import { env } from "../../config/env";
import { logger } from "../../lib/logger";
import { AppError } from "../../middleware/error";
import { redis } from "../../lib/redis";
import {
  createCustomer,
  createCheckoutSession,
  createCustomerPortalSession,
  getSubscription,
  constructWebhookEvent,
} from "@ai-company-os/integrations";
import type { StripeConfig } from "@ai-company-os/integrations";

/**
 * Idempotency key TTL — Stripe retries for up to 3 days, keep 7 for safety.
 */
const WEBHOOK_EVENT_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Returns true if this event.id has not been seen before (and marks it seen).
 * Prevents duplicate processing when Stripe retries a webhook.
 */
async function claimWebhookEvent(eventId: string): Promise<boolean> {
  // SETNX returns "OK" on first write, null if already set.
  const result = await redis.set(`stripe:webhook:${eventId}`, "1", "EX", WEBHOOK_EVENT_TTL_SECONDS, "NX");
  return result === "OK";
}

/**
 * Release a webhook event claim so Stripe can retry it.
 * Used when handler fails, before returning 5xx.
 */
async function releaseWebhookEvent(eventId: string): Promise<void> {
  await redis.del(`stripe:webhook:${eventId}`).catch(() => {});
}

function getStripeConfig(): StripeConfig {
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET) {
    throw new AppError(503, "Stripe not configured");
  }
  return {
    secretKey: env.STRIPE_SECRET_KEY,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET,
  };
}

export const billingRouter = Router();

// ─── Authenticated endpoints ─────────────────────────────

const authedRouter = Router();
authedRouter.use(authMiddleware);

// GET /api/v1/billing/usage — current period usage meters
authedRouter.get("/usage", async (req, res, next) => {
  try {
    const tenantId = req.auth!.tenantId;
    const now = new Date();
    // UTC anchored to match incrementMeter/claimQuota in metering.ts —
    // local-tz drift would mis-count meters in the first hours of a new
    // month for non-UTC servers.
    const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

    const meters = await prisma.usageMeter.findMany({
      where: { tenantId, periodStart: { gte: periodStart } },
    });

    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { plan: true },
    });

    // Also compute live counts
    const [runCount, toolCallCount] = await Promise.all([
      prisma.run.count({
        where: {
          createdAt: { gte: periodStart },
          pipeline: { company: { tenantId } },
        },
      }),
      prisma.toolCall.count({
        where: {
          createdAt: { gte: periodStart },
          runStep: { run: { pipeline: { company: { tenantId } } } },
        },
      }),
    ]);

    res.json({
      plan: tenant?.plan ?? "FREE",
      period: { start: periodStart.toISOString(), end: now.toISOString() },
      meters: meters.map((m) => ({
        metric: m.metric,
        value: m.value,
      })),
      live: { runs: runCount, toolCalls: toolCallCount },
    });
  } catch (err) { next(err); }
});

// GET /api/v1/billing/subscription — subscription details
authedRouter.get("/subscription", async (req, res, next) => {
  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: req.auth!.tenantId },
      select: {
        plan: true,
        stripeCustomerId: true,
        stripeSubscriptionId: true,
      },
    });
    if (!tenant) throw new AppError(404, "Tenant not found");

    let subscription = null;
    if (tenant.stripeSubscriptionId) {
      try {
        const config = getStripeConfig();
        subscription = await getSubscription(config, tenant.stripeSubscriptionId);
      } catch {
        // Stripe not configured or subscription not found
      }
    }

    res.json({
      plan: tenant.plan,
      stripeCustomerId: tenant.stripeCustomerId,
      subscription: subscription
        ? {
            id: subscription.id,
            status: subscription.status,
            currentPeriodEnd: new Date(subscription.current_period_end * 1000).toISOString(),
            cancelAtPeriodEnd: subscription.cancel_at_period_end,
          }
        : null,
    });
  } catch (err) { next(err); }
});

// POST /api/v1/billing/checkout — create Stripe checkout session
const checkoutSchema = z.object({
  plan: z.enum(["CREATOR", "PRO", "BUSINESS", "ENTERPRISE"]),
  billingCycle: z.enum(["monthly", "yearly"]).default("monthly"),
});

authedRouter.post("/checkout", async (req, res, next) => {
  try {
    const config = getStripeConfig();
    const { plan, billingCycle } = checkoutSchema.parse(req.body);

    // Pick the price ID for the requested plan + cycle. yearly is
    // optional — if the corresponding env slot is empty, fall back to
    // monthly so a partial Stripe setup still produces a usable
    // checkout (rather than a 400 the moment a user clicks Yearly).
    const priceMap: Record<string, { monthly?: string; yearly?: string }> = {
      CREATOR: { monthly: env.STRIPE_CREATOR_PRICE_ID, yearly: env.STRIPE_CREATOR_YEARLY_PRICE_ID },
      PRO: { monthly: env.STRIPE_PRO_PRICE_ID, yearly: env.STRIPE_PRO_YEARLY_PRICE_ID },
      BUSINESS: { monthly: env.STRIPE_BUSINESS_PRICE_ID, yearly: env.STRIPE_BUSINESS_YEARLY_PRICE_ID },
      ENTERPRISE: { monthly: env.STRIPE_ENTERPRISE_PRICE_ID, yearly: env.STRIPE_ENTERPRISE_YEARLY_PRICE_ID },
    };
    const priceId = priceMap[plan][billingCycle] ?? priceMap[plan].monthly;
    if (!priceId) throw new AppError(400, `No price configured for plan: ${plan} (${billingCycle})`);

    const tenant = await prisma.tenant.findUnique({
      where: { id: req.auth!.tenantId },
      include: { users: { take: 1 } },
    });
    if (!tenant) throw new AppError(404, "Tenant not found");

    // Create Stripe customer if needed
    let customerId = tenant.stripeCustomerId;
    if (!customerId) {
      customerId = await createCustomer(
        config,
        tenant.id,
        tenant.name,
        tenant.users[0]?.email ?? `${tenant.slug}@braavolabs.com`,
      );
      await prisma.tenant.update({
        where: { id: tenant.id },
        data: { stripeCustomerId: customerId },
      });
    }

    const url = await createCheckoutSession(
      config,
      customerId,
      priceId,
      `${env.APP_URL}/settings?billing=success`,
      `${env.APP_URL}/settings?billing=cancelled`,
    );

    await prisma.activityLog.create({
      data: {
        tenantId: tenant.id,
        actor: req.auth!.userId,
        action: "billing.checkout_started",
        resource: "tenant",
        resourceId: tenant.id,
        details: { plan, billingCycle },
      },
    });

    res.json({ url });
  } catch (err) { next(err); }
});

// POST /api/v1/billing/portal — Stripe customer portal link
authedRouter.post("/portal", async (req, res, next) => {
  try {
    const config = getStripeConfig();
    const tenant = await prisma.tenant.findUnique({
      where: { id: req.auth!.tenantId },
      select: { stripeCustomerId: true },
    });
    if (!tenant?.stripeCustomerId) {
      throw new AppError(400, "No billing account found. Subscribe to a plan first.");
    }

    const url = await createCustomerPortalSession(
      config,
      tenant.stripeCustomerId,
      `${env.APP_URL}/settings`,
    );

    res.json({ url });
  } catch (err) { next(err); }
});

billingRouter.use(authedRouter);

// ─── Stripe Webhook (no auth, raw body) ──────────────────

export const stripeWebhookRouter = Router();

stripeWebhookRouter.post(
  "/stripe",
  raw({ type: "application/json" }),
  async (req, res) => {
    let config: StripeConfig;
    try {
      config = getStripeConfig();
    } catch {
      // MED-7 fix: when Stripe is mid-rotation or env is briefly missing,
      // we want Stripe to RETRY the event (3 days of retries on 5xx),
      // not permanently mark it failed (some events never retry on 4xx).
      // 503 instead of 400 keeps event delivery resilient against
      // momentary config blips. Drive-by probes still get a uniform
      // "service unavailable" — no information leak about Stripe state.
      logger.warn({ hasSig: !!req.headers["stripe-signature"] }, "Stripe webhook hit while not configured");
      res.status(503).json({ error: "Service temporarily unavailable" });
      return;
    }

    const sig = req.headers["stripe-signature"];
    if (!sig || typeof sig !== "string") {
      // Same uniform 400 — don't distinguish "missing header" from
      // "wrong header value", which the next branch already handles.
      res.status(400).json({ error: "Invalid request" });
      return;
    }

    let event;
    try {
      event = constructWebhookEvent(config, req.body, sig);
    } catch (err) {
      logger.error({ err }, "Stripe webhook signature verification failed");
      res.status(400).json({ error: "Invalid signature" });
      return;
    }

    logger.info({ type: event.type, id: event.id }, "Stripe webhook received");

    // ─── Idempotency guard — prevents duplicate processing on retry ───
    const firstSeen = await claimWebhookEvent(event.id);
    if (!firstSeen) {
      logger.info({ id: event.id, type: event.type }, "Stripe webhook duplicate — skipped");
      res.json({ received: true, duplicate: true });
      return;
    }

    try {
      switch (event.type) {
        case "checkout.session.completed": {
          const session = event.data.object as any;
          const customerId = session.customer as string;
          const subscriptionId = session.subscription as string;

          // Find tenant by stripe customer ID
          const tenant = await prisma.tenant.findFirst({
            where: { stripeCustomerId: customerId },
          });

          if (tenant && subscriptionId) {
            await prisma.tenant.update({
              where: { id: tenant.id },
              data: { stripeSubscriptionId: subscriptionId },
            });

            await prisma.activityLog.create({
              data: {
                tenantId: tenant.id,
                actor: "stripe",
                action: "billing.subscription_created",
                resource: "tenant",
                resourceId: tenant.id,
                details: { subscriptionId, stripeEventId: event.id },
              },
            });
          }
          break;
        }

        case "customer.subscription.updated": {
          const subscription = event.data.object as any;
          const customerId = subscription.customer as string;
          const status = subscription.status as string;
          const priceId = subscription.items?.data?.[0]?.price?.id;

          const tenant = await prisma.tenant.findFirst({
            where: { stripeCustomerId: customerId },
          });

          if (tenant) {
            // Map Stripe subscription status + price ID to plan. Both
            // monthly and yearly price IDs map to the same plan tier —
            // missing a yearly slot here means the customer who picks
            // yearly is silently downgraded to PRO (and then billed for
            // the wrong tier next renewal).
            let plan: "FREE" | "CREATOR" | "PRO" | "BUSINESS" | "ENTERPRISE" = "FREE";
            if (status === "active" || status === "trialing") {
              if (priceId === env.STRIPE_ENTERPRISE_PRICE_ID || priceId === env.STRIPE_ENTERPRISE_YEARLY_PRICE_ID) plan = "ENTERPRISE";
              else if (priceId === env.STRIPE_BUSINESS_PRICE_ID || priceId === env.STRIPE_BUSINESS_YEARLY_PRICE_ID) plan = "BUSINESS";
              else if (priceId === env.STRIPE_PRO_PRICE_ID || priceId === env.STRIPE_PRO_YEARLY_PRICE_ID) plan = "PRO";
              else if (priceId === env.STRIPE_CREATOR_PRICE_ID || priceId === env.STRIPE_CREATOR_YEARLY_PRICE_ID) plan = "CREATOR";
              else {
                // HIGH-6 fix: unknown priceId must NOT silently upgrade to PRO.
                // Either an env-config typo or a Stripe Connect / test-mode
                // edge case can deliver a price ID that doesn't match any
                // configured tier; treat as untrusted and stay on FREE.
                logger.warn(
                  { tenantId: tenant.id, priceId, status, subscriptionId: subscription.id },
                  "Stripe webhook: unknown price ID — keeping tenant on FREE plan",
                );
                plan = "FREE";
              }
            }

            await prisma.tenant.update({
              where: { id: tenant.id },
              data: {
                plan,
                stripeSubscriptionId: subscription.id,
              },
            });

            await prisma.activityLog.create({
              data: {
                tenantId: tenant.id,
                actor: "stripe",
                action: "billing.plan_changed",
                resource: "tenant",
                resourceId: tenant.id,
                details: { plan, status, priceId, stripeEventId: event.id },
              },
            });
          }
          break;
        }

        case "customer.subscription.deleted": {
          const subscription = event.data.object as any;
          const customerId = subscription.customer as string;

          const tenant = await prisma.tenant.findFirst({
            where: { stripeCustomerId: customerId },
          });

          if (tenant) {
            // Stripe's subscription.deleted fires either:
            //   (a) at period end when cancel_at_period_end=true was set
            //       earlier — at this point the user has used what they
            //       paid for and downgrade is correct;
            //   (b) immediately if an admin/support cancels the sub mid
            //       period (rare path) — also correct to downgrade since
            //       refunds are issued separately.
            // The risk we want to *flag* (not silently swallow) is path
            // (b) when current_period_end is still in the future: that
            // tenant has paid for time they're now losing access to.
            const periodEndUnix = Number(subscription.current_period_end ?? 0);
            const periodEndsAt = periodEndUnix > 0 ? new Date(periodEndUnix * 1000) : null;
            const earlyCancel = !!periodEndsAt && periodEndsAt.getTime() > Date.now();

            await prisma.tenant.update({
              where: { id: tenant.id },
              data: {
                plan: "FREE",
                stripeSubscriptionId: null,
              },
            });

            if (earlyCancel) {
              logger.warn(
                {
                  tenantId: tenant.id,
                  subscriptionId: subscription.id,
                  periodEndsAt: periodEndsAt!.toISOString(),
                  stripeEventId: event.id,
                },
                "Subscription cancelled before paid period ended — manual refund review may be needed",
              );
            }

            await prisma.activityLog.create({
              data: {
                tenantId: tenant.id,
                actor: "stripe",
                action: "billing.subscription_cancelled",
                resource: "tenant",
                resourceId: tenant.id,
                details: {
                  stripeEventId: event.id,
                  earlyCancel,
                  periodEndsAt: periodEndsAt?.toISOString() ?? null,
                },
              },
            });
          }
          break;
        }

        case "invoice.payment_failed": {
          const invoice = event.data.object as any;
          const customerId = invoice.customer as string;
          const tenant = await prisma.tenant.findFirst({
            where: { stripeCustomerId: customerId },
          });
          if (tenant) {
            await prisma.activityLog.create({
              data: {
                tenantId: tenant.id,
                actor: "stripe",
                action: "billing.payment_failed",
                resource: "tenant",
                resourceId: tenant.id,
                details: {
                  invoiceId: invoice.id,
                  amountDue: invoice.amount_due,
                  attemptCount: invoice.attempt_count,
                  stripeEventId: event.id,
                },
              },
            });
            logger.warn({ tenantId: tenant.id, invoiceId: invoice.id }, "Stripe payment failed");
          }
          break;
        }

        case "invoice.payment_action_required": {
          const invoice = event.data.object as any;
          const customerId = invoice.customer as string;
          const tenant = await prisma.tenant.findFirst({
            where: { stripeCustomerId: customerId },
          });
          if (tenant) {
            await prisma.activityLog.create({
              data: {
                tenantId: tenant.id,
                actor: "stripe",
                action: "billing.payment_action_required",
                resource: "tenant",
                resourceId: tenant.id,
                details: {
                  invoiceId: invoice.id,
                  hostedInvoiceUrl: invoice.hosted_invoice_url,
                  stripeEventId: event.id,
                },
              },
            });
          }
          break;
        }

        case "customer.subscription.trial_will_end": {
          const subscription = event.data.object as any;
          const customerId = subscription.customer as string;
          const tenant = await prisma.tenant.findFirst({
            where: { stripeCustomerId: customerId },
          });
          if (tenant) {
            await prisma.activityLog.create({
              data: {
                tenantId: tenant.id,
                actor: "stripe",
                action: "billing.trial_will_end",
                resource: "tenant",
                resourceId: tenant.id,
                details: {
                  subscriptionId: subscription.id,
                  trialEnd: subscription.trial_end,
                  stripeEventId: event.id,
                },
              },
            });
          }
          break;
        }

        case "charge.refunded": {
          const charge = event.data.object as any;
          const customerId = charge.customer as string;
          if (customerId) {
            const tenant = await prisma.tenant.findFirst({
              where: { stripeCustomerId: customerId },
            });
            if (tenant) {
              // Full refund → downgrade to FREE immediately (safer default)
              const fullyRefunded = charge.amount_refunded >= charge.amount;
              if (fullyRefunded) {
                await prisma.tenant.update({
                  where: { id: tenant.id },
                  data: { plan: "FREE" },
                });
              }
              await prisma.activityLog.create({
                data: {
                  tenantId: tenant.id,
                  actor: "stripe",
                  action: "billing.refunded",
                  resource: "tenant",
                  resourceId: tenant.id,
                  details: {
                    chargeId: charge.id,
                    amountRefunded: charge.amount_refunded,
                    fullyRefunded,
                    downgradedToFree: fullyRefunded,
                    stripeEventId: event.id,
                  },
                },
              });
            }
          }
          break;
        }

        default:
          // Known but unhandled event types — log and move on
          logger.debug({ type: event.type, id: event.id }, "Stripe webhook event unhandled");
      }
    } catch (err) {
      logger.error({ err, eventType: event.type, eventId: event.id }, "Error processing Stripe webhook");
      // Release the idempotency claim so Stripe can retry this event.
      await releaseWebhookEvent(event.id);
      // Return 5xx so Stripe retries (don't swallow the error).
      res.status(500).json({ error: "Webhook processing failed" });
      return;
    }

    res.json({ received: true });
  },
);
