/**
 * BRA-P1-06-N2 — job owner + insan onaylı teslim. Hafıza içi sahte db; where'deki tenant ve
 * CAS koşullarını gerçekten uygular (tenantId silinirse testler düşer). Gerçek Postgres yok.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Router } from "express";

vi.mock("../../../lib/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const db = vi.hoisted(() => ({
  runs: [] as Array<Record<string, any>>,
  users: [] as Array<{ id: string; tenantId: string }>,
  logs: [] as Array<Record<string, any>>,
  runTenant: {} as Record<string, string>,
  created: [] as Array<Record<string, any>>,
}));

vi.mock("../../../lib/db", () => {
  const matches = (r: any, w: any): boolean => {
    if (w.id !== undefined && r.id !== w.id) return false;
    const t = w.pipeline?.company?.tenantId;
    if (t !== undefined && db.runTenant[r.id] !== t) return false;
    if (w.status !== undefined && r.status !== w.status) return false;
    if ("deliveryApprovedAt" in w && w.deliveryApprovedAt === null && r.deliveryApprovedAt) return false;
    return true;
  };
  const run = {
    findFirst: async ({ where }: any) => {
      const r = db.runs.find((x) => matches(x, where));
      return r ? { ...r } : null;
    },
    updateMany: async ({ where, data }: any) => {
      const rows = db.runs.filter((x) => matches(x, where));
      rows.forEach((r) => Object.assign(r, data));
      return { count: rows.length };
    },
  };
  const activityLog = { create: async ({ data }: any) => { db.logs.push(data); return data; } };
  return {
    prisma: {
      run,
      user: { findFirst: async ({ where }: any) => db.users.find((u) => u.id === where.id && u.tenantId === where.tenantId) ?? null },
      activityLog,
    },
    tenantTx: async (fn: any) => fn({ run, activityLog }),
  };
});
vi.mock("../../../middleware/auth", () => ({ authMiddleware: (_q: unknown, _s: unknown, next: () => void) => next() }));
vi.mock("../../../middleware/rateLimit", () => ({ rateLimit: () => (_q: unknown, _s: unknown, next: () => void) => next() }));
vi.mock("../../../middleware/require-permission", () => ({ requirePermission: () => (_q: unknown, _s: unknown, next: () => void) => next() }));
vi.mock("../../pipeline/runner", () => ({ enqueueRun: vi.fn() }));
vi.mock("../../governance/engine", () => ({ getGovernanceConfig: vi.fn(), getRiskSummary: vi.fn() }));
vi.mock("../../../config/env", () => ({ env: { NODE_ENV: "development", OFFLINE_MODE: false } }));

import { assignRunOwner, approveRunDelivery } from "../delivery";
import { runRouter } from "../router";
import { createPlannedRun } from "../../jobs/start";

const T = "tenant-1";
const member = { tenantId: T, userId: "u-member", role: "MEMBER" };
const owner = { tenantId: T, userId: "u-owner", role: "MEMBER" };
const admin = { tenantId: T, userId: "u-admin", role: "ADMIN" };
const foreignAdmin = { tenantId: "tenant-2", userId: "u-x", role: "OWNER" };

const seed = (over: Record<string, any> = {}) => {
  db.runs.push({ id: "run-1", status: "COMPLETED", state: "COMPLETED", ownerUserId: "u-owner", deliveryApprovedAt: null, deliveryApprovedById: null, ...over });
  db.runTenant[over.id ?? "run-1"] = T;
};
const errOf = async (p: Promise<unknown>) => p.then(() => null, (e) => e);

beforeEach(() => {
  db.runs.length = 0;
  db.logs.length = 0;
  db.created.length = 0;
  db.runTenant = {};
  db.users = [{ id: "u-owner", tenantId: T }, { id: "u-new", tenantId: T }, { id: "u-admin", tenantId: T }, { id: "u-foreign", tenantId: "tenant-2" }];
  seed();
});

describe("assignRunOwner", () => {
  it("ADMIN assigns a same-tenant user; logs run.owner.assign", async () => {
    const out = await assignRunOwner(admin, "run-1", "u-new");
    expect(out).toEqual({ id: "run-1", ownerUserId: "u-new" });
    expect(db.runs[0].ownerUserId).toBe("u-new");
    expect(db.logs).toHaveLength(1);
    expect(db.logs[0]).toMatchObject({ tenantId: T, actor: "u-admin", action: "run.owner.assign", resource: "run", resourceId: "run-1" });
    expect(db.logs[0].details).toEqual({ previousOwnerUserId: "u-owner", ownerUserId: "u-new" });
  });
  it("current owner (MEMBER role) may reassign", async () => {
    await assignRunOwner(owner, "run-1", "u-new");
    expect(db.runs[0].ownerUserId).toBe("u-new");
  });
  it("owner may be cleared with null", async () => {
    await assignRunOwner(admin, "run-1", null);
    expect(db.runs[0].ownerUserId).toBeNull();
  });
  it("non-owner MEMBER gets 403 and nothing is written", async () => {
    const e = await errOf(assignRunOwner(member, "run-1", "u-new"));
    expect(e.statusCode ?? e.status).toBe(403);
    expect(db.runs[0].ownerUserId).toBe("u-owner");
    expect(db.logs).toHaveLength(0);
  });
  it("unowned run: MEMBER 403, ADMIN allowed", async () => {
    db.runs[0].ownerUserId = null;
    expect((await errOf(assignRunOwner(member, "run-1", "u-new"))).statusCode).toBe(403);
    await assignRunOwner(admin, "run-1", "u-new");
    expect(db.runs[0].ownerUserId).toBe("u-new");
  });
  it("foreign-tenant target user → 404, unchanged", async () => {
    const e = await errOf(assignRunOwner(admin, "run-1", "u-foreign"));
    expect(e.statusCode).toBe(404);
    expect(db.runs[0].ownerUserId).toBe("u-owner");
  });
  it("foreign tenant caller → 404 (run not visible), not 403", async () => {
    const e = await errOf(assignRunOwner(foreignAdmin, "run-1", "u-new"));
    expect(e.statusCode).toBe(404);
    expect(db.logs).toHaveLength(0);
  });
  it("unknown role string is not admin (fail-closed)", async () => {
    const e = await errOf(assignRunOwner({ ...member, role: "constructor" }, "run-1", "u-new"));
    expect(e.statusCode).toBe(403);
  });
});

describe("approveRunDelivery", () => {
  it("owner approves; sets approver+time once; logs; run status untouched", async () => {
    const out = await approveRunDelivery(owner, "run-1");
    expect(out.deliveryApprovedById).toBe("u-owner");
    expect(db.runs[0].deliveryApprovedAt).toBeInstanceOf(Date);
    expect(db.runs[0].status).toBe("COMPLETED");
    expect(db.logs).toHaveLength(1);
    expect(db.logs[0]).toMatchObject({ tenantId: T, actor: "u-owner", action: "run.delivery.approve", resourceId: "run-1" });
  });
  it("ADMIN who is not the owner may approve", async () => {
    await approveRunDelivery(admin, "run-1");
    expect(db.runs[0].deliveryApprovedById).toBe("u-admin");
  });
  it("non-owner MEMBER → 403", async () => {
    const e = await errOf(approveRunDelivery(member, "run-1"));
    expect(e.statusCode).toBe(403);
    expect(db.runs[0].deliveryApprovedAt).toBeNull();
  });
  it("double approval → 409, no second log", async () => {
    await approveRunDelivery(owner, "run-1");
    const e = await errOf(approveRunDelivery(admin, "run-1"));
    expect(e.statusCode).toBe(409);
    expect(db.logs).toHaveLength(1);
    expect(db.runs[0].deliveryApprovedById).toBe("u-owner");
  });
  it.each(["RUNNING", "PENDING", "PAUSED", "WAITING_APPROVAL"])("non-terminal %s → 409", async (status) => {
    db.runs[0].status = status; db.runs[0].state = null;
    expect((await errOf(approveRunDelivery(owner, "run-1"))).statusCode).toBe(409);
  });
  it.each(["FAILED", "CANCELLED"])("unsuccessful terminal %s → 409", async (status) => {
    db.runs[0].status = status; db.runs[0].state = status;
    expect((await errOf(approveRunDelivery(admin, "run-1"))).statusCode).toBe(409);
    expect(db.logs).toHaveLength(0);
  });
  it("legacy row with null state but COMPLETED status is approvable", async () => {
    db.runs[0].state = null;
    await approveRunDelivery(owner, "run-1");
    expect(db.runs[0].deliveryApprovedAt).toBeInstanceOf(Date);
  });
  it("foreign tenant → 404 and nothing written", async () => {
    const e = await errOf(approveRunDelivery(foreignAdmin, "run-1"));
    expect(e.statusCode).toBe(404);
    expect(db.runs[0].deliveryApprovedAt).toBeNull();
  });
  it("race: CAS loses (approved between read and write) → 409", async () => {
    // okuma sonrası başka istek onaylamış gibi: findFirst eski görüntü döner, updateMany 0 satır.
    const orig = db.runs[0];
    const snapshot = { ...orig };
    db.runs[0] = { ...orig, deliveryApprovedAt: new Date() };
    const { prisma } = await import("../../../lib/db");
    const spy = vi.spyOn(prisma.run, "findFirst").mockResolvedValueOnce(snapshot as never);
    expect((await errOf(approveRunDelivery(owner, "run-1"))).statusCode).toBe(409);
    spy.mockRestore();
  });
});

describe("routes", () => {
  const handler = (method: string, path: string) => {
    const layer = (runRouter as Router as any).stack.find((l: any) => l.route?.path === path && l.route.methods[method]);
    if (!layer) throw new Error(`no route ${method} ${path}`);
    return layer.route.stack.at(-1).handle as (q: any, s: any, n: any) => Promise<void>;
  };
  const call = async (h: any, auth: any, body: any = {}) => {
    const res: any = { body: undefined, json(p: unknown) { this.body = p; return this; } };
    let err: any;
    await h({ auth, params: { id: "run-1" }, body }, res, (e: any) => { err = e; });
    return { res, err };
  };
  it("PATCH /:id/owner wires to assignment", async () => {
    const { res, err } = await call(handler("patch", "/:id/owner"), admin, { ownerUserId: "u-new" });
    expect(err).toBeUndefined();
    expect(res.body).toEqual({ id: "run-1", ownerUserId: "u-new" });
  });
  it("PATCH /:id/owner rejects a missing/non-string ownerUserId with 400", async () => {
    expect((await call(handler("patch", "/:id/owner"), admin, {})).err.statusCode).toBe(400);
    expect((await call(handler("patch", "/:id/owner"), admin, { ownerUserId: 5 })).err.statusCode).toBe(400);
  });
  it("POST /:id/delivery/approve wires to approval; response has success + approver", async () => {
    const { res, err } = await call(handler("post", "/:id/delivery/approve"), owner);
    expect(err).toBeUndefined();
    expect(res.body).toMatchObject({ success: true, id: "run-1", deliveryApprovedById: "u-owner" });
  });
});

describe("default owner at creation (jobs/start)", () => {
  const input = (extra: Record<string, unknown> = {}) => ({
    tenantId: T, workspaceId: "co-1", agentRole: "dev", planHash: "h", idempotencyKey: "k",
    budget: {}, card: { title: "t", goal: "g", steps: [] }, ...extra,
  }) as never;
  it("user-started job: ownerUserId = starter; system job: null", async () => {
    const { tenantTx } = await import("../../../lib/db");
    void tenantTx;
    const mod = await import("../../../lib/db");
    const tx = {
      pipeline: { create: async () => ({ id: "p1" }) },
      run: { create: async ({ data }: any) => { db.created.push(data); return { id: "r1", status: "PENDING" }; } },
    };
    vi.spyOn(mod, "tenantTx").mockImplementation((async (fn: any) => fn(tx)) as never);
    await createPlannedRun(input({ ownerUserId: "u-owner" }));
    await createPlannedRun(input());
    expect(db.created[0].ownerUserId).toBe("u-owner");
    expect(db.created[1].ownerUserId).toBeNull();
  });
});
