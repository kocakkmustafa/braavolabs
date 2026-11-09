import { describe, expect, it } from "vitest";
import {
  JOB_STATES,
  jobBucket,
  type InboxBucket,
  type JobState,
} from "../types/job";

const NOW = Date.parse("2026-11-09T12:00:00Z");
const STALE = 5 * 60_000;
const fresh = new Date(NOW - 10_000);
const old = new Date(NOW - STALE - 1);
const base = { now: NOW, staleAfterMs: STALE };

const STATE_EXPECT: Record<JobState, InboxBucket | null> = {
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

const LEGACY_EXPECT: Array<[string | null, InboxBucket]> = [
  ["PENDING", "working"],
  ["RUNNING", "working"],
  ["WAITING_APPROVAL", "needs_approval"],
  ["PAUSED", "stuck"],
  ["COMPLETED", "done"],
  ["FAILED", "stuck"],
  ["CANCELLED", "done"],
  ["BOGUS", "stuck"],
  [null, "stuck"],
];

describe("jobBucket", () => {
  it("covers all 10 JobStates", () => {
    expect(Object.keys(STATE_EXPECT).sort()).toEqual([...JOB_STATES].sort());
    expect(JOB_STATES).toHaveLength(10);
  });

  it.each(JOB_STATES)("state %s (status agrees or is null) -> table", (state) => {
    expect(jobBucket({ ...base, state, status: null, heartbeatAt: fresh })).toBe(STATE_EXPECT[state]);
  });

  it.each(LEGACY_EXPECT)("state NULL + legacy status %s -> %s", (status, bucket) => {
    expect(jobBucket({ ...base, state: null, status, heartbeatAt: fresh })).toBe(bucket);
    expect(jobBucket({ ...base, status: status ?? undefined })).toBe(bucket);
  });

  it("DRAFT is hidden (null) whatever status says", () => {
    for (const status of ["PENDING", "RUNNING", "FAILED", "BOGUS", null]) {
      expect(jobBucket({ ...base, state: "DRAFT", status })).toBeNull();
    }
  });

  it("stale heartbeat on RUNNING -> stuck (state and legacy)", () => {
    expect(jobBucket({ ...base, state: "RUNNING", heartbeatAt: old })).toBe("stuck");
    expect(jobBucket({ ...base, state: null, status: "RUNNING", heartbeatAt: old })).toBe("stuck");
    expect(jobBucket({ ...base, state: "RUNNING", heartbeatAt: fresh })).toBe("working");
  });

  it("heartbeat exactly at the threshold is not stale; ISO string and number accepted", () => {
    expect(jobBucket({ ...base, state: "RUNNING", heartbeatAt: new Date(NOW - STALE) })).toBe("working");
    expect(jobBucket({ ...base, state: "RUNNING", heartbeatAt: new Date(old).toISOString() })).toBe("stuck");
    expect(jobBucket({ ...base, state: "RUNNING", heartbeatAt: NOW - 1 })).toBe("working");
  });

  it("missing heartbeat on RUNNING is not judged stale (legacy rows have none)", () => {
    expect(jobBucket({ ...base, state: "RUNNING", heartbeatAt: null })).toBe("working");
    expect(jobBucket({ ...base, state: null, status: "RUNNING" })).toBe("working");
  });

  it("stale heartbeat does not affect non-RUNNING states (RESUMING waits in queue)", () => {
    expect(jobBucket({ ...base, state: "RESUMING", heartbeatAt: old })).toBe("working");
    expect(jobBucket({ ...base, state: "COMPLETED", heartbeatAt: old })).toBe("done");
    expect(jobBucket({ ...base, state: "NEEDS_APPROVAL", heartbeatAt: old })).toBe("needs_approval");
  });

  it("unreadable heartbeat / clock / threshold on RUNNING fails closed -> stuck", () => {
    expect(jobBucket({ ...base, state: "RUNNING", heartbeatAt: "not-a-date" })).toBe("stuck");
    expect(jobBucket({ now: NaN, staleAfterMs: STALE, state: "RUNNING", heartbeatAt: fresh })).toBe("stuck");
    expect(jobBucket({ now: NOW, staleAfterMs: NaN, state: "RUNNING", heartbeatAt: fresh })).toBe("stuck");
  });

  describe("negative: unknown / incompatible input -> stuck (never hidden)", () => {
    it("unknown state", () => {
      expect(jobBucket({ ...base, state: "WEIRD", status: "COMPLETED" })).toBe("stuck");
      expect(jobBucket({ ...base, state: "running" })).toBe("stuck");
      expect(jobBucket({ ...base, state: "toString" })).toBe("stuck");
      expect(jobBucket({ ...base, state: "__proto__" })).toBe("stuck");
    });
    it("unknown legacy status when state is NULL", () => {
      expect(jobBucket({ ...base, state: null, status: "toString" })).toBe("stuck");
      expect(jobBucket({ ...base, state: undefined, status: "pending" })).toBe("stuck");
    });
    it("unknown resultStatus", () => {
      expect(jobBucket({ ...base, state: "COMPLETED", resultStatus: "MAYBE" })).toBe("stuck");
      expect(jobBucket({ ...base, state: "COMPLETED", resultStatus: "VERIFIED" })).toBe("done");
      expect(jobBucket({ ...base, state: "COMPLETED", resultStatus: "UNVERIFIED" })).toBe("done");
      expect(jobBucket({ ...base, state: "COMPLETED", resultStatus: null })).toBe("done");
    });
  });

  describe("negative: state vs status conflict -> state wins", () => {
    it.each([
      ["COMPLETED", "RUNNING", "done"],
      ["RUNNING", "COMPLETED", "working"],
      ["NEEDS_APPROVAL", "FAILED", "needs_approval"],
      ["FAILED", "PENDING", "stuck"],
      ["CANCELLED", "WAITING_APPROVAL", "done"],
    ] as const)("state=%s status=%s -> %s", (state, status, bucket) => {
      expect(jobBucket({ ...base, state, status, heartbeatAt: fresh })).toBe(bucket);
    });
    it("state=COMPLETED + status=RUNNING with stale heartbeat stays done", () => {
      expect(jobBucket({ ...base, state: "COMPLETED", status: "RUNNING", heartbeatAt: old })).toBe("done");
    });
  });
});
