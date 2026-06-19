/**
 * n8n Webhook Bridge
 *
 * Sends webhook events to n8n for workflow automation. Behind a feature
 * flag (N8N_WEBHOOK_URL must be set + URL must point to a non-private
 * host). When the flag is off — the integration card UI may still be
 * shown, but pipeline calls log + skip rather than throwing so a single
 * misconfigured integration doesn't poison an otherwise-healthy run.
 */

import { assertPublicUrl, guardedFetch } from "../lib/net";

export interface N8nConfig {
  webhookUrl: string;
  apiKey?: string;
}

export async function triggerN8nWorkflow(
  config: N8nConfig,
  event: string,
  payload: Record<string, unknown>,
): Promise<{ status: "sent" | "skipped"; reason?: string }> {
  if (!config.webhookUrl) {
    return { status: "skipped", reason: "n8n integration not configured (N8N_WEBHOOK_URL empty)" };
  }

  // SSRF guard (FINDINGS H4) — resolve DNS and refuse any host that lands on
  // a private/loopback/link-local/CGNAT/cloud-metadata address. The previous
  // regex-only check was bypassable by a public hostname resolving to
  // 127.0.0.1 / 169.254.169.254. assertPublicUrl resolves A+AAAA and checks
  // every returned address.
  try {
    await assertPublicUrl(config.webhookUrl);
  } catch (err) {
    return { status: "skipped", reason: err instanceof Error ? err.message : String(err) };
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.apiKey) {
    headers["X-N8N-API-KEY"] = config.apiKey;
  }

  // guardedFetch adds a 10s timeout + bounded exponential-backoff retry
  // (FINDINGS H3) so a transient n8n blip doesn't silently drop the event.
  try {
    const res = await guardedFetch(
      config.webhookUrl,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ event, payload, ts: Date.now() }),
      },
      // URL already validated above; skip the duplicate guard inside fetch.
      { timeoutMs: 10_000, retries: 2, skipUrlGuard: true },
    );
    if (!res.ok) {
      return { status: "skipped", reason: `n8n returned ${res.status}` };
    }
    return { status: "sent" };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { status: "skipped", reason };
  }
}
