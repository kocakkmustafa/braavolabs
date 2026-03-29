import { Router } from "express";
import crypto from "crypto";
import { prisma } from "../../lib/db";
import { logger } from "../../lib/logger";
import { enqueueRun } from "../pipeline/runner";

export const webhookRouter = Router();

// POST /hooks/:companySlug/:event — handle external webhooks
webhookRouter.post("/:companySlug/:event", async (req, res, next) => {
  try {
    const { companySlug, event } = req.params;

    const company = await prisma.company.findFirst({
      where: { slug: companySlug, status: "ACTIVE" },
    });
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }

    // Verify webhook signature if X-Webhook-Signature header is present
    const signature = req.headers["x-webhook-signature"] as string | undefined;
    if (signature) {
      const secret = (company.config as Record<string, any>)?.webhookSecret || process.env.WEBHOOK_SECRET || "";
      if (secret) {
        const expectedSig = crypto
          .createHmac("sha256", secret)
          .update(JSON.stringify(req.body))
          .digest("hex");
        if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig))) {
          return res.status(401).json({ error: "Invalid webhook signature" });
        }
      }
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

    // Find pipelines with WEBHOOK trigger for this company
    const pipelines = await prisma.pipeline.findMany({
      where: {
        companyId: company.id,
        trigger: "WEBHOOK",
        enabled: true,
      },
    });

    const runs: string[] = [];

    for (const pipeline of pipelines) {
      // Create a run for each matching pipeline
      const run = await prisma.run.create({
        data: {
          pipelineId: pipeline.id,
          status: "PENDING",
          trigger: `webhook:${event}`,
          input: { event, payload: req.body },
        },
      });

      await enqueueRun(run.id);
      runs.push(run.id);

      logger.info(
        { pipelineId: pipeline.id, runId: run.id, event },
        "Webhook triggered pipeline run",
      );
    }

    res.json({
      received: true,
      company: companySlug,
      event,
      triggeredRuns: runs,
    });
  } catch (err) { next(err); }
});
