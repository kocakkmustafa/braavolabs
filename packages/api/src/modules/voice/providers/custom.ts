/**
 * Custom adapter — for tenants running their own voice infra
 * (LiveKit + custom STT/TTS, self-hosted Asterisk + Vosk, etc.).
 * The tenant supplies an HTTPS endpoint + HMAC secret via
 * integration credentials; we POST a normalised payload and parse
 * a normalised response. Wide-open contract so operators don't
 * have to ship a new adapter for every in-house setup.
 */

import crypto from "node:crypto";
import { prisma } from "../../../lib/db";
import { decrypt } from "../../../lib/encryption";
import { AppError } from "../../../middleware/error";
import { logger } from "../../../lib/logger";
import { assertSafeExternalUrl, SsrfError } from "../../../lib/ssrf";
import type { VoiceProviderAdapter } from "../voice.service";

interface CustomCreds {
  endpointUrl: string;
  apiKey: string;
  webhookSecret?: string;
}

async function getCreds(voiceAgentId: string): Promise<CustomCreds> {
  const agent = await prisma.voiceAgent.findUnique({
    where: { id: voiceAgentId },
    select: { companyId: true },
  });
  if (!agent) throw new AppError(404, "Voice agent not found");
  const integ = await prisma.integration.findFirst({
    where: { companyId: agent.companyId, provider: "VOICE_CUSTOM" },
  });
  if (!integ) throw new AppError(503, "Custom voice integration not configured");
  let parsed: CustomCreds;
  try {
    parsed = JSON.parse(decrypt(integ.credentials));
  } catch {
    throw new AppError(500, "Failed to decrypt custom voice credentials");
  }
  if (!parsed.endpointUrl || !parsed.apiKey) {
    throw new AppError(503, "Custom voice credentials missing endpointUrl or apiKey");
  }
  // Same SSRF guard as the rest of the platform — refuses
  // metadata IPs / loopback unless the tenant is in OFFLINE_MODE.
  try {
    await assertSafeExternalUrl(parsed.endpointUrl);
  } catch (err) {
    if (err instanceof SsrfError) throw new AppError(400, `Voice endpoint rejected: ${err.message}`);
    throw err;
  }
  return parsed;
}

export const customAdapter: VoiceProviderAdapter = {
  async placeOutboundCall(input) {
    const creds = await getCreds(input.voiceAgent.id);
    const res = await fetch(creds.endpointUrl + "/calls/outbound", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${creds.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: input.voiceAgent.phoneNumber,
        to: input.calleeNumber,
        prompt: input.prompt,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.error({ status: res.status, body: body.slice(0, 300) }, "Custom voice outbound failed");
      throw new AppError(502, `Custom voice outbound failed: ${res.status}`);
    }
    const json = (await res.json()) as { id?: string; callId?: string };
    const id = json.id ?? json.callId;
    if (!id) throw new AppError(502, "Custom voice endpoint did not return a call id");
    return { providerCallId: id };
  },

  verifyWebhookSignature(req) {
    const sig = req.headers["x-braavo-voice-signature"];
    if (typeof sig !== "string") return false;
    const secret = process.env.VOICE_CUSTOM_WEBHOOK_SECRET;
    if (!secret) return false;
    const expected = crypto.createHmac("sha256", secret).update(req.rawBody).digest("hex");
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  },

  parseWebhookEvent(payload) {
    const p = payload as { event?: string; callId?: string };
    if (!p?.event || !p?.callId) return null;
    if (p.event === "call.started") return { type: "call.started", providerCallId: p.callId, data: p as any };
    if (p.event === "call.completed") return { type: "call.completed", providerCallId: p.callId, data: p as any };
    if (p.event === "call.failed") return { type: "call.failed", providerCallId: p.callId, data: p as any };
    if (p.event === "transcript.appended") return { type: "transcript.appended", providerCallId: p.callId, data: p as any };
    return null;
  },
};
