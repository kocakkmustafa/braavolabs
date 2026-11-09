/**
 * BRA-P0-04b — gelen kutusu kovası → Prisma where (ADR-0003).
 *
 * jobBucket() (core) tek doğruluk kaynağıdır; buradaki where onunla AYNI
 * eşlemeyi SQL tarafında yapar: runs.state doluysa o kazanır, NULL ise eski
 * status'a düşülür; bayat kalp atışlı RUNNING stuck sayılır; DRAFT hiçbir
 * kovada görünmez. Tutarlılık __tests__/job-bucket-query.test.ts ile kilitli.
 */
import type { Prisma } from "@prisma/client";
import { INBOX_BUCKETS, type InboxBucket } from "@ai-company-os/core";

export const DEFAULT_JOB_STALE_AFTER_MS = 15 * 60_000;

/** Bayat kalp atışı eşiği (ms). JOB_HEARTBEAT_STALE_MS ile ayarlanır; geçersizse 15 dk. */
export function jobStaleAfterMs(): number {
  const raw = Number(process.env.JOB_HEARTBEAT_STALE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_JOB_STALE_AFTER_MS;
}

export function isInboxBucket(v: unknown): v is InboxBucket {
  return typeof v === "string" && (INBOX_BUCKETS as readonly string[]).includes(v);
}

type RunWhere = Prisma.RunWhereInput;

const NON_DRAFT_STATES = [
  "PLANNED", "READY", "RUNNING", "NEEDS_APPROVAL", "RESUMING", "PAUSED", "FAILED", "CANCELLED", "COMPLETED",
] as const;

function freshHeartbeat(cutoff: Date): RunWhere {
  return { OR: [{ heartbeatAt: null }, { heartbeatAt: { gte: cutoff } }] };
}

/** Kova için where; bucket yoksa gelen kutusunda görünen (DRAFT olmayan) tüm koşular. */
export function bucketWhere(bucket: InboxBucket | undefined, now: Date, staleAfterMs: number): RunWhere {
  const cutoff = new Date(now.getTime() - staleAfterMs);
  const fresh = freshHeartbeat(cutoff);
  const stale: RunWhere = { heartbeatAt: { lt: cutoff } };
  switch (bucket) {
    case "working":
      return {
        OR: [
          { state: { in: ["PLANNED", "READY", "RESUMING"] } },
          { AND: [{ state: "RUNNING" }, fresh] },
          { state: null, status: "PENDING" },
          { AND: [{ state: null, status: "RUNNING" }, fresh] },
        ],
      };
    case "needs_approval":
      return { OR: [{ state: "NEEDS_APPROVAL" }, { state: null, status: "WAITING_APPROVAL" }] };
    case "done":
      return {
        OR: [
          { state: { in: ["COMPLETED", "CANCELLED"] } },
          { state: null, status: { in: ["COMPLETED", "CANCELLED"] } },
        ],
      };
    case "stuck":
      return {
        OR: [
          { state: { in: ["FAILED", "PAUSED"] } },
          { AND: [{ state: "RUNNING" }, stale] },
          { state: null, status: { in: ["FAILED", "PAUSED"] } },
          { AND: [{ state: null, status: "RUNNING" }, stale] },
        ],
      };
    default:
      return { OR: [{ state: null }, { state: { in: [...NON_DRAFT_STATES] } }] };
  }
}
