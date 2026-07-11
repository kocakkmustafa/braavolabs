/**
 * Tenant-isolation regression net (Forge P1 security hardening) — draft
 * router. Pins the `company.findFirst({ tenantId })` / `draft.company.tenantId`
 * guards with real handler invocation (mocked Prisma) so a future edit that
 * drops one of these checks fails the suite instead of silently leaking (or
 * letting a cross-tenant caller mutate/send) another tenant's drafts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Router } from "express";

const companyFindFirst = vi.hoisted(() => vi.fn());
const draftFindMany = vi.hoisted(() => vi.fn());
const draftFindUnique = vi.hoisted(() => vi.fn());
const draftUpdate = vi.hoisted(() => vi.fn());
const activityLogCreate = vi.hoisted(() => vi.fn());

vi.mock("../../../lib/db", () => ({
  prisma: {
    company: { findFirst: (...a: unknown[]) => companyFindFirst(...a) },
    draft: {
      findMany: (...a: unknown[]) => draftFindMany(...a),
      findUnique: (...a: unknown[]) => draftFindUnique(...a),
      update: (...a: unknown[]) => draftUpdate(...a),
    },
    activityLog: { create: (...a: unknown[]) => activityLogCreate(...a) },
  },
}));

vi.mock("../../../middleware/auth", () => ({
  authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const notifyTenantUsersMock = vi.hoisted(() => vi.fn());
vi.mock("../../../services/push", () => ({
  notifyTenantUsers: (...a: unknown[]) => notifyTenantUsersMock(...a),
}));

import { draftRouter } from "../router";

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

function foreignDraft(overrides: Record<string, unknown> = {}) {
  return {
    id: "draft-secret-1",
    title: "Tenant A's unpublished ad copy",
    content: { body: "confidential" },
    status: "PENDING",
    company: { tenantId: OWNER_TENANT },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  activityLogCreate.mockResolvedValue({});
  notifyTenantUsersMock.mockResolvedValue(undefined);
});

describe("GET /drafts?companyId=... — cross-tenant regression", () => {
  const handler = getHandler(draftRouter, "get", "/");

  it("tenant B querying tenant A's companyId gets 404 and the draft list is never fetched", async () => {
    // company.findFirst is itself tenant-scoped in the WHERE clause — a
    // foreign company id simply doesn't match and resolves to null.
    companyFindFirst.mockImplementation(async (args: any) =>
      args.where.tenantId === OWNER_TENANT ? { id: "co-A", tenantId: OWNER_TENANT } : null,
    );

    const { nextErr } = await invoke(handler, ATTACKER_TENANT, { query: { companyId: "co-A" } });

    expect(nextErr?.statusCode).toBe(404);
    // The critical regression guard: no draft rows are ever fetched for a
    // company the caller doesn't own.
    expect(draftFindMany).not.toHaveBeenCalled();
  });
});

describe("PATCH /drafts/:id — cross-tenant regression", () => {
  const handler = getHandler(draftRouter, "patch", "/:id");

  it("tenant B cannot edit tenant A's draft — 404, no write issued", async () => {
    draftFindUnique.mockResolvedValue(foreignDraft());

    const { nextErr } = await invoke(handler, ATTACKER_TENANT, {
      params: { id: "draft-secret-1" },
      body: { title: "pwned" },
    });

    expect(nextErr?.statusCode).toBe(404);
    expect(draftUpdate).not.toHaveBeenCalled();
  });
});

describe("POST /drafts/:id/approve — cross-tenant regression", () => {
  const handler = getHandler(draftRouter, "post", "/:id/approve");

  it("tenant B cannot approve/send tenant A's draft — 404, no publish, no notification", async () => {
    draftFindUnique.mockResolvedValue(foreignDraft());

    const { nextErr } = await invoke(handler, ATTACKER_TENANT, {
      params: { id: "draft-secret-1" },
      body: { send: true },
    });

    expect(nextErr?.statusCode).toBe(404);
    expect(draftUpdate).not.toHaveBeenCalled();
  });
});
