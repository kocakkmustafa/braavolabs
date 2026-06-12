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

export interface ExternalAdapter {
  platform: string;
  fetchExecutions(cfg: ExternalConnConfig): Promise<FetchResult>;
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
