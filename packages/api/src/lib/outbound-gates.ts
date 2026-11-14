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
 * (static and connector tools) and, for connector tools, on the REMOTE
 * description too (a tool named `run` that "deploys the app"), plus the
 * connector slug / display name (a deploy-looking connector taints ALL its
 * tools; fail closed, no allowlist).
 *
 * Normalisation before matching (input is clipped FIRST so cost is bounded):
 * strip format/combining chars (ZWSP, soft hyphen, ...), NFKC, a small
 * Cyrillic/Greek look-alike map, camelCase splitting (`PRMerge`, `mergePR`)
 * and leet folding (0->o 1->i|l 3->e 4->a 5->s 7->t $->s @->a).
 *
 * Name blocking rules:
 *  - folds to deploy/merge (also homoglyph-only names such as an all-Cyrillic
 *    look-alike of `deploy`), or
 *  - script mixing inside one token (Latin ASCII letters together with
 *    Cyrillic/Greek ones): a homoglyph disguise.
 * Purely single-script names (Turkish, Arabic, Cyrillic, CJK, ...) pass.
 * `deploy` also matches squashed (`deployprod`). `merge` matches as a token
 * prefix/suffix (`automerge_pr`) or joined across tokens (`mer_ge_pr`,
 * `automergepr`), but not `mergeable` / `emergency` / `emerge`, and a join
 * that straddles words in the middle (`customer_get`) is ignored.
 * Fail closed by design: read-looking names such as `deployment_status` are
 * blocked too while the flag is off; a false positive only blocks.
 * Non-string input (number, object, null) is treated as a match.
 */
const NAME_EXACT = new Set(["rollout", "rollback", "release", "promote"]);

const MAX_NAME = 200;
const MAX_DESC_HEAD = 4000;
const MAX_DESC_TAIL = 1000;

const CONFUSABLES: Record<string, string> = {
  "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "у": "y", "х": "x", "і": "i",
  "ѕ": "s", "ј": "j", "ԁ": "d", "һ": "h", "ӏ": "l", "в": "b", "к": "k", "м": "m",
  "н": "h", "т": "t",
  "α": "a", "ε": "e", "ο": "o", "ρ": "p", "ν": "v", "ι": "i", "κ": "k", "τ": "t",
  "υ": "u", "χ": "x", "δ": "d", "μ": "m",
};
const LEET: Record<string, string> = { "0": "o", "3": "e", "4": "a", "5": "s", "7": "t", $: "s", "@": "a" };

function clipName(text: string): string {
  return text.length > MAX_NAME ? text.slice(0, MAX_NAME) : text;
}

/** Head + tail of an over-long description so a verb hidden in the tail is still seen. */
function clipDescription(text: string): string {
  if (text.length <= MAX_DESC_HEAD + MAX_DESC_TAIL) return text;
  return `${text.slice(0, MAX_DESC_HEAD)} ${text.slice(-MAX_DESC_TAIL)}`;
}

function stripInvisible(text: string): string {
  return text.replace(/[\p{Cf}\p{M}]/gu, "");
}

function foldBase(text: string): string {
  return stripInvisible(text)
    .normalize("NFKC")
    .replace(/[^\x00-\x7f]/g, (c) => CONFUSABLES[c.toLowerCase()] ?? c);
}

/** Token lists: camelCase-split and plain, each with `1` read as i and as l. */
function tokenVariants(folded: string): string[][] {
  const camel = folded
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[A-Z](?=[A-Z][a-z])/g, "$& ");
  const out: string[][] = [];
  for (const base of [camel, folded]) {
    const leet = base.toLowerCase().replace(/[03457$@]/g, (c) => LEET[c] ?? c);
    for (const one of ["i", "l"]) out.push(leet.replace(/1/g, one).split(/[^a-z0-9]+/).filter(Boolean));
  }
  return out;
}

const isDeployToken = (t: string) => t.startsWith("deploy");
const isMergeToken = (t: string) =>
  /^merge(?!able|ability)/.test(t) || (t.endsWith("merge") && t !== "emerge");

/** `merge` found in the tokens joined together (`mer_ge_pr`, `automergepr`). */
function joinedMergeHit(tokens: string[]): boolean {
  const starts = new Set<number>();
  const ends = new Set<number>();
  const bounds: number[] = [];
  let pos = 0;
  for (const t of tokens) {
    starts.add(pos);
    pos += t.length;
    ends.add(pos);
    bounds.push(pos);
  }
  const joined = tokens.join("");
  let i = joined.indexOf("merge");
  while (i !== -1) {
    const end = i + 5;
    const crosses = bounds.some((b) => b > i && b < end);
    const okBoundary = !crosses || starts.has(i) || ends.has(end);
    const rest = joined.slice(end, end + 7);
    const excluded =
      /^(able|ability|ncy|nce|nt)/.test(rest) || (i > 0 && joined[i - 1] === "e" && starts.has(i - 1));
    if (okBoundary && !excluded) return true;
    i = joined.indexOf("merge", i + 1);
  }
  return false;
}

function textHits(folded: string, isName: boolean): boolean {
  for (const tokens of tokenVariants(folded)) {
    if (tokens.some((t) => isDeployToken(t) || isMergeToken(t))) return true;
    if (isName && tokens.some((t) => NAME_EXACT.has(t))) return true;
    // Squashed (`deployprod`, `d-e-p-l-o-y`).
    if (tokens.join("").includes("deploy")) return true;
    if (joinedMergeHit(tokens)) return true;
  }
  return false;
}

/** Latin ASCII letters mixed with Cyrillic/Greek inside one token: homoglyph disguise. */
function mixesScripts(text: string): boolean {
  return stripInvisible(text)
    .normalize("NFKC")
    .split(/[^\p{L}\p{N}]+/u)
    .some((t) => /[A-Za-z]/.test(t) && /[\p{Script=Cyrillic}\p{Script=Greek}]/u.test(t));
}

export function isDeployMergeTool(toolName: unknown, remoteDescription?: unknown): boolean {
  // Anything that is not a string cannot be classified: fail closed, never throw.
  if (typeof toolName !== "string") return true;
  if (remoteDescription !== undefined && typeof remoteDescription !== "string") return true;
  const clipped = clipName(toolName);
  if (mixesScripts(clipped)) return true;
  if (textHits(foldBase(clipped), true)) return true;
  return typeof remoteDescription === "string" && textHits(foldBase(clipDescription(remoteDescription)), false);
}

export interface ToolCallGateOpts {
  /** Connector (MCP) tool resolved from request-scoped extraTools. */
  dynamic?: boolean;
  /** UNPREFIXED remote tool name (connector slug / display name excluded). When the key is present it is used strictly. */
  remoteName?: unknown;
  /** UNTRUNCATED remote description. */
  remoteDescription?: unknown;
  /** Connector slug / display name: a deploy/merge-looking connector taints ALL its tools. */
  connectorSlug?: unknown;
  connectorName?: unknown;
  /** Precomputed isDeployMergeCall result (the executor classifies once). */
  deployMerge?: boolean;
}

/**
 * Deploy/merge classification of one call. Primary signal: the remote tool
 * name + untruncated description. Additionally, a connector whose slug or name
 * classifies as deploy/merge makes ALL its tools deploy/merge (fail closed,
 * no allowlist): e.g. a `Deployer` connector's harmless-looking tool is
 * blocked while the flag is off and always needs approval when it is on.
 */
export function isDeployMergeCall(toolName: string, opts: ToolCallGateOpts = {}): boolean {
  if (!opts.dynamic) return isDeployMergeTool(toolName);
  const name = "remoteName" in opts ? opts.remoteName : toolName;
  if (isDeployMergeTool(name, opts.remoteDescription)) return true;
  return (
    (opts.connectorSlug !== undefined && isDeployMergeTool(opts.connectorSlug)) ||
    (opts.connectorName !== undefined && isDeployMergeTool(opts.connectorName))
  );
}

export function disabledFeatureForTool(toolName: string, opts: ToolCallGateOpts = {}): OutboundFeature | null {
  // Connector tools never match the static contact-tool map (their names are
  // namespaced); they are only subject to the deploy/merge classifier.
  const features = opts.dynamic ? undefined : OUTBOUND_TOOL_GATES[toolName];
  if (features) {
    const hit = features.find((feature) => !isOutboundFeatureEnabled(feature));
    if (hit) return hit;
  }
  if (isOutboundFeatureEnabled("deploy_merge")) return null;
  const deployMerge = opts.deployMerge ?? isDeployMergeCall(toolName, opts);
  return deployMerge ? "deploy_merge" : null;
}
