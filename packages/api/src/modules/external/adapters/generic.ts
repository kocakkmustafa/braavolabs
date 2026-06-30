import {
  assertPublicUrl,
  type ControlResult,
  type ExternalAdapter,
  type ExternalConnConfig,
  type FetchResult,
  type NormalizedExecution,
  type NormalizedStatus,
} from "./types";

/**
 * Generic REST poll adapter — the universal escape hatch.
 *
 * Unlike n8n (which exposes a uniform GET /executions), Make and Zapier don't
 * give third parties a single pollable run-history endpoint: Make's history is
 * per-scenario, and Zapier has no public task-history read API at all. The
 * portable answer is to point this adapter at ANY JSON endpoint the user can
 * expose — a Make scenario/Data Store that echoes its run list, a Zapier
 * "Storage"/webhook collector, or a home-grown status feed — and normalise
 * whatever common shape it returns.
 *
 * Accepts an array, or `{ executions | runs | data | results: [...] }`. Field
 * names are matched loosely (id/status/startedAt aliases). Auth is sent BOTH
 * as `Authorization: Bearer` and `X-API-Key` so it works against most setups.
 */

export function mapGenericStatus(s: unknown): NormalizedStatus {
  const v = String(s ?? "").toLowerCase().trim();
  if (["running", "in_progress", "in-progress", "started", "new", "waiting", "queued", "active"].includes(v)) return "RUNNING";
  if (["success", "succeeded", "completed", "complete", "ok", "done", "finished", "true", "1"].includes(v)) return "COMPLETED";
  if (["error", "failed", "failure", "errored", "crashed", "halted", "false"].includes(v)) return "FAILED";
  if (["canceled", "cancelled", "aborted", "stopped", "skipped"].includes(v)) return "CANCELLED";
  return "PENDING";
}

function pick(o: any, keys: string[]): any {
  for (const k of keys) if (o != null && o[k] != null) return o[k];
  return undefined;
}

/**
 * Defensively extract the execution array from an arbitrary response body.
 * Returns the body itself if it's already an array, else the first listed key
 * whose value IS an array, else []. Guards against a key being present but
 * non-array (e.g. `{executions: 5}`) which would otherwise crash `.slice`.
 */
export function pickArray(body: any, keys: string[]): any[] {
  if (Array.isArray(body)) return body;
  for (const k of keys) if (Array.isArray(body?.[k])) return body[k];
  return [];
}

/** Coerce epoch (s or ms) or date-ish string to an ISO string, else undefined. */
export function toIso(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (typeof v === "number") {
    const ms = v < 1e12 ? v * 1000 : v; // seconds vs millis heuristic
    const d = new Date(ms);
    return isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** Normalise an arbitrary record into our execution shape (exported for tests). */
export function normalizeGenericRecord(e: any): NormalizedExecution | null {
  const startedAt = toIso(pick(e, ["startedAt", "started_at", "createdAt", "created_at", "timestamp", "time", "start", "date"]));
  const finishedAt = toIso(pick(e, ["finishedAt", "finished_at", "completedAt", "completed_at", "stoppedAt", "endedAt", "end"]));
  const name = pick(e, ["workflowName", "name", "title", "scenario", "zap", "workflow"]);
  let externalId = pick(e, ["externalId", "id", "uuid", "runId", "run_id", "execution_id", "executionId"]);
  // No natural id → derive a deterministic key so re-polls upsert the same row
  // (a random id would duplicate the run on every tick).
  if (externalId == null) {
    if (!name && !startedAt) return null; // nothing stable to key on — skip
    externalId = `${name ?? "run"}@${startedAt ?? finishedAt ?? ""}`;
  }
  return {
    externalId: String(externalId),
    workflowName: name != null ? String(name) : undefined,
    status: mapGenericStatus(pick(e, ["status", "state", "result", "outcome", "finished"])),
    startedAt,
    finishedAt,
    raw: { status: pick(e, ["status", "state", "result", "outcome"]) },
  };
}

export const genericAdapter: ExternalAdapter = {
  platform: "GENERIC",
  // No standard control API exists for an arbitrary endpoint (this is also how
  // Zapier connects — it has no run-control API). The one honest lever is a
  // trigger webhook: POST to a URL the user supplies.
  capabilities: { discover: false, trigger: true, pauseResume: false, stopExecution: false },
  async fetchExecutions(cfg: ExternalConnConfig): Promise<FetchResult> {
    const base = await assertPublicUrl(cfg.baseUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    try {
      const res = await fetch(base.toString(), {
        headers: {
          Authorization: `Bearer ${cfg.apiKey}`,
          "X-API-Key": cfg.apiKey,
          Accept: "application/json",
        },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Endpoint returned ${res.status}`);
      const body: any = await res.json();
      const list = pickArray(body, ["executions", "runs", "data", "results"]);

      const executions: NormalizedExecution[] = list
        .slice(0, 100)
        .map(normalizeGenericRecord)
        .filter((e): e is NormalizedExecution => e != null);

      // Best-effort numeric cursor (max id) when ids are numeric; otherwise
      // leave the prior cursor — upserts are idempotent so it's advisory only.
      const maxNumeric = executions.reduce((m, e) => {
        const n = Number(e.externalId);
        return Number.isFinite(n) ? Math.max(m, n) : m;
      }, Number(cfg.cursor) || 0);
      return { executions, cursor: maxNumeric ? String(maxNumeric) : cfg.cursor ?? undefined };
    } finally {
      clearTimeout(timer);
    }
  },

  async triggerWorkflow(cfg: ExternalConnConfig, targetId: string): Promise<ControlResult> {
    // targetId is a full https webhook URL (e.g. a Zapier catch hook). SSRF-guard
    // it the same way as the read endpoint before POSTing.
    const hook = await assertPublicUrl(targetId);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    try {
      const res = await fetch(hook.toString(), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cfg.apiKey}`,
          "X-API-Key": cfg.apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ source: "braavolabs", triggeredAt: new Date().toISOString() }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Trigger webhook returned ${res.status}`);
      return { ok: true, detail: "Webhook triggered", raw: { url: hook.origin + hook.pathname } };
    } finally {
      clearTimeout(timer);
    }
  },
};
