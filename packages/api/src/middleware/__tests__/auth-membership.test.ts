import { beforeEach, describe, expect, it, vi } from "vitest";
import jwt from "jsonwebtoken";

const envMock = vi.hoisted(() => ({
  JWT_SECRET: "membership-test-secret-at-least-32-characters",
  AUTH_COOKIE_MODE: false,
}));
const findUser = vi.hoisted(() => vi.fn());
vi.mock("../../config/env", () => ({ env: envMock }));
vi.mock("../../lib/db", () => ({ prisma: { user: { findFirst: findUser } } }));
vi.mock("../../lib/logger", () => ({ logger: { warn: vi.fn() } }));

import { authMiddleware } from "../auth";
import { requirePermission } from "../require-permission";
import { currentTenantContext, runWithoutTenant } from "../../lib/tenant-context";

const claims = { userId: "user-a", tenantId: "tenant-a", role: "OWNER" };
let membership: { id: string; tenantId: string; role: string } | null;

function tokenFor(payload: object) {
  return jwt.sign(payload, envMock.JWT_SECRET, { algorithm: "HS256", expiresIn: "1h" });
}

async function invoke(payload: object = claims, onNext?: (req: any, res: any) => void) {
  const req: any = {
    method: "GET",
    headers: { authorization: `Bearer ${tokenFor(payload)}` },
  };
  const res: any = {
    statusCode: 200,
    body: undefined,
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; },
  };
  const next = vi.fn(() => onNext?.(req, res));
  await authMiddleware(req, res, next);
  return { req, res, next };
}

beforeEach(() => {
  vi.resetAllMocks();
  membership = { id: claims.userId, tenantId: claims.tenantId, role: "OWNER" };
  findUser.mockImplementation(async ({ where }) => {
    expect(currentTenantContext()).toEqual({ kind: "tenant", tenantId: where.tenantId });
    return membership?.id === where.id && membership.tenantId === where.tenantId
      ? { ...membership }
      : null;
  });
});

describe("access JWT current membership boundary", () => {
  it("checks membership inside RLS context and keeps that context through next", async () => {
    let handlerContext: unknown;
    const { next, req } = await invoke(claims, () => {
      handlerContext = currentTenantContext();
    });
    expect(findUser).toHaveBeenCalledWith({
      where: { id: claims.userId, tenantId: claims.tenantId },
      select: { id: true, tenantId: true, role: true },
    });
    expect(next).toHaveBeenCalledOnce();
    expect(req.auth).toMatchObject(claims);
    expect(handlerContext).toEqual({ kind: "tenant", tenantId: claims.tenantId });
    expect(currentTenantContext()).toBeUndefined();
  });

  it("rejects a deleted user even while its correctly signed access JWT is unexpired", async () => {
    membership = null;
    const { next, res, req } = await invoke();
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
    expect(req.auth).toBeUndefined();
  });

  it("rejects an old-tenant JWT after the same user moved to a different tenant", async () => {
    membership!.tenantId = "tenant-b";
    const { next, res } = await invoke();
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("uses the current MEMBER role to reject an old OWNER's company-delete permission", async () => {
    membership!.role = "MEMBER";
    const permissionNext = vi.fn();
    const { req, res } = await invoke(claims, (req, res) => {
      requirePermission("company:delete")(req, res, permissionNext);
    });
    expect(req.auth.role).toBe("MEMBER");
    expect(res.statusCode).toBe(403);
    expect(permissionNext).not.toHaveBeenCalled();
  });

  it("preserves a current OWNER's company-delete permission", async () => {
    const permissionNext = vi.fn();
    const { res } = await invoke(claims, (req, res) => {
      requirePermission("company:delete")(req, res, permissionNext);
    });
    expect(res.statusCode).toBe(200);
    expect(permissionNext).toHaveBeenCalledOnce();
  });

  it("refuses to authenticate when the membership database is unavailable", async () => {
    findUser.mockRejectedValueOnce(new Error("private database connection details"));
    const { next, res, req } = await invoke();
    expect(res.statusCode).toBe(503);
    expect(JSON.stringify(res.body)).not.toContain("private database");
    expect(next).not.toHaveBeenCalled();
    expect(req.auth).toBeUndefined();
  });

  it("bootstraps an authenticated tenant inside the pre-auth system scope", async () => {
    const { next } = await runWithoutTenant("route:auth", () => invoke());
    expect(next).toHaveBeenCalledOnce();
    expect(findUser).toHaveBeenCalledOnce();
    expect(currentTenantContext()).toBeUndefined();
  });

  it.each([
    { tenantId: "tenant-a", role: "OWNER" },
    { userId: "user-a", role: "OWNER" },
    { ...claims, tenantId: "" },
    { ...claims, userId: 42 },
  ])("rejects malformed signed membership claims before consulting the DB: %j", async (payload) => {
    const { res, next } = await invoke(payload);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
    expect(findUser).not.toHaveBeenCalled();
  });

  it("keeps concurrent request tenant contexts separate across the membership await", async () => {
    const seen: unknown[] = [];
    findUser.mockImplementation(async ({ where }) => {
      await Promise.resolve();
      expect(currentTenantContext()).toEqual({ kind: "tenant", tenantId: where.tenantId });
      return { id: where.id, tenantId: where.tenantId, role: "MEMBER" };
    });
    const results = await Promise.all([
      invoke(claims, () => seen.push(currentTenantContext())),
      invoke({ ...claims, userId: "user-b", tenantId: "tenant-b" }, () => seen.push(currentTenantContext())),
    ]);
    expect(results.every(({ next }) => next.mock.calls.length === 1)).toBe(true);
    expect(seen).toEqual([
      { kind: "tenant", tenantId: "tenant-a" },
      { kind: "tenant", tenantId: "tenant-b" },
    ]);
  });
});
