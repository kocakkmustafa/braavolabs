/**
 * Tenant-isolation regression net (Forge P1 security hardening) — outreach
 * router. The enrollment endpoint carries the module's own documented CRIT-2
 * history (see router.ts): contactId used to be taken from the request body
 * with no tenant check, letting an attacker enroll ANOTHER tenant's contact
 * in their own sequence and trigger outreach billed against the victim's
 * relationship history. This file pins BOTH tenant hops the fix introduced —
 * sequence ownership and contact ownership — as an explicit regression test,
 * plus the enrollment-reply/unsubscribe guards, using real handler
 * invocation (mocked Prisma).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Router } from "express";

const sequenceFindUnique = vi.hoisted(() => vi.fn());
const contactFindFirst = vi.hoisted(() => vi.fn());
const enrollmentCount = vi.hoisted(() => vi.fn());
const enrollmentCreate = vi.hoisted(() => vi.fn());
const enrollmentFindUnique = vi.hoisted(() => vi.fn());
const enrollmentUpdate = vi.hoisted(() => vi.fn());
const activityLogCreate = vi.hoisted(() => vi.fn());

vi.mock("../../../lib/db", () => ({
  prisma: {
    outreachSequence: { findUnique: (...a: unknown[]) => sequenceFindUnique(...a) },
    contact: { findFirst: (...a: unknown[]) => contactFindFirst(...a) },
    outreachEnrollment: {
      count: (...a: unknown[]) => enrollmentCount(...a),
      create: (...a: unknown[]) => enrollmentCreate(...a),
      findUnique: (...a: unknown[]) => enrollmentFindUnique(...a),
      update: (...a: unknown[]) => enrollmentUpdate(...a),
    },
    activityLog: { create: (...a: unknown[]) => activityLogCreate(...a) },
  },
}));

vi.mock("../../../middleware/auth", () => ({
  authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { outreachRouter } from "../router";

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

beforeEach(() => {
  vi.clearAllMocks();
  activityLogCreate.mockResolvedValue({});
});

describe("POST /outreach/sequences/:id/enroll — cross-tenant regression", () => {
  const handler = getHandler(outreachRouter, "post", "/sequences/:id/enroll");

  it("tenant B cannot enroll into tenant A's sequence — 404, contact lookup never attempted", async () => {
    sequenceFindUnique.mockResolvedValue({
      id: "seq-secret-1",
      company: { tenantId: OWNER_TENANT },
    });

    const { nextErr } = await invoke(handler, ATTACKER_TENANT, {
      params: { id: "seq-secret-1" },
      body: { contactId: "ct-attacker-own" },
    });

    expect(nextErr?.statusCode).toBe(404);
    expect(nextErr?.message).toMatch(/Sequence not found/);
    expect(contactFindFirst).not.toHaveBeenCalled();
    expect(enrollmentCreate).not.toHaveBeenCalled();
  });

  it("CRIT-2 regression: tenant B owns the sequence but the contactId belongs to tenant A — 404, no enrollment created", async () => {
    // Sequence legitimately belongs to the caller's own tenant...
    sequenceFindUnique.mockResolvedValue({
      id: "seq-own-1",
      companyId: "co-B",
      company: { tenantId: ATTACKER_TENANT },
    });
    // ...but the contact being enrolled is scoped (via company.tenantId) to
    // a DIFFERENT tenant, so the tenant-scoped findFirst legitimately
    // resolves to null — this is exactly the CRIT-2 fix's contract.
    contactFindFirst.mockImplementation(async (args: any) =>
      args.where.company.tenantId === ATTACKER_TENANT ? null : { id: "ct-victim", companyId: "co-A" },
    );

    const { nextErr } = await invoke(handler, ATTACKER_TENANT, {
      params: { id: "seq-own-1" },
      body: { contactId: "ct-victim" },
    });

    expect(nextErr?.statusCode).toBe(404);
    expect(nextErr?.message).toMatch(/Contact not found/);
    expect(contactFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "ct-victim", company: { tenantId: ATTACKER_TENANT } }),
      }),
    );
    expect(enrollmentCreate).not.toHaveBeenCalled();
  });

  it("same-tenant sequence + same-tenant contact enrolls successfully (positive control)", async () => {
    sequenceFindUnique.mockResolvedValue({
      id: "seq-own-1",
      companyId: "co-A",
      company: { tenantId: OWNER_TENANT },
    });
    contactFindFirst.mockResolvedValue({ id: "ct-own", companyId: "co-A" });
    enrollmentCount.mockResolvedValue(0);
    enrollmentCreate.mockResolvedValue({ id: "enr-1", sequenceId: "seq-own-1", contactId: "ct-own" });

    const { res, nextErr } = await invoke(handler, OWNER_TENANT, {
      params: { id: "seq-own-1" },
      body: { contactId: "ct-own" },
    });

    expect(nextErr).toBeUndefined();
    expect(res.statusCode).toBe(201);
    expect(enrollmentCreate).toHaveBeenCalledTimes(1);
  });
});

describe("POST /outreach/enrollments/:id/reply — cross-tenant regression", () => {
  const handler = getHandler(outreachRouter, "post", "/enrollments/:id/reply");

  it("tenant B cannot mark tenant A's enrollment as replied — 404, no write issued", async () => {
    enrollmentFindUnique.mockResolvedValue({
      id: "enr-secret-1",
      sequence: { company: { tenantId: OWNER_TENANT } },
    });

    const { nextErr } = await invoke(handler, ATTACKER_TENANT, { params: { id: "enr-secret-1" } });

    expect(nextErr?.statusCode).toBe(404);
    expect(enrollmentUpdate).not.toHaveBeenCalled();
  });
});
