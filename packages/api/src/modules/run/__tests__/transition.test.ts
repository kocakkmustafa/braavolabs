/**
 * BRA-P0-02b — transitionRun (single lifecycle writer) and JOB_STATE_DUAL_WRITE.
 *
 * No DB: a tiny in-memory run store implements the compare-and-set semantics of
 * Prisma's `updateMany({ where })` (id + status + state, including `state: null`)
 * and the tenant relation filter of `findFirst`, and records every `select`,
 * `where` and `data` it receives, so the tests can prove
 *   • flag off never names the new `state` column (select, where or data),
 *   • flag on writes state + status together and they always agree,
 *   • a lost race performs no write and reports `lost_race`,
 *   • N deliveries that all read before any write yield exactly ONE winner,
 *   • another tenant's run is invisible (`not_found`) and never written.
 * These prove the decision logic around the CAS with an in-memory fake. They do
 * NOT prove real-Postgres behaviour (row locking, RLS, the migration itself);
 * that needs a database-backed integration test and CI's DB Migration Check
 * only checks that the migration applies.
 */
import { afterEach, describe, it, expect } from "vitest";
import {
  JOB_STATES,
  LEGACY_RUN_STATUSES,
  canTransition,
  toLegacyStatus,
  type JobState,
  type LegacyRunStatus,
} from "../job-state";
import {
  RESERVED_RUN_COLUMNS,
  currentJobState,
  isJobStateDualWriteEnabled,
  transitionRun,
  type RunTransitionClient,
} from "../transition";

interface Row {
  id: string;
  tenant: string;
  status: LegacyRunStatus;
  state: JobState | null;
  resultStatus?: string | null;
  completedAt?: Date | null;
  error?: string | null;
}

type Where = {
  id: string;
  status?: string;
  state?: JobState | null;
  pipeline?: { company?: { tenantId?: string } };
};

const tenantOf = (w: Where) => w.pipeline?.company?.tenantId;

/** In-memory fake with real CAS `updateMany`, tenant relation filter and an optional read barrier. */
function fakeClient(initial: Row, opts: { barrier?: () => Promise<void> } = {}) {
  const row = { ...initial };
  const log = {
    selects: [] as unknown[],
    readWheres: [] as Where[],
    wheres: [] as Where[],
    datas: [] as Array<Record<string, unknown>>,
  };
  const client = {
    run: {
      findFirst: async (args: { where: Where; select: Record<string, boolean> }) => {
        log.selects.push(args.select);
        log.readWheres.push(args.where);
        if (args.where.id !== row.id || tenantOf(args.where) !== row.tenant) return null;
        const snapshot: Record<string, unknown> = {};
        for (const k of Object.keys(args.select)) snapshot[k] = (row as unknown as Record<string, unknown>)[k];
        if (opts.barrier) await opts.barrier();
        return snapshot;
      },
      updateMany: async (args: { where: Where; data: Record<string, unknown> }) => {
        log.wheres.push(args.where);
        log.datas.push(args.data);
        const w = args.where;
        const matches =
          w.id === row.id &&
          (w.status === undefined || w.status === row.status) &&
          (!("state" in w) || w.state === row.state);
        if (!matches) return { count: 0 };
        Object.assign(row, args.data);
        return { count: 1 };
      },
    },
  };
  return { client: client as unknown as RunTransitionClient, row, log };
}

const T = "tenant_a";
const mk = (status: LegacyRunStatus, state: JobState | null = null): Row => ({ id: "run_1", tenant: T, status, state });
const on = { tenantId: T, dualWrite: true } as const;
const off = { tenantId: T, dualWrite: false } as const;

describe("isJobStateDualWriteEnabled (default OFF)", () => {
  it("only the literal string 'true' enables it", () => {
    expect(isJobStateDualWriteEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    for (const v of ["", "false", "TRUE", "True", "1", "yes", " true", "true "]) {
      expect(isJobStateDualWriteEnabled({ JOB_STATE_DUAL_WRITE: v } as NodeJS.ProcessEnv)).toBe(false);
    }
    expect(isJobStateDualWriteEnabled({ JOB_STATE_DUAL_WRITE: "true" } as NodeJS.ProcessEnv)).toBe(true);
  });
});

describe("environment default (no dualWrite option passed)", () => {
  const saved = process.env.JOB_STATE_DUAL_WRITE;
  afterEach(() => {
    if (saved === undefined) delete process.env.JOB_STATE_DUAL_WRITE;
    else process.env.JOB_STATE_DUAL_WRITE = saved;
  });

  it("unset env => OFF: never selects or writes the new columns", async () => {
    delete process.env.JOB_STATE_DUAL_WRITE;
    const { client, log } = fakeClient(mk("RUNNING"));
    const r = await transitionRun(client, "run_1", "PAUSED", { tenantId: T });
    expect(r).toMatchObject({ ok: true, noop: false });
    expect(log.selects).toEqual([{ status: true }]);
    expect(Object.keys(log.datas[0])).toEqual(["status"]);
  });

  it("env 'true' => ON, read at call time", async () => {
    process.env.JOB_STATE_DUAL_WRITE = "true";
    const { client, log } = fakeClient(mk("RUNNING"));
    await transitionRun(client, "run_1", "PAUSED", { tenantId: T });
    expect(log.selects).toEqual([{ status: true, state: true }]);
    expect(log.datas[0]).toEqual({ status: "PAUSED", state: "PAUSED" });
  });
});

describe("currentJobState (status is authoritative until all writers migrate)", () => {
  it("uses the stored state while it still projects onto status", () => {
    expect(currentJobState("PENDING", "PLANNED")).toBe("PLANNED");
    expect(currentJobState("RUNNING", "RESUMING")).toBe("RESUMING"); // RESUMING projects onto RUNNING
  });

  it("re-derives from status when the stored state is stale (legacy writer moved status)", () => {
    expect(currentJobState("WAITING_APPROVAL", "RUNNING")).toBe("NEEDS_APPROVAL");
    expect(currentJobState("COMPLETED", "READY")).toBe("COMPLETED");
  });

  it("derives from status when state is NULL (pre-migration row)", () => {
    for (const l of LEGACY_RUN_STATUSES) expect(toLegacyStatus(currentJobState(l, null))).toBe(l);
    expect(currentJobState("PENDING", null)).toBe("READY");
  });
});

describe("guards", () => {
  it("requires a tenantId", async () => {
    const { client } = fakeClient(mk("RUNNING"));
    await expect(transitionRun(client, "run_1", "PAUSED", { tenantId: "", dualWrite: true })).rejects.toThrow(/tenantId is required/);
  });

  it("rejects every lifecycle column in `extra`, flag off or on, before any read or write", async () => {
    for (const dualWrite of [false, true]) {
      for (const key of RESERVED_RUN_COLUMNS) {
        const { client, log } = fakeClient(mk("RUNNING", "RUNNING"));
        await expect(
          transitionRun(client, "run_1", "PAUSED", { tenantId: T, dualWrite, extra: { [key]: "x" } as never }),
        ).rejects.toThrow(/may not set the lifecycle column/);
        expect(log.selects).toHaveLength(0);
        expect(log.datas).toHaveLength(0);
      }
    }
  });

  it("another tenant's run is invisible and never written", async () => {
    const { client, log, row } = fakeClient(mk("WAITING_APPROVAL", "NEEDS_APPROVAL"));
    const r = await transitionRun(client, "run_1", "RESUMING", { tenantId: "tenant_b", dualWrite: true });
    expect(r).toEqual({ ok: false, reason: "not_found" });
    expect(log.datas).toHaveLength(0);
    expect(row.status).toBe("WAITING_APPROVAL");
  });

  it("the read is tenant-scoped; the write is a scalar-only CAS (no relation filter, so it stays atomic)", async () => {
    const { client, log } = fakeClient(mk("RUNNING", "RUNNING"));
    await transitionRun(client, "run_1", "PAUSED", on);
    expect(log.readWheres[0].pipeline).toEqual({ company: { tenantId: T } });
    expect(log.wheres[0]).toEqual({ id: "run_1", status: "RUNNING", state: "RUNNING" });
    expect(log.wheres[0].pipeline).toBeUndefined();
  });
});

describe("flag OFF — legacy column only", () => {
  it("never selects, matches or writes the new columns", async () => {
    const { client, log, row } = fakeClient(mk("RUNNING"));
    const r = await transitionRun(client, "run_1", "NEEDS_APPROVAL", off);
    expect(r).toEqual({ ok: true, noop: false, from: "RUNNING", to: "NEEDS_APPROVAL" });
    expect(log.selects).toEqual([{ status: true }]);
    expect(Object.keys(log.wheres[0]).sort()).toEqual(["id", "status"]);
    expect(Object.keys(log.datas[0]).sort()).toEqual(["status"]);
    expect(row.status).toBe("WAITING_APPROVAL");
    expect(row.state).toBeNull();
  });

  it("legitimate extra columns are written, still without touching the lifecycle columns", async () => {
    const { client, log, row } = fakeClient(mk("RUNNING"));
    const done = new Date("2026-11-08T00:00:00Z");
    await transitionRun(client, "run_1", "FAILED", { ...off, extra: { completedAt: done, error: "boom" } });
    expect(Object.keys(log.datas[0]).sort()).toEqual(["completedAt", "error", "status"]);
    expect(row.completedAt).toBe(done);
    expect(row.error).toBe("boom");
    expect(row.status).toBe("FAILED");
  });

  it("still validates the transition and refuses illegal ones without writing", async () => {
    const { client, log } = fakeClient(mk("COMPLETED"));
    expect(await transitionRun(client, "run_1", "RUNNING", off)).toEqual({
      ok: false,
      reason: "illegal_transition",
      from: "COMPLETED",
      to: "RUNNING",
    });
    expect(log.datas).toHaveLength(0);
  });
});

describe("flag ON — dual write keeps state and status in agreement", () => {
  it("writes state and the legacy projection in the same UPDATE", async () => {
    const { client, log, row } = fakeClient(mk("WAITING_APPROVAL"));
    const r = await transitionRun(client, "run_1", "RESUMING", on);
    expect(r).toEqual({ ok: true, noop: false, from: "NEEDS_APPROVAL", to: "RESUMING" });
    expect(log.selects).toEqual([{ status: true, state: true }]);
    expect(log.datas[0]).toEqual({ status: "RUNNING", state: "RESUMING" });
    expect(row.status).toBe("RUNNING");
    expect(row.state).toBe("RESUMING");
  });

  it("carries extra columns and resultStatus", async () => {
    const { client, row } = fakeClient(mk("RUNNING", "RUNNING"));
    const done = new Date("2026-11-08T00:00:00Z");
    const r = await transitionRun(client, "run_1", "COMPLETED", { ...on, resultStatus: "UNVERIFIED", extra: { completedAt: done } });
    expect(r.ok).toBe(true);
    expect(row.status).toBe("COMPLETED");
    expect(row.state).toBe("COMPLETED");
    expect(row.resultStatus).toBe("UNVERIFIED");
    expect(row.completedAt).toBe(done);
  });

  it("a legacy row (state NULL) is read from status and CAS-matched on state NULL", async () => {
    const { client, log, row } = fakeClient(mk("PENDING", null));
    const r = await transitionRun(client, "run_1", "RUNNING", on);
    expect(r).toEqual({ ok: true, noop: false, from: "READY", to: "RUNNING" });
    expect(log.wheres[0].state).toBeNull();
    expect(row.state).toBe("RUNNING");
  });

  it("a stale stored state (legacy writer moved status on) is healed, not trusted", async () => {
    const { client, row } = fakeClient(mk("WAITING_APPROVAL", "RUNNING"));
    const r = await transitionRun(client, "run_1", "RESUMING", on);
    expect(r).toEqual({ ok: true, noop: false, from: "NEEDS_APPROVAL", to: "RESUMING" });
    expect(row.state).toBe("RESUMING");
    expect(row.status).toBe("RUNNING");
  });

  it("a same-state no-op writes nothing, so a NULL state stays NULL until the first real transition", async () => {
    const { client, log, row } = fakeClient(mk("RUNNING", null));
    expect(await transitionRun(client, "run_1", "RUNNING", on)).toEqual({ ok: true, noop: true, from: "RUNNING", to: "RUNNING" });
    expect(log.datas).toHaveLength(0);
    expect(row.state).toBeNull();
  });

  it("unknown run id", async () => {
    const { client } = fakeClient(mk("RUNNING"));
    expect(await transitionRun(client, "nope", "PAUSED", on)).toEqual({ ok: false, reason: "not_found" });
  });

  it("invariant: after every legal transition from every state, status == projection(state)", async () => {
    for (const from of JOB_STATES) {
      for (const to of JOB_STATES) {
        if (from === to || !canTransition(from, to)) continue;
        const { client, row } = fakeClient(mk(toLegacyStatus(from), from));
        const r = await transitionRun(client, "run_1", to, on);
        expect(r.ok).toBe(true);
        expect(row.state).toBe(to);
        expect(row.status).toBe(toLegacyStatus(to));
      }
    }
  });

  it("an illegal transition never writes, from any state", async () => {
    for (const from of JOB_STATES) {
      for (const to of JOB_STATES) {
        if (from === to || canTransition(from, to)) continue;
        const { client, log } = fakeClient(mk(toLegacyStatus(from), from));
        const r = await transitionRun(client, "run_1", to, on);
        expect(r).toMatchObject({ ok: false, reason: "illegal_transition" });
        expect(log.datas).toHaveLength(0);
      }
    }
  });
});

describe("compare-and-set race (duplicate approve / webhook)", () => {
  it("a write that loses the race reports lost_race and changes nothing", async () => {
    const { client, row } = fakeClient(mk("WAITING_APPROVAL", "NEEDS_APPROVAL"));
    // Another worker moves the row between our read and our write.
    const original = client.run.updateMany.bind(client.run);
    (client.run as { updateMany: unknown }).updateMany = async (args: Parameters<typeof original>[0]) => {
      row.status = "CANCELLED";
      row.state = "CANCELLED";
      return original(args);
    };
    const r = await transitionRun(client, "run_1", "RESUMING", on);
    expect(r).toEqual({ ok: false, reason: "lost_race", from: "NEEDS_APPROVAL", to: "RESUMING" });
    expect(row.status).toBe("CANCELLED");
    expect(row.state).toBe("CANCELLED");
  });

  it("3 deliveries that all read before any write: exactly ONE winner, two lost_race", async () => {
    let arrived = 0;
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const barrier = async () => {
      arrived += 1;
      if (arrived === 3) release();
      await gate;
    };
    const { client, row } = fakeClient(mk("WAITING_APPROVAL", "NEEDS_APPROVAL"), { barrier });
    const results = await Promise.all([1, 2, 3].map(() => transitionRun(client, "run_1", "RESUMING", on)));
    const winners = results.filter((r) => r.ok && !r.noop);
    const losers = results.filter((r) => !r.ok && r.reason === "lost_race");
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(2);
    expect(row.state).toBe("RESUMING");
    expect(row.status).toBe("RUNNING");
  });

  it("sequential replays after the winner are no-ops (side effects must not run again)", async () => {
    const { client } = fakeClient(mk("WAITING_APPROVAL", "NEEDS_APPROVAL"));
    const first = await transitionRun(client, "run_1", "RESUMING", on);
    const second = await transitionRun(client, "run_1", "RESUMING", on);
    const third = await transitionRun(client, "run_1", "RESUMING", on);
    expect(first).toMatchObject({ ok: true, noop: false });
    expect(second).toMatchObject({ ok: true, noop: true });
    expect(third).toMatchObject({ ok: true, noop: true });
  });

  it("a late approve cannot revive a cancelled job", async () => {
    const { client, row } = fakeClient(mk("CANCELLED", "CANCELLED"));
    const r = await transitionRun(client, "run_1", "RESUMING", on);
    expect(r).toMatchObject({ ok: false, reason: "illegal_transition" });
    expect(row.status).toBe("CANCELLED");
  });
});

describe("legacyUnchecked (02c-2 operator-route parity while the flag is OFF)", () => {
  it("off + legacyUnchecked: skips the graph (COMPLETED→PAUSED writes), never selects/writes state, same-status is a real write", async () => {
    const { client, row, log } = fakeClient(mk("COMPLETED"));
    const r = await transitionRun(client, "run_1", "PAUSED", { ...off, legacyUnchecked: true });
    expect(r).toMatchObject({ ok: true, noop: false });
    expect(row.status).toBe("PAUSED");
    expect(log.selects).toEqual([{ status: true }]);
    expect(Object.keys(log.datas[0])).toEqual(["status"]);
    const again = await transitionRun(client, "run_1", "PAUSED", { ...off, legacyUnchecked: true });
    expect(again).toMatchObject({ ok: true, noop: false });
  });

  it("off + legacyUnchecked still compare-and-sets on status: a stale read loses the race", async () => {
    const { client, row } = fakeClient(mk("PAUSED"), {
      barrier: async () => { row.status = "CANCELLED"; },
    });
    const r = await transitionRun(client, "run_1", "RUNNING", { ...off, legacyUnchecked: true });
    expect(r).toMatchObject({ ok: false, reason: "lost_race" });
    expect(row.status).toBe("CANCELLED");
  });

  it("ON ignores legacyUnchecked: the graph is enforced", async () => {
    const { client, row, log } = fakeClient(mk("COMPLETED", "COMPLETED"));
    const r = await transitionRun(client, "run_1", "PAUSED", { ...on, legacyUnchecked: true });
    expect(r).toMatchObject({ ok: false, reason: "illegal_transition" });
    expect(row.status).toBe("COMPLETED");
    expect(log.datas).toHaveLength(0);
  });
});
