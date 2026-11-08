/**
 * BRA-P0-05 — "onay atlama açığı" negative tests (ADR-0002).
 *
 * Before: /runs/:id/resume, and /handoff + /continue, flipped a run to RUNNING
 * while an approval it was waiting on was still PENDING, without anyone holding
 * approval:decide. After: both refuse with 409 and have no side effect; the only
 * door is POST /approvals/:id/decide. Router handlers are driven directly (same
 * zero-network harness as handoff-router.test.ts).
 * NOT covered: the full HTTP/JWT/RBAC stack for these two routes (the
 * decide route's RBAC is covered by decision-reason-http.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Router } from "express";

vi.mock("../../../lib/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const runFindUnique = vi.hoisted(() => vi.fn());
const runFindFirst = vi.hoisted(() => vi.fn());
const runUpdate = vi.hoisted(() => vi.fn());
const approvalFindFirst = vi.hoisted(() => vi.fn());
const activityLogCreate = vi.hoisted(() => vi.fn());
const handoffFindFirst = vi.hoisted(() => vi.fn());

vi.mock("../../../lib/db", () => ({
  prisma: {
    run: {
      findUnique: (...a: unknown[]) => runFindUnique(...a),
      findFirst: (...a: unknown[]) => runFindFirst(...a),
      update: (...a: unknown[]) => runUpdate(...a),
    },
    approval: { findFirst: (...a: unknown[]) => approvalFindFirst(...a) },
    activityLog: { create: (...a: unknown[]) => activityLogCreate(...a) },
    handoffLedger: { findFirst: (...a: unknown[]) => handoffFindFirst(...a) },
  },
}));
vi.mock("../../../middleware/auth", () => ({ authMiddleware: (_q: unknown, _s: unknown, next: () => void) => next() }));
vi.mock("../../../middleware/rateLimit", () => ({ rateLimit: () => (_q: unknown, _s: unknown, next: () => void) => next() }));

const enqueueRunMock = vi.hoisted(() => vi.fn());
vi.mock("../../pipeline/runner", () => ({ enqueueRun: (...a: unknown[]) => enqueueRunMock(...a) }));
vi.mock("../../../services/ai-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../services/ai-client")>();
  return { ...actual, getTenantAIConfig: vi.fn().mockResolvedValue({ provider: "ANTHROPIC", model: "m" }), chatCompletion: vi.fn() };
});
vi.mock("../../../services/provider-chain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../services/provider-chain")>();
  return { ...actual, listTenantProviderLinks: vi.fn().mockResolvedValue([{ provider: "OPENAI" }]) };
});
const claimHandoffMock = vi.hoisted(() => vi.fn());
const createHandoffMock = vi.hoisted(() => vi.fn());
vi.mock("../handoff.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../handoff.service")>();
  return {
    ...actual,
    createHandoff: (...a: unknown[]) => createHandoffMock(...a),
    claimHandoff: (...a: unknown[]) => claimHandoffMock(...a),
  };
});
vi.mock("../../../config/env", () => ({ env: { NODE_ENV: "development", OFFLINE_MODE: false } }));

import { runRouter } from "../router";

function getHandler(router: Router, method: string, path: string) {
  const layer = (router as any).stack.find((l: any) => l.route?.path === path && l.route.methods[method.toLowerCase()]);
  if (!layer) throw new Error(`No route ${method} ${path}`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle as (req: any, res: any, next: any) => Promise<void> | void;
}
async function invoke(handler: (req: any, res: any, next: any) => Promise<void> | void, req: any) {
  const res: any = { statusCode: 200, body: undefined, status(c: number) { this.statusCode = c; return this; }, json(p: unknown) { this.body = p; return this; } };
  let nextErr: any;
  await handler({ auth: { tenantId: "tenant-1", userId: "user-1", role: "MEMBER" }, params: {}, body: {}, query: {}, ...req }, res, (e?: any) => { nextErr = e; });
  return { res, nextErr };
}

const tenantRun = (status: string) => ({ id: "run-1", status, pipeline: { company: { tenantId: "tenant-1" } } });

beforeEach(() => {
  vi.clearAllMocks();
  runUpdate.mockResolvedValue({});
  activityLogCreate.mockResolvedValue({});
  enqueueRunMock.mockResolvedValue(undefined);
  approvalFindFirst.mockResolvedValue(null);
  handoffFindFirst.mockResolvedValue({ id: "hl-1", status: "OPEN" });
  claimHandoffMock.mockResolvedValue({ id: "hl-1", status: "CLAIMED" });
  createHandoffMock.mockResolvedValue({ id: "hl-1", checkpoint: null });
});

describe("POST /runs/:id/resume — BRA-P0-05 bypass guard", () => {
  const resume = getHandler(runRouter, "post", "/:id/resume");

  it.each(["WAITING_APPROVAL", "PAUSED"])(
    "%s run with an undecided approval → 409; run is NOT flipped to RUNNING, nothing enqueued, no audit row",
    async (status) => {
      runFindUnique.mockResolvedValue(tenantRun(status));
      approvalFindFirst.mockResolvedValue({ id: "ap-1" });
      const { nextErr, res } = await invoke(resume, { params: { id: "run-1" } });
      expect(nextErr?.statusCode).toBe(409);
      expect(res.body).toBeUndefined();
      expect(approvalFindFirst).toHaveBeenCalledWith({ where: { runId: "run-1", status: "PENDING" }, select: { id: true } });
      expect(runUpdate).not.toHaveBeenCalled();
      expect(enqueueRunMock).not.toHaveBeenCalled();
      expect(activityLogCreate).not.toHaveBeenCalled();
    },
  );

  it("approval already decided (none PENDING) → resume still works exactly as before", async () => {
    runFindUnique.mockResolvedValue(tenantRun("WAITING_APPROVAL"));
    const { nextErr, res } = await invoke(resume, { params: { id: "run-1" } });
    expect(nextErr).toBeUndefined();
    expect(res.body).toEqual({ success: true, status: "RUNNING" });
    expect(runUpdate).toHaveBeenCalledWith({ where: { id: "run-1" }, data: { status: "RUNNING" } });
    expect(enqueueRunMock).toHaveBeenCalledWith("run-1");
  });

  it("cross-tenant run → 404 before the approval is even looked up", async () => {
    runFindUnique.mockResolvedValue({ ...tenantRun("PAUSED"), pipeline: { company: { tenantId: "tenant-2" } } });
    const { nextErr } = await invoke(resume, { params: { id: "run-1" } });
    expect(nextErr?.statusCode).toBe(404);
    expect(approvalFindFirst).not.toHaveBeenCalled();
  });

  it("the approval lookup failing is NOT swallowed into a resume (fail-closed)", async () => {
    runFindUnique.mockResolvedValue(tenantRun("PAUSED"));
    approvalFindFirst.mockRejectedValue(new Error("db down"));
    const { nextErr } = await invoke(resume, { params: { id: "run-1" } });
    expect(nextErr).toBeInstanceOf(Error);
    expect(runUpdate).not.toHaveBeenCalled();
    expect(enqueueRunMock).not.toHaveBeenCalled();
  });
});

describe("/handoff → /continue — BRA-P0-05 bypass guard", () => {
  const handoff = getHandler(runRouter, "post", "/:id/handoff");
  const cont = getHandler(runRouter, "post", "/:id/continue");

  it("WAITING_APPROVAL run: /handoff opens a ledger (allowed) but /continue then 409s — run never goes RUNNING", async () => {
    runFindFirst.mockResolvedValue({ id: "run-1", status: "WAITING_APPROVAL" });
    approvalFindFirst.mockResolvedValue({ id: "ap-1" });

    const h = await invoke(handoff, { params: { id: "run-1" }, body: {} });
    expect(h.nextErr).toBeUndefined();
    expect(createHandoffMock).toHaveBeenCalled();

    const c = await invoke(cont, { params: { id: "run-1" }, body: { provider: "OPENAI" } });
    expect(c.nextErr?.statusCode).toBe(409);
    expect(claimHandoffMock).not.toHaveBeenCalled();
    expect(runUpdate).not.toHaveBeenCalledWith({ where: { id: "run-1" }, data: { status: "RUNNING" } });
    expect(enqueueRunMock).not.toHaveBeenCalled();
  });

  it("once the approval is decided via the decide route, the same /continue succeeds", async () => {
    runFindFirst.mockResolvedValue({ id: "run-1", status: "WAITING_APPROVAL" });
    approvalFindFirst.mockResolvedValue(null);
    const c = await invoke(cont, { params: { id: "run-1" }, body: { provider: "OPENAI" } });
    expect(c.nextErr).toBeUndefined();
    expect(claimHandoffMock).toHaveBeenCalled();
    expect(runUpdate).toHaveBeenCalledWith({ where: { id: "run-1" }, data: { status: "RUNNING" } });
    expect(enqueueRunMock).toHaveBeenCalledWith("run-1");
  });
});
