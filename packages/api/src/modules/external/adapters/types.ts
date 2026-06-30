/**
 * External-automation adapter contract.
 *
 * Each connected platform (n8n / Make / Zapier / generic) implements
 * `fetchExecutions`, returning the platform's recent runs normalised to our
 * RunStatus vocabulary. The poller upserts them into ExternalRun so the
 * dashboard shows native + external runs in one pane of glass.
 */
import { assertSafeExternalUrl } from "../../../lib/ssrf";

export type NormalizedStatus = "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";

export interface NormalizedExecution {
  /** The external system's own execution id — natural upsert key. */
  externalId: string;
  workflowName?: string;
  status: NormalizedStatus;
  startedAt?: string;
  finishedAt?: string;
  /** Bounded raw snapshot for the detail view (never the full payload). */
  raw?: unknown;
}

export interface FetchResult {
  executions: NormalizedExecution[];
  /** Opaque per-platform incremental cursor (e.g. last execution id seen). */
  cursor?: string;
}

export interface ExternalConnConfig {
  baseUrl: string;
  apiKey: string;
  cursor?: string | null;
}

// ── Control plane ──────────────────────────────────────────────
// The poll path only READS (fetchExecutions). The control plane lets the user
// (and, later, an approval-gated agent) ACT on the connected platform from one
// pane: trigger a run, pause/resume the automation, stop a running execution.
//
// Capabilities are declared HONESTLY per platform — we never expose a button
// the platform's API can't back. e.g. n8n's public API can activate/deactivate
// a workflow but cannot stop a running execution, and Zapier exposes no
// run-control API at all (so its only lever is a generic trigger webhook).

export type ExternalActionType = "TRIGGER" | "PAUSE" | "RESUME" | "STOP";

export interface ExternalCapabilities {
  /** List the automations on the platform (GET workflows/scenarios). */
  discover: boolean;
  /** Start a fresh run of an automation. */
  trigger: boolean;
  /** Activate / deactivate the automation (pause = future runs stop firing). */
  pauseResume: boolean;
  /** Stop an in-flight execution (rare — most platforms can't). */
  stopExecution: boolean;
}

export interface ExternalWorkflowSummary {
  id: string;
  name: string;
  /** Whether the automation is currently active/enabled, when knowable. */
  active?: boolean;
}

export interface ControlResult {
  ok: boolean;
  /** Human-readable outcome for the audit log + UI toast. */
  detail?: string;
  /** Bounded raw snapshot (never the full payload). */
  raw?: unknown;
}

export interface ExternalAdapter {
  platform: string;
  /** What this platform's API actually supports — drives the UI + the gate. */
  capabilities: ExternalCapabilities;
  fetchExecutions(cfg: ExternalConnConfig): Promise<FetchResult>;
  /** List automations. Required when capabilities.discover is true. */
  discoverWorkflows?(cfg: ExternalConnConfig): Promise<ExternalWorkflowSummary[]>;
  /**
   * Control actions. `targetId` is platform-specific:
   * - trigger / pause / resume → workflow or scenario id
   * - stopExecution → the running execution id
   * - GENERIC trigger → a full https webhook URL to POST to
   * Each is only present when its capability flag is true.
   */
  triggerWorkflow?(cfg: ExternalConnConfig, targetId: string): Promise<ControlResult>;
  setActive?(cfg: ExternalConnConfig, targetId: string, active: boolean): Promise<ControlResult>;
  stopExecution?(cfg: ExternalConnConfig, targetId: string): Promise<ControlResult>;
}

// ── Shared SSRF guard (mirrors integrations/src/n8n/webhook.ts) ──
// A tenant supplies the base URL; refuse private/loopback/link-local/metadata
// hosts so a connection can't be used to reach our own infra (169.254.169.254).
const PRIVATE_HOST_PATTERNS: RegExp[] = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^::1$/,
  /^fc00:/i,
  /^fe80:/i,
];

export async function assertPublicUrl(raw: string): Promise<URL> {
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Unsupported protocol: ${url.protocol}`);
  }
  // Fast-fail on the obvious patterns, then delegate to the DNS-resolving
  // guard used everywhere else (ai-client, MCP, research, SSO) — it also
  // catches decimal/hex/octal IP encodings and hostnames that resolve to
  // private ranges, which the regexes alone can't.
  if (PRIVATE_HOST_PATTERNS.some((re) => re.test(url.hostname))) {
    throw new Error(`Refusing to reach private host: ${url.hostname}`);
  }
  await assertSafeExternalUrl(url.toString());
  return url;
}
