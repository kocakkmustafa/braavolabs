/**
 * BRA-P0-02 — job lifecycle state machine (ADR-0001).
 *
 * Pure unit tests: no DB, no Redis, no network. They prove the contract the
 * additive migration (BRA-P0-02b) must keep:
 *   • the 7 legacy RunStatus values stay reachable through a total projection,
 *   • the DECISION for a duplicate approve / resume never yields a second
 *     'start' (the atomic compare-and-set race itself is proven in 02b),
 *   • cancel is final and idempotent, finished jobs are not cancellable,
 *   • a crashed run resumes from the cursor but never retries forever,
 *   • "VERIFIED" needs real evidence (no diff/test/PR → UNVERIFIED).
 */
import { describe, it, expect } from "vitest";
import {
  JOB_STATES,
  LEGACY_RUN_STATUSES,
  applyTransition,
  canTransition,
  decideCancel,
  decideCrashRecovery,
  decideResume,
  deriveResultStatus,
  fromLegacyStatus,
  isTerminal,
  toLegacyStatus,
  type JobState,
} from "../job-state";

describe("legacy projection (backward compatibility)", () => {
  it("every JobState projects onto one of the 7 frozen legacy statuses", () => {
    for (const s of JOB_STATES) expect(LEGACY_RUN_STATUSES).toContain(toLegacyStatus(s));
  });

  it("every legacy status is produced by at least one JobState (no legacy value is orphaned)", () => {
    const produced = new Set(JOB_STATES.map(toLegacyStatus));
    for (const l of LEGACY_RUN_STATUSES) expect(produced.has(l)).toBe(true);
  });

  it("backfill round-trips: legacy → state → legacy is the identity for all 7 values", () => {
    for (const l of LEGACY_RUN_STATUSES) expect(toLegacyStatus(fromLegacyStatus(l))).toBe(l);
  });

  it("legacy PENDING backfills to READY (old runs were enqueued directly)", () => {
    expect(fromLegacyStatus("PENDING")).toBe("READY");
  });

  it("pins the exact projection legacy clients see", () => {
    expect(toLegacyStatus("DRAFT")).toBe("PENDING");
    expect(toLegacyStatus("PLANNED")).toBe("PENDING");
    expect(toLegacyStatus("READY")).toBe("PENDING");
    expect(toLegacyStatus("RESUMING")).toBe("RUNNING");
    expect(toLegacyStatus("NEEDS_APPROVAL")).toBe("WAITING_APPROVAL");
  });
});

describe("transition table", () => {
  it("COMPLETED and CANCELLED are terminal: nothing leaves them", () => {
    for (const to of JOB_STATES) {
      if (to !== "COMPLETED") expect(canTransition("COMPLETED", to)).toBe(false);
      if (to !== "CANCELLED") expect(canTransition("CANCELLED", to)).toBe(false);
    }
    expect(isTerminal("COMPLETED")).toBe(true);
    expect(isTerminal("CANCELLED")).toBe(true);
    expect(isTerminal("FAILED")).toBe(false); // FAILED can be retried via RESUMING
  });

  it("FAILED is left only through an explicit retry (RESUMING)", () => {
    const out = JOB_STATES.filter((to) => to !== "FAILED" && canTransition("FAILED", to));
    expect(out).toEqual(["RESUMING"]);
  });

  it("no dead ends: every state can reach a terminal or FAILED state", () => {
    const reaches = (start: JobState): boolean => {
      const seen = new Set<JobState>([start]);
      const queue: JobState[] = [start];
      while (queue.length) {
        const cur = queue.shift()!;
        if (isTerminal(cur)) return true;
        for (const next of JOB_STATES) {
          if (canTransition(cur, next) && !seen.has(next)) {
            seen.add(next);
            queue.push(next);
          }
        }
      }
      return false;
    };
    for (const s of JOB_STATES) expect(reaches(s)).toBe(true);
  });

  it("illegal jumps are refused: DRAFT cannot run, COMPLETED cannot restart", () => {
    expect(applyTransition("DRAFT", "RUNNING")).toEqual({ ok: false, reason: "illegal_transition", from: "DRAFT", to: "RUNNING" });
    expect(applyTransition("COMPLETED", "RUNNING").ok).toBe(false);
    expect(applyTransition("READY", "COMPLETED").ok).toBe(false);
  });

  it("the happy path is legal end to end", () => {
    const path: JobState[] = ["DRAFT", "PLANNED", "READY", "RUNNING", "NEEDS_APPROVAL", "RESUMING", "RUNNING", "COMPLETED"];
    for (let i = 0; i < path.length - 1; i++) expect(canTransition(path[i], path[i + 1])).toBe(true);
  });

  it("same-state transition is an idempotent no-op (replayed webhook never re-fires side effects)", () => {
    expect(applyTransition("RUNNING", "RUNNING")).toEqual({ ok: true, state: "RUNNING", noop: true });
    expect(applyTransition("READY", "RUNNING")).toEqual({ ok: true, state: "RUNNING", noop: false });
  });
});

describe("duplicate approve / resume (decision only; the CAS race is 02b)", () => {
  it("first approve starts the resume, replays are 'already' for every intent", () => {
    expect(decideResume("NEEDS_APPROVAL", "approve")).toBe("start");
    for (const intent of ["approve", "unpause", "retry"] as const) {
      expect(decideResume("RESUMING", intent)).toBe("already");
      expect(decideResume("RUNNING", intent)).toBe("already");
    }
  });

  it("simulated 3× approve delivery: the decision function yields exactly one 'start'", () => {
    let state: JobState = "NEEDS_APPROVAL";
    const decisions: string[] = [];
    for (let i = 0; i < 3; i++) {
      const d = decideResume(state, "approve");
      decisions.push(d);
      if (d === "start") state = "RESUMING";
    }
    expect(decisions).toEqual(["start", "already", "already"]);
    expect(state).toBe("RESUMING");
  });

  it("the intent decides, not just the state: a plain un-pause cannot skip a pending approval", () => {
    expect(decideResume("NEEDS_APPROVAL", "unpause")).toBe("reject");
    expect(decideResume("NEEDS_APPROVAL", "retry")).toBe("reject");
  });

  it("FAILED restarts only with an explicit retry intent (open handoff), never a plain resume/approve", () => {
    expect(decideResume("FAILED", "retry")).toBe("start");
    expect(decideResume("FAILED", "unpause")).toBe("reject");
    expect(decideResume("FAILED", "approve")).toBe("reject");
  });

  it("PAUSED restarts only by un-pausing", () => {
    expect(decideResume("PAUSED", "unpause")).toBe("start");
    expect(decideResume("PAUSED", "approve")).toBe("reject");
    expect(decideResume("PAUSED", "retry")).toBe("reject");
  });

  it("finished or never-started jobs cannot be resumed by any intent", () => {
    for (const s of ["COMPLETED", "CANCELLED", "DRAFT", "PLANNED", "READY"] as const) {
      for (const intent of ["approve", "unpause", "retry"] as const) expect(decideResume(s, intent)).toBe("reject");
    }
  });

  it("every 'start' decision is a legal transition into RESUMING", () => {
    const cases: Array<[JobState, "approve" | "unpause" | "retry"]> = [
      ["NEEDS_APPROVAL", "approve"],
      ["PAUSED", "unpause"],
      ["FAILED", "retry"],
    ];
    for (const [s, intent] of cases) {
      expect(decideResume(s, intent)).toBe("start");
      expect(applyTransition(s, "RESUMING")).toEqual({ ok: true, state: "RESUMING", noop: false });
    }
  });
});

describe("cancel", () => {
  it("every unfinished state is cancellable", () => {
    for (const s of ["DRAFT", "PLANNED", "READY", "RUNNING", "NEEDS_APPROVAL", "RESUMING", "PAUSED"] as const) {
      expect(decideCancel(s)).toBe("start");
      expect(canTransition(s, "CANCELLED")).toBe(true);
    }
  });

  it("repeated cancel is idempotent; finished jobs are rejected", () => {
    expect(decideCancel("CANCELLED")).toBe("already");
    expect(decideCancel("COMPLETED")).toBe("reject");
    expect(decideCancel("FAILED")).toBe("reject");
  });

  it("a cancelled job cannot be revived by a late approve", () => {
    expect(decideResume("CANCELLED", "approve")).toBe("reject");
    expect(applyTransition("CANCELLED", "RESUMING").ok).toBe(false);
  });
});

describe("crashed-run resume", () => {
  it("a crashed RUNNING/RESUMING job resumes while retries remain, consuming one retry", () => {
    expect(decideCrashRecovery({ state: "RUNNING", retries: 0, maxRetries: 2 })).toEqual({ action: "resume", to: "RESUMING", consumesRetry: true });
    expect(decideCrashRecovery({ state: "RESUMING", retries: 1, maxRetries: 2 })).toEqual({ action: "resume", to: "RESUMING", consumesRetry: true });
  });

  it("never retries forever: at the ceiling the job fails with retries_exhausted", () => {
    expect(decideCrashRecovery({ state: "RUNNING", retries: 2, maxRetries: 2 })).toEqual({ action: "fail", to: "FAILED", reason: "retries_exhausted" });
    expect(decideCrashRecovery({ state: "RUNNING", retries: 0, maxRetries: 0 })).toEqual({ action: "fail", to: "FAILED", reason: "retries_exhausted" });
  });

  it("fail-closed on garbage counters: negative, fractional, NaN, Infinity never grant retries", () => {
    for (const bad of [
      { retries: -1, maxRetries: 3 },
      { retries: 0.5, maxRetries: 3 },
      { retries: Number.NaN, maxRetries: 3 },
      { retries: 0, maxRetries: Number.POSITIVE_INFINITY },
      { retries: 0, maxRetries: Number.NaN },
      { retries: 0, maxRetries: -2 },
    ]) {
      expect(decideCrashRecovery({ state: "RUNNING", ...bad })).toEqual({ action: "fail", to: "FAILED", reason: "retries_exhausted" });
    }
  });

  it("bounded: the recovery loop terminates after exactly maxRetries resumes", () => {
    let retries = 0;
    let steps = 0;
    let last: ReturnType<typeof decideCrashRecovery> = { action: "none" };
    while (steps++ < 100) {
      last = decideCrashRecovery({ state: "RUNNING", retries, maxRetries: 3 }); // worker crashed again each time
      if (last.action !== "resume") break;
      retries += 1;
    }
    expect(retries).toBe(3);
    expect(last).toEqual({ action: "fail", to: "FAILED", reason: "retries_exhausted" });
    expect(steps).toBe(4);
  });

  it("the worker never 'recovers' states it does not own", () => {
    for (const s of ["DRAFT", "PLANNED", "READY", "NEEDS_APPROVAL", "PAUSED", "FAILED", "CANCELLED", "COMPLETED"] as const) {
      expect(decideCrashRecovery({ state: s, retries: 0, maxRetries: 5 })).toEqual({ action: "none" });
    }
  });

  it("every recovery outcome is reachable through applyTransition from the crashed state", () => {
    // RUNNING→RESUMING is a real edge; RESUMING→RESUMING is a no-op, guarded by the retry CAS instead.
    expect(applyTransition("RUNNING", "RESUMING")).toEqual({ ok: true, state: "RESUMING", noop: false });
    expect(applyTransition("RESUMING", "RESUMING")).toEqual({ ok: true, state: "RESUMING", noop: true });
    expect(applyTransition("RUNNING", "FAILED").ok).toBe(true);
    expect(applyTransition("RESUMING", "FAILED").ok).toBe(true);
    expect(applyTransition("RESUMING", "RUNNING").ok).toBe(true);
  });

  it("the queue gap after approve can be paused (RESUMING→PAUSED), as the unconditional /pause allows today", () => {
    expect(applyTransition("RESUMING", "PAUSED").ok).toBe(true);
  });
});

describe("result status (no evidence → no verified success)", () => {
  const code = ["diff", "test", "pr"] as const;

  it("is null until the job completes", () => {
    for (const s of JOB_STATES) if (s !== "COMPLETED") expect(deriveResultStatus(s, code, [])).toBeNull();
  });

  it("COMPLETED with diff + passing test + PR is VERIFIED", () => {
    expect(
      deriveResultStatus("COMPLETED", code, [
        { kind: "diff", ref: "d1" },
        { kind: "test", ref: "t1", ok: true },
        { kind: "pr", ref: "https://example.test/pr/1" },
      ]),
    ).toBe("VERIFIED");
  });

  it("COMPLETED without the required PR is UNVERIFIED", () => {
    expect(deriveResultStatus("COMPLETED", code, [{ kind: "diff", ref: "d1" }, { kind: "test", ref: "t1", ok: true }])).toBe("UNVERIFIED");
  });

  it("a failing test makes it UNVERIFIED even when all kinds are present", () => {
    expect(
      deriveResultStatus("COMPLETED", code, [
        { kind: "diff", ref: "d1" },
        { kind: "test", ref: "t1", ok: false },
        { kind: "pr", ref: "p1" },
      ]),
    ).toBe("UNVERIFIED");
  });

  it("an empty evidence ref does not count", () => {
    expect(deriveResultStatus("COMPLETED", ["pr"], [{ kind: "pr", ref: "" }])).toBe("UNVERIFIED");
  });

  it("fail-closed: no evidence is UNVERIFIED even when no kind is required", () => {
    expect(deriveResultStatus("COMPLETED", [], [])).toBe("UNVERIFIED");
    expect(deriveResultStatus("COMPLETED", code, [])).toBe("UNVERIFIED");
  });

  it("a test item without an explicit ok is not a pass", () => {
    expect(deriveResultStatus("COMPLETED", ["test"], [{ kind: "test", ref: "t1" }])).toBe("UNVERIFIED");
    expect(deriveResultStatus("COMPLETED", ["test"], [{ kind: "test", ref: "t1", ok: true }])).toBe("VERIFIED");
  });

  it("with no required kinds, any real passing evidence is enough", () => {
    expect(deriveResultStatus("COMPLETED", [], [{ kind: "artifact", ref: "a1" }])).toBe("VERIFIED");
  });
});
