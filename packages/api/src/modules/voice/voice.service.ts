/**
 * Voice agent service.
 *
 * Provider-agnostic — the abstract VoiceProviderAdapter interface is
 * implemented in `providers/{vapi,twilio_deepgram,retell,custom}.ts`.
 * Service code stays clean of vendor-specific HTTP details.
 *
 * Outbound calls go through `placeOutboundCall()` which is the
 * back-end of the `make_outbound_call` tool. Inbound webhook deliveries
 * land at the router and call `recordInboundCall()` /
 * `appendTranscript()` / `finalizeCall()` to keep the VoiceCall row
 * fresh.
 *
 * Per-hour outbound rate limit is enforced at the service layer
 * (Redis ZSET) so an LLM that loops on dialing doesn't burn the
 * tenant's Twilio bill.
 */

import { prisma } from "../../lib/db";
import { redis } from "../../lib/redis";
import { AppError } from "../../middleware/error";
import { logger } from "../../lib/logger";

export interface OutboundCallRequest {
  voiceAgentId: string;
  tenantId: string;
  calleeNumber: string;
  // Free-text task description, fed to the conversational agent.
  prompt: string;
  // Optional run_step that initiated this call (audit trail).
  initiatedByRunStepId?: string;
}

export interface OutboundCallResult {
  callId: string;
  providerCallId: string;
  status: "queued" | "ringing";
}

const E164_RE = /^\+[1-9]\d{1,14}$/;

/**
 * Per-hour outbound rate limit. Keyed by voiceAgentId; the ZSET
 * stores call timestamps so the count is exact across a sliding
 * window rather than a fixed-bucket. Redis-backed so multiple API
 * replicas share the same counter.
 */
async function consumeOutboundQuota(voiceAgentId: string, limitPerHour: number): Promise<void> {
  const key = `voice:outbound:${voiceAgentId}`;
  const now = Date.now();
  const windowStart = now - 60 * 60 * 1000;
  try {
    await redis.zremrangebyscore(key, 0, windowStart);
    const count = await redis.zcard(key);
    if (count >= limitPerHour) {
      throw new AppError(
        429,
        `Outbound call rate limit hit (${limitPerHour}/hour for this voice agent). Adjust the cap on Settings → Voice if this is legitimate burst dialing.`,
      );
    }
    await redis.zadd(key, now, `${now}-${Math.random()}`);
    await redis.expire(key, 60 * 60 + 60);
  } catch (err) {
    if (err instanceof AppError) throw err;
    // Redis outage — fail closed for outbound dialing to keep the
    // tenant's phone bill bounded. Inbound is unaffected; calls
    // queued at the provider side can still be answered.
    logger.warn({ err, voiceAgentId }, "Voice outbound quota check failed — refusing to dial");
    throw new AppError(503, "Voice agent quota service temporarily unavailable");
  }
}

export async function placeOutboundCall(req: OutboundCallRequest): Promise<OutboundCallResult> {
  if (!E164_RE.test(req.calleeNumber)) {
    throw new AppError(400, "calleeNumber must be in E.164 format (e.g. +14155550101)");
  }

  const agent = await prisma.voiceAgent.findFirst({
    where: { id: req.voiceAgentId, company: { tenantId: req.tenantId } },
    include: { company: true },
  });
  if (!agent) throw new AppError(404, "Voice agent not found in this tenant");
  if (!agent.isActive) throw new AppError(409, "Voice agent is disabled");

  // Rate limit per-hour. NULL = no cap.
  if (agent.outboundPerHour) {
    await consumeOutboundQuota(agent.id, agent.outboundPerHour);
  }

  const provider = await getProviderAdapter(agent.provider);
  const providerCall = await provider.placeOutboundCall({
    voiceAgent: agent,
    calleeNumber: req.calleeNumber,
    prompt: req.prompt,
  });

  const call = await prisma.voiceCall.create({
    data: {
      voiceAgentId: agent.id,
      tenantId: req.tenantId,
      direction: "OUTBOUND",
      callerNumber: agent.phoneNumber ?? "",
      calleeNumber: req.calleeNumber,
      status: "RINGING",
      providerCallId: providerCall.providerCallId,
      initiatedByRunStepId: req.initiatedByRunStepId,
    },
  });
  await prisma.activityLog.create({
    data: {
      tenantId: req.tenantId,
      actor: "voice-agent",
      action: "voice.outbound_placed",
      resource: "voice_call",
      resourceId: call.id,
      details: { voiceAgentId: agent.id, calleeNumber: req.calleeNumber },
    },
  });
  return { callId: call.id, providerCallId: providerCall.providerCallId, status: "ringing" };
}

export async function recordInboundCall(input: {
  voiceAgentId: string;
  callerNumber: string;
  providerCallId: string;
}) {
  const agent = await prisma.voiceAgent.findUnique({
    where: { id: input.voiceAgentId },
    include: { company: true },
  });
  if (!agent) throw new AppError(404, "Voice agent not found");
  if (!agent.inboundEnabled || !agent.isActive) {
    // The provider's webhook still records the attempt so the call
    // log isn't missing entries, but the call itself is rejected at
    // the provider's instruction layer (the adapter returns the
    // proper response shape).
    logger.info({ voiceAgentId: input.voiceAgentId }, "Inbound rejected — agent disabled");
  }
  // De-dup: providerCallId is globally unique. A second webhook for
  // the same call (e.g. retry) lands on the existing row.
  const call = await prisma.voiceCall.upsert({
    where: { providerCallId: input.providerCallId },
    create: {
      voiceAgentId: agent.id,
      tenantId: agent.company.tenantId,
      direction: "INBOUND",
      callerNumber: input.callerNumber,
      calleeNumber: agent.phoneNumber ?? "",
      status: "RINGING",
      providerCallId: input.providerCallId,
      startedAt: new Date(),
    },
    update: { status: "RINGING" },
  });
  return call;
}

export async function finalizeCall(input: {
  providerCallId: string;
  status: "COMPLETED" | "FAILED" | "NO_ANSWER" | "BUSY";
  durationSeconds?: number;
  costUsd?: number;
  recordingUrl?: string;
  transcript?: unknown;
}) {
  await prisma.voiceCall.update({
    where: { providerCallId: input.providerCallId },
    data: {
      status: input.status,
      durationSeconds: input.durationSeconds,
      costUsd: input.costUsd,
      recordingUrl: input.recordingUrl,
      transcript: input.transcript as any,
      endedAt: new Date(),
    },
  });
}

// ── Provider adapter loader ────────────────────────────────

export interface VoiceProviderAdapter {
  placeOutboundCall(input: {
    voiceAgent: { id: string; voiceConfig: unknown; phoneNumber: string | null };
    calleeNumber: string;
    prompt: string;
  }): Promise<{ providerCallId: string }>;
  // Verify the webhook signature for inbound provider callbacks.
  // Each provider has its own signing scheme; the adapter returns
  // true on valid signature, false otherwise.
  verifyWebhookSignature(req: {
    rawBody: Buffer;
    headers: Record<string, string | string[] | undefined>;
  }): boolean;
  // Parse the provider's event envelope into our normalised form.
  parseWebhookEvent(payload: unknown): {
    type: "call.started" | "call.completed" | "call.failed" | "transcript.appended";
    providerCallId: string;
    data: Record<string, unknown>;
  } | null;
}

async function getProviderAdapter(provider: string): Promise<VoiceProviderAdapter> {
  switch (provider) {
    case "VAPI":
      return (await import("./providers/vapi")).vapiAdapter;
    case "TWILIO_DEEPGRAM":
      return (await import("./providers/twilio_deepgram")).twilioDeepgramAdapter;
    case "RETELL":
      return (await import("./providers/retell")).retellAdapter;
    case "CUSTOM":
      return (await import("./providers/custom")).customAdapter;
    default:
      throw new AppError(500, `Unknown voice provider: ${provider}`);
  }
}
