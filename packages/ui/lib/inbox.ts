/**
 * BRA-P0-04e — Gelen kutusu (/inbox) saf yardımcıları. I/O yok.
 * Tipler `@ai-company-os/core`dan gelir (InboxBucket, JobState, JobReceipt);
 * kova hesabı sunucudadır (`GET /runs?bucket=`), burada yalnız görünüm kararı var.
 */
import { INBOX_BUCKETS, JOB_STATES, type InboxBucket, type JobState } from "@ai-company-os/core";

export const INBOX_TABS: readonly InboxBucket[] = INBOX_BUCKETS;

export interface InboxRun {
  id: string;
  pipelineId: string;
  status: string;
  state: JobState | null;
  resultStatus: "VERIFIED" | "UNVERIFIED" | null;
  trigger?: string | null;
  costUsd?: number | string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  heartbeatAt?: string | null;
  createdAt: string;
  updatedAt: string;
  bucket: InboxBucket | null;
  pipeline?: { id: string; name: string; company?: { id: string; name: string } | null } | null;
}
export interface InboxRunsPage { runs: InboxRun[]; nextCursor: string | null }

export interface InboxApproval {
  id: string;
  runId: string;
  type?: string;
  status: string;
  description?: string | null;
  amountUsd?: number | string | null;
  createdAt: string;
  metadata?: { toolName?: string };
}
export interface InboxApprovalGroup { runId: string; runTitle: string | null; approvals: InboxApproval[] }
export interface InboxApprovalGroupsPage { groups: InboxApprovalGroup[]; nextCursor: string | null }

export function isInboxBucket(v: unknown): v is InboxBucket {
  return typeof v === "string" && (INBOX_BUCKETS as readonly string[]).includes(v);
}

/** Sekme bulunamazsa ilk sekme; `#hash`/`?bucket=` gibi dış girdi için güvenli. */
export function tabFromValue(v: unknown): InboxBucket {
  return isInboxBucket(v) ? v : INBOX_TABS[0];
}

/** WAI-ARIA tablist: ok tuşları (RTL'de yatay yön tersine döner), Home/End; çevrel. */
export function nextTabIndex(key: string, index: number, count: number, rtl = false): number | null {
  if (count <= 0) return null;
  const forward = rtl ? "ArrowLeft" : "ArrowRight";
  const backward = rtl ? "ArrowRight" : "ArrowLeft";
  if (key === forward) return (index + 1) % count;
  if (key === backward) return (index - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

/** Sayfa birleştirme: kimliğe göre tekilleştirir (imleç kayması çift satır üretmesin); sıra korunur. */
export function mergeById<T extends { id: string }>(existing: readonly T[], incoming: readonly T[]): T[] {
  const seen = new Set(existing.map((x) => x.id));
  const out = existing.slice();
  for (const item of incoming) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

/** Onay gruplarını koşuya göre birleştirir (sayfa sınırı bir koşunun grubunu bölebilir). */
export function mergeApprovalGroups(existing: readonly InboxApprovalGroup[], incoming: readonly InboxApprovalGroup[]): InboxApprovalGroup[] {
  const out = existing.map((g) => ({ ...g, approvals: g.approvals.slice() }));
  const byRun = new Map(out.map((g) => [g.runId, g]));
  for (const g of incoming) {
    const cur = byRun.get(g.runId);
    if (cur) cur.approvals = mergeById(cur.approvals, g.approvals);
    else {
      const copy = { ...g, approvals: g.approvals.slice() };
      out.push(copy);
      byRun.set(g.runId, copy);
    }
  }
  return out;
}

export type RunAction = "resume" | "pause" | "stop" | "retry" | "steer";

const LEGACY_TO_STATE: Record<string, JobState> = {
  PENDING: "READY", RUNNING: "RUNNING", PAUSED: "PAUSED",
  WAITING_APPROVAL: "NEEDS_APPROVAL", COMPLETED: "COMPLETED", FAILED: "FAILED", CANCELLED: "CANCELLED",
};

/** `state` doluysa o, yoksa eski `status` (ADR-0003); bilinmeyen = null. */
export function effectiveState(run: Pick<InboxRun, "state" | "status">): JobState | null {
  if (run.state && (JOB_STATES as readonly string[]).includes(run.state)) return run.state;
  return Object.prototype.hasOwnProperty.call(LEGACY_TO_STATE, run.status) ? LEGACY_TO_STATE[run.status] : null;
}

/**
 * Yalnız durumun izin verdiği eylemler (sunucu yine de doğrular; bu yalnız görünürlük).
 * NEEDS_APPROVAL'da resume YOK: karar /approvals'tan verilir. Bayat kalp atışlı RUNNING
 * (bucket=stuck) önce durdurulur (retry run_still_running döner).
 */
export function allowedActions(run: Pick<InboxRun, "state" | "status" | "bucket">): RunAction[] {
  const st = effectiveState(run);
  switch (st) {
    case "PLANNED": case "READY": case "RESUMING": return ["steer", "stop"];
    case "RUNNING": return run.bucket === "stuck" ? ["stop"] : ["steer", "pause", "stop"];
    case "NEEDS_APPROVAL": return ["steer", "stop"];
    case "PAUSED": return ["resume", "retry", "steer", "stop"];
    case "FAILED": return ["retry"];
    default: return [];
  }
}

export const CONFLICT_CODES = [
  "retry_disabled", "run_still_running", "already_retrying",
  "approval_pending", "retry_budget_exhausted", "run_not_retryable",
] as const;
export type ConflictCode = (typeof CONFLICT_CODES)[number];

/** Eylem hatası → `app.inbox.*` mesaj anahtarı. 409 koduna göre; kodsuz 409 ve diğerleri genel. */
export function actionErrorKey(err: unknown): string {
  const e = err as { status?: unknown; code?: unknown } | null;
  if (e && typeof e === "object" && e.status === 409) {
    if (typeof e.code === "string" && (CONFLICT_CODES as readonly string[]).includes(e.code)) return `app.inbox.conflict.${e.code}`;
    return "app.inbox.conflict.generic";
  }
  if (e && typeof e === "object" && e.status === 403) return "app.inbox.actionForbidden";
  return "app.inbox.actionFailed";
}

export type ReceiptView =
  | { kind: "none" }
  | { kind: "ready"; verified: boolean | null };

export function receiptVerified(r: { resultStatus: string | null }): boolean | null {
  return r.resultStatus === "VERIFIED" ? true : r.resultStatus === "UNVERIFIED" ? false : null;
}

/** Yanıt şekli beklenenden farklıysa FIRLATIR: sessiz boş liste yok (UI hata durumu gösterir). */
export class InboxShapeError extends Error {
  constructor(what: string) { super(`Unexpected ${what} response shape`); this.name = "InboxShapeError"; }
}
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const cursorOf = (v: unknown, what: string): string | null => {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v;
  throw new InboxShapeError(what);
};

/** GET /runs → `{ runs, nextCursor }` GÖVDEDE (X-Next-Cursor başlığı YOK). */
export function parseRunsPage(raw: unknown): InboxRunsPage {
  if (!isObj(raw) || !Array.isArray(raw.runs)) throw new InboxShapeError("runs");
  for (const r of raw.runs) if (!isObj(r) || typeof r.id !== "string" || typeof r.status !== "string") throw new InboxShapeError("runs");
  return { runs: raw.runs as InboxRun[], nextCursor: cursorOf(raw.nextCursor, "runs") };
}

/** GET /approvals?groupBy=run → `{ groups, nextCursor }` GÖVDEDE. (Düz mod: dizi + X-Next-Cursor başlığı.) */
export function parseApprovalGroupsPage(raw: unknown): InboxApprovalGroupsPage {
  if (!isObj(raw) || !Array.isArray(raw.groups)) throw new InboxShapeError("approval groups");
  for (const g of raw.groups) {
    if (!isObj(g) || typeof g.runId !== "string" || !Array.isArray(g.approvals)) throw new InboxShapeError("approval groups");
    for (const a of g.approvals) if (!isObj(a) || typeof a.id !== "string") throw new InboxShapeError("approval groups");
  }
  return { groups: raw.groups as InboxApprovalGroup[], nextCursor: cursorOf(raw.nextCursor, "approval groups") };
}

/** Düz modda imleç başlıkta; başlığı olmayan/boş değer = son sayfa. */
export function cursorFromHeaders(h: { get(name: string): string | null }): string | null {
  const v = h.get("X-Next-Cursor");
  return v && v.length > 0 ? v : null;
}
