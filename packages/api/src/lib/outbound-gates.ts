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

export type OutboundFeature = "email" | "outreach" | "voice" | "deploy_merge";

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
  // BRA-P1-03c: deploy / merge style tools change production state or a
  // shared repository. FOUNDER-APPROVAL REQUIREMENT (kurucu onayı şartı):
  // they stay OFF until the founder explicitly approves enabling them and an
  // operator sets the flag; an agent's own approval row is not that approval.
  deploy_merge: {
    env: "DEPLOY_MERGE_TOOLS_ENABLED",
    code: "DEPLOY_MERGE_TOOLS_DISABLED",
    message: "Deploy and merge tools are temporarily unavailable.",
  },
};

export const OUTBOUND_GATE_ENV = {
  email: GATES.email.env,
  outreach: GATES.outreach.env,
  voice: GATES.voice.env,
  deploy_merge: GATES.deploy_merge.env,
} as const;

export const OUTBOUND_DISABLED_CODES = {
  email: GATES.email.code,
  outreach: GATES.outreach.code,
  voice: GATES.voice.code,
  deploy_merge: GATES.deploy_merge.code,
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

/**
 * BRA-P1-03c: is this a deploy / merge style tool? Matched on the tool NAME
 * (static and connector tools) and, for connector tools only, on the remote
 * DESCRIPTION too (a tool named `run` that "deploys the app"). Matching is
 * case-insensitive and camelCase / snake / kebab / dotted aware, so
 * `DeployApp`, `DEPLOY-prod`, `github__merge_pull_request` all match.
 * Fails closed: a false positive only blocks while the flag is off.
 */
const NAME_EXACT = new Set(["rollout", "rollback", "release", "promote"]);

function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((t) => (t.length > 3 && t.endsWith("s") ? t.slice(0, -1) : t));
}

const isDeployToken = (t: string) => t.startsWith("deploy");
const isMergeToken = (t: string) => /^merge(?!able|ability)/.test(t);

export function isDeployMergeTool(toolName: string, remoteDescription?: string): boolean {
  if (tokenize(toolName).some((t) => isDeployToken(t) || isMergeToken(t) || NAME_EXACT.has(t))) return true;
  // Squashed names (`deployprod`) have no separator to split on.
  if (toolName.toLowerCase().replace(/[^a-z0-9]/g, "").includes("deploy")) return true;
  if (remoteDescription && tokenize(remoteDescription).some((t) => isDeployToken(t) || isMergeToken(t))) return true;
  return false;
}

export function disabledFeatureForTool(
  toolName: string,
  opts: { dynamic?: boolean; description?: string } = {},
): OutboundFeature | null {
  // Connector tools never match the static contact-tool map (their names are
  // namespaced); they are only subject to the deploy/merge classifier.
  const features = opts.dynamic ? undefined : OUTBOUND_TOOL_GATES[toolName];
  if (features) {
    const hit = features.find((feature) => !isOutboundFeatureEnabled(feature));
    if (hit) return hit;
  }
  if (!isOutboundFeatureEnabled("deploy_merge") && isDeployMergeTool(toolName, opts.dynamic ? opts.description : undefined)) {
    return "deploy_merge";
  }
  return null;
}
