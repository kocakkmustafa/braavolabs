/**
 * BRA-P0-04d — POST /runs/:id/retry. Hafıza içi koşu satırı, `updateMany`
 * CAS semantiğini (id + status [+ state]) taklit eder; `beforeWrite` kancası
 * yarışı simüle eder. NOT covered: gerçek Postgres kilitleme/RLS/HTTP+JWT
 * (tenantTx sahte; yarış için .db.test.ts yok — NOT_TESTED).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Router } from "express";

vi.mock("../../../lib/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const store = vi.hoisted(() => ({
  row: {} as Record<string, any>,
  tenant: "tenant-1",
  pipelineType: "SEQUENTIAL",
  steps: [] as any[],
  beforeWrite: null as null | (() => void),
  beforeAcct: null as null | (() => void),
  writes: [] as Array<{ where: Record<string, any>; data: Record<string, any> }>,
  undo: [] as Array<{ prev: Record<string, any>; wrote: Record<string, any> }>,
}));
const activityLogCreate = vi.hoisted(() => vi.fn());
const approvalFindFirst = vi.hoisted(() => vi.fn());
const enqueueRunMock = vi.hoisted(() => vi.fn());

const applyData = (row: Record<string, any>, data: Record<string, any>) => {
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === "object" && "increment" in v) row[k] = (row[k] ?? 0) + v.increment;
    else if (v && typeof v === "object" && "decrement" in v) row[k] = (row[k] ?? 0) - v.decrement;
    else row[k] = v;
  }
};

vi.mock("../../../lib/db", () => {
  const txRun = {
    findFirst: async (args: { where: any; select: Record<string, boolean> }) => {
      if (args.where.pipeline?.company?.tenantId !== store.tenant) return null;
      const snap: Record<string, unknown> = {};
      for (const k of Object.keys(args.select)) snap[k] = store.row[k];
      return snap;
    },
    updateMany: async (args: { where: Record<string, any>; data: Record<string, any> }) => {
      store.writes.push(args);
      if ("retryCount" in args.data && !("decrement" in (args.data.retryCount ?? {}))) {
        const h = store.beforeAcct;
        store.beforeAcct = null;
        h?.();
      }
      const hook = store.beforeWrite;
      store.beforeWrite = null;
      hook?.();
      const w = args.where;
      if (w.status !== undefined && w.status !== store.row.status) return { count: 0 };
      if ("state" in w && w.state !== store.row.state) return { count: 0 };
      if (w.retryCount?.lt !== undefined && !(store.row.retryCount < w.retryCount.lt)) return { count: 0 };
      if (typeof w.retryCount === "number" && w.retryCount !== store.row.retryCount) return { count: 0 };
      const prev: Record<string, any> = {};
      for (const k of Object.keys(args.data)) prev[k] = store.row[k];
      store.undo.push({ prev, wrote: { ...args.data } });
      applyData(store.row, args.data);
      return { count: 1 };
    },
  };
  return {
    prisma: {
      run: {
        findUnique: async () => ({
          ...store.row,
          steps: store.steps,
          pipeline: { pipelineType: store.pipelineType, company: { tenantId: store.tenant === "none" ? "other" : "tenant-1" } },
        }),
      },
      approval: { findFirst: (...a: unknown[]) => approvalFindFirst(...a) },
    },
    tenantTx: async (fn: (tx: unknown) => unknown) => {
      store.undo.length = 0;
      const logs: unknown[][] = [];
      try {
        const out = await fn({ run: txRun, activityLog: { create: async (...a: unknown[]) => { logs.push(a); return {}; } } });
        for (const a of logs) await activityLogCreate(...a);
        return out;
      } catch (err) {
        for (const u of [...store.undo].reverse()) for (const k of Object.keys(u.prev)) store.row[k] = u.prev[k];
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
  return { ...actual, getTenantAIConfig: vi.fn(), chatCompletion: vi.fn() };
});
vi.mock("../../../services/provider-chain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../services/provider-chain")>();
  return { ...actual, listTenantProviderLinks: vi.fn().mockResolvedValue([]) };
});
vi.mock("../../../config/env", () => ({ env: { NODE_ENV: "development", OFFLINE_MODE: false } }));

import { runRouter } from "../router";

function getHandler(router: Router, method: string, path: string) {
  const layer = (router as any).stack.find((l: any) => l.route?.path === path && l.route.methods[method.toLowerCase()]);
  if (!layer) throw new Error(`No route ${method} ${path}`);
  return layer.route.stack[layer.route.stack.length - 1].handle as (req: any, res: any, next: any) => Promise<void> | void;
}
async function invoke(handler: (req: any, res: any, next: any) => Promise<void> | void) {
  const res: any = { statusCode: 200, body: undefined, status(c: number) { this.statusCode = c; return this; }, json(p: unknown) { this.body = p; return this; } };
  let nextErr: any;
  await handler({ auth: { tenantId: "tenant-1", userId: "user-1" }, params: { id: "run-1" }, body: {}, query: {} }, res, (e?: any) => { nextErr = e; });
  return { res, nextErr };
}
const setRun = (status: string, state: string | null, extra: Record<string, unknown> = {}) => {
  store.row = { id: "run-1", status, state, retryCount: 0, heartbeatAt: null, resultStatus: null, jobBudget: null, costUsd: 0, ...extra };
};
const retry = getHandler(runRouter, "post", "/:id/retry");

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("JOB_STATE_DUAL_WRITE", "true");
  store.tenant = "tenant-1";
  store.pipelineType = "SEQUENTIAL";
  store.steps = [];
  store.beforeWrite = null;
  store.beforeAcct = null;
  store.writes.length = 0;
  approvalFindFirst.mockResolvedValue(null);
  enqueueRunMock.mockResolvedValue(undefined);
  activityLogCreate.mockResolvedValue({});
  setRun("FAILED", "FAILED");
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /runs/:id/retry", () => {
  it("FAILED → RESUMING → RUNNING, retryCount+1, fresh heartbeat, one enqueue, one audit row", async () => {
    const { res, nextErr } = await invoke(retry);
    expect(nextErr).toBeUndefined();
    expect(res.body).toEqual({ success: true, status: "RUNNING", retryCount: 1 });
    expect(store.writes.map((w) => w.data.state ?? "acct")).toEqual(["RESUMING", "RUNNING", "acct"]);
    expect(store.row).toMatchObject({ status: "RUNNING", state: "RUNNING", retryCount: 1 });
    expect(store.row.heartbeatAt).toBeInstanceOf(Date);
    expect(enqueueRunMock).toHaveBeenCalledTimes(1);
    expect(activityLogCreate).toHaveBeenCalledTimes(1);
  });

  it("PAUSED with no open approval is retryable too", async () => {
    setRun("PAUSED", "PAUSED");
    const { nextErr } = await invoke(retry);
    expect(nextErr).toBeUndefined();
    expect(enqueueRunMock).toHaveBeenCalledTimes(1);
  });

  it("enqueue fails → run put back to FAILED, retry refunded, error surfaced", async () => {
    enqueueRunMock.mockRejectedValueOnce(new Error("redis down"));
    const { nextErr, res } = await invoke(retry);
    expect(nextErr?.message).toBe("redis down");
    expect(res.body).toBeUndefined();
    expect(store.row).toMatchObject({ status: "FAILED", state: "FAILED", retryCount: 0 });
  });

  it("enqueue fails but a concurrent /stop moved the run on → not revived, retry not refunded over a foreign state", async () => {
    enqueueRunMock.mockImplementationOnce(async () => { store.row.status = "CANCELLED"; store.row.state = "CANCELLED"; throw new Error("timeout"); });
    const { nextErr } = await invoke(retry);
    expect(nextErr?.message).toBe("timeout");
    expect(store.row).toMatchObject({ status: "CANCELLED", state: "CANCELLED" });
  });

  it("quota used up (default 3) → 409 retry_budget_exhausted, nothing written or enqueued", async () => {
    setRun("FAILED", "FAILED", { retryCount: 3 });
    const { nextErr } = await invoke(retry);
    expect(nextErr?.statusCode).toBe(409);
    expect(nextErr?.message).toBe("retry_budget_exhausted");
    expect(store.writes).toHaveLength(0);
    expect(enqueueRunMock).not.toHaveBeenCalled();
  });

  it("default allows exactly 3 retries (retryCount 2 → ok)", async () => {
    setRun("FAILED", "FAILED", { retryCount: 2 });
    const { res } = await invoke(retry);
    expect(res.body).toMatchObject({ retryCount: 3 });
  });

  it("jobBudget.maxRetries wins over the default; spent usd budget also blocks", async () => {
    setRun("FAILED", "FAILED", { retryCount: 1, jobBudget: { maxRetries: 1 } });
    expect((await invoke(retry)).nextErr?.message).toBe("retry_budget_exhausted");
    setRun("FAILED", "FAILED", { jobBudget: { maxUsd: 1 }, costUsd: 1 });
    expect((await invoke(retry)).nextErr?.message).toBe("retry_budget_exhausted");
    setRun("FAILED", "FAILED", { jobBudget: { maxRetries: "x" } });
    expect((await invoke(retry)).nextErr?.message).toBe("retry_budget_exhausted"); // malformed: fail-closed
    expect(enqueueRunMock).not.toHaveBeenCalled();
  });

  it("duplicate request after the first won → 409 already_retrying, single enqueue", async () => {
    const first = await invoke(retry);
    expect(first.nextErr).toBeUndefined();
    const second = await invoke(retry);
    expect(second.nextErr?.statusCode).toBe(409);
    expect(second.nextErr?.message).toBe("already_retrying");
    expect(enqueueRunMock).toHaveBeenCalledTimes(1);
    expect(store.row.retryCount).toBe(1);
  });

  it("race: a competing retry wins the CAS between read and write → 409 already_retrying, no enqueue, no audit", async () => {
    store.beforeWrite = () => { store.row.status = "RUNNING"; store.row.state = "RUNNING"; };
    const { nextErr } = await invoke(retry);
    expect(nextErr?.statusCode).toBe(409);
    expect(nextErr?.message).toBe("already_retrying");
    expect(enqueueRunMock).not.toHaveBeenCalled();
    expect(activityLogCreate).not.toHaveBeenCalled();
  });

  it("another tenant's run → 404, nothing written", async () => {
    store.tenant = "none";
    const { nextErr } = await invoke(retry);
    expect(nextErr?.statusCode).toBe(404);
    expect(store.writes).toHaveLength(0);
  });

  it("open approval is never skipped (PAUSED and FAILED) → 409 approval_pending", async () => {
    approvalFindFirst.mockResolvedValue({ id: "ap-1" });
    for (const st of ["PAUSED", "FAILED"]) {
      setRun(st, st);
      const { nextErr } = await invoke(retry);
      expect(nextErr?.statusCode).toBe(409);
      expect(nextErr?.message).toBe("approval_pending");
    }
    expect(store.writes).toHaveLength(0);
    expect(enqueueRunMock).not.toHaveBeenCalled();
  });

  it("run waiting on approval (NEEDS_APPROVAL / WAITING_APPROVAL), finished runs → 409 run_not_retryable", async () => {
    for (const [st, state] of [["WAITING_APPROVAL", "NEEDS_APPROVAL"], ["WAITING_APPROVAL", null], ["COMPLETED", "COMPLETED"], ["CANCELLED", "CANCELLED"], ["PENDING", null]] as const) {
      setRun(st, state);
      const { nextErr } = await invoke(retry);
      expect(nextErr?.message).toBe("run_not_retryable");
    }
    expect(store.writes).toHaveLength(0);
  });

  it("stale-heartbeat RUNNING → 409 run_still_running (use stop first); fresh RUNNING → already_retrying", async () => {
    setRun("RUNNING", "RUNNING", { heartbeatAt: new Date(Date.now() - 3_600_000) });
    const stale = await invoke(retry);
    expect(stale.nextErr?.statusCode).toBe(409);
    expect(stale.nextErr?.message).toBe("run_still_running");
    setRun("RUNNING", "RUNNING", { heartbeatAt: new Date() });
    expect((await invoke(retry)).nextErr?.message).toBe("already_retrying");
    expect(store.writes).toHaveLength(0);
    expect(enqueueRunMock).not.toHaveBeenCalled();
  });

  it("flag OFF: dark route → 409 retry_disabled, nothing written", async () => {
    vi.stubEnv("JOB_STATE_DUAL_WRITE", "false");
    const { nextErr } = await invoke(retry);
    expect(nextErr?.message).toBe("retry_disabled");
    expect(store.writes).toHaveLength(0);
    expect(enqueueRunMock).not.toHaveBeenCalled();
  });

  it("hierarchical pipeline → retry now ACCEPTED like sequential (BRA-P0-04j): CAS, retryCount+1, one enqueue", async () => {
    store.pipelineType = "HIERARCHICAL";
    setRun("FAILED", "FAILED", { retryCount: 1 });
    const { nextErr } = await invoke(retry);
    expect(nextErr).toBeUndefined();
    expect(store.row).toMatchObject({ status: "RUNNING", retryCount: 2 });
    expect(enqueueRunMock).toHaveBeenCalledTimes(1);
    expect(activityLogCreate).toHaveBeenCalledTimes(1);
    store.pipelineType = "SEQUENTIAL";
  });

  it("refund is CAS on retryCount in the SAME tx as the revert: never negative, never double, skipped if retryCount moved", async () => {
    // normal: 2 -> 3 -> refund back to 2, exactly once
    setRun("FAILED", "FAILED", { retryCount: 2 });
    enqueueRunMock.mockRejectedValueOnce(new Error("redis down"));
    await invoke(retry);
    expect(store.row).toMatchObject({ status: "FAILED", retryCount: 2 });
    // retryCount moved by someone else (e.g. crash recovery) while still RUNNING: run reverted, refund NOT applied
    setRun("FAILED", "FAILED", { retryCount: 0 });
    enqueueRunMock.mockImplementationOnce(async () => { store.row.retryCount = 5; throw new Error("timeout"); });
    await invoke(retry);
    expect(store.row).toMatchObject({ status: "FAILED", retryCount: 5 });
    // run already moved on (not RUNNING): nothing reverted, nothing refunded, never below zero
    setRun("FAILED", "FAILED", { retryCount: 0 });
    enqueueRunMock.mockImplementationOnce(async () => { store.row.status = "COMPLETED"; store.row.state = "COMPLETED"; throw new Error("x"); });
    await invoke(retry);
    expect(store.row.retryCount).toBe(1);
    expect(store.row.retryCount).toBeGreaterThanOrEqual(0);
  });

  it("race: another retry bumps retryCount to the limit between read and accounting → 409 retry_budget_exhausted, tx rolled back, limit never exceeded", async () => {
    setRun("FAILED", "FAILED", { retryCount: 2 });
    store.beforeAcct = () => { store.row.retryCount = 3; };
    const { nextErr } = await invoke(retry);
    expect(nextErr?.statusCode).toBe(409);
    expect(nextErr?.message).toBe("retry_budget_exhausted");
    expect(store.row).toMatchObject({ status: "FAILED", state: "FAILED", retryCount: 3 });
    expect(enqueueRunMock).not.toHaveBeenCalled();
    expect(activityLogCreate).not.toHaveBeenCalled();
  });

  it("response, audit and refund use the CURRENT incremented value, not the stale read", async () => {
    setRun("FAILED", "FAILED", { retryCount: 1 });
    store.beforeAcct = () => { store.row.retryCount = 2; };
    const { res } = await invoke(retry);
    expect(res.body).toMatchObject({ retryCount: 3 });
    expect(activityLogCreate.mock.calls[0][0].data.details.retryCount).toBe(3);
    // refund matches the current value (3 → 2)
    setRun("FAILED", "FAILED", { retryCount: 1 });
    store.beforeAcct = () => { store.row.retryCount = 2; };
    enqueueRunMock.mockRejectedValueOnce(new Error("redis down"));
    await invoke(retry);
    expect(store.row).toMatchObject({ status: "FAILED", retryCount: 2 });
  });

  it("accounting and refund updates are tenant-scoped (rule #10) and limit-conditioned", async () => {
    setRun("FAILED", "FAILED", { jobBudget: { maxRetries: 5 } });
    enqueueRunMock.mockRejectedValueOnce(new Error("redis down"));
    await invoke(retry);
    const scope = { company: { tenantId: "tenant-1" } };
    const acct = store.writes.find((w) => "heartbeatAt" in w.data)!;
    expect(acct.where.pipeline).toEqual(scope);
    expect(acct.where.retryCount).toEqual({ lt: 5 });
    const refund = store.writes.find((w) => w.data.retryCount && "decrement" in w.data.retryCount)!;
    expect(refund.where.pipeline).toEqual(scope);
  });
});
