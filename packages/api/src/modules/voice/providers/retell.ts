/**
 * Retell AI adapter — stub mirror of vapi.ts for tenants who prefer
 * Retell. Same shape; only the HTTP path differs (POST
 * https://api.retellai.com/create-phone-call with `to_number` + JSON
 * body keyed by `agent_id`). Filling this in is operator work once
 * RETELL_API_KEY is provisioned.
 */

import { AppError } from "../../../middleware/error";
import type { VoiceProviderAdapter } from "../voice.service";

export const retellAdapter: VoiceProviderAdapter = {
  async placeOutboundCall() {
    throw new AppError(
      501,
      "Retell adapter not yet implemented for this environment. Switch the voice agent's provider to VAPI.",
    );
  },
  verifyWebhookSignature() {
    return false;
  },
  parseWebhookEvent() {
    return null;
  },
};
