/**
 * n8n Webhook Bridge
 *
 * Sends webhook events to n8n for workflow automation. Behind a feature
 * flag (N8N_WEBHOOK_URL must be set + URL must point to a non-private
 * host). When the flag is off — the integration card UI may still be
 * shown, but pipeline calls log + skip rather than throwing so a single
 * misconfigured integration doesn't poison an otherwise-healthy run.
 */

export interface N8nConfig {
  webhookUrl: string;
  apiKey?: string;
}

const PRIVATE_HOST_PATTERNS: RegExp[] = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./, // link-local
  /^::1$/, // ipv6 loopback
  /^fc00:/i, // ipv6 ULA
  /^fe80:/i, // ipv6 link-local
];

function isPrivateHost(hostname: string): boolean {
  return PRIVATE_HOST_PATTERNS.some((re) => re.test(hostname));
}

export async function triggerN8nWorkflow(
  config: N8nConfig,
  event: string,
  payload: Record<string, unknown>,
): Promise<{ status: "sent" | "skipped"; reason?: string }> {
  if (!config.webhookUrl) {
    return { status: "skipped", reason: "n8n integration not configured (N8N_WEBHOOK_URL empty)" };
  }

  let url: URL;
  try {
    url = new URL(config.webhookUrl);
  } catch {
    return { status: "skipped", reason: `Invalid n8n webhook URL: ${config.webhookUrl}` };
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { status: "skipped", reason: `Unsupported protocol: ${url.protocol}` };
  }

  // SSRF guard — refuse private/loopback/link-local hosts. n8n is meant to
  // be reached over the public internet (or an explicit allowlisted internal
  // hostname); a tenant-supplied URL pointing at 127.0.0.1 or 169.254.169.254
  // (cloud metadata) would let the agent loop hit our own infra.
  if (isPrivateHost(url.hostname)) {
    return { status: "skipped", reason: `Refusing to send webhook to private host: ${url.hostname}` };
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.apiKey) {
    headers["X-N8N-API-KEY"] = config.apiKey;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(config.webhookUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ event, payload, ts: Date.now() }),
      signal: controller.signal,
    });
    if (!res.ok) {
      return { status: "skipped", reason: `n8n returned ${res.status}` };
    }
    return { status: "sent" };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { status: "skipped", reason };
  } finally {
    clearTimeout(timeout);
  }
}
