/**
 * E3/T5 — approval decide HANDOFF branch (plan T5, adversarial B4b/B4d). The
 * decide handler is extracted from the Router stack and driven with a mock
 * req/res; prisma (incl. $transaction), enqueueRun, claimHandoff are mocked.
 *
 * Covered:
 *   • APPROVE + HANDOFF → claim runs FIRST; on success run → RUNNING + enqueue.
 *   • APPROVE + claim FAILS → NO enqueue, run stays FAILED, ledger stays OPEN,
 *     claimError noted on the approval (B4b).
 *   • REJECT + HANDOFF → run stays FAILED (NOT CANCELLED), ledger CANCELLED (B4d).
 *   • The generic (non-HANDOFF) branch is unaffected: APPROVE → RUNNING+enqueue.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Router } from "express";

vi.mock("../../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const approvalFindUnique = vi.hoisted(() => vi.fn());
const approvalUpdate = vi.hoisted(() => vi.fn());
const approvalUpdateMany = vi.hoisted(() => vi.fn());
const runUpdate = vi.hoisted(() => vi.fn());
const runFindMany = vi.hoisted(() => vi.fn());
const handoffUpdateMany = vi.hoisted(() => vi.fn());
const activityLogCreate = vi.hoisted(() => vi.fn());
const steeringCreate = vi.hoisted(() => vi.fn());
const draftFindFirst = vi.hoisted(() => vi.fn());
const txRun = vi.hoisted(() => vi.fn());

// A $transaction(fn) mock: builds a `tx` object with the same method surface
// and runs the callback. Records run.update calls made INSIDE the tx via txRun.
vi.mock("../../../lib/db", () => {
  const tx = {
    approval: {
      updateMany: (...a: unknown[]) => approvalUpdateMany(...a),
      update: (...a: unknown[]) => approvalUpdate(...a),
    },
    run: { update: (...a: unknown[]) => txRun(...a) },
    activityLog: { create: (...a: unknown[]) => activityLogCreate(...a) },
    steeringMessage: { create: (...a: unknown[]) => steeringCreate(...a) },
  };
  return {
    prisma: {
      approval: {
        findUnique: (...a: unknown[]) => approvalFindUnique(...a),
        update: (...a: unknown[]) => approvalUpdate(...a),
        findMany: vi.fn(),
      },
      run: {
        update: (...a: unknown[]) => runUpdate(...a),
        findMany: (...a: unknown[]) => runFindMany(...a),
      },
      handoffLedger: { updateMany: (...a: unknown[]) => handoffUpdateMany(...a) },
      draft: { findFirst: (...a: unknown[]) => draftFindFirst(...a) },
      $transaction: async (fn: any) => fn(tx),
    },
  };
});

vi.mock("../../../middleware/auth", () => ({
  authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const enqueueRunMock = vi.hoisted(() => vi.fn());
vi.mock("../../pipeline/runner", () => ({ enqueueRun: (...a: unknown[]) => enqueueRunMock(...a) }));

const claimHandoffMock = vi.hoisted(() => vi.fn());
vi.mock("../../run/handoff.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../run/handoff.service")>();
  return {
    ...actual,
    claimHandoff: (...a: unknown[]) => claimHandoffMock(...a),
    // HandoffClaimError stays real.
  };
});

import { approvalRouter } from "../router";
import { HandoffClaimError } from "../../run/handoff.service";

function getHandler(router: Router, method: string, path: string) {
  const layer = (router as any).stack.find(
    (l: any) => l.route && l.route.path === path && l.route.methods[method.toLowerCase()],
  );
  if (!layer) throw new Error(`No route ${method} ${path}`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle as (req: any, res: any, next: any) => Promise<void>;
}

function mockRes() {
  const res: any = {
    statusCode: 200, body: undefined,
    status(c: number) { this.statusCode = c; return this; },
    json(p: unknown) { this.body = p; return this; },
  };
  return res;
}

async function invoke(handler: any, req: any) {
  const res = mockRes();
  let nextErr: any;
  await handler({ auth: { tenantId: "tenant-1", userId: "user-1" }, params: {}, body: {}, query: {}, ...req }, res, (e?: any) => { nextErr = e; });
  return { res, nextErr };
}

function handoffApproval(overrides: Record<string, unknown> = {}) {
  return {
    id: "ap-1",
    runId: "run-1",
    type: "HANDOFF",
    status: "PENDING",
    amountUsd: null,
    metadata: { handoffId: "hl-1", suggestedProvider: "OPENAI", suggestedModel: "gpt-4o" },
    run: { pipeline: { company: { tenantId: "tenant-1" } } },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  approvalUpdateMany.mockResolvedValue({ count: 1 }); // wins the race
  approvalUpdate.mockResolvedValue({});
  runUpdate.mockResolvedValue({});
  txRun.mockResolvedValue({});
  handoffUpdateMany.mockResolvedValue({ count: 1 });
  activityLogCreate.mockResolvedValue({});
  steeringCreate.mockResolvedValue({});
  enqueueRunMock.mockResolvedValue(undefined);
  claimHandoffMock.mockResolvedValue({ id: "hl-1", status: "CLAIMED" });
});

const decideHandler = getHandler(approvalRouter, "post", "/:id/decide");

describe("approval decide — HANDOFF branch (B4b/B4d)", () => {
  it("APPROVE → claim runs FIRST, then run RUNNING + enqueue", async () => {
    approvalFindUnique.mockResolvedValue(handoffApproval());
    const { res, nextErr } = await invoke(decideHandler, { params: { id: "ap-1" }, body: { decision: "APPROVED" } });

    expect(nextErr).toBeUndefined();
    // Inside the tx the run was NOT flipped to RUNNING for HANDOFF.
    expect(txRun).not.toHaveBeenCalled();
    // Claim ran, THEN run → RUNNING (post-tx), THEN enqueue.
    expect(claimHandoffMock).toHaveBeenCalledWith(expect.objectContaining({ handoffId: "hl-1", provider: "OPENAI", model: "gpt-4o" }));
    expect(runUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "RUNNING" } }));
    expect(enqueueRunMock).toHaveBeenCalledWith("run-1");
    expect(res.body).toMatchObject({ success: true, decision: "APPROVED" });
  });

  it("APPROVE + claim FAILS → NO enqueue, run stays FAILED, claimError noted (B4b)", async () => {
    approvalFindUnique.mockResolvedValue(handoffApproval());
    claimHandoffMock.mockRejectedValue(new HandoffClaimError("CHECKPOINT_PENDING", "not frozen"));

    const { res, nextErr } = await invoke(decideHandler, { params: { id: "ap-1" }, body: { decision: "APPROVED" } });

    expect(nextErr).toBeUndefined();
    expect(enqueueRunMock).not.toHaveBeenCalled();
    // Run driven to FAILED (never RUNNING).
    expect(runUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "FAILED", completedAt: expect.any(Date) } }));
    expect(runUpdate).not.toHaveBeenCalledWith(expect.objectContaining({ data: { status: "RUNNING" } }));
    // claimError noted on the approval.
    const noteCall = approvalUpdate.mock.calls.find((c: any) => c[0]?.data?.metadata?.claimError);
    expect(noteCall).toBeTruthy();
    expect(res.body).toMatchObject({ success: true, decision: "APPROVED", claimFailed: true });
  });

  it("REJECT → run stays FAILED (NOT CANCELLED), ledger CANCELLED (B4d)", async () => {
    approvalFindUnique.mockResolvedValue(handoffApproval());
    const { res, nextErr } = await invoke(decideHandler, { params: { id: "ap-1" }, body: { decision: "REJECTED" } });

    expect(nextErr).toBeUndefined();
    // Inside the tx, HANDOFF+REJECT flips run to FAILED (not CANCELLED).
    expect(txRun).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "FAILED", completedAt: expect.any(Date) } }));
    // No CANCELLED anywhere for the run.
    const cancelledRun = [...txRun.mock.calls, ...runUpdate.mock.calls].find((c: any) => c[0]?.data?.status === "CANCELLED");
    expect(cancelledRun).toBeUndefined();
    // Ledger CANCELLED.
    expect(handoffUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "hl-1", status: "OPEN" },
      data: expect.objectContaining({ status: "CANCELLED" }),
    }));
    expect(enqueueRunMock).not.toHaveBeenCalled();
    expect(res.body).toMatchObject({ success: true, decision: "REJECTED" });
  });

  it("generic (SPEND) APPROVE is unaffected → RUNNING + enqueue via generic path", async () => {
    approvalFindUnique.mockResolvedValue(handoffApproval({ type: "SPEND", metadata: {} }));
    const { nextErr } = await invoke(decideHandler, { params: { id: "ap-1" }, body: { decision: "APPROVED" } });

    expect(nextErr).toBeUndefined();
    // Generic branch flips run to RUNNING INSIDE the tx.
    expect(txRun).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "RUNNING" } }));
    expect(claimHandoffMock).not.toHaveBeenCalled();
    expect(enqueueRunMock).toHaveBeenCalledWith("run-1");
  });
});
