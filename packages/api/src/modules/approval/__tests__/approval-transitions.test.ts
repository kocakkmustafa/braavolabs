/**
 * BRA-P0-02c-3 — approval `decide` and the expiry cron write the run through
 * `transitionRun` (CAS), against a STATEFUL fake of `runs` + `approvals`.
 * Persistence is synthetic (no Postgres): CAS and rollback are modelled, not
 * proven on a real database (that is 02c-6).
 *
 * JOB_STATE_DUAL_WRITE off: the old status-only behaviour (A/B, HANDOFF
 * protection and the finished-run refusals are NOT active).
 * On: A/B gates, `already`, PAUSED approve, HANDOFF working-run protection.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Router } from "express";

vi.mock("../../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

type Row = { status: string; state: string | null };
type Appr = { id: string; runId: string; type: string; status: string; decidedBy?: string };
const store = vi.hoisted(() => ({
  row: { status: "WAITING_APPROVAL", state: null } as { status: string; state: string | null },
  approvals: [] as Array<{ id: string; runId: string; type: string; status: string; decidedBy?: string }>,
  writes: [] as Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>,
  beforeWriteAt: new Map<number, () => void>(),
  ledgerCancel: vi.fn(),
  undoLog: [] as Array<{ w: unknown; prev: Record<string, unknown> }>,
}));
const approvalFindUnique = vi.hoisted(() => vi.fn());
const approvalFindMany = vi.hoisted(() => vi.fn());
const activityLogCreate = vi.hoisted(() => vi.fn());
const enqueueRunMock = vi.hoisted(() => vi.fn());
const claimHandoffMock = vi.hoisted(() => vi.fn());
const reopenMock = vi.hoisted(() => vi.fn());

vi.mock("../../../lib/db", () => {
  const run = {
    findFirst: async (args: { select: Record<string, boolean> }) => {
      const snap: Record<string, unknown> = {};
      for (const k of Object.keys(args.select)) snap[k] = (store.row as unknown as Record<string, unknown>)[k];
      return snap;
    },
    updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const ordinal = store.writes.length;
      store.writes.push(args);
      store.beforeWriteAt.get(ordinal)?.();
      const w = args.where;
      const ok = w.status === store.row.status && (!("state" in w) || w.state === store.row.state);
      if (!ok) return { count: 0 };
      const prev: Record<string, unknown> = {};
      for (const k of Object.keys(args.data)) if (k === "status" || k === "state") prev[k] = (store.row as any)[k];
      store.undoLog.push({ w: args, prev });
      Object.assign(store.row, args.data);
      return { count: 1 };
    },
  };
  const approval = {
    updateMany: async (args: { where: { id: string; status: string }; data: Record<string, unknown> }) => {
      const a = store.approvals.find((x) => x.id === args.where.id);
      if (!a || a.status !== args.where.status) return { count: 0 };
      Object.assign(a, args.data);
      return { count: 1 };
    },
    update: async () => ({}),
    findFirst: async (args: { where: { runId: string; id: { not: string }; status: string; type: { not: string } } }) =>
      store.approvals.find(
        (x) => x.runId === args.where.runId && x.id !== args.where.id.not && x.status === args.where.status && x.type !== args.where.type.not,
      ) ?? null,
    findUnique: (...a: unknown[]) => approvalFindUnique(...a),
    findMany: (...a: unknown[]) => approvalFindMany(...a),
  };
  const tx = {
    run,
    approval,
    activityLog: { create: (...a: unknown[]) => activityLogCreate(...a) },
    steeringMessage: { create: async () => ({}) },
  };
  return {
    prisma: {
      run,
      approval,
      handoffLedger: { updateMany: (...a: unknown[]) => store.ledgerCancel(...a) },
      activityLog: tx.activityLog,
    },
    // Rollback model: restore the run row and approvals when the callback throws.
    tenantTx: async (fn: (t: typeof tx) => Promise<unknown>) => {
      const snap = { row: { ...store.row }, approvals: store.approvals.map((a) => ({ ...a })), writes: store.writes.length };
      try {
        return await fn(tx);
      } catch (e) {
        // Roll back only what THIS tx wrote to the run (a concurrent writer's change must survive).
        for (const w of store.writes.slice(snap.writes)) {
          const undo = store.undoLog.find((u) => u.w === w);
          if (undo) Object.assign(store.row, undo.prev);
        }
        store.approvals = snap.approvals;
        throw e;
      }
    },
  };
});
vi.mock("../../../middleware/auth", () => ({ authMiddleware: (_q: unknown, _s: unknown, next: () => void) => next() }));
vi.mock("../../../middleware/require-permission", () => ({
  requirePermission: () => (_q: unknown, _s: unknown, next: () => void) => next(),
}));
vi.mock("../../pipeline/runner", () => ({ enqueueRun: (...a: unknown[]) => enqueueRunMock(...a) }));
vi.mock("../../external/control", () => ({ runControlAction: vi.fn() }));
vi.mock("../../run/handoff.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../run/handoff.service")>();
  return {
    ...actual,
    claimHandoff: (...a: unknown[]) => claimHandoffMock(...a),
    reopenClaimedHandoff: (...a: unknown[]) => reopenMock(...a),
  };
});

import { approvalRouter } from "../router";
import { runApprovalExpiry } from "../expiry-cron";

const CLAIMED_AT = new Date(1_700_000_000_000);

function decideHandler() {
  const layer = (approvalRouter as Router as any).stack.find((l: any) => l.route?.path === "/:id/decide" && l.route.methods.post);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle as (req: any, res: any, next: any) => Promise<void>;
}
async function decide(id: string, decision: "APPROVED" | "REJECTED") {
  const res: any = { statusCode: 200, body: undefined, status(c: number) { this.statusCode = c; return this; }, json(p: unknown) { this.body = p; return this; } };
  let nextErr: any;
  await decideHandler()({ auth: { tenantId: "tenant-1", userId: "user-1" }, params: { id }, body: { decision } }, res, (e?: any) => { nextErr = e; });
  return { res, nextErr };
}

function setRun(status: string, state: string | null = null) {
  store.row = { status, state };
}
function addApproval(a: Partial<Appr> & { id: string }): Appr {
  const full: Appr = { runId: "run-1", type: "SPEND", status: "PENDING", ...a };
  store.approvals.push(full);
  return full;
}
function serve(a: Appr, metadata: unknown = {}) {
  // decide() re-reads by id; return the CURRENT stored status like the real table would.
  approvalFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) => {
    const cur = store.approvals.find((x) => x.id === where.id) ?? a;
    return { ...cur, amountUsd: null, metadata, expiresAt: null, run: { pipeline: { company: { tenantId: "tenant-1" } } } };
  });
}
const flag = (on: boolean) => { process.env.JOB_STATE_DUAL_WRITE = on ? "true" : "false"; };
const wroteState = () => store.writes.some((w) => "state" in w.data);

beforeEach(() => {
  vi.clearAllMocks();
  store.row = { status: "WAITING_APPROVAL", state: null };
  store.approvals = [];
  store.writes = [];
  store.undoLog = [];
  store.beforeWriteAt.clear();
  activityLogCreate.mockResolvedValue({});
  enqueueRunMock.mockResolvedValue(undefined);
  store.ledgerCancel.mockResolvedValue({ count: 1 });
  claimHandoffMock.mockResolvedValue({ id: "hl-1", status: "CLAIMED", claimedAt: CLAIMED_AT });
  reopenMock.mockResolvedValue(true);
});
afterEach(() => { delete process.env.JOB_STATE_DUAL_WRITE; });

describe("decide APPROVED (non-HANDOFF)", () => {
  it("flag OFF: one status-only write RUNNING + one enqueue (as before)", async () => {
    flag(false);
    const a = addApproval({ id: "a" }); serve(a);
    const { res, nextErr } = await decide("a", "APPROVED");
    expect(nextErr).toBeUndefined();
    expect(res.body).toEqual({ success: true, decision: "APPROVED" });
    expect(store.row).toEqual({ status: "RUNNING", state: null });
    expect(store.writes).toHaveLength(1);
    expect(wroteState()).toBe(false);
    expect(enqueueRunMock).toHaveBeenCalledTimes(1);
  });

  it("flag ON: NEEDS_APPROVAL → RESUMING → RUNNING in the same tx (ADR-0001 (e)), one enqueue", async () => {
    flag(true);
    setRun("WAITING_APPROVAL", "NEEDS_APPROVAL");
    const a = addApproval({ id: "a" }); serve(a);
    const { nextErr } = await decide("a", "APPROVED");
    expect(nextErr).toBeUndefined();
    expect(store.writes.map((w) => w.data.state)).toEqual(["RESUMING", "RUNNING"]);
    expect(store.row).toMatchObject({ status: "RUNNING", state: "RUNNING" });
    expect(enqueueRunMock).toHaveBeenCalledTimes(1);
  });

  it("A/B, flag ON: A approved while B is still PENDING → run STAYS WAITING_APPROVAL, no enqueue; deciding B then starts it", async () => {
    flag(true);
    setRun("WAITING_APPROVAL", "NEEDS_APPROVAL");
    const a = addApproval({ id: "a" }); addApproval({ id: "b" }); serve(a);
    const first = await decide("a", "APPROVED");
    expect(first.nextErr).toBeUndefined();
    expect(first.res.body).toEqual({ success: true, decision: "APPROVED" });
    expect(store.approvals.find((x) => x.id === "a")?.status).toBe("APPROVED");
    expect(store.row).toMatchObject({ status: "WAITING_APPROVAL", state: "NEEDS_APPROVAL" });
    expect(store.writes).toHaveLength(0);
    expect(enqueueRunMock).not.toHaveBeenCalled();

    const second = await decide("b", "APPROVED");
    expect(second.nextErr).toBeUndefined();
    expect(store.row).toMatchObject({ status: "RUNNING", state: "RUNNING" });
    expect(enqueueRunMock).toHaveBeenCalledTimes(1);
  });

  it("A/B, flag OFF: legacy — A approved starts the run although B is PENDING", async () => {
    flag(false);
    const a = addApproval({ id: "a" }); addApproval({ id: "b" }); serve(a);
    await decide("a", "APPROVED");
    expect(store.row.status).toBe("RUNNING");
    expect(enqueueRunMock).toHaveBeenCalledTimes(1);
  });

  it("flag ON: a PENDING HANDOFF proposal is not a gate (does not hold the run)", async () => {
    flag(true);
    setRun("WAITING_APPROVAL", "NEEDS_APPROVAL");
    const a = addApproval({ id: "a" }); addApproval({ id: "h", type: "HANDOFF" }); serve(a);
    await decide("a", "APPROVED");
    expect(store.row.status).toBe("RUNNING");
    expect(enqueueRunMock).toHaveBeenCalledTimes(1);
  });

  it("flag ON: PAUSED run (operator paused while waiting) — approval is decided, run STAYS PAUSED, no enqueue; /resume is then unblocked", async () => {
    flag(true);
    setRun("PAUSED", "PAUSED");
    const a = addApproval({ id: "a" }); serve(a);
    const { res, nextErr } = await decide("a", "APPROVED");
    expect(nextErr).toBeUndefined();
    expect(res.body).toEqual({ success: true, decision: "APPROVED" });
    expect(store.approvals[0].status).toBe("APPROVED");
    expect(store.row).toMatchObject({ status: "PAUSED", state: "PAUSED" });
    expect(enqueueRunMock).not.toHaveBeenCalled();
    // no PENDING gating approval is left, so the #110 guard (hasOpenApproval) no longer blocks /resume
    expect(store.approvals.filter((x) => x.status === "PENDING" && x.type !== "HANDOFF")).toHaveLength(0);
  });

  it("flag ON: already RUNNING → no second enqueue; flag OFF → legacy enqueue", async () => {
    flag(true);
    setRun("RUNNING", "RUNNING");
    const a = addApproval({ id: "a" }); serve(a);
    await decide("a", "APPROVED");
    expect(enqueueRunMock).not.toHaveBeenCalled();
    expect(store.writes).toHaveLength(0);

    flag(false);
    setRun("RUNNING");
    addApproval({ id: "a2" }); serve(store.approvals[1]);
    await decide("a2", "APPROVED");
    expect(enqueueRunMock).toHaveBeenCalledTimes(1);
  });

  it("race: CAS lost to a concurrent /stop → 409, approval claim rolled back (still PENDING), no enqueue", async () => {
    flag(false);
    const a = addApproval({ id: "a" }); serve(a);
    store.beforeWriteAt.set(0, () => { store.row.status = "CANCELLED"; });
    const { nextErr, res } = await decide("a", "APPROVED");
    expect(nextErr?.statusCode).toBe(409);
    expect(res.body).toBeUndefined();
    expect(store.approvals[0].status).toBe("PENDING");
    expect(store.row.status).toBe("CANCELLED");
    expect(enqueueRunMock).not.toHaveBeenCalled();
  });
});

describe("decide APPROVED (non-HANDOFF) — enqueue fails after the commit", () => {
  it.each([false, true])("flag %s: run put back to WAITING_APPROVAL (retry-able), answer still 200 as before", async (on) => {
    flag(on);
    setRun("WAITING_APPROVAL", on ? "NEEDS_APPROVAL" : null);
    const a = addApproval({ id: "a" }); serve(a);
    enqueueRunMock.mockRejectedValueOnce(new Error("redis down"));
    const { res, nextErr } = await decide("a", "APPROVED");
    expect(nextErr).toBeUndefined();
    expect(res.body).toEqual({ success: true, decision: "APPROVED" });
    expect(store.row.status).toBe("WAITING_APPROVAL");
    if (on) expect(store.row.state).toBe("NEEDS_APPROVAL");
  });

  it.each([false, true])("flag %s: a /stop, completion or failure in between is never undone (CANCELLED stays CANCELLED)", async (on) => {
    for (const other of ["CANCELLED", "COMPLETED", "FAILED"]) {
      flag(on);
      store.approvals = [];
      setRun("WAITING_APPROVAL", on ? "NEEDS_APPROVAL" : null);
      const a = addApproval({ id: "a" }); serve(a);
      enqueueRunMock.mockImplementationOnce(async () => { store.row.status = other; if (on) store.row.state = other; throw new Error("redis down"); });
      await decide("a", "APPROVED");
      expect(store.row.status).toBe(other);
    }
  });
});

describe("decide REJECTED (non-HANDOFF)", () => {
  it("flag OFF: CANCELLED + completedAt, status-only, same body", async () => {
    flag(false);
    const a = addApproval({ id: "a" }); serve(a);
    const { res } = await decide("a", "REJECTED");
    expect(res.body).toEqual({ success: true, decision: "REJECTED" });
    expect(store.row.status).toBe("CANCELLED");
    expect(store.writes[0].data.completedAt).toBeInstanceOf(Date);
    expect(wroteState()).toBe(false);
    expect(enqueueRunMock).not.toHaveBeenCalled();
  });

  it("flag ON: CANCELLED with state; a finished (COMPLETED) run is left alone but the decision stands (200)", async () => {
    flag(true);
    setRun("WAITING_APPROVAL", "NEEDS_APPROVAL");
    const a = addApproval({ id: "a" }); serve(a);
    await decide("a", "REJECTED");
    expect(store.row).toMatchObject({ status: "CANCELLED", state: "CANCELLED" });

    store.writes = [];
    setRun("COMPLETED", "COMPLETED");
    addApproval({ id: "c" }); serve(store.approvals[1]);
    const { res, nextErr } = await decide("c", "REJECTED");
    expect(nextErr).toBeUndefined();
    expect(res.body).toEqual({ success: true, decision: "REJECTED" });
    expect(store.row).toMatchObject({ status: "COMPLETED", state: "COMPLETED" });
    expect(store.approvals[1].status).toBe("REJECTED");
    expect(store.writes).toHaveLength(0);
  });
});

describe("decide — HANDOFF proposals (02c-3: do not fail a working run)", () => {
  const meta = { handoffId: "hl-1", suggestedProvider: "OPENAI", suggestedModel: "gpt-4o" };

  it("after /continue closed the proposal (REJECTED by system:continue) a late decide → 409, run untouched", async () => {
    flag(true);
    setRun("RUNNING", "RUNNING");
    const h = addApproval({ id: "h", type: "HANDOFF", status: "REJECTED", decidedBy: "system:continue" }); serve(h, meta);
    const { nextErr } = await decide("h", "REJECTED");
    expect(nextErr?.statusCode).toBe(409);
    expect(store.writes).toHaveLength(0);
    expect(store.row.status).toBe("RUNNING");
  });

  it("REJECT on a RUNNING run: flag ON → run NOT failed (ledger still cancelled); flag OFF → legacy FAILED", async () => {
    flag(true);
    setRun("RUNNING", "RUNNING");
    const h = addApproval({ id: "h", type: "HANDOFF" }); serve(h, meta);
    const { res } = await decide("h", "REJECTED");
    expect(res.body).toEqual({ success: true, decision: "REJECTED" });
    expect(store.row).toMatchObject({ status: "RUNNING", state: "RUNNING" });
    expect(store.ledgerCancel).toHaveBeenCalledTimes(1);

    flag(false);
    setRun("RUNNING");
    addApproval({ id: "h2", type: "HANDOFF" }); serve(store.approvals[1], meta);
    await decide("h2", "REJECTED");
    expect(store.row.status).toBe("FAILED");
  });

  it("REJECT on a FAILED run (the normal case) stays FAILED, flag ON and OFF", async () => {
    for (const on of [true, false]) {
      flag(on);
      store.approvals = [];
      setRun("FAILED", on ? "FAILED" : null);
      const h = addApproval({ id: "h", type: "HANDOFF" }); serve(h, meta);
      const { nextErr } = await decide("h", "REJECTED");
      expect(nextErr).toBeUndefined();
      expect(store.row.status).toBe("FAILED");
    }
  });

  it("APPROVE on a FAILED run: claim, then RESUMING → RUNNING, one enqueue (flag ON); status-only RUNNING (OFF)", async () => {
    flag(true);
    setRun("FAILED", "FAILED");
    const h = addApproval({ id: "h", type: "HANDOFF" }); serve(h, meta);
    const { res } = await decide("h", "APPROVED");
    expect(res.body).toEqual({ success: true, decision: "APPROVED" });
    expect(store.writes.map((w) => w.data.state)).toEqual(["RESUMING", "RUNNING"]);
    expect(enqueueRunMock).toHaveBeenCalledTimes(1);

    flag(false);
    store.writes = []; store.approvals = []; enqueueRunMock.mockClear();
    setRun("FAILED");
    const h2 = addApproval({ id: "h2", type: "HANDOFF" }); serve(h2, meta);
    await decide("h2", "APPROVED");
    expect(store.writes).toHaveLength(1);
    expect(wroteState()).toBe(false);
    expect(store.row.status).toBe("RUNNING");
    expect(enqueueRunMock).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])("APPROVE, flag %s: enqueue fails AFTER the run committed RUNNING → run back to FAILED, ledger reopened with OUR token, claimFailed answer (no RUNNING-without-job, no stuck CLAIMED)", async (on) => {
    flag(on);
    setRun("FAILED", on ? "FAILED" : null);
    const h = addApproval({ id: "h", type: "HANDOFF" }); serve(h, meta);
    enqueueRunMock.mockRejectedValueOnce(new Error("redis down"));
    const { res, nextErr } = await decide("h", "APPROVED");
    expect(nextErr).toBeUndefined();
    expect(res.body).toMatchObject({ success: true, decision: "APPROVED", claimFailed: true, error: "redis down" });
    expect(store.row.status).toBe("FAILED");
    if (on) expect(store.row.state).toBe("FAILED");
    expect(reopenMock).toHaveBeenCalledWith("hl-1", CLAIMED_AT);
  });

  it.each([true, false])("APPROVE, flag %s: a concurrent /stop / completion between commit and a failing enqueue → run NOT revived, ledger NOT reopened (only a revert of our own RUNNING reopens)", async (on) => {
    for (const other of ["CANCELLED", "COMPLETED"]) {
      flag(on);
      reopenMock.mockClear(); store.approvals = [];
      setRun("FAILED", on ? "FAILED" : null);
      const h = addApproval({ id: "h", type: "HANDOFF" }); serve(h, meta);
      enqueueRunMock.mockImplementationOnce(async () => { store.row.status = other; if (on) store.row.state = other; throw new Error("timeout"); });
      const { res } = await decide("h", "APPROVED");
      expect(res.body).toMatchObject({ claimFailed: true, error: "timeout" });
      expect(store.row.status).toBe(other);
      expect(reopenMock).not.toHaveBeenCalled();
    }
  });

  it("APPROVE while the run is already RUNNING (flag ON): claimed, NO second enqueue, run not failed", async () => {
    flag(true);
    setRun("RUNNING", "RUNNING");
    const h = addApproval({ id: "h", type: "HANDOFF" }); serve(h, meta);
    const { res } = await decide("h", "APPROVED");
    expect(res.body).toEqual({ success: true, decision: "APPROVED" });
    expect(claimHandoffMock).toHaveBeenCalledTimes(1);
    expect(enqueueRunMock).not.toHaveBeenCalled();
    expect(store.row.status).toBe("RUNNING");
    expect(reopenMock).not.toHaveBeenCalled();
  });

  it("APPROVE on a COMPLETED run (flag ON): transition refused → claimFailed, ledger given back with OUR claim token, run untouched, no enqueue", async () => {
    flag(true);
    setRun("COMPLETED", "COMPLETED");
    const h = addApproval({ id: "h", type: "HANDOFF" }); serve(h, meta);
    const { res, nextErr } = await decide("h", "APPROVED");
    expect(nextErr).toBeUndefined();
    expect(res.body).toMatchObject({ success: true, decision: "APPROVED", claimFailed: true });
    expect(reopenMock).toHaveBeenCalledWith("hl-1", CLAIMED_AT);
    expect(store.row).toMatchObject({ status: "COMPLETED", state: "COMPLETED" });
    expect(enqueueRunMock).not.toHaveBeenCalled();
  });
});

describe("approval expiry cron", () => {
  const stale = (id: string, type: string) => ({ id, runId: "run-1", type, run: { pipeline: { company: { tenantId: "tenant-1" } } } });

  it("non-HANDOFF: run → CANCELLED through transitionRun (flag OFF status-only, ON with state)", async () => {
    flag(false);
    addApproval({ id: "a" });
    approvalFindMany.mockResolvedValue([stale("a", "SPEND")]);
    await runApprovalExpiry();
    expect(store.row.status).toBe("CANCELLED");
    expect(wroteState()).toBe(false);

    flag(true);
    store.writes = []; store.approvals = [];
    setRun("WAITING_APPROVAL", "NEEDS_APPROVAL");
    addApproval({ id: "a" });
    await runApprovalExpiry();
    expect(store.row).toMatchObject({ status: "CANCELLED", state: "CANCELLED" });
  });

  it("HANDOFF: the run is left alone (no run write at all), flag ON and OFF", async () => {
    for (const on of [true, false]) {
      flag(on);
      store.writes = []; store.approvals = [];
      setRun("FAILED", on ? "FAILED" : null);
      addApproval({ id: "h", type: "HANDOFF" });
      approvalFindMany.mockResolvedValue([stale("h", "HANDOFF")]);
      await runApprovalExpiry();
      expect(store.writes).toHaveLength(0);
      expect(store.row.status).toBe("FAILED");
      expect(activityLogCreate.mock.calls.at(-1)?.[0].data.details).toMatchObject({ runCancelled: false });
    }
  });

  it("flag ON: a finished run is not touched and the audit row says runCancelled=false; the approval is still REJECTED", async () => {
    flag(true);
    setRun("COMPLETED", "COMPLETED");
    addApproval({ id: "a" });
    approvalFindMany.mockResolvedValue([stale("a", "SPEND")]);
    await runApprovalExpiry();
    expect(store.row.status).toBe("COMPLETED");
    expect(store.approvals[0].status).toBe("REJECTED");
    expect(activityLogCreate.mock.calls.at(-1)?.[0].data.details).toMatchObject({ runCancelled: false });
  });

  it("lost CAS (run changed under the sweep) → run not overwritten, sweep continues", async () => {
    flag(false);
    addApproval({ id: "a" });
    store.beforeWriteAt.set(0, () => { store.row.status = "COMPLETED"; });
    approvalFindMany.mockResolvedValue([stale("a", "SPEND")]);
    await runApprovalExpiry();
    expect(store.row.status).toBe("COMPLETED");
    expect(activityLogCreate).toHaveBeenCalledTimes(1);
  });
});

export type { Row };
