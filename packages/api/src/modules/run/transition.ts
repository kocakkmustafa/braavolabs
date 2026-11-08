/**
 * BRA-P0-02b — `transitionRun`: the single writer of `Run` lifecycle state
 * (ADR-0001 karar 5). NOT wired into any existing writer yet: moving the 20+
 * direct `prisma.run.update({ status })` call sites is 02c, in small PRs. This
 * module adds the writer and the flag; importing it changes no behaviour.
 *
 * Compare-and-set: the write only lands if the row still has the `status` (and
 * `state`) we read, so a replayed webhook / double approve that reads the same
 * row loses the race instead of firing a second side effect. Callers run side
 * effects only when `ok && !noop`.
 *
 * Tenant scope (CLAUDE.md rule #10): `tenantId` is REQUIRED. The READ is scoped
 *   through `pipeline → company → tenantId` (a relation filter, so it works
 *   before AND after the migration — it does not use the new `runs.tenant_id`
 *   column). The WRITE is a scalar-only compare-and-set on `id + status
 *   (+ state)`: relation filters in `updateMany` may be executed by Prisma as
 *   select-ids-then-update, which would not make the CAS atomic, so the tenant
 *   check lives in the read of the SAME transaction and the write can only hit
 *   the row that read just verified. Call inside `tenantTx` so RLS is bound
 *   too; RLS is fail-open and is defence in depth, not the primary guarantee.
 *
 * JOB_STATE_DUAL_WRITE (default OFF, literal "true" only, read at call time —
 * same convention as `lib/outbound-gates.ts`):
 *   off  touches ONLY the legacy `status` column of THIS function's own
 *        select/where/data. It never selects or writes `state`, and `extra`
 *        may not carry any lifecycle column (rejected at compile time and at
 *        run time), so THIS function is safe even before the
 *        20261108000000_job_lifecycle migration. That is a property of
 *        `transitionRun` only: once the migration's Prisma client is
 *        deployed, every `prisma.run.*` query names the new columns, so the
 *        migration MUST be applied BEFORE the new app image starts (the
 *        deploy script already migrates first, then `up -d api ui`).
 *   on   also writes `state` (+ `resultStatus`), always together with
 *        `status = toLegacyStatus(state)` in the same UPDATE. `state` is
 *        filled on the first REAL transition; a same-state no-op writes
 *        nothing, so a row whose `state` is still NULL stays NULL.
 *
 * `status` stays authoritative until every writer goes through this function:
 * legacy writers still update only `status`, so a stored `state` can be stale.
 * The current state is therefore `state` only when it still projects onto
 * `status`; otherwise it is re-derived from `status` (self-healing).
 */
import type { Prisma } from "@prisma/client";
import {
  applyTransition,
  fromLegacyStatus,
  toLegacyStatus,
  type JobState,
  type LegacyRunStatus,
  type ResultStatus,
} from "./job-state";

/** Only the literal string "true" enables dual write; anything else (or unset) is off. */
export function isJobStateDualWriteEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.JOB_STATE_DUAL_WRITE === "true";
}

/** The slice of a Prisma (transaction) client this function needs — also what tests fake. */
export type RunTransitionClient = Pick<Prisma.TransactionClient, "run">;

/** Columns only `transitionRun` may write (identity, status/state projection and the job-lifecycle columns). */
export const RESERVED_RUN_COLUMNS = [
  "id",
  "pipelineId",
  "status",
  "state",
  "resultStatus",
  "tenantId",
  "workspaceId",
  "idempotencyKey",
  "planVersion",
  "evidenceRef",
  "retryCount",
  "heartbeatAt",
  "deadline",
] as const;
type ReservedRunColumn = (typeof RESERVED_RUN_COLUMNS)[number];

export interface TransitionOptions {
  /** Tenant that must own the run (required: rule #10). */
  tenantId: string;
  /** Other columns to write in the same UPDATE (completedAt, error, costUsd …). Lifecycle columns are rejected. */
  extra?: Omit<Prisma.RunUpdateManyMutationInput, ReservedRunColumn>;
  /** Written only with dual write on, and only meaningful when `to` is COMPLETED. */
  resultStatus?: ResultStatus | null;
  /** Override the env flag (tests, callers that already resolved it). */
  dualWrite?: boolean;
  /**
   * BRA-P0-02c-2: legacy-writer parity while the flag is OFF. Operator routes
   * (/pause, /continue …) wrote `status` unconditionally before 02c, whatever
   * the current status. With this set AND dual write off, the state graph is
   * skipped (no `illegal_transition`, same-status is not a no-op) and only the
   * status compare-and-set protects the write. IGNORED when dual write is on:
   * the graph is always enforced there.
   */
  legacyUnchecked?: boolean;
}

export type TransitionOutcome =
  | { ok: true; noop: boolean; from: JobState; to: JobState }
  | { ok: false; reason: "not_found" } // also: run belongs to another tenant
  | { ok: false; reason: "illegal_transition"; from: JobState; to: JobState }
  | { ok: false; reason: "lost_race"; from: JobState; to: JobState };

/** Current state of a row: stored `state` if it still agrees with `status`, else derived from `status`. */
export function currentJobState(status: LegacyRunStatus, state: JobState | null | undefined): JobState {
  if (state && toLegacyStatus(state) === status) return state;
  return fromLegacyStatus(status);
}

export async function transitionRun(
  tx: RunTransitionClient,
  runId: string,
  to: JobState,
  opts: TransitionOptions,
): Promise<TransitionOutcome> {
  if (!opts.tenantId) throw new TypeError("transitionRun: tenantId is required");
  for (const k of Object.keys(opts.extra ?? {})) {
    if ((RESERVED_RUN_COLUMNS as readonly string[]).includes(k)) {
      throw new TypeError(`transitionRun: extra may not set the lifecycle column "${k}"`);
    }
  }
  const dual = opts.dualWrite ?? isJobStateDualWriteEnabled();
  const tenantScope: Prisma.RunWhereInput = { pipeline: { company: { tenantId: opts.tenantId } } };

  const row = (await tx.run.findFirst({
    where: { id: runId, ...tenantScope },
    // Flag off must not even name the new column.
    select: dual ? { status: true, state: true } : { status: true },
  })) as { status: LegacyRunStatus; state?: JobState | null } | null;
  if (!row) return { ok: false, reason: "not_found" };

  const from = currentJobState(row.status, dual ? row.state : null);
  if (!(opts.legacyUnchecked && !dual)) {
    const decision = applyTransition(from, to);
    if (!decision.ok) return { ok: false, reason: "illegal_transition", from, to };
    if (decision.noop) return { ok: true, noop: true, from, to };
  }

  // Scalar-only CAS (see header): tenant was verified by the read above.
  const where: Prisma.RunWhereInput = { id: runId, status: row.status };
  if (dual) where.state = row.state ?? null;

  const data: Prisma.RunUpdateManyMutationInput = {
    ...(opts.extra ?? {}),
    status: toLegacyStatus(to),
    ...(dual ? { state: to, ...(opts.resultStatus !== undefined ? { resultStatus: opts.resultStatus } : {}) } : {}),
  };

  const res = await tx.run.updateMany({ where, data });
  if (res.count !== 1) return { ok: false, reason: "lost_race", from, to };
  return { ok: true, noop: false, from, to };
}
