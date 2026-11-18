/**
 * BRA-P0-02c-4 — crash recovery writer (ADR-0001 karar 6, ADR-0002 "maxRetries yazarı yok").
 *
 * The queue re-delivered a run job (BullMQ retry/stall after the worker died or
 * threw while the run was RUNNING/RESUMING). `decideCrashRecovery` (pure) says
 * whether to resume from the persisted COMPLETED steps or fail with
 * `retries_exhausted`; this function applies it:
 *   resume  compare-and-set on `(status, state, retry_count)` →
 *           `state=RESUMING, status=RUNNING, retry_count+1`. Only the winner of
 *           that CAS may continue, so a recovery loop ends after `maxRetries`.
 *   fail    `transitionRun(FAILED)` with the exhaustion reason.
 *
 * Flag OFF → always `{ action: "none" }`: the legacy path never named
 * `retry_count`/`state` and still does not (the columns may not exist before
 * the migration is applied).
 */
import { transitionRun, currentJobState, isJobStateDualWriteEnabled, type RunTransitionClient } from "./transition";
import { decideCrashRecovery } from "./job-state";

export type CrashRecoveryOutcome =
  | { action: "none" }
  | { action: "resumed"; retryCount: number }
  | { action: "failed" }
  /** CAS lost: someone else moved the run; the caller must exit without side effects. */
  | { action: "lost" };

export async function recoverCrashedRun(
  tx: RunTransitionClient,
  runId: string,
  opts: { tenantId: string; maxRetries: number; dualWrite?: boolean },
): Promise<CrashRecoveryOutcome> {
  if (!opts.tenantId) throw new TypeError("recoverCrashedRun: tenantId is required");
  const dual = opts.dualWrite ?? isJobStateDualWriteEnabled();
  if (!dual) return { action: "none" };

  const row = (await tx.run.findFirst({
    where: { id: runId, pipeline: { company: { tenantId: opts.tenantId } } },
    select: { status: true, state: true, retryCount: true },
  })) as { status: string; state: string | null; retryCount: number | null } | null;
  if (!row) return { action: "none" };

  const retries = row.retryCount ?? 0;
  const decision = decideCrashRecovery({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    state: currentJobState(row.status as any, row.state as any),
    retries,
    maxRetries: opts.maxRetries,
  });
  if (decision.action === "none") return { action: "none" };

  if (decision.action === "fail") {
    const o = await transitionRun(tx, runId, "FAILED", {
      tenantId: opts.tenantId,
      dualWrite: true,
      extra: { error: "Run crashed and the retry allowance is exhausted (retries_exhausted).", completedAt: new Date() },
    });
    return o.ok && !o.noop ? { action: "failed" } : { action: "lost" };
  }

  const res = await tx.run.updateMany({
    where: { id: runId, status: row.status, state: row.state ?? null, retryCount: retries },
    data: { status: "RUNNING", state: "RESUMING", retryCount: { increment: 1 } },
  });
  return res.count === 1 ? { action: "resumed", retryCount: retries + 1 } : { action: "lost" };
}
