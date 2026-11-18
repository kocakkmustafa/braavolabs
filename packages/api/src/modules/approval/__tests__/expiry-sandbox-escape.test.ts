/**
 * BRA-P2-02c — expiry cron: a stale SANDBOX_ESCAPE approval is REJECTED (escape denied),
 * the run is NOT cancelled; the agent is told once per approval and a run that is really
 * WAITING_APPROVAL (no other open gate) is resumed + enqueued. Terminal/PAUSED runs and runs
 * with another open gate are untouched.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../lib/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const approvalFindMany = vi.hoisted(() => vi.fn());
const approvalUpdateMany = vi.hoisted(() => vi.fn());
const runWrites = vi.hoisted(() => vi.fn());
const activityLogCreate = vi.hoisted(() => vi.fn());
const steeringCreate = vi.hoisted(() => vi.fn());
const enqueueRunMock = vi.hoisted(() => vi.fn());
const st = vi.hoisted(() => ({
  runStatus: "WAITING_APPROVAL",
  otherGate: false,
  // existing steering rows: { content, consumedAt }
  steering: [] as Array<{ content: string; consumedAt: Date | null }>,
}));

vi.mock("../../../lib/db", () => ({
  prisma: {
    approval: {
      findMany: (...a: unknown[]) => approvalFindMany(...a),
      updateMany: (...a: unknown[]) => approvalUpdateMany(...a),
      findFirst: async () => (st.otherGate ? { id: "other" } : null),
    },
    run: {
      findFirst: async () => ({ status: st.runStatus }),
      updateMany: async (a: { where: { status?: string }; data: { status?: string } }) => {
        if (a.where.status !== st.runStatus) return { count: 0 };
        runWrites(a.data);
        if (a.data.status) st.runStatus = a.data.status;
        return { count: 1 };
      },
    },
    activityLog: { create: (...a: unknown[]) => activityLogCreate(...a) },
    steeringMessage: {
      // real filter semantics for the fields the cron uses
      findFirst: async (a: { where: { content: string; consumedAt: null } }) =>
        st.steering.find((m) => m.content === a.where.content && m.consumedAt === a.where.consumedAt) ? { id: "m" } : null,
      create: async (a: { data: { content: string } }) => {
        steeringCreate(a);
        st.steering.push({ content: a.data.content, consumedAt: null });
        return {};
      },
    },
  },
}));
vi.mock("../../pipeline/runner", () => ({ enqueueRun: (...a: unknown[]) => enqueueRunMock(...a) }));

import { runApprovalExpiry } from "../expiry-cron";
import { buildSandboxEscapeMetadata, sandboxEscapeDeniedMessage } from "../sandbox-escape";

const META = buildSandboxEscapeMetadata({ kind: "net.connect", target: "example.com:443", reasonCode: "net-denied" });
const stale = (type: string, id = "a1") => ({
  id, runId: "run-1", type, metadata: META,
  run: { pipeline: { company: { tenantId: "tenant-1" } } },
});
const statuses = () => runWrites.mock.calls.map((c) => c[0].status);

beforeEach(() => {
  vi.clearAllMocks();
  st.runStatus = "WAITING_APPROVAL";
  st.otherGate = false;
  st.steering = [];
  delete process.env.JOB_STATE_DUAL_WRITE;
  approvalUpdateMany.mockResolvedValue({ count: 1 });
  activityLogCreate.mockResolvedValue({});
  enqueueRunMock.mockResolvedValue(undefined);
});

describe("expiry cron — SANDBOX_ESCAPE", () => {
  it("REJECTS, tells the agent, resumes WAITING_APPROVAL → RUNNING and enqueues; never CANCELLED", async () => {
    approvalFindMany.mockResolvedValue([stale("SANDBOX_ESCAPE")]);
    await runApprovalExpiry();
    expect(approvalUpdateMany.mock.calls[0][0].data.status).toBe("REJECTED");
    expect(statuses()).toEqual(["RUNNING"]);
    expect(st.runStatus).toBe("RUNNING");
    expect(enqueueRunMock).toHaveBeenCalledWith("run-1");
    expect(steeringCreate).toHaveBeenCalledWith({
      data: { runId: "run-1", kind: "INPUT", content: "Sandbox escape denied (net.connect) [approval a1]. Continue without leaving the sandbox.", createdBy: "system:expiry" },
    });
    expect(activityLogCreate.mock.calls[0][0].data.details).toMatchObject({ type: "SANDBOX_ESCAPE", runCancelled: false });
  });
  it.each(["CANCELLED", "COMPLETED", "FAILED"])("%s run → untouched, no enqueue, no message", async (s) => {
    st.runStatus = s;
    approvalFindMany.mockResolvedValue([stale("SANDBOX_ESCAPE")]);
    await runApprovalExpiry();
    expect(approvalUpdateMany.mock.calls[0][0].data.status).toBe("REJECTED");
    expect(st.runStatus).toBe(s);
    expect(statuses()).toEqual([]);
    expect(enqueueRunMock).not.toHaveBeenCalled();
    expect(steeringCreate).not.toHaveBeenCalled();
  });
  it("terminal run, flag ON → untouched too", async () => {
    process.env.JOB_STATE_DUAL_WRITE = "true";
    st.runStatus = "CANCELLED";
    approvalFindMany.mockResolvedValue([stale("SANDBOX_ESCAPE")]);
    await runApprovalExpiry();
    expect(statuses()).toEqual([]);
    expect(enqueueRunMock).not.toHaveBeenCalled();
  });
  it("PAUSED run → stays PAUSED, no enqueue (message queued for the later resume)", async () => {
    st.runStatus = "PAUSED";
    approvalFindMany.mockResolvedValue([stale("SANDBOX_ESCAPE")]);
    await runApprovalExpiry();
    expect(st.runStatus).toBe("PAUSED");
    expect(enqueueRunMock).not.toHaveBeenCalled();
    expect(steeringCreate).toHaveBeenCalledTimes(1);
  });
  it("another open gate → run stays WAITING_APPROVAL, no enqueue", async () => {
    st.otherGate = true;
    approvalFindMany.mockResolvedValue([stale("SANDBOX_ESCAPE")]);
    await runApprovalExpiry();
    expect(st.runStatus).toBe("WAITING_APPROVAL");
    expect(enqueueRunMock).not.toHaveBeenCalled();
  });
  it("flag ON: WAITING_APPROVAL run resumes and enqueues", async () => {
    process.env.JOB_STATE_DUAL_WRITE = "true";
    approvalFindMany.mockResolvedValue([stale("SANDBOX_ESCAPE")]);
    await runApprovalExpiry();
    expect(st.runStatus).toBe("RUNNING");
    expect(enqueueRunMock).toHaveBeenCalledWith("run-1");
  });
  it("idempotent per approval: the same approval's unconsumed message is not written twice", async () => {
    st.runStatus = "PAUSED";
    st.steering = [{ content: sandboxEscapeDeniedMessage(META, "a1"), consumedAt: null }];
    approvalFindMany.mockResolvedValue([stale("SANDBOX_ESCAPE", "a1")]);
    await runApprovalExpiry();
    expect(steeringCreate).not.toHaveBeenCalled();
  });
  it("an OLD consumed message for the same run+kind does not suppress a second request's message", async () => {
    st.runStatus = "PAUSED";
    st.steering = [
      { content: sandboxEscapeDeniedMessage(META, "a0"), consumedAt: new Date() }, // earlier approval, consumed
      { content: sandboxEscapeDeniedMessage(META, "a2"), consumedAt: new Date() }, // even the same approval id, consumed
    ];
    approvalFindMany.mockResolvedValue([stale("SANDBOX_ESCAPE", "a2")]);
    await runApprovalExpiry();
    expect(steeringCreate).toHaveBeenCalledTimes(1);
    expect(steeringCreate.mock.calls[0][0].data.content).toContain("[approval a2]");
  });
  it("enqueue failure puts the run back (no job → not left RUNNING)", async () => {
    enqueueRunMock.mockRejectedValue(new Error("redis down"));
    approvalFindMany.mockResolvedValue([stale("SANDBOX_ESCAPE")]);
    await runApprovalExpiry();
    expect(st.runStatus).toBe("WAITING_APPROVAL");
  });
  it("a lost race (already decided) writes nothing", async () => {
    approvalFindMany.mockResolvedValue([stale("SANDBOX_ESCAPE")]);
    approvalUpdateMany.mockResolvedValue({ count: 0 });
    await runApprovalExpiry();
    expect(steeringCreate).not.toHaveBeenCalled();
    expect(statuses()).toEqual([]);
  });
  it("SPEND still cancels its run; HANDOFF leaves it alone (unchanged)", async () => {
    approvalFindMany.mockResolvedValue([stale("SPEND")]);
    await runApprovalExpiry();
    expect(statuses()).toEqual(["CANCELLED"]);
    expect(enqueueRunMock).not.toHaveBeenCalled();
    st.runStatus = "FAILED";
    runWrites.mockClear();
    approvalFindMany.mockResolvedValue([stale("HANDOFF")]);
    await runApprovalExpiry();
    expect(statuses()).toEqual([]);
    expect(steeringCreate).not.toHaveBeenCalled();
  });
});
