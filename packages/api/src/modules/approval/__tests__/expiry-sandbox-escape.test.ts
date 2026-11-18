/**
 * BRA-P2-02c — expiry cron: a stale SANDBOX_ESCAPE approval is REJECTED (escape denied)
 * but the run is NOT cancelled; the agent gets one idempotent "denied" INPUT message.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../lib/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const approvalFindMany = vi.hoisted(() => vi.fn());
const approvalUpdateMany = vi.hoisted(() => vi.fn());
const runUpdate = vi.hoisted(() => vi.fn());
const activityLogCreate = vi.hoisted(() => vi.fn());
const steeringFindFirst = vi.hoisted(() => vi.fn());
const steeringCreate = vi.hoisted(() => vi.fn());

vi.mock("../../../lib/db", () => ({
  prisma: {
    approval: { findMany: (...a: unknown[]) => approvalFindMany(...a), updateMany: (...a: unknown[]) => approvalUpdateMany(...a) },
    run: {
      findFirst: async () => ({ status: "WAITING_APPROVAL" }),
      updateMany: async (a: { where: { id: string }; data: unknown }) => { runUpdate({ where: { id: a.where.id }, data: a.data }); return { count: 1 }; },
    },
    activityLog: { create: (...a: unknown[]) => activityLogCreate(...a) },
    steeringMessage: { findFirst: (...a: unknown[]) => steeringFindFirst(...a), create: (...a: unknown[]) => steeringCreate(...a) },
  },
}));

import { runApprovalExpiry } from "../expiry-cron";
import { buildSandboxEscapeMetadata } from "../sandbox-escape";

const stale = (type: string) => ({
  id: "a1", runId: "run-1", type,
  metadata: buildSandboxEscapeMetadata({ kind: "net.connect", target: "example.com:443", reasonCode: "net-denied" }),
  run: { pipeline: { company: { tenantId: "tenant-1" } } },
});

beforeEach(() => {
  vi.clearAllMocks();
  approvalUpdateMany.mockResolvedValue({ count: 1 });
  activityLogCreate.mockResolvedValue({});
  steeringFindFirst.mockResolvedValue(null);
  steeringCreate.mockResolvedValue({});
});

describe("expiry cron — SANDBOX_ESCAPE", () => {
  it("REJECTS, does NOT cancel the run, tells the agent", async () => {
    approvalFindMany.mockResolvedValue([stale("SANDBOX_ESCAPE")]);
    await runApprovalExpiry();
    expect(approvalUpdateMany.mock.calls[0][0].data.status).toBe("REJECTED");
    expect(runUpdate).not.toHaveBeenCalled();
    expect(steeringCreate).toHaveBeenCalledWith({
      data: { runId: "run-1", kind: "INPUT", content: "Sandbox escape denied (net.connect). Continue without leaving the sandbox.", createdBy: "system:expiry" },
    });
    expect(activityLogCreate.mock.calls[0][0].data.details).toMatchObject({ type: "SANDBOX_ESCAPE", runCancelled: false });
  });
  it("is idempotent: the same message already queued is not queued again", async () => {
    approvalFindMany.mockResolvedValue([stale("SANDBOX_ESCAPE")]);
    steeringFindFirst.mockResolvedValue({ id: "m1" });
    await runApprovalExpiry();
    expect(steeringCreate).not.toHaveBeenCalled();
    expect(runUpdate).not.toHaveBeenCalled();
  });
  it("a lost race (already decided) writes nothing", async () => {
    approvalFindMany.mockResolvedValue([stale("SANDBOX_ESCAPE")]);
    approvalUpdateMany.mockResolvedValue({ count: 0 });
    await runApprovalExpiry();
    expect(steeringCreate).not.toHaveBeenCalled();
  });
  it("a stale SPEND approval still cancels its run (unchanged)", async () => {
    approvalFindMany.mockResolvedValue([stale("SPEND")]);
    await runApprovalExpiry();
    expect(runUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "CANCELLED" }) }));
    expect(steeringCreate).not.toHaveBeenCalled();
  });
});
