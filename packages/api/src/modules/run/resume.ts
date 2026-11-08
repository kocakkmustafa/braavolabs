/**
 * Shared "resume a run" writers (BRA-P0-02c-2 moved here from run/router.ts in
 * 02c-3 so the approval `decide` route uses the exact same pattern, not a copy).
 */
import { AppError } from "../../middleware/error";
import { transitionRun, isJobStateDualWriteEnabled, type RunTransitionClient, type TransitionOutcome } from "./transition";
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
): Promise<void> {
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
}

/** The lifecycle state a run had before a resume (for undoing it when the queue job cannot be created). */
export function priorJobState(legacyStatus: string): JobState {
  if (legacyStatus === "FAILED") return "FAILED";
  if (legacyStatus === "WAITING_APPROVAL") return "NEEDS_APPROVAL";
  return "PAUSED";
}

/**
 * BRA-P0-02c-3: `enqueueRun` threw AFTER the resume committed RUNNING. A RUNNING
 * run without a job can never be resumed again (/resume on RUNNING is a 400), so
 * move it back (RUNNING→PAUSED/FAILED/NEEDS_APPROVAL are all legal edges).
 * Best-effort and CAS-guarded: if the run already moved on, it is left alone.
 */
export async function revertRunAfterEnqueueFailure(
  client: RunTransitionClient,
  runId: string,
  tenantId: string,
  to: JobState,
): Promise<void> {
  await transitionRun(client, runId, to, { tenantId, legacyUnchecked: true }).catch(() => undefined);
}
