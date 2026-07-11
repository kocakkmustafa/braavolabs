/**
 * Tenant-isolation regression net (Forge P1 security hardening) — approval
 * router. Pins the `approval.run.pipeline.company.tenantId !==
 * req.auth!.tenantId` guard on POST /:id/decide with real handler invocation
 * (mocked Prisma). A financial/HITL decision endpoint is exactly the kind of
 * surface where a silently-dropped guard is highest severity (spend approval,
 * external-automation control, handoff claim) — this pins it so a future
 * refactor that removes the check fails loudly instead of shipping.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Router } from "express";

const approvalFindUnique = vi.hoisted(() => vi.fn());
const approvalFindMany = vi.hoisted(() => vi.fn());
const transactionMock = vi.hoisted(() => vi.fn());

vi.mock("../../../lib/db", () => ({
  prisma: {
    approval: {
      findUnique: (...a: unknown[]) => approvalFindUnique(...a),
      findMany: (...a: unknown[]) => approvalFindMany(...a),
    },
    draft: { findFirst: vi.fn() },
    run: { findMany: vi.fn() },
    $transaction: (...a: unknown[]) => transactionMock(...a),
  },
}));

vi.mock("../../../middleware/auth", () => ({
  authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const enqueueRunMock = vi.hoisted(() => vi.fn());
vi.mock("../../pipeline/runner", () => ({ enqueueRun: (...a: unknown[]) => enqueueRunMock(...a) }));

const runControlActionMock = vi.hoisted(() => vi.fn());
vi.mock("../../external/control", () => ({ runControlAction: (...a: unknown[]) => runControlActionMock(...a) }));

import { approvalRouter } from "../router";

function getHandler(router: Router, method: string, path: string) {
  const layer = (router as any).stack.find(
    (l: any) => l.route && l.route.path === path && l.route.methods[method.toLowerCase()],
  );
  if (!layer) throw new Error(`No route ${method} ${path}`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle as (req: any, res: any, next: any) => Promise<void> | void;
}

function mockRes() {
  const res: any = {
    statusCode: 200,
    body: undefined,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
  };
  return res;
}

async function invoke(handler: any, tenantId: string, req: any) {
  const res = mockRes();
  let nextErr: any = undefined;
  const next = (err?: any) => { nextErr = err; };
  await handler(
    { auth: { tenantId, userId: "user-1", role: "admin" }, params: {}, body: {}, query: {}, ...req },
    res,
    next,
  );
  return { res, nextErr };
}

const OWNER_TENANT = "tenant-A";
const ATTACKER_TENANT = "tenant-B";

function foreignApproval(overrides: Record<string, unknown> = {}) {
  return {
    id: "appr-secret-1",
    type: "SPEND",
    status: "PENDING",
    amountUsd: 500,
    runId: "run-secret-1",
    metadata: {},
    run: { pipeline: { company: { tenantId: OWNER_TENANT } } },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /approvals/:id/decide — cross-tenant regression", () => {
  const handler = getHandler(approvalRouter, "post", "/:id/decide");

  it("tenant B cannot approve/reject tenant A's $500 spend approval — 404, no transaction, no side effects", async () => {
    approvalFindUnique.mockResolvedValue(foreignApproval());

    const { nextErr } = await invoke(handler, ATTACKER_TENANT, {
      params: { id: "appr-secret-1" },
      body: { decision: "APPROVED" },
    });

    expect(nextErr?.statusCode).toBe(404);
    // The atomic state-transition transaction (and every side effect that
    // flows from it — run status flip, enqueue, external control action)
    // must never fire for a resource the caller doesn't own.
    expect(transactionMock).not.toHaveBeenCalled();
    expect(enqueueRunMock).not.toHaveBeenCalled();
    expect(runControlActionMock).not.toHaveBeenCalled();
  });

  it("tenant B cannot even discover whether a foreign approval id exists — same 404 shape as a missing id", async () => {
    approvalFindUnique.mockResolvedValue(null);
    const { nextErr: missingErr } = await invoke(handler, ATTACKER_TENANT, {
      params: { id: "does-not-exist" },
      body: { decision: "REJECTED" },
    });

    approvalFindUnique.mockResolvedValue(foreignApproval());
    const { nextErr: foreignErr } = await invoke(handler, ATTACKER_TENANT, {
      params: { id: "appr-secret-1" },
      body: { decision: "REJECTED" },
    });

    expect(missingErr?.statusCode).toBe(foreignErr?.statusCode);
    expect(missingErr?.message).toBe(foreignErr?.message);
  });
});

describe("GET /approvals — list is tenant-scoped at the query level", () => {
  const handler = getHandler(approvalRouter, "get", "/");

  it("the findMany where-clause always scopes to the caller's own tenantId, never a foreign one", async () => {
    approvalFindMany.mockResolvedValue([]);

    await invoke(handler, ATTACKER_TENANT, {});

    expect(approvalFindMany).toHaveBeenCalledTimes(1);
    const whereArg = approvalFindMany.mock.calls[0]![0].where;
    expect(whereArg.run).toEqual({ pipeline: { company: { tenantId: ATTACKER_TENANT } } });
  });
});
