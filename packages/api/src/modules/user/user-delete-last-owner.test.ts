/**
 * BRA-P2-07 — DELETE /users/me: şirketin SON OWNER'ı olan kullanıcı silinemez (409).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Router } from "express";

const prismaMock = vi.hoisted(() => ({
  user: { findUnique: vi.fn(), count: vi.fn(), delete: vi.fn() },
  tenant: { delete: vi.fn() },
  companyMember: { findMany: vi.fn() },
  activityLog: { create: vi.fn() },
}));
const tombstoneMock = vi.hoisted(() => vi.fn());

vi.mock("../../lib/db", () => ({ prisma: prismaMock }));
vi.mock("../../middleware/auth", () => ({ authMiddleware: (_a: unknown, _b: unknown, next: () => void) => next() }));
vi.mock("../../lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../../services/trial-llm", () => ({ getTrialStatus: vi.fn() }));
vi.mock("../../config/env", () => ({ env: { ERASURE_LEDGER_PATH: "/synthetic/ledger.jsonl" } }));
vi.mock("./apple-revocation", async (orig) => ({
  ...(await orig<typeof import("./apple-revocation")>()),
  revokeAppleAccess: vi.fn().mockResolvedValue("NOT_APPLICABLE"),
}));
vi.mock("./erasure-tombstones", () => ({ recordErasureTombstones: (...a: unknown[]) => tombstoneMock(...a) }));

const { userRouter } = await import("./user.router");

async function del() {
  const layer = (userRouter as Router as any).stack.find((l: any) => l.route?.path === "/me" && l.route.methods.delete);
  const res: any = { statusCode: 200, body: undefined, status(c: number) { this.statusCode = c; return this; }, json(p: unknown) { this.body = p; return this; } };
  let err: any;
  await layer.route.stack.at(-1).handle({ headers: {}, body: { confirm: "DELETE" }, auth: { userId: "u1", tenantId: "t1" } }, res, (e?: any) => { err = e; });
  return { res, err };
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.user.findUnique.mockResolvedValue({ email: "x@example.invalid", role: "ADMIN", appleId: null, tenant: { plan: "FREE", stripeSubscriptionId: null } });
  prismaMock.activityLog.create.mockResolvedValue({});
  prismaMock.companyMember.findMany.mockResolvedValue([]);
});

describe("DELETE /users/me son-OWNER koruması", () => {
  it("tenant'ta başka kullanıcı var + kullanıcı bir şirketin tek OWNER'ı -> 409, hiçbir yazma yok", async () => {
    prismaMock.user.count.mockResolvedValue(2);
    prismaMock.companyMember.findMany.mockResolvedValue([{ companyId: "c1" }]);
    const { err } = await del();
    expect(err).toMatchObject({ statusCode: 409 });
    expect(String(err.message)).toMatch(/only OWNER/);
    expect(prismaMock.user.delete).not.toHaveBeenCalled();
    expect(prismaMock.activityLog.create).not.toHaveBeenCalled();
    expect(tombstoneMock).not.toHaveBeenCalled();
  });

  it("sorgu tenant + userId + OWNER + 'başka OWNER yok' ile sınırlanır", async () => {
    prismaMock.user.count.mockResolvedValue(1);
    await del();
    expect(prismaMock.companyMember.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: "t1", userId: "u1", role: "OWNER", company: { members: { none: { role: "OWNER", userId: { not: "u1" } } } } },
    }));
  });

  it("tek-OWNER şirketi yoksa silme eskisi gibi sürer", async () => {
    prismaMock.user.count.mockResolvedValue(1);
    const { res, err } = await del();
    expect(err).toBeUndefined();
    expect(prismaMock.user.delete).toHaveBeenCalledWith({ where: { id: "u1" } });
    expect(res.body).toMatchObject({ success: true, tenantDeleted: false });
  });

  it("son kullanıcıysa (tenant tamamen silinir) kontrol atlanır", async () => {
    prismaMock.user.count.mockResolvedValue(0);
    prismaMock.companyMember.findMany.mockResolvedValue([{ companyId: "c1" }]);
    const { res, err } = await del();
    expect(err).toBeUndefined();
    expect(prismaMock.companyMember.findMany).not.toHaveBeenCalled();
    expect(prismaMock.tenant.delete).toHaveBeenCalledWith({ where: { id: "t1" } });
    expect(res.body).toMatchObject({ tenantDeleted: true });
  });
});
