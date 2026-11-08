/**
 * BRA-P0-02c-3 — the approval gates in executeTool drive the run to
 * WAITING_APPROVAL through `transitionRun` (CAS). Stateful fake of the run row;
 * persistence is synthetic. A lost race / refused edge withdraws the just-made
 * approval and leaves NO side effect (activity row, push, event).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  row: { status: "RUNNING", state: null as string | null },
  writes: [] as Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>,
  beforeWrite: null as null | (() => void),
}));
const approvalCreate = vi.hoisted(() => vi.fn());
const approvalDeleteMany = vi.hoisted(() => vi.fn());
const activityLogCreate = vi.hoisted(() => vi.fn());
const toolCallCreate = vi.hoisted(() => vi.fn());
const notify = vi.hoisted(() => vi.fn());
const publish = vi.hoisted(() => vi.fn());

vi.mock("../../../lib/db", () => ({
  prisma: {
    approval: { create: (...a: unknown[]) => approvalCreate(...a), deleteMany: (...a: unknown[]) => approvalDeleteMany(...a) },
    run: {
      findFirst: async (args: { select: Record<string, boolean> }) => {
        const snap: Record<string, unknown> = {};
        for (const k of Object.keys(args.select)) snap[k] = (store.row as Record<string, unknown>)[k];
        return snap;
      },
      updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        store.writes.push(args);
        const hook = store.beforeWrite;
        store.beforeWrite = null;
        hook?.();
        const w = args.where;
        if (w.status !== store.row.status || ("state" in w && w.state !== store.row.state)) return { count: 0 };
        Object.assign(store.row, args.data);
        return { count: 1 };
      },
    },
    activityLog: { create: (...a: unknown[]) => activityLogCreate(...a) },
    toolCall: { create: (...a: unknown[]) => toolCallCreate(...a) },
    company: { findFirst: vi.fn() },
  },
}));
vi.mock("../../../lib/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../../../services/push", () => ({ notifyTenantUsers: (...a: unknown[]) => notify(...a) }));
vi.mock("../../../lib/runEvents", () => ({ publishRunEvent: (...a: unknown[]) => publish(...a) }));

import { executeTool } from "../tool-executor";
import { makeConnectorToolName } from "../../marketplace/dynamic-tools";
import { deriveConnectorToolMeta } from "../../marketplace/connector-tool-risk";

const tool = () => {
  const name = makeConnectorToolName("acme", "delete_record");
  return {
    name,
    description: "Delete a record",
    inputSchema: { type: "object", properties: {} },
    meta: deriveConnectorToolMeta("delete_record", "Delete a record"),
    handler: vi.fn(),
  };
};
const ctx = (t: ReturnType<typeof tool>) => ({
  runId: "run-1", runStepId: "step-1", companyId: "company-a", tenantId: "tenant-a",
  autonomy: "SUPERVISED" as const, extraTools: new Map([[t.name, t as never]]),
});
const flag = (on: boolean) => { process.env.JOB_STATE_DUAL_WRITE = on ? "true" : "false"; };

beforeEach(() => {
  vi.clearAllMocks();
  store.row = { status: "RUNNING", state: null };
  store.writes = [];
  store.beforeWrite = null;
  approvalCreate.mockResolvedValue({ id: "appr-1" });
  approvalDeleteMany.mockResolvedValue({ count: 1 });
  activityLogCreate.mockResolvedValue({});
  toolCallCreate.mockResolvedValue({});
  notify.mockResolvedValue(undefined);
  publish.mockResolvedValue(undefined);
});
afterEach(() => { delete process.env.JOB_STATE_DUAL_WRITE; });

describe("tool gate → WAITING_APPROVAL via transitionRun", () => {
  it("flag OFF: single status-only write, PENDING_APPROVAL, approval kept", async () => {
    flag(false);
    const t = tool();
    const res = await executeTool(t.name, {}, ctx(t));
    expect(res.status).toBe("PENDING_APPROVAL");
    expect(store.row).toEqual({ status: "WAITING_APPROVAL", state: null });
    expect(store.writes).toHaveLength(1);
    expect("state" in store.writes[0].data).toBe(false);
    expect(approvalDeleteMany).not.toHaveBeenCalled();
    expect(t.handler).not.toHaveBeenCalled();
  });

  it("flag ON: RUNNING → NEEDS_APPROVAL (state written together with status)", async () => {
    flag(true);
    store.row = { status: "RUNNING", state: "RUNNING" };
    const t = tool();
    const res = await executeTool(t.name, {}, ctx(t));
    expect(res.status).toBe("PENDING_APPROVAL");
    expect(store.row).toEqual({ status: "WAITING_APPROVAL", state: "NEEDS_APPROVAL" });
  });

  it.each([false, true])("flag %s: race — run cancelled between read and write → FAILED result, approval withdrawn, NO activity/push/event", async (on) => {
    flag(on);
    store.row = { status: "RUNNING", state: on ? "RUNNING" : null };
    store.beforeWrite = () => { store.row.status = "CANCELLED"; if (on) store.row.state = "CANCELLED"; };
    const t = tool();
    const res = await executeTool(t.name, {}, ctx(t));
    expect(res.status).toBe("FAILED");
    expect(approvalDeleteMany).toHaveBeenCalledWith({ where: { id: "appr-1", status: "PENDING" } });
    expect(store.row.status).toBe("CANCELLED");
    expect(activityLogCreate).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(t.handler).not.toHaveBeenCalled();
  });

  it("flag ON: a finished run (COMPLETED) refuses the edge → FAILED result, approval withdrawn, run untouched", async () => {
    flag(true);
    store.row = { status: "COMPLETED", state: "COMPLETED" };
    const t = tool();
    const res = await executeTool(t.name, {}, ctx(t));
    expect(res.status).toBe("FAILED");
    expect(store.writes).toHaveLength(0);
    expect(approvalDeleteMany).toHaveBeenCalledTimes(1);
    expect(activityLogCreate).not.toHaveBeenCalled();
  });

  it("flag ON: a second gate while already WAITING_APPROVAL is a no-op transition and still pends (A/B setup)", async () => {
    flag(true);
    store.row = { status: "WAITING_APPROVAL", state: "NEEDS_APPROVAL" };
    const t = tool();
    const res = await executeTool(t.name, {}, ctx(t));
    expect(res.status).toBe("PENDING_APPROVAL");
    expect(store.writes).toHaveLength(0);
    expect(approvalDeleteMany).not.toHaveBeenCalled();
  });
});
