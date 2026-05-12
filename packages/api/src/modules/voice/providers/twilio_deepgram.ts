/**
 * Twilio + Deepgram adapter — stub.
 *
 * Reference architecture: Twilio Media Streams → WebSocket → Deepgram
 * Flux (sub-second STT) → Claude → Deepgram TTS → Twilio. The full
 * implementation requires a long-running WebSocket server which lives
 * outside this Express process. This stub keeps the type contract so
 * tenants can SELECT the provider in the UI; the actual dialing
 * surface 503s until the WS server ships.
 */

import { AppError } from "../../../middleware/error";
import type { VoiceProviderAdapter } from "../voice.service";

export const twilioDeepgramAdapter: VoiceProviderAdapter = {
  async placeOutboundCall() {
    throw new AppError(
      501,
      "Twilio + Deepgram backend is not deployed in this environment. Switch the voice agent's provider to VAPI or RETELL, or set TWILIO_MEDIA_WS_URL and ship the WS worker.",
    );
  },
  verifyWebhookSignature() {
    return false;
  },
  parseWebhookEvent() {
    return null;
  },
};
