/**
 * Shared "resume a run" writers (BRA-P0-02c-2 moved here from run/router.ts in
 * 02c-3 so the approval `decide` route uses the exact same pattern, not a copy).
 */
import { AppError } from "../../middleware/error";
import { transitionRun, isJobStateDualWriteEnabled, type RunTransitionClient, type TransitionOptions, type TransitionOutcome } from "./transition";
import type { JobState } from "./job-state";

/**
 * Turn a failed `transitionRun` outcome into the route's error.
 * Thrown INSIDE the `tenantTx` callback so the transaction rolls back and no
 * side effect (activity row, ledger, queue job) follows a lost race.
 * `illegal_transition` is a conflict (409) unless the route names its own code.
 */
export function assertTransitioned(o: TransitionOutcome, illegal: { status: number; message: string }): void {
  if (o.ok) return;
  if (o.reason === "not_found") throw new AppError(404, "Run not found");
  if (o.reason === "illegal_transition") throw new AppError(illegal.status, illegal.message);
  throw new AppError(409, "Run state changed concurrently; retry");
}

/** Thrown inside the tx (so it rolls back) when the FRESH in-tx read shows RUNNING/RESUMING: someone else already resumed. */
export class AlreadyRunningError extends Error {}

/**
 * →RESUMING, then (dual write on) →RUNNING in the same transaction: RESUMING
 * projects onto status RUNNING, and the runner does not yet advance
 * RESUMING→RUNNING itself (ADR-0001 (e), 02c-4), so the writer does it here.
 * Off, the single write is the legacy `status = RUNNING`.
 */
export async function resumeToRunning(
  tx: RunTransitionClient,
  runId: string,
  tenantId: string,
  opts: { rejectIfAlreadyRunning: boolean },
): Promise<{ from: JobState }> {
  const illegal = { status: 409, message: "Run cannot be resumed from its current state" };
  const first = await transitionRun(tx, runId, "RESUMING", { tenantId, legacyUnchecked: true });
  assertTransitioned(first, illegal);
  // RUNNING→RESUMING is a legal edge (crash recovery), so the CAS above can WIN
  // against a request that already resumed the run. The decision must come from
  // this fresh in-tx read, not from the stale read outside the tx: roll back and
  // let the caller answer "already" (no second enqueue).
  if (opts.rejectIfAlreadyRunning && first.ok && (first.from === "RUNNING" || first.from === "RESUMING")) {
    throw new AlreadyRunningError();
  }
  if (isJobStateDualWriteEnabled()) {
    assertTransitioned(await transitionRun(tx, runId, "RUNNING", { tenantId }), illegal);
  }
  return { from: first.ok ? first.from : "PAUSED" };
}

/** Where an undo should put a run that THIS request moved from `from` to RUNNING (never called for RUNNING/RESUMING). */
export function revertTarget(from: JobState): JobState {
  return from === "FAILED" || from === "NEEDS_APPROVAL" ? from : "PAUSED";
}

/**
 * BRA-P0-02c-3: `enqueueRun` threw AFTER the resume committed RUNNING. A RUNNING
 * run without a job can never be resumed again (/resume on RUNNING is a 400), so
 * move it back to where THIS request found it. Safe by construction: the write
 * lands only while the fresh in-tx read still shows RUNNING/RESUMING (our own
 * write) and is CAS-pinned to that status — a run that was cancelled, finished,
 * failed or re-paused in the meantime is never touched (both flag modes).
 * `from` is the state this request's own transition started from; if the run was
 * already RUNNING/RESUMING then, nothing of ours is undone. Returns whether the
 * run was actually put back (callers reopen the ledger only then).
 */
export async function revertRunAfterEnqueueFailure(
  client: RunTransitionClient,
  runId: string,
  tenantId: string,
  from: JobState,
  extra?: TransitionOptions["extra"],
): Promise<boolean> {
  if (from === "RUNNING" || from === "RESUMING") return false;
  const o = await transitionRun(client, runId, revertTarget(from), {
    tenantId,
    legacyUnchecked: true,
    onlyIfStatus: ["RUNNING"],
    ...(extra ? { extra } : {}),
  }).catch(() => null);
  return !!o && o.ok && !o.noop;
}
