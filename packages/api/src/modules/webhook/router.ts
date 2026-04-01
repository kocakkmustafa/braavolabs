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

    // Verify webhook signature — REQUIRED (reject if no secret configured)
    const signature = req.headers["x-webhook-signature"] as string | undefined;
    const timestamp = req.headers["x-webhook-timestamp"] as string | undefined;
    const secret = (company.config as Record<string, any>)?.webhookSecret || process.env.WEBHOOK_SECRET || "";
    if (!secret) {
      res.status(403).json({ error: "Webhook secret not configured for this company" });
      return;
    }
    if (!signature) {
      res.status(401).json({ error: "Missing X-Webhook-Signature header" });
      return;
    }

    // Replay protection: reject requests older than 5 minutes
    if (timestamp) {
      const ts = parseInt(timestamp, 10);
      if (isNaN(ts) || Math.abs(Date.now() - ts) > 5 * 60 * 1000) {
        res.status(401).json({ error: "Webhook timestamp too old or invalid" });
        return;
      }
    }

    const payload = timestamp ? `${timestamp}.${JSON.stringify(req.body)}` : JSON.stringify(req.body);
    const expectedSig = crypto
      .createHmac("sha256", secret)
      .update(payload)
      .digest("hex");
    const sigBuf = Buffer.from(signature);
    const expectedBuf = Buffer.from(expectedSig);
    if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
      res.status(401).json({ error: "Invalid webhook signature" });
      return;
    }

    logger.info({ companySlug, event, payloadSize: JSON.stringify(req.body).length }, "Webhook received");

    await prisma.activityLog.create({
      data: {
        tenantId: company.tenantId,
        actor: "webhook",
        action: `webhook.${event}`,
        resource: "company",
        resourceId: company.id,
        details: { event, payloadSize: JSON.stringify(req.body).length, payloadKeys: Object.keys(req.body ?? {}) },
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
