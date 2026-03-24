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
import {
  createCustomer,
  createCheckoutSession,
  createCustomerPortalSession,
  getSubscription,
  constructWebhookEvent,
} from "@ai-company-os/integrations";
import type { StripeConfig } from "@ai-company-os/integrations";

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
    const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);

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
  plan: z.enum(["PRO", "ENTERPRISE"]),
});

authedRouter.post("/checkout", async (req, res, next) => {
  try {
    const config = getStripeConfig();
    const { plan } = checkoutSchema.parse(req.body);

    const priceId = plan === "PRO" ? env.STRIPE_PRO_PRICE_ID : env.STRIPE_ENTERPRISE_PRICE_ID;
    if (!priceId) throw new AppError(400, `No price configured for plan: ${plan}`);

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
        tenant.users[0]?.email ?? `${tenant.slug}@aicompanyos.com`,
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
        details: { plan },
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
      res.status(503).json({ error: "Stripe not configured" });
      return;
    }

    const sig = req.headers["stripe-signature"];
    if (!sig || typeof sig !== "string") {
      res.status(400).json({ error: "Missing stripe-signature header" });
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
                details: { subscriptionId },
              },
            });
          }
          break;
        }

        case "customer.subscription.updated": {
          const subscription = event.data.object as any;
          const customerId = subscription.customer as string;
          const status = subscription.status as string;

          const tenant = await prisma.tenant.findFirst({
            where: { stripeCustomerId: customerId },
          });

          if (tenant) {
            // Map Stripe subscription status to plan
            const plan = status === "active" || status === "trialing"
              ? (subscription.items?.data?.[0]?.price?.id === env.STRIPE_ENTERPRISE_PRICE_ID
                ? "ENTERPRISE" : "PRO")
              : "FREE";

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
                details: { plan, status },
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
            await prisma.tenant.update({
              where: { id: tenant.id },
              data: {
                plan: "FREE",
                stripeSubscriptionId: null,
              },
            });

            await prisma.activityLog.create({
              data: {
                tenantId: tenant.id,
                actor: "stripe",
                action: "billing.subscription_cancelled",
                resource: "tenant",
                resourceId: tenant.id,
              },
            });
          }
          break;
        }
      }
    } catch (err) {
      logger.error({ err, eventType: event.type }, "Error processing Stripe webhook");
    }

    res.json({ received: true });
  },
);
