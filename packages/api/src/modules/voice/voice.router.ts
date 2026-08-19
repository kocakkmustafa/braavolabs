/**
 * Voice agent router.
 *
 * Surfaces:
 *   /api/v1/voice/agents              CRUD per tenant (auth required)
 *   /api/v1/voice/agents/:id/calls    list calls for one agent
 *   /api/v1/voice/calls               flat list across all agents
 *   /hooks/voice/:provider/:agentId   provider webhook (unauthed,
 *                                     signature-verified by adapter)
 */

import { Router, raw } from "express";
import { z } from "zod";
import { authMiddleware } from "../../middleware/auth";
import { systemScope } from "../../middleware/system-scope";
import { prisma } from "../../lib/db";
import { logger } from "../../lib/logger";
import { AppError } from "../../middleware/error";
import { placeOutboundCall, finalizeCall, recordInboundCall } from "./voice.service";

// ─── /voice/* — authenticated ──────────────────────────────

export const voiceRouter = Router();
voiceRouter.use(authMiddleware);

const phoneRegex = /^\+[1-9]\d{1,14}$/;
const upsertSchema = z.object({
  companyId: z.string().min(1),
  agentId: z.string().optional(),
  name: z.string().min(1).max(120),
  phoneNumber: z.string().regex(phoneRegex, "phoneNumber must be E.164").optional(),
  provider: z.enum(["VAPI", "TWILIO_DEEPGRAM", "RETELL", "CUSTOM"]).default("VAPI"),
  voiceConfig: z.record(z.unknown()).optional(),
  inboundEnabled: z.boolean().optional(),
  outboundPerHour: z.number().int().min(0).max(10_000).nullable().optional(),
  isActive: z.boolean().optional(),
});

voiceRouter.get("/agents", async (req, res, next) => {
  try {
    const agents = await prisma.voiceAgent.findMany({
      where: { company: { tenantId: req.auth!.tenantId } },
      orderBy: { createdAt: "desc" },
    });
    res.json(agents);
  } catch (err) { next(err); }
});

voiceRouter.post("/agents", async (req, res, next) => {
  try {
    const body = upsertSchema.parse(req.body);
    const company = await prisma.company.findFirst({
      where: { id: body.companyId, tenantId: req.auth!.tenantId },
    });
    if (!company) throw new AppError(404, "Company not found");

    if (body.agentId) {
      const agent = await prisma.agent.findFirst({
        where: { id: body.agentId, companyId: body.companyId },
      });
      if (!agent) throw new AppError(400, "agentId does not belong to this company");
    }

    const created = await prisma.voiceAgent.create({
      data: {
        companyId: body.companyId,
        agentId: body.agentId,
        name: body.name,
        phoneNumber: body.phoneNumber,
        provider: body.provider,
        voiceConfig: (body.voiceConfig ?? {}) as any,
        inboundEnabled: body.inboundEnabled ?? true,
        outboundPerHour: body.outboundPerHour ?? null,
        isActive: body.isActive ?? true,
      },
    });
    await prisma.activityLog.create({
      data: {
        tenantId: req.auth!.tenantId,
        actor: req.auth!.userId,
        action: "voice.agent.create",
        resource: "voice_agent",
        resourceId: created.id,
        details: { provider: body.provider, phoneNumber: body.phoneNumber ?? null },
      },
    });
    res.status(201).json(created);
  } catch (err) { next(err); }
});

voiceRouter.patch("/agents/:id", async (req, res, next) => {
  try {
    const existing = await prisma.voiceAgent.findFirst({
      where: { id: req.params.id, company: { tenantId: req.auth!.tenantId } },
    });
    if (!existing) throw new AppError(404, "Voice agent not found");
    const partial = upsertSchema.partial().parse(req.body);
    const updated = await prisma.voiceAgent.update({
      where: { id: existing.id },
      data: {
        name: partial.name,
        phoneNumber: partial.phoneNumber,
        provider: partial.provider,
        voiceConfig: partial.voiceConfig as any,
        inboundEnabled: partial.inboundEnabled,
        outboundPerHour: partial.outboundPerHour,
        isActive: partial.isActive,
        agentId: partial.agentId,
      },
    });
    res.json(updated);
  } catch (err) { next(err); }
});

voiceRouter.delete("/agents/:id", async (req, res, next) => {
  try {
    const existing = await prisma.voiceAgent.findFirst({
      where: { id: req.params.id, company: { tenantId: req.auth!.tenantId } },
    });
    if (!existing) throw new AppError(404, "Voice agent not found");
    await prisma.voiceAgent.delete({ where: { id: existing.id } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

voiceRouter.get("/agents/:id/calls", async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const agent = await prisma.voiceAgent.findFirst({
      where: { id: req.params.id, company: { tenantId: req.auth!.tenantId } },
    });
    if (!agent) throw new AppError(404, "Voice agent not found");
    const calls = await prisma.voiceCall.findMany({
      where: { voiceAgentId: agent.id },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    res.json(calls);
  } catch (err) { next(err); }
});

const outboundSchema = z.object({
  calleeNumber: z.string().regex(phoneRegex, "calleeNumber must be E.164"),
  prompt: z.string().min(1).max(2000),
});
voiceRouter.post("/agents/:id/dial", async (req, res, next) => {
  try {
    const body = outboundSchema.parse(req.body);
    const result = await placeOutboundCall({
      voiceAgentId: req.params.id,
      tenantId: req.auth!.tenantId,
      calleeNumber: body.calleeNumber,
      prompt: body.prompt,
    });
    res.json(result);
  } catch (err) { next(err); }
});

// ─── Webhook router — public, signature-verified ───────────

export const voiceWebhookRouter = Router();
// BR-P0-004: signature-verified provider ingress — no authenticated tenant.
// The tenant is only discoverable after the payload is parsed; handlers that
// do row-level work should bind it with runWithTenant at that point.
voiceWebhookRouter.use(systemScope("webhook:voice"));

voiceWebhookRouter.post(
  "/:provider/:agentId",
  raw({ type: "*/*", limit: "2mb" }),
  async (req, res) => {
    const { provider, agentId } = req.params;
    let adapter;
    try {
      switch (provider) {
        case "vapi":
          adapter = (await import("./providers/vapi")).vapiAdapter;
          break;
        case "twilio_deepgram":
          adapter = (await import("./providers/twilio_deepgram")).twilioDeepgramAdapter;
          break;
        case "retell":
          adapter = (await import("./providers/retell")).retellAdapter;
          break;
        case "custom":
          adapter = (await import("./providers/custom")).customAdapter;
          break;
        default:
          res.status(404).json({ error: "Unknown voice provider" });
          return;
      }
    } catch (err) {
      logger.error({ err, provider }, "Voice webhook adapter load failed");
      res.status(500).json({ error: "Adapter load failed" });
      return;
    }

    const rawBuf: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
    if (!adapter.verifyWebhookSignature({ rawBody: rawBuf, headers: req.headers })) {
      res.status(401).json({ error: "Invalid webhook signature" });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBuf.toString("utf8"));
    } catch {
      res.status(400).json({ error: "Webhook body is not valid JSON" });
      return;
    }
    const event = adapter.parseWebhookEvent(parsed);
    if (!event) {
      // Unrecognised event — ack so the provider stops retrying.
      res.status(200).json({ received: true, recognised: false });
      return;
    }

    try {
      if (event.type === "call.started") {
        const callerNumber = (event.data as any)?.message?.customer?.number ?? "";
        await recordInboundCall({
          voiceAgentId: agentId,
          callerNumber,
          providerCallId: event.providerCallId,
        });
      } else if (event.type === "call.completed" || event.type === "call.failed") {
        const data = event.data as any;
        await finalizeCall({
          providerCallId: event.providerCallId,
          status:
            event.type === "call.failed"
              ? "FAILED"
              : "COMPLETED",
          durationSeconds: data?.message?.durationSeconds ?? data?.durationSeconds,
          costUsd: data?.message?.cost ?? data?.cost ?? undefined,
          recordingUrl: data?.message?.recordingUrl ?? data?.recordingUrl,
          transcript: data?.message?.transcript ?? data?.transcript,
        });
      }
      // transcript.appended — currently we wait for the final
      // call.completed event and persist the full transcript at
      // once. A future iteration can stream partial transcripts
      // through SSE to the dashboard.
      res.status(200).json({ received: true });
    } catch (err) {
      logger.error({ err, provider, agentId, eventType: event.type }, "Voice webhook handler failed");
      res.status(500).json({ error: "Handler failed" });
    }
  },
);
