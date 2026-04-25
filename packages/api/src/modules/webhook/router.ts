import { Router, raw } from "express";
import crypto from "crypto";
import { z } from "zod";
import { prisma } from "../../lib/db";
import { logger } from "../../lib/logger";
import { enqueueRun } from "../pipeline/runner";
import { claimQuota } from "../billing/metering";
import { getWebhookTemplates, getWebhookTemplateById, getWebhookTemplateCategories } from "./templates";
import { authMiddleware } from "../../middleware/auth";
import { AppError } from "../../middleware/error";

const webhookParamsSchema = z.object({
  companySlug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/),
  event: z.string().min(1).max(100).regex(/^[a-z0-9_.]+$/),
});

export const webhookRouter = Router();

// POST /hooks/:companySlug/:event — handle external webhooks.
//
// Signature verification is over the **raw request bytes**, not over a
// re-serialized JSON. JSON.stringify(req.body) is not byte-stable across
// producers (key order, escape forms, whitespace) and would let an
// attacker who replays a captured signed payload mutate the body without
// invalidating the signature. The Stripe webhook handler uses the same
// pattern — we mirror it here.
webhookRouter.post(
  "/:companySlug/:event",
  // type:'*/*' captures every Content-Type — different providers send
  // application/json, text/plain, or x-www-form-urlencoded; the HMAC
  // is over raw bytes regardless. 1mb cap matches the global JSON
  // parser to avoid memory-exhaustion DoS.
  raw({ type: "*/*", limit: "1mb" }),
  async (req, res, next) => {
    try {
      const { companySlug, event } = webhookParamsSchema.parse(req.params);

      const company = await prisma.company.findFirst({
        where: { slug: companySlug, status: "ACTIVE" },
      });
      if (!company) {
        res.status(404).json({ error: "Company not found" });
        return;
      }

      // Verify webhook signature — REQUIRED. Per-company secret only —
      // the previous `process.env.WEBHOOK_SECRET` fallback was a process-
      // wide global, so any tenant that learned the value could sign
      // payloads for any other tenant's `/hooks/:slug/:event`.
      const signature = req.headers["x-webhook-signature"] as string | undefined;
      const timestamp = req.headers["x-webhook-timestamp"] as string | undefined;
      const secret = (company.config as Record<string, any>)?.webhookSecret;
      if (!secret || typeof secret !== "string") {
        res.status(403).json({ error: "Webhook secret not configured for this company" });
        return;
      }
      if (!signature) {
        res.status(401).json({ error: "Missing X-Webhook-Signature header" });
        return;
      }

      // Replay protection: reject requests older than 5 minutes.
      if (timestamp) {
        const ts = parseInt(timestamp, 10);
        if (isNaN(ts) || Math.abs(Date.now() - ts) > 5 * 60 * 1000) {
          res.status(401).json({ error: "Webhook timestamp too old or invalid" });
          return;
        }
      }

      // Express's `raw()` parser leaves a Buffer on req.body. If the body
      // hasn't been parsed (e.g. no Content-Type header), normalize to an
      // empty buffer so the signed payload is well-defined.
      const rawBuffer: Buffer = Buffer.isBuffer(req.body)
        ? req.body
        : Buffer.from("");
      const signedPayload = timestamp
        ? Buffer.concat([Buffer.from(`${timestamp}.`), rawBuffer])
        : rawBuffer;
      const expectedSig = crypto
        .createHmac("sha256", secret)
        .update(signedPayload)
        .digest("hex");
      const sigBuf = Buffer.from(signature);
      const expectedBuf = Buffer.from(expectedSig);
      if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
        res.status(401).json({ error: "Invalid webhook signature" });
        return;
      }

      // Signature verified — now safe to parse the JSON.
      let parsedBody: Record<string, unknown> = {};
      if (rawBuffer.length > 0) {
        try {
          parsedBody = JSON.parse(rawBuffer.toString("utf8"));
        } catch {
          res.status(400).json({ error: "Webhook body is not valid JSON" });
          return;
        }
      }

      const payloadSize = rawBuffer.length;
      logger.info({ companySlug, event, payloadSize }, "Webhook received");

      await prisma.activityLog.create({
        data: {
          tenantId: company.tenantId,
          actor: "webhook",
          action: `webhook.${event}`,
          resource: "company",
          resourceId: company.id,
          details: { event, payloadSize, payloadKeys: Object.keys(parsedBody) },
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
        // Atomic quota claim before enqueue (ISS-010). If the tenant has no
        // remaining runs, skip this pipeline rather than enqueuing a run that
        // would just fail downstream — avoids polluting the run history with
        // quota-exceeded entries on every webhook delivery.
        const claim = await claimQuota(company.tenantId, "runs");
        if (!claim.claimed) {
          logger.warn(
            { pipelineId: pipeline.id, tenantId: company.tenantId, value: claim.value, limit: claim.limit },
            "Webhook trigger skipped — quota exhausted",
          );
          continue;
        }

        // Create a run for each matching pipeline
        const run = await prisma.run.create({
          data: {
            pipelineId: pipeline.id,
            status: "PENDING",
            trigger: `webhook:${event}`,
            input: { event, payload: parsedBody },
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
  },
);

// ─── Webhook Template Marketplace Routes ────────────────────
// These are authenticated API routes, exported as a separate router
// and mounted at /api/v1/webhooks in the main app.

export const webhookTemplateRouter = Router();
webhookTemplateRouter.use(authMiddleware);

// GET /api/v1/webhooks/templates — List all templates (with optional ?category= filter)
webhookTemplateRouter.get("/templates", async (req, res, _next) => {
  const category = req.query.category as string | undefined;
  const templates = getWebhookTemplates(category);
  const categories = getWebhookTemplateCategories();

  res.json({
    templates: templates.map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      category: t.category,
      icon: t.icon,
      provider: t.provider,
      eventType: t.eventType,
      popularity: t.popularity,
    })),
    categories,
    total: templates.length,
  });
});

// GET /api/v1/webhooks/templates/:id — Get template detail with sample payload
webhookTemplateRouter.get("/templates/:id", async (req, res, next) => {
  try {
    const template = getWebhookTemplateById(req.params.id);
    if (!template) throw new AppError(404, "Webhook template not found");

    res.json(template);
  } catch (err) { next(err); }
});

// POST /api/v1/webhooks/templates/:id/install — Install a template for a company
webhookTemplateRouter.post("/templates/:id/install", async (req, res, next) => {
  try {
    const template = getWebhookTemplateById(req.params.id);
    if (!template) throw new AppError(404, "Webhook template not found");

    const { companyId, pipelineId } = req.body;
    if (!companyId || !pipelineId) {
      throw new AppError(400, "companyId and pipelineId are required");
    }

    // Verify company belongs to tenant
    const company = await prisma.company.findFirst({
      where: { id: companyId, tenantId: req.auth!.tenantId },
    });
    if (!company) throw new AppError(404, "Company not found");

    // Verify pipeline belongs to company
    const pipeline = await prisma.pipeline.findFirst({
      where: { id: pipelineId, companyId: company.id },
    });
    if (!pipeline) throw new AppError(404, "Pipeline not found for this company");

    // Generate a webhook secret for this installation
    const webhookSecret = crypto.randomBytes(32).toString("hex");

    // Update pipeline to be webhook-triggered with template config
    await prisma.pipeline.update({
      where: { id: pipeline.id },
      data: {
        trigger: "WEBHOOK",
        enabled: true,
        config: {
          ...(pipeline.config as Record<string, any> ?? {}),
          webhookTemplate: {
            templateId: template.id,
            provider: template.provider,
            eventType: template.eventType,
            fieldMapping: template.fieldMapping,
            installedAt: new Date().toISOString(),
          },
        },
      },
    });

    // Store webhook secret in company config (merge with existing)
    const existingConfig = (company.config as Record<string, any>) ?? {};
    await prisma.company.update({
      where: { id: company.id },
      data: {
        config: {
          ...existingConfig,
          webhookSecret,
        },
      },
    });

    // Build the webhook URL
    const baseUrl = process.env.APP_URL || "http://localhost:4000";
    const webhookUrl = `${baseUrl}/hooks/${company.slug}/${template.eventType}`;

    await prisma.activityLog.create({
      data: {
        tenantId: req.auth!.tenantId,
        actor: req.auth!.userId,
        action: "webhook.template.install",
        resource: "pipeline",
        resourceId: pipeline.id,
        details: {
          templateId: template.id,
          templateName: template.name,
          provider: template.provider,
          companyId: company.id,
          pipelineId: pipeline.id,
        },
      },
    });

    logger.info(
      { templateId: template.id, companyId: company.id, pipelineId: pipeline.id },
      "Webhook template installed",
    );

    res.status(201).json({
      success: true,
      webhookUrl,
      webhookSecret,
      template: {
        id: template.id,
        name: template.name,
        provider: template.provider,
        eventType: template.eventType,
      },
      setupInstructions: template.setupInstructions,
      fieldMapping: template.fieldMapping,
      pipelineId: pipeline.id,
    });
  } catch (err) { next(err); }
});
