import {
  assertPublicUrl,
  type ExternalAdapter,
  type ExternalConnConfig,
  type FetchResult,
  type NormalizedExecution,
  type NormalizedStatus,
} from "./types";
import { mapGenericStatus, toIso, pickArray } from "./generic";

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
};
