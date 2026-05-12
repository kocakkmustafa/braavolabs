/**
 * Vapi adapter — most popular voice-AI infrastructure. Same vendor
 * Lindy's Gaia is built on. Credentials live in the tenant's
 * `integration.credentials` JSON under `provider: "vapi"`:
 *
 *   { apiKey, defaultAssistantId, defaultVoiceId, phoneNumberId }
 *
 * Vapi's outbound REST API:
 *
 *   POST https://api.vapi.ai/call
 *   { phoneNumberId, customer: { number }, assistant: { … } }
 *
 * Webhook signature: HMAC-SHA256 over the raw body with the
 * webhook secret from the dashboard, in the `X-Vapi-Signature`
 * header. Verified at the router edge before any DB write.
 */

import crypto from "node:crypto";
import { prisma } from "../../../lib/db";
import { decrypt } from "../../../lib/encryption";
import { AppError } from "../../../middleware/error";
import { logger } from "../../../lib/logger";
import type { VoiceProviderAdapter } from "../voice.service";

interface VapiCredentials {
  apiKey: string;
  webhookSecret?: string;
  defaultAssistantId?: string;
  defaultVoiceId?: string;
  phoneNumberId?: string;
}

async function getVapiCredentials(voiceAgentId: string): Promise<VapiCredentials> {
  const agent = await prisma.voiceAgent.findUnique({
    where: { id: voiceAgentId },
    select: { companyId: true },
  });
  if (!agent) {
    throw new AppError(404, "Voice agent not found");
  }
  const integ = await prisma.integration.findFirst({
    where: { companyId: agent.companyId, provider: "VAPI" },
  });
  if (!integ) {
    throw new AppError(503, "Vapi integration not configured for this company");
  }
  let parsed: VapiCredentials;
  try {
    parsed = JSON.parse(decrypt(integ.credentials));
  } catch {
    throw new AppError(500, "Failed to decrypt Vapi credentials");
  }
  if (!parsed.apiKey) {
    throw new AppError(503, "Vapi credentials missing apiKey");
  }
  return parsed;
}

export const vapiAdapter: VoiceProviderAdapter = {
  async placeOutboundCall(input) {
    const creds = await getVapiCredentials(input.voiceAgent.id);
    const cfg = (input.voiceAgent.voiceConfig ?? {}) as Record<string, unknown>;
    const assistantId = (cfg.assistantId as string) ?? creds.defaultAssistantId;
    const phoneNumberId = (cfg.phoneNumberId as string) ?? creds.phoneNumberId;
    if (!assistantId || !phoneNumberId) {
      throw new AppError(
        503,
        "Vapi voice agent missing assistantId or phoneNumberId in voiceConfig",
      );
    }

    const res = await fetch("https://api.vapi.ai/call", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${creds.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        phoneNumberId,
        customer: { number: input.calleeNumber },
        assistant: { assistantId },
        assistantOverrides: {
          firstMessage: input.prompt.slice(0, 500),
          variableValues: { task: input.prompt },
        },
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.error({ status: res.status, body: body.slice(0, 300) }, "Vapi outbound failed");
      throw new AppError(502, `Vapi outbound call failed: ${res.status}`);
    }
    const json = (await res.json()) as { id?: string };
    if (!json.id) throw new AppError(502, "Vapi did not return a call id");
    return { providerCallId: json.id };
  },

  verifyWebhookSignature(req) {
    const sig = req.headers["x-vapi-signature"];
    if (typeof sig !== "string") return false;
    const secret = process.env.VAPI_WEBHOOK_SECRET;
    if (!secret) {
      logger.warn("VAPI_WEBHOOK_SECRET missing — rejecting webhook");
      return false;
    }
    const expected = crypto.createHmac("sha256", secret).update(req.rawBody).digest("hex");
    const sigBuf = Buffer.from(sig);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length) return false;
    return crypto.timingSafeEqual(sigBuf, expBuf);
  },

  parseWebhookEvent(payload) {
    const env = payload as {
      type?: string;
      message?: { type?: string; call?: { id?: string }; transcript?: unknown };
      call?: { id?: string };
      endedReason?: string;
      transcript?: unknown;
    };
    const type = env?.message?.type ?? env?.type;
    const providerCallId = env?.message?.call?.id ?? env?.call?.id;
    if (!type || !providerCallId) return null;

    switch (type) {
      case "call-started":
      case "status-update":
        return { type: "call.started", providerCallId, data: env as any };
      case "transcript":
        return { type: "transcript.appended", providerCallId, data: env as any };
      case "end-of-call-report":
      case "hang":
        return {
          type: env.endedReason && /fail|error|busy|no-answer/i.test(env.endedReason)
            ? "call.failed"
            : "call.completed",
          providerCallId,
          data: env as any,
        };
      default:
        return null;
    }
  },
};
