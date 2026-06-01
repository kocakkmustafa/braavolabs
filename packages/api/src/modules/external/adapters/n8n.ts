import {
  assertPublicUrl,
  type ExternalAdapter,
  type ExternalConnConfig,
  type FetchResult,
  type NormalizedExecution,
  type NormalizedStatus,
} from "./types";

/** Map an n8n execution record to our normalised status. */
function mapStatus(e: any): NormalizedStatus {
  const s = String(e?.status ?? "").toLowerCase();
  if (s === "running" || s === "new" || s === "waiting") return "RUNNING";
  if (s === "success") return "COMPLETED";
  if (s === "error" || s === "failed" || s === "crashed") return "FAILED";
  if (s === "canceled" || s === "cancelled") return "CANCELLED";
  // Older n8n returns `finished: boolean` instead of `status`.
  if (e?.finished === true) return "COMPLETED";
  if (e?.finished === false) return "RUNNING";
  return "PENDING";
}

/**
 * n8n adapter. Uses the public API: GET {baseUrl}/api/v1/executions with the
 * `X-N8N-API-KEY` header (the same header the outbound webhook bridge uses).
 * Execution ids are increasing integers — we carry the max seen as the cursor.
 */
export const n8nAdapter: ExternalAdapter = {
  platform: "N8N",
  async fetchExecutions(cfg: ExternalConnConfig): Promise<FetchResult> {
    const base = assertPublicUrl(cfg.baseUrl);
    const u = new URL("api/v1/executions", base.toString().endsWith("/") ? base : new URL(base.toString() + "/"));
    u.searchParams.set("limit", "50");
    u.searchParams.set("includeData", "false");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    try {
      const res = await fetch(u.toString(), {
        headers: { "X-N8N-API-KEY": cfg.apiKey, Accept: "application/json" },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`n8n API returned ${res.status}`);
      const body = (await res.json()) as { data?: any[] };
      const list = Array.isArray(body.data) ? body.data : [];

      const executions: NormalizedExecution[] = list.map((e) => ({
        externalId: String(e.id),
        workflowName: e.workflowData?.name ?? e.workflowName ?? undefined,
        status: mapStatus(e),
        startedAt: e.startedAt ?? undefined,
        finishedAt: e.stoppedAt ?? e.finishedAt ?? undefined,
        raw: { id: e.id, finished: e.finished, mode: e.mode, status: e.status, retryOf: e.retryOf },
      }));

      const maxId = list.reduce(
        (m, e) => Math.max(m, Number(e.id) || 0),
        Number(cfg.cursor) || 0,
      );
      return { executions, cursor: maxId ? String(maxId) : cfg.cursor ?? undefined };
    } finally {
      clearTimeout(timer);
    }
  },
};
