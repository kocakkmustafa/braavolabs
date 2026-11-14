/**
 * BRA-OPS-02 — GET /api/v1/ops/flags: platform-admin-only, read-only.
 * 401 (no/invalid token) comes from the REAL authMiddleware; 403 from the
 * admin-email gate; 200 only for an admin email.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Router } from "express";

vi.mock("../../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
const userFindUnique = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/db", () => ({
  prisma: { user: { findUnique: (...a: unknown[]) => userFindUnique(...a) } },
}));

import { opsRouter, isPlatformAdminEmail, serverFlagState } from "../router";

function routeStack(router: Router, path: string) {
  for (const layer of (router as any).stack) {
    if (layer.route && layer.route.path === path && layer.route.methods.get) {
      return layer.route.stack.map((l: any) => l.handle as (req: any, res: any, next: any) => unknown);
    }
  }
  throw new Error(`No route GET ${path}`);
}

function mockRes() {
  const res: any = {
    statusCode: 200, body: undefined, headers: {} as Record<string, string>,
    status(c: number) { this.statusCode = c; return this; },
    json(p: unknown) { this.body = p; return this; },
    set(k: string, v: string) { this.headers[k] = v; return this; },
  };
  return res;
}

const [auth, handler] = routeStack(opsRouter, "/flags");
const FLAGS = ["JOB_STATE_DUAL_WRITE", "EXACT_ACTION_APPROVAL", "STEP_APPROVAL_GATE"] as const;

beforeEach(() => { userFindUnique.mockReset(); });
afterEach(() => {
  delete process.env.MARKETPLACE_ADMIN_EMAILS;
  for (const f of FLAGS) delete process.env[f];
});

describe("GET /ops/flags", () => {
  it("401 without Authorization (real authMiddleware; handler never runs)", async () => {
    const res = mockRes();
    const next = vi.fn();
    await auth({ headers: {}, cookies: {} }, res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
    expect(userFindUnique).not.toHaveBeenCalled();
  });

  it("401 with a garbage bearer token", async () => {
    const res = mockRes();
    await auth({ headers: { authorization: "Bearer not-a-jwt" }, cookies: {} }, res, vi.fn());
    expect(res.statusCode).toBe(401);
  });

  it("403 for an authenticated non-admin", async () => {
    process.env.MARKETPLACE_ADMIN_EMAILS = "admin@example.com";
    userFindUnique.mockResolvedValue({ email: "member@example.com", emailVerifiedAt: new Date() });
    const res = mockRes();
    const next = vi.fn();
    await handler({ auth: { userId: "u1", tenantId: "t1", role: "OWNER" } }, res, next);
    expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 403 });
    expect(res.body).toBeUndefined();
  });

  it("403 fail-closed when no admin list is configured (even if verified)", async () => {
    userFindUnique.mockResolvedValue({ email: "admin@example.com", emailVerifiedAt: new Date() });
    const res = mockRes();
    const next = vi.fn();
    await handler({ auth: { userId: "u1", tenantId: "t1", role: "OWNER" } }, res, next);
    expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 403 });
  });

  it("403 when the user row is missing", async () => {
    process.env.MARKETPLACE_ADMIN_EMAILS = "admin@example.com";
    userFindUnique.mockResolvedValue(null);
    const res = mockRes();
    const next = vi.fn();
    await handler({ auth: { userId: "u1", tenantId: "t1", role: "OWNER" } }, res, next);
    expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 403 });
    expect(res.body).toBeUndefined();
  });

  it("403 for a verified user whose email is not in the admin list", async () => {
    process.env.MARKETPLACE_ADMIN_EMAILS = "admin@example.com";
    userFindUnique.mockResolvedValue({ email: "other@example.com", emailVerifiedAt: new Date() });
    const res = mockRes();
    const next = vi.fn();
    await handler({ auth: { userId: "u1", tenantId: "t1", role: "OWNER" } }, res, next);
    expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 403 });
    expect(res.body).toBeUndefined();
  });

  it("403 fail-closed for an admin email whose emailVerifiedAt is null", async () => {
    process.env.MARKETPLACE_ADMIN_EMAILS = "admin@example.com";
    userFindUnique.mockResolvedValue({ email: "admin@example.com", emailVerifiedAt: null });
    const res = mockRes();
    const next = vi.fn();
    await handler({ auth: { userId: "u1", tenantId: "t1", role: "OWNER" } }, res, next);
    expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 403 });
    expect(res.body).toBeUndefined();
    expect(userFindUnique.mock.calls[0][0].select).toEqual({ email: true, emailVerifiedAt: true });
  });

  it("200 for a verified admin: all three flags off by default, no-store, no secrets", async () => {
    process.env.MARKETPLACE_ADMIN_EMAILS = " Admin@Example.com ";
    userFindUnique.mockResolvedValue({ email: "admin@example.com", emailVerifiedAt: new Date() });
    const res = mockRes();
    await handler({ auth: { userId: "u1", tenantId: "t1", role: "OWNER" } }, res, vi.fn());
    expect(res.statusCode).toBe(200);
    expect(res.headers["Cache-Control"]).toBe("no-store");
    expect(res.body.flags).toEqual(FLAGS.map((name) => ({ name, enabled: false })));
    expect(Object.keys(res.body).sort()).toEqual(["flags", "generatedAt"]);
  });

  it("reports a flag on only for the literal string \"true\"", () => {
    expect(serverFlagState({ STEP_APPROVAL_GATE: "true", EXACT_ACTION_APPROVAL: "1", JOB_STATE_DUAL_WRITE: "TRUE" } as any))
      .toEqual([
        { name: "JOB_STATE_DUAL_WRITE", enabled: false },
        { name: "EXACT_ACTION_APPROVAL", enabled: false },
        { name: "STEP_APPROVAL_GATE", enabled: true },
      ]);
  });

  it("isPlatformAdminEmail handles empty/missing", () => {
    expect(isPlatformAdminEmail(null, { MARKETPLACE_ADMIN_EMAILS: "a@b.c" } as any)).toBe(false);
    expect(isPlatformAdminEmail("a@b.c", {} as any)).toBe(false);
    expect(isPlatformAdminEmail("A@B.C", { MARKETPLACE_ADMIN_EMAILS: "a@b.c, x@y.z" } as any)).toBe(true);
  });
});
