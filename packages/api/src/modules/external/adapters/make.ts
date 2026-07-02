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
import { mapGenericStatus, toIso, pickArray } from "./generic";

/**
 * From a Make scenario-logs baseUrl derive the API root + the scenario id, e.g.
 *   https://eu1.make.com/api/v2/scenarios/12345/logs
 *     → { apiBase: https://eu1.make.com/api/v2/, scenarioId: "12345" }
 * Control endpoints live alongside /logs on the same zone host.
 */
async function parseMakeBase(baseUrl: string): Promise<{ apiBase: URL; scenarioId: string }> {
  const url = await assertPublicUrl(baseUrl);
  const m = url.pathname.match(/\/scenarios\/(\d+)/);
  if (!m) throw new Error("Make baseUrl must contain /scenarios/{id} (paste the scenario logs URL)");
  return { apiBase: new URL(`${url.origin}/api/v2/`), scenarioId: m[1] };
}

async function makeFetch(url: URL, apiKey: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    return await fetch(url.toString(), {
      ...init,
      headers: { Authorization: `Token ${apiKey}`, Accept: "application/json" },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Make (Integromat) adapter — Make API v2.
 *
 * Make's run history is per-scenario, so the connection's baseUrl is a Make
 * scenario-logs endpoint, e.g.
 *   https://eu1.make.com/api/v2/scenarios/{scenarioId}/logs
 * (zone host varies: eu1/eu2/us1…). Auth is `Authorization: Token {apiKey}`.
 * If the user pastes the scenario URL without the trailing `/logs`, we append
 * it best-effort. Responses wrap the list in `scenarioLogs` (older shapes use
 * `data` or a bare array — all handled).
 */

export function mapMakeStatus(log: any): NormalizedStatus {
  const s = String(log?.status ?? log?.type ?? "").toLowerCase();
  if (s.includes("success") || s === "ok") return "COMPLETED";
  if (s.includes("error") || s.includes("fail") || s.includes("warning")) return "FAILED";
  if (s.includes("incomplete") || s.includes("running") || s.includes("processing")) return "RUNNING";
  if (s.includes("cancel") || s.includes("stop")) return "CANCELLED";
  return mapGenericStatus(log?.status ?? log?.type);
}

export const makeAdapter: ExternalAdapter = {
  platform: "MAKE",
  // Make API v2 can list (the scenario in baseUrl), run, and start/stop a
  // scenario. Stopping a single in-flight execution isn't exposed.
  capabilities: { discover: true, trigger: true, pauseResume: true, stopExecution: false },
  async fetchExecutions(cfg: ExternalConnConfig): Promise<FetchResult> {
    const base = await assertPublicUrl(cfg.baseUrl);
    let target = base.toString();
    if (!/\/logs\/?(?:$|\?)/.test(target)) {
      target = target.replace(/\/$/, "") + "/logs";
    }
    const u = new URL(target);
    if (!u.searchParams.has("limit")) u.searchParams.set("limit", "50");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    try {
      const res = await fetch(u.toString(), {
        headers: { Authorization: `Token ${cfg.apiKey}`, Accept: "application/json" },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Make API returned ${res.status}`);
      const body: any = await res.json();
      const list = pickArray(body, ["scenarioLogs", "data"]);

      const executions: NormalizedExecution[] = list
        .slice(0, 100)
        .map((e: any): NormalizedExecution => {
          const id = e?.imt_id ?? e?.id ?? e?.executionId;
          const startedAt = toIso(e?.timestamp ?? e?.created ?? e?.startedAt);
          return {
            externalId: String(id ?? `make@${startedAt ?? ""}`),
            workflowName: e?.scenarioName ?? e?.name ?? undefined,
            status: mapMakeStatus(e),
            startedAt,
            finishedAt: toIso(e?.finishedAt ?? e?.stopped),
            raw: { status: e?.status, type: e?.type, operations: e?.operations, transfer: e?.transfer },
          };
        })
        .filter((e) => e.externalId !== "make@");

      const maxNumeric = executions.reduce((m, e) => {
        const n = Number(e.externalId);
        return Number.isFinite(n) ? Math.max(m, n) : m;
      }, Number(cfg.cursor) || 0);
      return { executions, cursor: maxNumeric ? String(maxNumeric) : cfg.cursor ?? undefined };
    } finally {
      clearTimeout(timer);
    }
  },

  async discoverWorkflows(cfg: ExternalConnConfig): Promise<ExternalWorkflowSummary[]> {
    // The connection is scenario-scoped (baseUrl is one scenario's logs), so we
    // surface that single scenario rather than the whole account.
    const { apiBase, scenarioId } = await parseMakeBase(cfg.baseUrl);
    const res = await makeFetch(new URL(`scenarios/${scenarioId}`, apiBase), cfg.apiKey);
    if (!res.ok) throw new Error(`Make API returned ${res.status}`);
    const body: any = await res.json();
    const s = body?.scenario ?? body;
    return [{ id: scenarioId, name: s?.name ?? `scenario ${scenarioId}`, active: !!(s?.isActive ?? s?.scheduling) }];
  },

  async triggerWorkflow(cfg: ExternalConnConfig, targetId: string): Promise<ControlResult> {
    const { apiBase, scenarioId } = await parseMakeBase(cfg.baseUrl);
    const id = targetId || scenarioId;
    const res = await makeFetch(new URL(`scenarios/${id}/run`, apiBase), cfg.apiKey, { method: "POST" });
    if (!res.ok) throw new Error(`Make run returned ${res.status}`);
    return { ok: true, detail: "Scenario run triggered", raw: { scenarioId: id } };
  },

  async setActive(cfg: ExternalConnConfig, targetId: string, active: boolean): Promise<ControlResult> {
    const { apiBase, scenarioId } = await parseMakeBase(cfg.baseUrl);
    const id = targetId || scenarioId;
    const verb = active ? "start" : "stop";
    const res = await makeFetch(new URL(`scenarios/${id}/${verb}`, apiBase), cfg.apiKey, { method: "POST" });
    if (!res.ok) throw new Error(`Make ${verb} returned ${res.status}`);
    return { ok: true, detail: `Scenario ${active ? "resumed" : "paused"}`, raw: { scenarioId: id, active } };
  },
};
