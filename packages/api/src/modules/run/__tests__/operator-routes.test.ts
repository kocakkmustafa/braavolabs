/**
 * BRA-P0-02c-2 — operator control routes through `transitionRun`.
 * /stop, /pause, /resume, /handoff (RUNNING→PAUSED), /continue and governance
 * /hard-stop. An in-memory run row implements the CAS semantics of `updateMany`
 * (id + status [+ state]); a hook lets a competing writer change the row between
 * the router's read and the write (the race). Per route:
 *   • flag OFF: only `status` is written (no `state` key anywhere), legacy HTTP
 *     codes/bodies, legacy permissiveness (terminal /pause, /continue on anything);
 *   • flag ON: `state` is written with `status`, the ADR-0001 table differences hold;
 *   • race (CAS lost): 409, no queue job, no activity row, no claim rollback gaps.
 * NOT covered: real Postgres row locking / RLS / the HTTP+JWT stack (tenantTx is faked).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Router } from "express";

vi.mock("../../../lib/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

interface Row {
  status: string;
  state: string | null;
}
const store = vi.hoisted(() => ({
  row: { status: "RUNNING", state: null } as { status: string; state: string | null },
  /** runs once, right before the next updateMany CAS check: simulates a competing writer. */
  beforeWrite: null as null | (() => void),
  /** keyed by absolute write ordinal (0-based): competing writer right before that write. */
  beforeWriteAt: new Map<number, () => void>(),
  /** the router's up-front read returns this once (a stale snapshot) instead of the live row. */
  staleRead: null as null | { status: string; state: string | null },
  /** this tx's own successful writes, for rollback: only fields still holding OUR value are undone. */
  undo: [] as Array<{ prev: Record<string, unknown>; wrote: Record<string, unknown> }>,
  ledger: { status: "OPEN", claimedBy: null as string | null, claimedAt: null as Date | null },
  selects: [] as unknown[],
  writes: [] as Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>,
}));
const activityLogCreate = vi.hoisted(() => vi.fn());
const approvalFindFirst = vi.hoisted(() => vi.fn());
const approvalUpdateMany = vi.hoisted(() => vi.fn());
const approvalFindMany = vi.hoisted(() => vi.fn());
const handoffFindFirst = vi.hoisted(() => vi.fn());
const enqueueRunMock = vi.hoisted(() => vi.fn());
const claimHandoffMock = vi.hoisted(() => vi.fn());
const createHandoffMock = vi.hoisted(() => vi.fn());
const cancelOpenHandoffForRunMock = vi.hoisted(() => vi.fn());

const tenantRun = () => {
  const snap = store.staleRead ?? store.row;
  store.staleRead = null;
  return { id: "run-1", status: snap.status, state: snap.state, pipeline: { company: { tenantId: "tenant-1" } } };
};

vi.mock("../../../lib/db", () => {
  const txRun = {
    findFirst: async (args: { select: Record<string, boolean> }) => {
      store.selects.push(args.select);
      const snap: Record<string, unknown> = {};
      for (const k of Object.keys(args.select)) snap[k] = (store.row as unknown as Record<string, unknown>)[k];
      return snap;
    },
    updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const ordinal = store.writes.length;
      store.writes.push(args);
      const hook = store.beforeWrite;
      store.beforeWrite = null;
      hook?.();
      store.beforeWriteAt.get(ordinal)?.();
      const w = args.where;
      const ok = w.status === store.row.status && (!("state" in w) || w.state === store.row.state);
      if (!ok) return { count: 0 };
      const row = store.row as unknown as Record<string, unknown>;
      const prev: Record<string, unknown> = {};
      const wrote: Record<string, unknown> = {};
      for (const k of ["status", "state"]) if (k in args.data) { prev[k] = row[k]; wrote[k] = args.data[k]; }
      store.undo.push({ prev, wrote });
      Object.assign(store.row, args.data);
      return { count: 1 };
    },
  };
  return {
    prisma: {
      run: {
        findUnique: async () => tenantRun(),
        findFirst: async () => tenantRun(),
      },
      approval: {
        findFirst: (...a: unknown[]) => approvalFindFirst(...a),
        updateMany: (...a: unknown[]) => approvalUpdateMany(...a),
      },
      handoffLedger: {
        findFirst: (...a: unknown[]) => handoffFindFirst(...a),
        updateMany: async (args: { where: { status: string; claimedAt: Date }; data: { status: string; claimedBy: null; claimedAt: null } }) => {
          const l = store.ledger;
          if (l.status !== args.where.status || l.claimedAt?.getTime() !== args.where.claimedAt.getTime()) return { count: 0 };
          Object.assign(l, { status: args.data.status, claimedBy: args.data.claimedBy, claimedAt: args.data.claimedAt });
          return { count: 1 };
        },
      },
      activityLog: { create: (...a: unknown[]) => activityLogCreate(...a) },
    },
    // Realistic rollback: a throw undoes every run write and drops the tx's audit rows.
    tenantTx: async (fn: (tx: unknown) => unknown) => {
      store.undo.length = 0;
      const pendingLogs: unknown[][] = [];
      try {
        const out = await fn({ run: txRun, approval: { findMany: (...a: unknown[]) => approvalFindMany(...a), updateMany: (...a: unknown[]) => approvalUpdateMany(...a) }, activityLog: { create: async (...a: unknown[]) => { pendingLogs.push(a); return {}; } } });
        for (const a of pendingLogs) await activityLogCreate(...a);
        return out;
      } catch (err) {
        const row = store.row as unknown as Record<string, unknown>;
        for (const u of [...store.undo].reverse()) {
          for (const k of Object.keys(u.wrote)) if (row[k] === u.wrote[k]) row[k] = u.prev[k];
        }
        throw err;
      }
    },
  };
});
vi.mock("../../../middleware/auth", () => ({ authMiddleware: (_q: unknown, _s: unknown, next: () => void) => next() }));
vi.mock("../../../middleware/rateLimit", () => ({ rateLimit: () => (_q: unknown, _s: unknown, next: () => void) => next() }));
vi.mock("../../../middleware/require-permission", () => ({
  requirePermission: () => (_q: unknown, _s: unknown, next: () => void) => next(),
}));
vi.mock("../../pipeline/runner", () => ({ enqueueRun: (...a: unknown[]) => enqueueRunMock(...a) }));
vi.mock("../../governance/engine", () => ({ getGovernanceConfig: vi.fn(), getRiskSummary: vi.fn() }));
vi.mock("../../../services/ai-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../services/ai-client")>();
  return { ...actual, getTenantAIConfig: vi.fn().mockResolvedValue({ provider: "ANTHROPIC", model: "m" }), chatCompletion: vi.fn() };
});
vi.mock("../../../services/provider-chain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../services/provider-chain")>();
  return { ...actual, listTenantProviderLinks: vi.fn().mockResolvedValue([{ provider: "OPENAI" }]) };
});
vi.mock("../handoff.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../handoff.service")>();
  return {
    ...actual,
    createHandoff: (...a: unknown[]) => createHandoffMock(...a),
    claimHandoff: (...a: unknown[]) => claimHandoffMock(...a),
    cancelOpenHandoffForRun: (...a: unknown[]) => cancelOpenHandoffForRunMock(...a),
  };
});
vi.mock("../../../config/env", () => ({ env: { NODE_ENV: "development", OFFLINE_MODE: false } }));

import { runRouter } from "../router";
import { governanceRouter } from "../../governance/router";
import { HandoffClaimError } from "../handoff.service";

function getHandler(router: Router, method: string, path: string) {
  const layer = (router as any).stack.find((l: any) => l.route?.path === path && l.route.methods[method.toLowerCase()]);
  if (!layer) throw new Error(`No route ${method} ${path}`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle as (req: any, res: any, next: any) => Promise<void> | void;
}
async function invoke(handler: (req: any, res: any, next: any) => Promise<void> | void, req: any) {
  const res: any = { statusCode: 200, body: undefined, status(c: number) { this.statusCode = c; return this; }, json(p: unknown) { this.body = p; return this; } };
  let nextErr: any;
  await handler({ auth: { tenantId: "tenant-1", userId: "user-1", role: "MEMBER" }, params: { id: "run-1", runId: "run-1" }, body: {}, query: {}, ...req }, res, (e?: any) => { nextErr = e; });
  return { res, nextErr };
}

const setRun = (status: string, state: string | null = null) => {
  store.row.status = status;
  store.row.state = state;
};
const flag = (on: boolean) => vi.stubEnv("JOB_STATE_DUAL_WRITE", on ? "true" : "false");
/** A competing writer finishes the run between the router's read and our write. */
const raceTo = (status: string, state: string | null = null) => {
  store.beforeWrite = () => setRun(status, state);
};
const noSideEffects = () => {
  expect(activityLogCreate).not.toHaveBeenCalled();
  expect(enqueueRunMock).not.toHaveBeenCalled();
};
let claimSeq = 0;
const wroteState = () => store.writes.some((w) => "state" in w.data) || store.selects.some((s) => "state" in (s as object));

beforeEach(() => {
  vi.clearAllMocks();
  setRun("RUNNING");
  store.beforeWrite = null;
  store.beforeWriteAt.clear();
  store.staleRead = null;
  store.ledger.status = "OPEN";
  store.ledger.claimedBy = null;
  store.ledger.claimedAt = null;
  claimSeq = 0;
  store.selects.length = 0;
  store.writes.length = 0;
  activityLogCreate.mockResolvedValue({});
  enqueueRunMock.mockResolvedValue(undefined);
  approvalFindFirst.mockResolvedValue(null);
  approvalFindMany.mockReset();
  approvalFindMany.mockResolvedValue([{ id: "ap-h" }]);
  approvalUpdateMany.mockReset();
  approvalUpdateMany.mockResolvedValue({ count: 1 });
  handoffFindFirst.mockResolvedValue({ id: "hl-1", status: "OPEN" });
  // Same contract as the real atomic claim: only an OPEN ledger can be claimed (one winner), claimedAt is the token.
  claimHandoffMock.mockImplementation(async (input: { claimedBy: string }) => {
    if (store.ledger.status !== "OPEN") throw new HandoffClaimError("NOT_OPEN", "Handoff was claimed by another request");
    store.ledger.status = "CLAIMED";
    store.ledger.claimedBy = input.claimedBy;
    store.ledger.claimedAt = new Date(1_700_000_000_000 + ++claimSeq); // unique per claim
    return { id: "hl-1", status: "CLAIMED", claimedAt: store.ledger.claimedAt };
  });
  createHandoffMock.mockResolvedValue({ id: "hl-1", checkpoint: null });
  cancelOpenHandoffForRunMock.mockResolvedValue(true);
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /runs/:id/stop", () => {
  const stop = getHandler(runRouter, "post", "/:id/stop");

  it.each(["RUNNING", "PAUSED", "WAITING_APPROVAL"])("flag OFF: %s → CANCELLED, status-only write, audit row, same body", async (st) => {
    flag(false);
    setRun(st);
    const { res, nextErr } = await invoke(stop, {});
    expect(nextErr).toBeUndefined();
    expect(res.body).toEqual({ success: true, status: "CANCELLED" });
    expect(store.row.status).toBe("CANCELLED");
    expect(Object.keys(store.writes[0].data).sort()).toEqual(["completedAt", "status"]);
    expect(wroteState()).toBe(false);
    expect(activityLogCreate).toHaveBeenCalledTimes(1);
  });

  it("flag OFF: PENDING is still 400, nothing written", async () => {
    flag(false);
    setRun("PENDING");
    const { nextErr } = await invoke(stop, {});
    expect(nextErr?.statusCode).toBe(400);
    expect(store.writes).toHaveLength(0);
  });

  it("flag ON: PENDING (READY) can be cancelled; state and status written together", async () => {
    flag(true);
    setRun("PENDING");
    const { res, nextErr } = await invoke(stop, {});
    expect(nextErr).toBeUndefined();
    expect(res.body).toEqual({ success: true, status: "CANCELLED" });
    expect(store.row).toMatchObject({ status: "CANCELLED", state: "CANCELLED" });
    expect(activityLogCreate).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("flag %s: finished run (COMPLETED / CANCELLED / FAILED) → 400, no write", async (on) => {
    flag(on);
    for (const st of ["COMPLETED", "CANCELLED", "FAILED"]) {
      setRun(st);
      const { nextErr } = await invoke(stop, {});
      expect(nextErr?.statusCode).toBe(400);
    }
    expect(store.writes).toHaveLength(0);
    noSideEffects();
  });

  it.each([false, true])("flag %s: race (run completes between read and write) → 409, run stays COMPLETED, no audit row", async (on) => {
    flag(on);
    raceTo("COMPLETED");
    const { nextErr, res } = await invoke(stop, {});
    expect(nextErr?.statusCode).toBe(409);
    expect(res.body).toBeUndefined();
    expect(store.row.status).toBe("COMPLETED");
    noSideEffects();
  });

  it("cross-tenant → 404", async () => {
    flag(true);
    const h = getHandler(runRouter, "post", "/:id/stop");
    const { nextErr } = await invoke(h, { auth: { tenantId: "tenant-2", userId: "u" } });
    expect(nextErr?.statusCode).toBe(404);
    expect(store.writes).toHaveLength(0);
  });
});

describe("POST /runs/:id/pause", () => {
  const pause = getHandler(runRouter, "post", "/:id/pause");

  it("flag OFF: still pauses ANY run, even COMPLETED (today's behaviour), status-only", async () => {
    flag(false);
    setRun("COMPLETED");
    const { res, nextErr } = await invoke(pause, {});
    expect(nextErr).toBeUndefined();
    expect(res.body).toEqual({ success: true, status: "PAUSED" });
    expect(store.row.status).toBe("PAUSED");
    expect(wroteState()).toBe(false);
  });

  it.each(["COMPLETED", "FAILED", "CANCELLED"])("flag ON: finished run %s → 409, row untouched", async (st) => {
    flag(true);
    setRun(st);
    const { nextErr } = await invoke(pause, {});
    expect(nextErr?.statusCode).toBe(409);
    expect(store.row.status).toBe(st);
    expect(store.writes).toHaveLength(0);
  });

  it.each(["RUNNING", "PENDING", "WAITING_APPROVAL"])("flag ON: %s → PAUSED with state", async (st) => {
    flag(true);
    setRun(st);
    const { res, nextErr } = await invoke(pause, {});
    expect(nextErr).toBeUndefined();
    expect(res.body).toEqual({ success: true, status: "PAUSED" });
    expect(store.row).toMatchObject({ status: "PAUSED", state: "PAUSED" });
  });

  it("flag ON: already PAUSED → 200, no write (idempotent)", async () => {
    flag(true);
    setRun("PAUSED", "PAUSED");
    const { res, nextErr } = await invoke(pause, {});
    expect(nextErr).toBeUndefined();
    expect(res.body).toEqual({ success: true, status: "PAUSED" });
    expect(store.writes).toHaveLength(0);
  });

  it.each([false, true])("flag %s: race (run completes first) → 409, COMPLETED is not overwritten", async (on) => {
    flag(on);
    raceTo("COMPLETED");
    const { nextErr } = await invoke(pause, {});
    expect(nextErr?.statusCode).toBe(409);
    expect(store.row.status).toBe("COMPLETED");
  });
});

describe("POST /runs/:id/resume", () => {
  const resume = getHandler(runRouter, "post", "/:id/resume");

  it("flag OFF: PAUSED → RUNNING in ONE status-only write, one enqueue, one audit row", async () => {
    flag(false);
    setRun("PAUSED");
    const { res, nextErr } = await invoke(resume, {});
    expect(nextErr).toBeUndefined();
    expect(res.body).toEqual({ success: true, status: "RUNNING" });
    expect(store.writes).toHaveLength(1);
    expect(store.writes[0].data).toEqual({ status: "RUNNING" });
    expect(wroteState()).toBe(false);
    expect(enqueueRunMock).toHaveBeenCalledTimes(1);
    expect(activityLogCreate).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("flag %s: enqueue fails AFTER the commit → run put back to PAUSED (retry-able), error surfaced", async (on) => {
    flag(on);
    setRun("PAUSED", on ? "PAUSED" : null);
    enqueueRunMock.mockRejectedValueOnce(new Error("redis down"));
    const { nextErr, res } = await invoke(resume, {});
    expect(nextErr?.message).toBe("redis down");
    expect(res.body).toBeUndefined();
    expect(store.row.status).toBe("PAUSED");
    if (on) expect(store.row.state).toBe("PAUSED");
  });

  it.each(["PAUSED", "WAITING_APPROVAL"])("flag ON: %s → RESUMING → RUNNING; final state RUNNING agrees with status (ADR (e))", async (st) => {
    flag(true);
    setRun(st);
    const { res, nextErr } = await invoke(resume, {});
    expect(nextErr).toBeUndefined();
    expect(res.body).toEqual({ success: true, status: "RUNNING" });
    expect(store.writes.map((w) => w.data.state)).toEqual(["RESUMING", "RUNNING"]);
    expect(store.row).toMatchObject({ status: "RUNNING", state: "RUNNING" });
    expect(enqueueRunMock).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("flag %s: RUNNING / terminal run → 400 as before, no write", async (on) => {
    flag(on);
    for (const st of ["RUNNING", "COMPLETED", "FAILED", "CANCELLED", "PENDING"]) {
      setRun(st);
      const { nextErr } = await invoke(resume, {});
      expect(nextErr?.statusCode).toBe(400);
    }
    expect(store.writes).toHaveLength(0);
    noSideEffects();
  });

  it.each([false, true])("flag %s: #110 guard kept — undecided approval → 409, no write/enqueue/audit", async (on) => {
    flag(on);
    setRun("WAITING_APPROVAL");
    approvalFindFirst.mockResolvedValue({ id: "ap-1" });
    const { nextErr } = await invoke(resume, {});
    expect(nextErr?.statusCode).toBe(409);
    expect(store.writes).toHaveLength(0);
    noSideEffects();
  });

  it.each([false, true])("flag %s: race (another writer moved the run) → 409; no enqueue, no audit row", async (on) => {
    flag(on);
    setRun("PAUSED");
    raceTo("CANCELLED");
    const { nextErr, res } = await invoke(resume, {});
    expect(nextErr?.statusCode).toBe(409);
    expect(res.body).toBeUndefined();
    expect(store.row.status).toBe("CANCELLED");
    noSideEffects();
  });

  it.each([false, true])("flag %s: staggered duplicate (A already committed RUNNING; B's up-front read was stale PAUSED) → B gets 400, tx rolled back, NO second enqueue/audit", async (on) => {
    flag(on);
    setRun("RUNNING", on ? "RUNNING" : null); // A committed
    store.staleRead = { status: "PAUSED", state: on ? "PAUSED" : null }; // B read before A's commit
    const { nextErr, res } = await invoke(resume, {});
    expect(nextErr?.statusCode).toBe(400);
    expect(res.body).toBeUndefined();
    // RUNNING→RESUMING won its CAS (legal edge) but was rolled back:
    expect(store.row).toMatchObject({ status: "RUNNING", state: on ? "RUNNING" : null });
    noSideEffects();
  });

  it("flag ON: A then B with B's stale read → total exactly one enqueue", async () => {
    flag(true);
    setRun("PAUSED", "PAUSED");
    const a = await invoke(resume, {});
    expect(a.nextErr).toBeUndefined();
    store.staleRead = { status: "PAUSED", state: "PAUSED" };
    const b = await invoke(resume, {});
    expect(b.nextErr?.statusCode).toBe(400);
    expect(enqueueRunMock).toHaveBeenCalledTimes(1);
  });

  it("flag ON: the SECOND write (RESUMING→RUNNING) loses → 409 and the FIRST write is rolled back too; no enqueue/audit", async () => {
    flag(true);
    setRun("PAUSED", "PAUSED");
    store.beforeWriteAt.set(1, () => { store.row.state = "CANCELLED"; }); // competing writer between the two writes
    const { nextErr } = await invoke(resume, {});
    expect(nextErr?.statusCode).toBe(409);
    expect(store.writes).toHaveLength(2);
    // rollback undid the first write (status back to PAUSED); the competitor's own state change stays
    expect(store.row).toMatchObject({ status: "PAUSED", state: "CANCELLED" });
    noSideEffects();
  });
});

describe("POST /runs/:id/handoff (RUNNING → PAUSED)", () => {
  const handoff = getHandler(runRouter, "post", "/:id/handoff");

  it.each([false, true])("flag %s: RUNNING → ledger first, then PAUSED, 201 body unchanged", async (on) => {
    flag(on);
    const { res, nextErr } = await invoke(handoff, { body: { reason: "x" } });
    expect(nextErr).toBeUndefined();
    expect(res.statusCode).toBe(201);
    expect(res.body).toMatchObject({ success: true, handoffId: "hl-1", status: "PAUSED", checkpointPending: true });
    expect(store.row.status).toBe("PAUSED");
    expect(store.row.state === "PAUSED").toBe(on);
    expect(wroteState()).toBe(on);
  });

  it.each([false, true])("flag %s: race (run finished first) → 409, the just-opened ledger is cancelled, no audit row", async (on) => {
    flag(on);
    raceTo("COMPLETED");
    const { nextErr, res } = await invoke(handoff, { body: {} });
    expect(nextErr?.statusCode).toBe(409);
    expect(res.body).toBeUndefined();
    expect(cancelOpenHandoffForRunMock).toHaveBeenCalledWith("run-1", expect.any(String), "user-1");
    expect(store.row.status).toBe("COMPLETED");
    expect(activityLogCreate).not.toHaveBeenCalled();
  });

  it("non-RUNNING (FAILED): no lifecycle write at all", async () => {
    flag(true);
    setRun("FAILED");
    const { res } = await invoke(handoff, { body: {} });
    expect(res.statusCode).toBe(201);
    expect(store.writes).toHaveLength(0);
  });
});

describe("POST /runs/:id/continue", () => {
  const cont = getHandler(runRouter, "post", "/:id/continue");
  const body = { provider: "OPENAI" };

  it.each(["PAUSED", "WAITING_APPROVAL", "FAILED"])("flag OFF: %s → RUNNING, status-only write, enqueue", async (st) => {
    flag(false);
    setRun(st);
    const { res, nextErr } = await invoke(cont, { body });
    expect(nextErr).toBeUndefined();
    expect(res.body).toMatchObject({ success: true, handoffId: "hl-1", status: "RUNNING", toProvider: "OPENAI" });
    expect(store.writes).toHaveLength(1);
    expect(store.writes[0].data).toEqual({ status: "RUNNING" });
    expect(wroteState()).toBe(false);
    expect(enqueueRunMock).toHaveBeenCalledTimes(1);
  });

  it("flag OFF (legacy, unchanged): RUNNING run is enqueued a second time; a stale COMPLETED run is flipped to RUNNING", async () => {
    flag(false);
    setRun("RUNNING");
    expect((await invoke(cont, { body })).nextErr).toBeUndefined();
    expect(enqueueRunMock).toHaveBeenCalledTimes(1);
    store.ledger.status = "OPEN"; // a fresh OPEN handoff for the second call
    setRun("COMPLETED");
    expect((await invoke(cont, { body })).nextErr).toBeUndefined();
    expect(store.row.status).toBe("RUNNING");
  });

  it.each(["PAUSED", "WAITING_APPROVAL", "FAILED"])("flag ON: %s → RESUMING → RUNNING, one enqueue", async (st) => {
    flag(true);
    setRun(st);
    const { res, nextErr } = await invoke(cont, { body });
    expect(nextErr).toBeUndefined();
    expect(res.body).toMatchObject({ success: true, status: "RUNNING" });
    expect(store.writes.map((w) => w.data.state)).toEqual(["RESUMING", "RUNNING"]);
    expect(store.row).toMatchObject({ status: "RUNNING", state: "RUNNING" });
    expect(enqueueRunMock).toHaveBeenCalledTimes(1);
  });

  it("flag ON: RUNNING run → 200 'already': ledger claimed, NO second enqueue, nothing left written", async () => {
    flag(true);
    setRun("RUNNING");
    const { res, nextErr } = await invoke(cont, { body });
    expect(nextErr).toBeUndefined();
    expect(res.body).toMatchObject({ success: true, status: "RUNNING" });
    expect(claimHandoffMock).toHaveBeenCalledTimes(1);
    expect(store.row).toMatchObject({ status: "RUNNING", state: null }); // fresh read said RUNNING: the probe write was rolled back
    expect(enqueueRunMock).not.toHaveBeenCalled();
  });

  it.each(["COMPLETED", "CANCELLED"])("flag ON: finished run %s → 409 BEFORE claim; ledger untouched, no write/enqueue", async (st) => {
    flag(true);
    setRun(st);
    const { nextErr } = await invoke(cont, { body });
    expect(nextErr?.statusCode).toBe(409);
    expect(claimHandoffMock).not.toHaveBeenCalled();
    expect(store.writes).toHaveLength(0);
    noSideEffects();
  });

  it.each([false, true])("flag %s: #110 guard kept — undecided approval → 409, no claim/write/enqueue", async (on) => {
    flag(on);
    setRun("WAITING_APPROVAL");
    approvalFindFirst.mockResolvedValue({ id: "ap-1" });
    const { nextErr } = await invoke(cont, { body });
    expect(nextErr?.statusCode).toBe(409);
    expect(claimHandoffMock).not.toHaveBeenCalled();
    expect(store.writes).toHaveLength(0);
    noSideEffects();
  });

  it.each([false, true])("flag %s: race (run cancelled between claim and write) → 409, no enqueue, ledger given back (OPEN, not CLAIMED)", async (on) => {
    flag(on);
    setRun("PAUSED");
    raceTo("CANCELLED");
    const { nextErr, res } = await invoke(cont, { body });
    expect(nextErr?.statusCode).toBe(409);
    expect(res.body).toBeUndefined();
    expect(store.row.status).toBe("CANCELLED");
    expect(claimHandoffMock).toHaveBeenCalledTimes(1);
    expect(store.ledger).toEqual({ status: "OPEN", claimedBy: null, claimedAt: null });
    noSideEffects();
  });

  it("flag ON: second write loses → 409, first write rolled back, ledger OPEN again", async () => {
    flag(true);
    setRun("PAUSED", "PAUSED");
    store.beforeWriteAt.set(1, () => { store.row.state = "CANCELLED"; });
    const { nextErr } = await invoke(cont, { body });
    expect(nextErr?.statusCode).toBe(409);
    expect(store.row).toMatchObject({ status: "PAUSED", state: "CANCELLED" });
    expect(store.ledger.status).toBe("OPEN");
    noSideEffects();
  });

  it.each([false, true])("flag %s: two concurrent /continue by the SAME user (claim race) → one claim wins and STAYS CLAIMED + one enqueue; loser 409 and never touches the ledger", async (on) => {
    flag(on);
    setRun("PAUSED");
    const [a, b] = await Promise.all([invoke(cont, { body }), invoke(cont, { body })]);
    const codes = [a.nextErr?.statusCode, b.nextErr?.statusCode];
    expect(codes.filter((c) => c === undefined)).toHaveLength(1);
    expect(codes.filter((c) => c === 409)).toHaveLength(1);
    expect(claimHandoffMock).toHaveBeenCalledTimes(2);
    expect(store.ledger.status).toBe("CLAIMED"); // winner's claim not reopened by the loser
    expect(store.ledger.claimedBy).toBe("user-1");
    expect(enqueueRunMock).toHaveBeenCalledTimes(1);
    expect(store.row.status).toBe("RUNNING");
  });

  it("02c-3: flag ON — after a successful claim the run's PENDING HANDOFF approval is closed (REJECTED by system:continue); flag OFF — left alone", async () => {
    flag(true);
    setRun("PAUSED", "PAUSED");
    const on = await invoke(cont, { body });
    expect(on.nextErr).toBeUndefined();
    expect(approvalUpdateMany).toHaveBeenCalledTimes(1);
    expect(approvalFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { runId: "run-1", type: "HANDOFF", status: "PENDING" } }));
    expect(approvalUpdateMany).toHaveBeenCalledWith({
      where: { id: "ap-h", status: "PENDING" },
      data: expect.objectContaining({ status: "REJECTED", decidedBy: "system:continue" }),
    });
    // rule #9: the system decision is audited in the same tx
    expect(activityLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "approval.closed_by_continue", resource: "approval", resourceId: "ap-h", tenantId: "tenant-1", details: expect.objectContaining({ runId: "run-1" }) }),
    });
    expect(enqueueRunMock).toHaveBeenCalledTimes(1);

    approvalUpdateMany.mockClear();
    store.ledger.status = "OPEN"; store.ledger.claimedBy = null; store.ledger.claimedAt = null;
    flag(false);
    setRun("PAUSED");
    await invoke(cont, { body });
    expect(approvalUpdateMany).not.toHaveBeenCalled();
  });

  it("02c-3: flag ON — 'already RUNNING' /continue also closes the pending HANDOFF approval; a refused (lost-CAS) /continue does NOT", async () => {
    flag(true);
    setRun("RUNNING", "RUNNING");
    store.staleRead = { status: "PAUSED", state: "PAUSED" };
    await invoke(cont, { body });
    expect(approvalUpdateMany).toHaveBeenCalledTimes(1);
    expect(enqueueRunMock).not.toHaveBeenCalled();

    approvalUpdateMany.mockClear();
    store.staleRead = null;
    store.ledger.status = "OPEN"; store.ledger.claimedBy = null; store.ledger.claimedAt = null;
    setRun("PAUSED", "PAUSED");
    store.beforeWriteAt.set(store.writes.length + 1, () => { store.row.state = "CANCELLED"; });
    const lost = await invoke(cont, { body });
    expect(lost.nextErr?.statusCode).toBe(409);
    expect(approvalUpdateMany).not.toHaveBeenCalled();
  });

  it.each([false, true])("flag %s: enqueue fails AFTER the commit → run put back to PAUSED, ledger reopened (own token), error surfaced; no RUNNING-without-job", async (on) => {
    flag(on);
    setRun("PAUSED", on ? "PAUSED" : null);
    enqueueRunMock.mockRejectedValueOnce(new Error("redis down"));
    const { nextErr, res } = await invoke(cont, { body });
    expect(nextErr?.message).toBe("redis down");
    expect(res.body).toBeUndefined();
    expect(store.row.status).toBe("PAUSED");
    expect(store.ledger).toEqual({ status: "OPEN", claimedBy: null, claimedAt: null });
  });

  it("a claim by ANOTHER request is never reopened (token mismatch): reopenClaimedHandoff with a stale token is a no-op", async () => {
    const { reopenClaimedHandoff } = await import("../handoff.service");
    store.ledger.status = "CLAIMED";
    store.ledger.claimedBy = "user-1";
    store.ledger.claimedAt = new Date(1_700_000_000_999);
    expect(await reopenClaimedHandoff("hl-1", new Date(1_700_000_000_001))).toBe(false);
    expect(store.ledger.status).toBe("CLAIMED");
    expect(await reopenClaimedHandoff("hl-1", new Date(1_700_000_000_999))).toBe(true);
    expect(store.ledger.status).toBe("OPEN");
  });

  it("flag ON staggered: up-front read stale PAUSED but run is already RUNNING → 200 'already', rolled back, NO second enqueue, claim stays (as for 'already' today)", async () => {
    flag(true);
    setRun("RUNNING", "RUNNING");
    store.staleRead = { status: "PAUSED", state: "PAUSED" };
    const { res, nextErr } = await invoke(cont, { body });
    expect(nextErr).toBeUndefined();
    expect(res.body).toMatchObject({ success: true, status: "RUNNING" });
    expect(store.row).toMatchObject({ status: "RUNNING", state: "RUNNING" });
    expect(enqueueRunMock).not.toHaveBeenCalled();
  });
});

describe("POST /governance/hard-stop/:runId", () => {
  const hardStop = getHandler(governanceRouter, "post", "/hard-stop/:runId");

  it.each([false, true])("flag %s: RUNNING → FAILED with error text, completedAt, audit row; same body", async (on) => {
    flag(on);
    const { res, nextErr } = await invoke(hardStop, { body: { reason: "too risky" } });
    expect(nextErr).toBeUndefined();
    expect(res.body).toEqual({ success: true, status: "FAILED", stopType: "hard_stop" });
    expect(store.row.status).toBe("FAILED");
    expect(store.row.state === "FAILED").toBe(on);
    expect(wroteState()).toBe(on);
    expect(store.writes[0].data).toMatchObject({ status: "FAILED", error: "Hard stop: too risky" });
    expect(store.writes[0].data.completedAt).toBeInstanceOf(Date);
    expect(activityLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "governance.hard_stop", resourceId: "run-1", details: { reason: "too risky" } }),
    });
  });

  it.each(["PAUSED", "WAITING_APPROVAL"])("flag ON: %s → FAILED", async (st) => {
    flag(true);
    setRun(st);
    const { nextErr } = await invoke(hardStop, { body: {} });
    expect(nextErr).toBeUndefined();
    expect(store.row).toMatchObject({ status: "FAILED", state: "FAILED" });
  });

  it.each([false, true])("flag %s: finished / PENDING run → 400, no write, no audit row", async (on) => {
    flag(on);
    for (const st of ["COMPLETED", "CANCELLED", "FAILED", "PENDING"]) {
      setRun(st);
      const { nextErr } = await invoke(hardStop, { body: {} });
      expect(nextErr?.statusCode).toBe(400);
    }
    expect(store.writes).toHaveLength(0);
    expect(activityLogCreate).not.toHaveBeenCalled();
  });

  it.each([false, true])("flag %s: race (run completes first) → 409, COMPLETED kept, NO governance audit row", async (on) => {
    flag(on);
    raceTo("COMPLETED");
    const { nextErr, res } = await invoke(hardStop, { body: {} });
    expect(nextErr?.statusCode).toBe(409);
    expect(res.body).toBeUndefined();
    expect(store.row.status).toBe("COMPLETED");
    expect(activityLogCreate).not.toHaveBeenCalled();
  });
});
