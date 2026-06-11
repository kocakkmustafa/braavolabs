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
import { computeSpendForecast } from "./forecast";
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
 *
 * Two-tier guard:
 *   1. Postgres `stripe_webhook_events` row with UNIQUE(stripe_event_id) —
 *      durable, survives Redis restart / eviction. The INSERT either
 *      succeeds (first-seen) or fails with P2002 (duplicate). This is
 *      the ground truth.
 *   2. Redis SETNX — fast-path cache. If we've seen the event in the
 *      last 7 days we can short-circuit before touching Postgres. The
 *      cache being missing/wrong only costs us one extra Postgres
 *      INSERT attempt — no correctness risk.
 *
 * The DB write is the source of truth. Redis is just optimization.
 *
 * Side effect: when this function returns true, a row exists in
 * `stripe_webhook_events` with processed_at = NULL. The caller is
 * expected to update it (markWebhookEventProcessed) once handler
 * logic finishes — that gives ops a clear "received vs processed"
 * audit trail.
 */
/**
 * A claimed-but-unfinished row younger than this is assumed to still be
 * in-flight on another worker, so a concurrent duplicate delivery is
 * skipped rather than double-processed. Stripe's automatic retries
 * arrive minutes-to-hours later, comfortably past this window, so a
 * genuine retry of a failed/crashed handler always gets through.
 */
const WEBHOOK_RECLAIM_AFTER_MS = 2 * 60 * 1000;

/**
 * "Seen before" ≠ "processed". A previous delivery may have claimed the
 * row and then FAILED (we 500'd — releaseWebhookEvent clears only the
 * Redis key, never the row) or the process crashed mid-handler (Redis
 * key survives for 7 days). In both cases the row's processedAt is
 * NULL. Treating the retry as a duplicate would answer 200 and
 * permanently drop the event — e.g. a paid plan upgrade that never
 * lands. So: resolve against the DB ground truth and RECLAIM stale
 * unprocessed rows for reprocessing.
 *
 * Returns true when the caller should run the handler again.
 */
async function reclaimIfUnprocessed(eventId: string, type: string): Promise<boolean> {
  const existing = await prisma.stripeWebhookEvent.findUnique({
    where: { stripeEventId: eventId },
    select: { processedAt: true, createdAt: true },
  });
  if (!existing) {
    // Redis knows the id but the durable row is gone/never landed —
    // nothing proves the handler ran. Process it.
    return true;
  }
  if (existing.processedAt !== null) {
    return false; // true duplicate — handler finished previously
  }
  if (Date.now() - existing.createdAt.getTime() < WEBHOOK_RECLAIM_AFTER_MS) {
    // Claimed seconds ago — almost certainly a concurrent duplicate
    // delivery with the original handler still in flight. Skip; if the
    // original fails, Stripe's retry (minutes later) will reclaim.
    logger.info({ eventId, type }, "Stripe webhook duplicate — original claim still in flight, skipped");
    return false;
  }
  logger.warn(
    { eventId, type },
    "Stripe webhook retry of unprocessed event (processedAt=NULL) — reprocessing",
  );
  return true;
}

async function claimWebhookEvent(
  eventId: string,
  type: string,
  livemode: boolean,
  rawPayload: unknown,
): Promise<boolean> {
  // Fast path — Redis SETNX. First writer wins; a cache hit means the
  // event id was seen recently, but completion is decided by the DB
  // (see reclaimIfUnprocessed — a crashed handler leaves the key behind).
  try {
    const cacheHit = await redis.set(`stripe:webhook:${eventId}`, "1", "EX", WEBHOOK_EVENT_TTL_SECONDS, "NX");
    if (cacheHit !== "OK") {
      return reclaimIfUnprocessed(eventId, type);
    }
  } catch (err) {
    // Redis failure → don't block the request, fall through to DB.
    logger.warn({ err, eventId }, "Stripe webhook idempotency: Redis unavailable, using DB-only path");
  }

  // Durable path — INSERT into stripe_webhook_events. Postgres unique
  // constraint catches duplicates that Redis would have missed (e.g.
  // after a Redis restart or maxmemory eviction).
  try {
    await prisma.stripeWebhookEvent.create({
      data: {
        stripeEventId: eventId,
        type,
        livemode,
        rawPayload: rawPayload as object,
      },
    });
    return true;
  } catch (err) {
    // Prisma P2002 = unique constraint violation = already-seen — but
    // possibly never finished. Same reclaim logic as the Redis path.
    const isDuplicate = err instanceof Error && /P2002|Unique constraint/.test(err.message);
    if (isDuplicate) {
      logger.info({ eventId }, "Stripe webhook duplicate caught at DB layer (Redis cache miss)");
      return reclaimIfUnprocessed(eventId, type);
    }
    // Some other DB error — re-raise so the webhook handler returns 5xx
    // and Stripe retries. Better to retry than to silently drop.
    throw err;
  }
}

/**
 * Release a webhook event claim so Stripe can retry it.
 *
 * IMPORTANT: this only clears the Redis fast-path key. It deliberately
 * does NOT delete the Postgres row — the unique constraint on
 * `stripeEventId` is the durable defence against double-processing,
 * and if we deleted the row a Stripe retry that arrived while another
 * worker was mid-handler could re-acquire the claim, run the handler
 * a second time, and (e.g.) issue a second plan upgrade.
 *
 * The retried request hits `claimWebhookEvent` again, finds the row
 * (no Redis key but a Postgres row with processedAt = NULL), and the
 * INSERT raises P2002 — claimWebhookEvent then inspects the row: a
 * NULL processedAt means the previous handler never finished, so the
 * retry RE-PROCESSES the event instead of being swallowed as a
 * duplicate. Only rows already stamped processedAt are skipped.
 */
async function releaseWebhookEvent(eventId: string): Promise<void> {
  await redis.del(`stripe:webhook:${eventId}`).catch(() => {});
}

/**
 * Mark a webhook event as fully processed. Called after the handler
 * switch finishes successfully. Persists a small summary so ops can
 * see "what did we do with this event?" without re-reading the raw
 * payload.
 */
async function markWebhookEventProcessed(
  eventId: string,
  resultSummary: object,
): Promise<void> {
  try {
    await prisma.stripeWebhookEvent.update({
      where: { stripeEventId: eventId },
      data: { processedAt: new Date(), resultSummary },
    });
  } catch (err) {
    // Non-fatal — the handler already succeeded, this is just bookkeeping.
    logger.warn({ err, eventId }, "Stripe webhook: failed to mark processed");
  }
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

// GET /api/v1/billing/forecast — month-end spend projection + budget bar
//
// Returns currentSpend / dailyAverage / projectedMonthEnd / budget +
// a 14-day sparkline + top-3 cost-driving tools. The dashboard
// renders a budget bar coloured per `status` ("under" / "nearing"
// / "over" / "no_budget"). When status is "over_budget" the runner
// also blocks new spend-approval auto-grants via isOverBudget().
authedRouter.get("/forecast", async (req, res, next) => {
  try {
    const forecast = await computeSpendForecast(req.auth!.tenantId);
    res.json(forecast);
  } catch (err) { next(err); }
});

// PATCH /api/v1/billing/budget — set or clear the monthly cap
//
// Body: { monthlyBudgetUsd: number | null }. Passing null clears the
// cap (back to informational-only mode). 1¢ minimum to disambiguate
// from "null clears" — a $0 budget would block every action.
const budgetSchema = z.object({
  monthlyBudgetUsd: z.union([z.number().min(0.01).max(1_000_000), z.null()]),
});
authedRouter.patch("/budget", async (req, res, next) => {
  try {
    const { monthlyBudgetUsd } = budgetSchema.parse(req.body);
    await prisma.tenant.update({
      where: { id: req.auth!.tenantId },
      data: { monthlyBudgetUsd },
    });
    await prisma.activityLog.create({
      data: {
        tenantId: req.auth!.tenantId,
        actor: req.auth!.userId,
        action: "billing.budget_update",
        resource: "tenant",
        resourceId: req.auth!.tenantId,
        details: { monthlyBudgetUsd },
      },
    });
    res.json({ success: true, monthlyBudgetUsd });
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

    // ─── Idempotency guard — Redis fast-path + Postgres durable backstop ───
    // Stripe retries failed webhooks for up to 3 days; without this guard
    // we'd create duplicate activity_log rows (and rarely duplicate
    // side effects like Hubspot syncs) every time they retry.
    const firstSeen = await claimWebhookEvent(
      event.id,
      event.type,
      event.livemode ?? false,
      event,
    );
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

    // Stamp the durable idempotency row as processed. Non-fatal if it
    // fails — the handler already succeeded and the unique constraint
    // still prevents duplicates. This just gives ops a clear "we
    // received AND finished handling this event" signal.
    await markWebhookEventProcessed(event.id, {
      type: event.type,
      handledAt: new Date().toISOString(),
    });

    res.json({ received: true });
  },
);
