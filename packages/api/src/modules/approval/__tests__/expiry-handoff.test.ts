/**
 * E3/T3 — approval expiry cron HANDOFF branch (plan §2.5 — B6.1). A HANDOFF
 * approval that goes 24h without a decision is REJECTED, but unlike every other
 * approval type the run is LEFT ALONE (stays FAILED) and the ledger is LEFT
 * OPEN — so the operator can still claim the handoff from web/CLI. The generic
 * branch (SPEND/INPUT/EXTERNAL_CONTROL) still cancels the run.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const txTenants = vi.hoisted(() => [] as Array<string | undefined>);
let failRunId: string | null = null;
const approvalFindMany = vi.hoisted(() => vi.fn());
const approvalUpdateMany = vi.hoisted(() => vi.fn());
const runUpdate = vi.hoisted(() => vi.fn());
const activityLogCreate = vi.hoisted(() => vi.fn());

vi.mock("../../../lib/db", () => {
  const prisma = {
    approval: {
      findMany: (...a: unknown[]) => approvalFindMany(...a),
      updateMany: (...a: unknown[]) => approvalUpdateMany(...a),
    },
    // 02c-3: the cancel is a transitionRun (findFirst + updateMany CAS); adapted onto the same spy.
    run: {
      findFirst: async () => ({ status: "WAITING_APPROVAL" }),
      updateMany: async (a: { where: { id: string }; data: unknown }) => { if (failRunId === a.where.id) throw new Error("boom"); runUpdate({ where: { id: a.where.id }, data: a.data }); return { count: 1 }; },
    },
    activityLog: { create: (...a: unknown[]) => activityLogCreate(...a) },
  };
  return {
    prisma,
    // Mirrors the real tenantTx contract the cron relies on: a tenant context must be bound.
    tenantTx: async (fn: (tx: typeof prisma) => unknown) => {
      const { currentTenantId } = await import("../../../lib/tenant-context");
      txTenants.push(currentTenantId());
      return fn(prisma);
    },
  };
});

import { runApprovalExpiry } from "../expiry-cron";

function staleApproval(id: string, type: string) {
  return {
    id,
    runId: `run-${id}`,
    type,
    run: { pipeline: { company: { tenantId: "tenant-1" } } },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  txTenants.length = 0;
  approvalUpdateMany.mockResolvedValue({ count: 1 }); // wins the race
  runUpdate.mockResolvedValue({});
  activityLogCreate.mockResolvedValue({});
});

describe("expiry cron — HANDOFF branch (B6.1)", () => {
  it("REJECTS a stale HANDOFF approval but does NOT cancel the run", async () => {
    approvalFindMany.mockResolvedValue([staleApproval("a1", "HANDOFF")]);

    await runApprovalExpiry();

    // Approval flipped to REJECTED.
    expect(approvalUpdateMany).toHaveBeenCalledTimes(1);
    expect(approvalUpdateMany.mock.calls[0][0].data.status).toBe("REJECTED");
    // Run was NOT touched — it stays FAILED, the ledger stays OPEN.
    expect(runUpdate).not.toHaveBeenCalled();
    // Auditable: the activity log records the run was left alone.
    expect(activityLogCreate.mock.calls[0][0].data.details).toMatchObject({
      type: "HANDOFF",
      runCancelled: false,
    });
  });

  it("BRA-ADAY-7: every per-approval write runs under that approval's tenant (claim, cancel, log)", async () => {
    approvalFindMany.mockResolvedValue([
      { ...staleApproval("a5", "SPEND"), run: { pipeline: { company: { tenantId: "tenant-A" } } } },
      { ...staleApproval("a6", "HANDOFF"), run: { pipeline: { company: { tenantId: "tenant-B" } } } },
    ]);

    await runApprovalExpiry();

    // ORTA2: claim + cancel + log is ONE tenantTx per approval, bound to that approval's tenant.
    expect(txTenants).toEqual(["tenant-A", "tenant-B"]);
  });

  it("ORTA1: a failing approval (3rd, cancel tx throws) is logged and the 4th+ are still processed", async () => {
    approvalFindMany.mockResolvedValue([1, 2, 3, 4, 5].map((n) => staleApproval(`b${n}`, "SPEND")));
    const { logger } = await import("../../../lib/logger");
    failRunId = "run-b3";
    await runApprovalExpiry();
    failRunId = null;
    expect(runUpdate.mock.calls.map((c) => c[0].where.id)).toEqual(["run-b1", "run-b2", "run-b4", "run-b5"]);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith({ scanned: 5, rejected: 4 }, "Approval expiry cron tick");
  });

  it("a stale SPEND approval STILL cancels its run (generic branch unchanged)", async () => {
    approvalFindMany.mockResolvedValue([staleApproval("a2", "SPEND")]);

    await runApprovalExpiry();

    expect(runUpdate).toHaveBeenCalledTimes(1);
    expect(runUpdate.mock.calls[0][0].data).toMatchObject({ status: "CANCELLED" });
    expect(activityLogCreate.mock.calls[0][0].data.details).toMatchObject({ runCancelled: true });
  });

  it("mixed batch: HANDOFF left alone, SPEND cancelled — exactly one run.update", async () => {
    approvalFindMany.mockResolvedValue([
      staleApproval("a3", "HANDOFF"),
      staleApproval("a4", "SPEND"),
    ]);

    await runApprovalExpiry();

    expect(approvalUpdateMany).toHaveBeenCalledTimes(2); // both rejected
    expect(runUpdate).toHaveBeenCalledTimes(1); // only the SPEND run cancelled
    expect(runUpdate.mock.calls[0][0].where.id).toBe("run-a4");
  });

  it("lost race (updateMany count 0) → no run touch, no activity log", async () => {
    approvalFindMany.mockResolvedValue([staleApproval("a5", "HANDOFF")]);
    approvalUpdateMany.mockResolvedValue({ count: 0 });

    await runApprovalExpiry();

    expect(runUpdate).not.toHaveBeenCalled();
    expect(activityLogCreate).not.toHaveBeenCalled();
  });
});
