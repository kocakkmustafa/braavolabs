/**
 * BRA-P0-04a — Ortak iş tipleri ve işler gelen kutusu kovası (ADR-0003).
 *
 * `JobState` ve `ResultStatus` Prisma enum'larıyla (schema.prisma `JobState`,
 * `ResultStatus`) birebir aynıdır; `JobReceipt` `job_receipts` satırının JSON
 * görünümüdür (Date yerine ISO string, Decimal yerine sayı). `jobBucket` saf bir
 * fonksiyondur: I/O, Prisma ve saat okuması yoktur (`now` dışarıdan gelir).
 */

export const JOB_STATES = [
  "DRAFT",
  "PLANNED",
  "READY",
  "RUNNING",
  "NEEDS_APPROVAL",
  "RESUMING",
  "PAUSED",
  "FAILED",
  "CANCELLED",
  "COMPLETED",
] as const;
export type JobState = (typeof JOB_STATES)[number];

export const RESULT_STATUSES = ["VERIFIED", "UNVERIFIED"] as const;
export type ResultStatus = (typeof RESULT_STATUSES)[number];

/** Prisma `RunStatus` (7 eski değer; istemciler hâlâ bunu okur). */
export const LEGACY_RUN_STATUS_VALUES = [
  "PENDING",
  "RUNNING",
  "PAUSED",
  "WAITING_APPROVAL",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
] as const;
export type LegacyRunStatusValue = (typeof LEGACY_RUN_STATUS_VALUES)[number];

export type JobReceiptEvidenceKind = "diff" | "test" | "pr" | "artifact" | "log";

export interface JobReceiptEvidence {
  kind: JobReceiptEvidenceKind;
  ref: string;
  ok?: boolean;
}

/** `job_receipts` satırı (append-only). */
export interface JobReceipt {
  id: string;
  runId: string;
  tenantId: string;
  outcome: JobState;
  resultStatus: ResultStatus | null;
  costUsd: number | null;
  evidence: JobReceiptEvidence[];
  approvalIds: string[];
  contentHash: string;
  /** ISO 8601 */
  createdAt: string;
}

export const INBOX_BUCKETS = ["working", "needs_approval", "done", "stuck"] as const;
export type InboxBucket = (typeof INBOX_BUCKETS)[number];

export interface JobBucketInput {
  /** `runs.state`; yalnız JOB_STATE_DUAL_WRITE ile dolar, yoksa null. */
  state?: string | null;
  /** Eski `runs.status` (RunStatus). */
  status?: string | null;
  resultStatus?: string | null;
  heartbeatAt?: Date | string | number | null;
  now: Date | string | number;
  staleAfterMs: number;
}

const STATE_BUCKET: Record<JobState, InboxBucket | null> = {
  DRAFT: null,
  PLANNED: "working",
  READY: "working",
  RUNNING: "working",
  RESUMING: "working",
  NEEDS_APPROVAL: "needs_approval",
  COMPLETED: "done",
  CANCELLED: "done",
  FAILED: "stuck",
  PAUSED: "stuck",
};

/** `state` NULL iken eski `status`tan kova (PENDING = READY: eski koşular doğrudan kuyruğa alınırdı). */
const LEGACY_BUCKET: Record<LegacyRunStatusValue, InboxBucket> = {
  PENDING: "working",
  RUNNING: "working",
  WAITING_APPROVAL: "needs_approval",
  COMPLETED: "done",
  CANCELLED: "done",
  FAILED: "stuck",
  PAUSED: "stuck",
};

function toMs(v: Date | string | number): number {
  return v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(v);
}

function isOwn<T extends string>(table: Record<T, unknown>, key: string): key is T {
  return Object.prototype.hasOwnProperty.call(table, key);
}

/** true = RUNNING koşunun kalp atışı bayat ya da okunamıyor (fail-closed). Kalp atışı yoksa (null) yargı yok. */
function isStale(
  heartbeatAt: JobBucketInput["heartbeatAt"],
  now: JobBucketInput["now"],
  staleAfterMs: number,
): boolean {
  if (heartbeatAt === null || heartbeatAt === undefined) return false;
  const hb = toMs(heartbeatAt);
  const n = toMs(now);
  if (!Number.isFinite(hb) || !Number.isFinite(n) || !Number.isFinite(staleAfterMs) || staleAfterMs < 0) {
    return true;
  }
  return n - hb > staleAfterMs;
}

/**
 * İşi gelen kutusu kovasına eşler. `null` = gelen kutusunda görünmez (DRAFT).
 * Kurallar (ADR-0003): `state` doluysa o kazanır, `status` yok sayılır; `state`
 * NULL ise eski `status`a düşülür; bilinmeyen/bozuk girdi `stuck` (iş gizlenmez);
 * bayat kalp atışlı RUNNING `stuck`.
 */
export function jobBucket(input: JobBucketInput): InboxBucket | null {
  const { state, status, resultStatus, heartbeatAt, now, staleAfterMs } = input;

  let bucket: InboxBucket | null;
  let running = false;
  if (state !== null && state !== undefined) {
    if (!isOwn(STATE_BUCKET, state)) return "stuck";
    bucket = STATE_BUCKET[state];
    running = state === "RUNNING";
  } else {
    if (typeof status !== "string" || !isOwn(LEGACY_BUCKET, status)) return "stuck";
    bucket = LEGACY_BUCKET[status];
    running = status === "RUNNING";
  }
  if (bucket === null) return null;

  if (
    resultStatus !== null &&
    resultStatus !== undefined &&
    !(RESULT_STATUSES as readonly string[]).includes(resultStatus)
  ) {
    return "stuck";
  }

  if (running && isStale(heartbeatAt, now, staleAfterMs)) return "stuck";
  return bucket;
}
