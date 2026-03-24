/**
 * n8n Webhook Bridge — Faz 1
 *
 * Sends webhook events to n8n for workflow automation.
 */

export interface N8nConfig {
  webhookUrl: string;
  apiKey?: string;
}

export async function triggerN8nWorkflow(
  _config: N8nConfig,
  _event: string,
  _payload: Record<string, unknown>,
): Promise<void> {
  // TODO: Faz 1
  throw new Error("Not implemented — Faz 1");
}
