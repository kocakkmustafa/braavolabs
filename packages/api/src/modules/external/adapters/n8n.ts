import {
  assertPublicUrl,
  type ControlResult,
  type ExternalAdapter,
  type ExternalConnConfig,
  type ExternalWorkflowSummary,
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

/** Build an n8n public-API URL from the instance base + a relative path. */
async function n8nUrl(baseUrl: string, path: string): Promise<URL> {
  const base = await assertPublicUrl(baseUrl);
  const root = base.toString().endsWith("/") ? base : new URL(base.toString() + "/");
  return new URL(path, root);
}

/** GET/POST against the n8n API with the shared header + a 12s timeout. */
async function n8nFetch(url: URL, apiKey: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    return await fetch(url.toString(), {
      ...init,
      headers: { "X-N8N-API-KEY": apiKey, Accept: "application/json" },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * n8n adapter. Uses the public API: GET {baseUrl}/api/v1/executions with the
 * `X-N8N-API-KEY` header (the same header the outbound webhook bridge uses).
 * Execution ids are increasing integers — we carry the max seen as the cursor.
 */
export const n8nAdapter: ExternalAdapter = {
  platform: "N8N",
  // n8n's public API can list + activate/deactivate workflows, but cannot start
  // a run (that's a trigger-node/webhook concern) nor stop a live execution.
  capabilities: { discover: true, trigger: false, pauseResume: true, stopExecution: false },
  async fetchExecutions(cfg: ExternalConnConfig): Promise<FetchResult> {
    const base = await assertPublicUrl(cfg.baseUrl);
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

  async discoverWorkflows(cfg: ExternalConnConfig): Promise<ExternalWorkflowSummary[]> {
    const u = await n8nUrl(cfg.baseUrl, "api/v1/workflows");
    u.searchParams.set("limit", "100");
    const res = await n8nFetch(u, cfg.apiKey);
    if (!res.ok) throw new Error(`n8n API returned ${res.status}`);
    const body = (await res.json()) as { data?: any[] };
    const list = Array.isArray(body.data) ? body.data : [];
    return list.map((w) => ({ id: String(w.id), name: w.name ?? `workflow ${w.id}`, active: !!w.active }));
  },

  async setActive(cfg: ExternalConnConfig, targetId: string, active: boolean): Promise<ControlResult> {
    const verb = active ? "activate" : "deactivate";
    const u = await n8nUrl(cfg.baseUrl, `api/v1/workflows/${encodeURIComponent(targetId)}/${verb}`);
    const res = await n8nFetch(u, cfg.apiKey, { method: "POST" });
    if (!res.ok) throw new Error(`n8n ${verb} returned ${res.status}`);
    return { ok: true, detail: `Workflow ${active ? "resumed" : "paused"}`, raw: { workflowId: targetId, active } };
  },
};
