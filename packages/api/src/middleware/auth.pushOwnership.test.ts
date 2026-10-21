/** Actual membership middleware and JWT verification; no database or cookie state is contacted. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import jwt from "jsonwebtoken";

const envMock = vi.hoisted(() => ({ JWT_SECRET: "push-middleware-test-secret-at-least-32-characters", AUTH_COOKIE_MODE: false }));
const findUser = vi.hoisted(() => vi.fn());
vi.mock("../config/env", () => ({ env: envMock }));
vi.mock("../lib/db", () => ({ prisma: { user: { findFirst: findUser } } }));
vi.mock("../lib/pushOwnership", () => ({ retirePushSession: vi.fn() }));
import { authMiddleware } from "./auth";
import { currentTenantContext } from "../lib/tenant-context";

const identity = { userId: "user-a", tenantId: "tenant-a", role: "OWNER" };
const sid = "97035340-20ad-4fbd-8d93-760f817f5b4d";
async function invoke(payload: object, secret = envMock.JWT_SECRET) {
  const token = jwt.sign(payload, secret, { algorithm: "HS256", expiresIn: "1h" });
  const req: any = { method: "POST", headers: { authorization: `Bearer ${token}` }, body: { pushSessionId: "client-controlled" } };
  const res: any = { statusCode: 200, body: undefined,
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; } };
  const next = vi.fn(() => expect(currentTenantContext()).toEqual({ kind: "tenant", tenantId: identity.tenantId }));
  await authMiddleware(req, res, next);
  return { req, res, next };
}
beforeEach(() => {
  vi.resetAllMocks();
  findUser.mockImplementation(async ({ where }) => {
    expect(currentTenantContext()).toEqual({ kind: "tenant", tenantId: where.tenantId });
    return { id: identity.userId, tenantId: identity.tenantId, role: "MEMBER" };
  });
});

describe("signed SID preservation through real auth membership validation", () => {
  it("preserves only signed UUID authority while replacing stale token roles with current DB membership", async () => {
    const { req, res, next } = await invoke({ ...identity, pushSessionId: sid });
    expect(res.statusCode).toBe(200);
    expect(next).toHaveBeenCalledOnce();
    expect(req.auth).toEqual({ ...identity, role: "MEMBER", pushSessionId: sid });
    expect(findUser).toHaveBeenCalledWith({ where: { id: identity.userId, tenantId: identity.tenantId }, select: { id: true, tenantId: true, role: true } });
    expect(currentTenantContext()).toBeUndefined();
  });

  it.each([undefined, "client-sid", "97035340-20ad-1fbd-8d93-760f817f5b4d", 42])(
    "keeps ordinary auth open and omits legacy/malformed signed SID %s", async pushSessionId => {
      const { req, next, res } = await invoke({ ...identity, ...(pushSessionId === undefined ? {} : { pushSessionId }) });
      expect(res.statusCode).toBe(200);
      expect(next).toHaveBeenCalledOnce();
      expect(req.auth).toEqual({ ...identity, role: "MEMBER" });
    },
  );

  it("never admits a valid-looking SID from a forged signature", async () => {
    const { req, next, res } = await invoke({ ...identity, pushSessionId: sid }, "synthetic-wrong-secret");
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
    expect(findUser).not.toHaveBeenCalled();
    expect(req.auth).toBeUndefined();
  });

  it("rejects a refresh bearer even when it carries a signed UUID SID", async () => {
    const { req, next, res } = await invoke({ ...identity, typ: "refresh", pushSessionId: sid });
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
    expect(findUser).not.toHaveBeenCalled();
    expect(req.auth).toBeUndefined();
  });
});
