/**
 * BRA-P0-02 — Job lifecycle (pure state machine, ADR-0001).
 *
 * `Run` stays the physical table and `Run.id` stays the job id. This module
 * defines the NEW lifecycle (`JobState`) and its deterministic projection onto
 * the 7 LEGACY `RunStatus` values that shipped clients (iOS 1.1.0, Android
 * 1.1.1, desktop, CLI) already read. It has no I/O and no Prisma import and is
 * NOT wired into any writer yet (BRA-P0-02b does the additive migration and the
 * single `transitionRun` writer), so importing it changes no behaviour.
 *
 * Invariant the migration must enforce: `Run.status === toLegacyStatus(Run.state)`.
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

/** The seven values of the Prisma `RunStatus` enum today — frozen, never extended. */
export const LEGACY_RUN_STATUSES = [
  "PENDING",
  "RUNNING",
  "PAUSED",
  "WAITING_APPROVAL",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
] as const;
export type LegacyRunStatus = (typeof LEGACY_RUN_STATUSES)[number];

/** Set only on COMPLETED jobs; null while unfinished or for pre-migration history. */
export type ResultStatus = "VERIFIED" | "UNVERIFIED";

const TO_LEGACY: Record<JobState, LegacyRunStatus> = {
  DRAFT: "PENDING",
  PLANNED: "PENDING",
  READY: "PENDING",
  RUNNING: "RUNNING",
  // Resuming is invisible to legacy readers: they saw RUNNING right after approve.
  RESUMING: "RUNNING",
  NEEDS_APPROVAL: "WAITING_APPROVAL",
  PAUSED: "PAUSED",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
};

/** Backfill for existing rows: legacy runs were enqueued directly, so PENDING means READY. */
const FROM_LEGACY: Record<LegacyRunStatus, JobState> = {
  PENDING: "READY",
  RUNNING: "RUNNING",
  PAUSED: "PAUSED",
  WAITING_APPROVAL: "NEEDS_APPROVAL",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
};

export const toLegacyStatus = (s: JobState): LegacyRunStatus => TO_LEGACY[s];
export const fromLegacyStatus = (s: LegacyRunStatus): JobState => FROM_LEGACY[s];

/**
 * Allowed transitions. COMPLETED and CANCELLED are terminal. FAILED is only
 * left through an explicit retry (RESUMING): today that is the open-handoff
 * paths only (`run/router.ts` /continue and the HANDOFF approval), never a
 * plain /resume — see `decideResume`.
 *
 * Edge sources in today's code:
 *   NEEDS_APPROVAL→CANCELLED  approval rejected, or a non-HANDOFF approval
 *                             expired (`approval/expiry-cron.ts`)
 *   NEEDS_APPROVAL→FAILED     governance hard-stop (`governance/router.ts`)
 *   RUNNING→RESUMING          crashed worker recovered from persisted steps
 *   RESUMING→PAUSED           operator pauses in the queue gap after approve
 */
const TRANSITIONS: Record<JobState, readonly JobState[]> = {
  DRAFT: ["PLANNED", "CANCELLED"],
  PLANNED: ["READY", "DRAFT", "CANCELLED"], // PLANNED→DRAFT = re-plan (plan_version++)
  READY: ["RUNNING", "PAUSED", "CANCELLED"], // READY→PAUSED: /pause has never checked status (02c-2)
  RUNNING: ["NEEDS_APPROVAL", "PAUSED", "RESUMING", "COMPLETED", "FAILED", "CANCELLED"],
  NEEDS_APPROVAL: ["RESUMING", "PAUSED", "CANCELLED", "FAILED"], // →PAUSED: /pause on WAITING_APPROVAL (02c-2)
  RESUMING: ["RUNNING", "PAUSED", "FAILED", "CANCELLED"],
  PAUSED: ["RESUMING", "CANCELLED", "FAILED"],
  FAILED: ["RESUMING"],
  CANCELLED: [],
  COMPLETED: [],
};

export const isTerminal = (s: JobState): boolean => s === "COMPLETED" || s === "CANCELLED";

export const canTransition = (from: JobState, to: JobState): boolean => TRANSITIONS[from].includes(to);

export type TransitionResult =
  | { ok: true; state: JobState; noop: boolean }
  | { ok: false; reason: "illegal_transition"; from: JobState; to: JobState };

/**
 * Compare-and-set style decision. `from === to` is a successful no-op, so a
 * replayed webhook / double-click never errors and never re-triggers a side
 * effect (the caller only runs side effects when `noop === false`).
 */
export function applyTransition(from: JobState, to: JobState): TransitionResult {
  if (from === to) return { ok: true, state: to, noop: true };
  if (!canTransition(from, to)) return { ok: false, reason: "illegal_transition", from, to };
  return { ok: true, state: to, noop: false };
}

export type IntentDecision = "start" | "already" | "reject";

/**
 * Who is asking to resume. The source matters, not just the state:
 *   approve  the decision on an approval (approval `/decide`) — the only intent
 *            that may leave NEEDS_APPROVAL WITHOUT an open handoff, so a plain
 *            /resume can no longer skip a PENDING approval (BRA-P0-05 builds
 *            on this). Known remaining path: `retry` (handoff + /continue) also
 *            starts NEEDS_APPROVAL, as it does today — see ADR-0001;
 *   unpause  an operator un-pausing (`/resume`) — PAUSED only;
 *   retry    a takeover backed by an OPEN handoff record (`/continue`,
 *            HANDOFF approval). `/handoff` is allowed from RUNNING, PAUSED,
 *            WAITING_APPROVAL and FAILED and parks a RUNNING run in PAUSED, so
 *            `retry` may start from PAUSED, NEEDS_APPROVAL or FAILED — the
 *            manual hand-over flow keeps working. It is also the only intent
 *            that may leave FAILED, so a governance hard-stop or loop-guard
 *            failure is never restarted by an ordinary resume. The caller must
 *            verify the OPEN handoff record; this function only checks state.
 */
export type ResumeIntent = "approve" | "unpause" | "retry";

/** Duplicate resume while RESUMING/RUNNING is `already` (any intent), never a second run. */
export function decideResume(current: JobState, intent: ResumeIntent): IntentDecision {
  if (current === "RESUMING" || current === "RUNNING") return "already";
  if (intent === "approve" && current === "NEEDS_APPROVAL") return "start";
  if (intent === "unpause" && current === "PAUSED") return "start";
  if (intent === "retry" && (current === "FAILED" || current === "PAUSED" || current === "NEEDS_APPROVAL")) return "start";
  return "reject";
}

/** `cancel`. Finished jobs are not cancellable (409); repeated cancel is `already`. */
export function decideCancel(current: JobState): IntentDecision {
  if (current === "CANCELLED") return "already";
  if (current === "COMPLETED" || current === "FAILED") return "reject";
  return "start";
}

export interface CrashRecoveryInput {
  state: JobState;
  /** Retries already consumed for this job (`retry_count`, 02b column). */
  retries: number;
  /** Job retry ceiling (budget field `max_retries`, ADR-0002); never infinite. */
  maxRetries: number;
}
export type CrashRecovery =
  | { action: "none" }
  | { action: "resume"; to: "RESUMING"; consumesRetry: true }
  | { action: "fail"; to: "FAILED"; reason: "retries_exhausted" };

/**
 * A worker died while the job was RUNNING/RESUMING (heartbeat lost). Resume
 * from the persisted COMPLETED steps (`planResume`) while retries remain; then
 * fail — no endless loop. Other states are not the worker's to recover.
 *
 * RUNNING→RESUMING is a real transition. RESUMING→RESUMING is a same-state
 * no-op for `applyTransition`, so the side effect (re-enqueue) is guarded by
 * the retry counter instead: the writer does a compare-and-set on
 * `(state, retry_count)` with `consumesRetry` and re-enqueues only when that
 * CAS wins. A recovery loop therefore ends after `maxRetries`.
 *
 * Fail-closed on garbage input: a negative, fractional or non-finite counter,
 * or a non-finite ceiling, ends the job instead of granting more retries.
 */
export function decideCrashRecovery(input: CrashRecoveryInput): CrashRecovery {
  if (input.state !== "RUNNING" && input.state !== "RESUMING") return { action: "none" };
  const sane =
    Number.isInteger(input.retries) && input.retries >= 0 && Number.isInteger(input.maxRetries) && input.maxRetries >= 0;
  if (sane && input.retries < input.maxRetries) return { action: "resume", to: "RESUMING", consumesRetry: true };
  return { action: "fail", to: "FAILED", reason: "retries_exhausted" };
}

export type EvidenceKind = "diff" | "test" | "pr" | "artifact" | "log";
export interface ReceiptEvidence {
  kind: EvidenceKind;
  ref: string;
  /** For `test`: whether the run passed. Other kinds omit it. */
  ok?: boolean;
}

/**
 * `VERIFIED` only for a COMPLETED job whose receipt carries at least one real
 * evidence item (non-blank `ref`), every required evidence kind, and whose
 * `test` items ALL passed explicitly (`ok === true`, blank ref or not). Everything else that
 * finished is `UNVERIFIED` (talimat §6.4 #7: no diff/test/PR → no verified
 * success). Fail-closed: no evidence, or a `test` item without an explicit
 * `ok`, never counts as verified — even when `requiredKinds` is empty.
 */
export function deriveResultStatus(
  state: JobState,
  requiredKindsRaw: unknown,
  evidenceRaw: unknown,
): ResultStatus | null {
  if (state !== "COMPLETED") return null;
  // BRA-P0-02c-4 (ADR-0001 (d)): the inputs come from stored JSON, so validate
  // instead of trusting the type. A missing/non-string `ref` is blank (never
  // real evidence), a non-object or unknown-kind item is dropped, a malformed
  // container is empty. Nothing here can throw, and nothing malformed can
  // produce VERIFIED.
  const requiredKinds: readonly EvidenceKind[] = Array.isArray(requiredKindsRaw) ? (requiredKindsRaw as EvidenceKind[]) : [];
  const kinds: readonly string[] = ["diff", "test", "pr", "artifact", "log"];
  const evidence: ReceiptEvidence[] = (Array.isArray(evidenceRaw) ? evidenceRaw : []).flatMap((item: unknown) => {
    if (typeof item !== "object" || item === null) return [];
    const o = item as Record<string, unknown>;
    const kind = typeof o.kind === "string" ? o.kind.trim().toLowerCase() : "";
    if (!kinds.includes(kind)) return [];
    return [{ kind: kind as EvidenceKind, ref: typeof o.ref === "string" ? o.ref : "", ok: o.ok === true ? true : o.ok === false ? false : undefined }];
  });
  const real = evidence.filter((e) => e.ref.trim().length > 0);
  if (real.length === 0) return "UNVERIFIED";
  const have = new Set(real.map((e) => e.kind));
  const allPresent = requiredKinds.every((k) => have.has(k));
  // The test veto looks at ALL evidence, not only items with a ref: a failing
  // or unconfirmed test never disappears just because its ref is blank.
  const testsPassed = evidence.every((e) => e.kind !== "test" || e.ok === true);
  return allPresent && testsPassed ? "VERIFIED" : "UNVERIFIED";
}
