import { Router } from "express";
import { prisma } from "../../lib/db";
import { logger } from "../../lib/logger";

export const webhookRouter = Router();

// POST /hooks/:companySlug/:event — handle external webhooks
webhookRouter.post("/:companySlug/:event", async (req, res, next) => {
  try {
    const { companySlug, event } = req.params;

    const company = await prisma.company.findFirst({
      where: { slug: companySlug },
    });
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }

    logger.info({ companySlug, event, body: req.body }, "Webhook received");

    await prisma.activityLog.create({
      data: {
        tenantId: company.tenantId,
        actor: "webhook",
        action: `webhook.${event}`,
        resource: "company",
        resourceId: company.id,
        details: { event, payload: req.body },
      },
    });

    // TODO: Faz 1 — route webhook to appropriate pipeline trigger
    // Find pipelines with trigger=WEBHOOK and matching event config

    res.json({ received: true, company: companySlug, event });
  } catch (err) { next(err); }
});
