/**
 * Outbound-contact feature gates (legal finding B-06).
 *
 * Email sent to CRM contacts, outreach sequences and the voice agent reach
 * third parties on the tenant's behalf. Until opt-out links, sender identity
 * and AI-disclosure requirements are met, these features stay switched OFF on
 * the server. Each one is behind a single env flag that is enabled only by the
 * literal string "true"; an unset variable (the production default — compose
 * does not forward these names) keeps the feature disabled, so no env change
 * is needed to deploy the gate and re-enabling is an explicit operator step.
 *
 * Read at call time (not cached at boot) so tests and a restarted container
 * see the current value. Account emails (verify / reset / welcome) are not
 * outbound contact and are intentionally not gated here.
 */
import { AppError } from "../middleware/error";

export type OutboundFeature = "email" | "outreach" | "voice";

const GATES: Record<OutboundFeature, { env: string; code: string; message: string }> = {
  email: {
    env: "OUTBOUND_EMAIL_ENABLED",
    code: "EMAIL_SENDING_DISABLED",
    message: "Sending email to contacts is temporarily unavailable.",
  },
  outreach: {
    env: "OUTREACH_SEQUENCES_ENABLED",
    code: "OUTREACH_SEQUENCES_DISABLED",
    message: "Outreach sequences are temporarily unavailable.",
  },
  voice: {
    env: "VOICE_AGENT_ENABLED",
    code: "VOICE_AGENT_DISABLED",
    message: "Voice agent calls are temporarily unavailable.",
  },
};

export const OUTBOUND_GATE_ENV = {
  email: GATES.email.env,
  outreach: GATES.outreach.env,
  voice: GATES.voice.env,
} as const;

export const OUTBOUND_DISABLED_CODES = {
  email: GATES.email.code,
  outreach: GATES.outreach.code,
  voice: GATES.voice.code,
} as const;

export function isOutboundFeatureEnabled(feature: OutboundFeature): boolean {
  return process.env[GATES[feature].env] === "true";
}

/** The 422 a disabled feature returns; clients key off `code`. */
export function outboundFeatureDisabledError(feature: OutboundFeature): AppError {
  const gate = GATES[feature];
  return new AppError(422, gate.message, undefined, gate.code);
}

export function assertOutboundFeatureEnabled(feature: OutboundFeature): void {
  if (!isOutboundFeatureEnabled(feature)) throw outboundFeatureDisabledError(feature);
}

/**
 * Agent tools that reach contacts through a gated feature. The executor
 * refuses them before any approval row is created, so a disabled feature
 * never surfaces an approvable call on mobile/web; the handlers re-check.
 */
export const OUTBOUND_TOOL_GATES: Readonly<Record<string, readonly OutboundFeature[]>> = {
  email_send_sequence: ["outreach", "email"],
  make_outbound_call: ["voice"],
};

export function disabledFeatureForTool(toolName: string): OutboundFeature | null {
  const features = OUTBOUND_TOOL_GATES[toolName];
  if (!features) return null;
  return features.find((feature) => !isOutboundFeatureEnabled(feature)) ?? null;
}
