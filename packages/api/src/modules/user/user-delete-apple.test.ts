/**
 * F04 — DELETE /users/me reports the Sign in with Apple revocation outcome.
 *
 * Erasure happens first and is never undone by a revocation failure. The
 * response carries an explicit `appleRevocation` axis and the
 * `appleAccessRemovalRequired` flag the mobile client already renders.
 * prisma, env and the revocation module are mocked; no network.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Router } from "express";

const prismaMock = vi.hoisted(() => ({
  user: { findUnique: vi.fn(), count: vi.fn(), delete: vi.fn() },
  tenant: { delete: vi.fn() },
  activityLog: { create: vi.fn() },
}));
const revokeMock = vi.hoisted(() => vi.fn());
const tombstoneMock = vi.hoisted(() => vi.fn());

vi.mock("../../lib/db", () => ({ prisma: prismaMock }));
vi.mock("../../middleware/auth", () => ({ authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next() }));
vi.mock("../../lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../../services/trial-llm", () => ({ getTrialStatus: vi.fn() }));
vi.mock("../../config/env", () => ({
  env: { APPLE_SIWA_BUNDLE_ID: "com.example.synthetic", APPLE_SIWA_TEAM_ID: "TEAMSYNTH1",
    APPLE_SIWA_KEY_ID: "KEYSYNTH01", APPLE_SIWA_PRIVATE_KEY: "synthetic-pem",
    ERASURE_LEDGER_PATH: "/synthetic/erasure-ledger.jsonl" },
}));
vi.mock("./apple-revocation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./apple-revocation")>()),
  revokeAppleAccess: (...args: unknown[]) => revokeMock(...args),
}));

vi.mock("./erasure-tombstones", () => ({ recordErasureTombstones: (...args: unknown[]) => tombstoneMock(...args) }));

const { userRouter } = await import("./user.router");

function getHandler(router: Router, method: string, path: string) {
  const layer = (router as any).stack.find(
    (l: any) => l.route && l.route.path === path && l.route.methods[method.toLowerCase()],
  );
  if (!layer) throw new Error(`No route ${method} ${path}`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle as (req: any, res: any, next: any) => Promise<void> | void;
}

async function invoke(body: unknown) {
  const res: any = { statusCode: 200, body: undefined, status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; } };
  let nextErr: any;
  await getHandler(userRouter, "delete", "/me")(
    { headers: {}, method: "DELETE", body, query: {}, auth: { userId: "u1", tenantId: "t1" } }, res,
    (err?: any) => { nextErr = err; });
  return { res, nextErr };
}

function user(appleId: string | null) {
  return { email: "synthetic@example.invalid", role: "OWNER", appleId,
    tenant: { plan: "FREE", stripeSubscriptionId: null } };
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.user.count.mockResolvedValue(0);
  prismaMock.tenant.delete.mockResolvedValue({});
  prismaMock.activityLog.create.mockResolvedValue({});
  tombstoneMock.mockResolvedValue([]);
});

describe("DELETE /users/me Apple revocation outcome", () => {
  it("erases first, then revokes with the fresh authorization code and reports REVOKED", async () => {
    prismaMock.user.findUnique.mockResolvedValue(user("apple-sub"));
    revokeMock.mockImplementation(async () => {
      expect(prismaMock.tenant.delete).toHaveBeenCalledTimes(1); // erasure already happened
      return "REVOKED";
    });
    const { res, nextErr } = await invoke({ confirm: "DELETE", appleAuthorizationCode: "synthetic-code" });
    expect(nextErr).toBeUndefined();
    expect(revokeMock).toHaveBeenCalledWith(expect.objectContaining({ appleId: "apple-sub",
      authorizationCode: "synthetic-code",
      config: { clientId: "com.example.synthetic", teamId: "TEAMSYNTH1", keyId: "KEYSYNTH01", privateKey: "synthetic-pem" } }));
    expect(res.body).toMatchObject({ success: true, appleRevocation: "REVOKED", appleAccessRemovalRequired: false });
  });

  it.each(["APPLE_PENDING", "UNKNOWN"] as const)("keeps the erasure and asks for manual Apple removal on %s", async (outcome) => {
    prismaMock.user.findUnique.mockResolvedValue(user("apple-sub"));
    revokeMock.mockResolvedValue(outcome);
    const { res, nextErr } = await invoke({ confirm: "DELETE" });
    expect(nextErr).toBeUndefined();
    expect(prismaMock.tenant.delete).toHaveBeenCalledTimes(1);
    expect(res.body).toMatchObject({ success: true, appleRevocation: outcome, appleAccessRemovalRequired: true });
  });

  it("reports UNKNOWN instead of failing the erased request when revocation throws", async () => {
    prismaMock.user.findUnique.mockResolvedValue(user("apple-sub"));
    revokeMock.mockRejectedValue(new Error("unexpected"));
    const { res, nextErr } = await invoke({ confirm: "DELETE" });
    expect(nextErr).toBeUndefined();
    expect(res.body).toMatchObject({ success: true, appleRevocation: "UNKNOWN", appleAccessRemovalRequired: true });
  });

  it("reports NOT_LINKED for accounts without Apple identity", async () => {
    prismaMock.user.findUnique.mockResolvedValue(user(null));
    revokeMock.mockResolvedValue("NOT_LINKED");
    const { res } = await invoke({ confirm: "DELETE" });
    expect(res.body).toMatchObject({ success: true, appleRevocation: "NOT_LINKED", appleAccessRemovalRequired: false });
  });

  it("never stores the authorization code in the audit log", async () => {
    prismaMock.user.findUnique.mockResolvedValue(user("apple-sub"));
    revokeMock.mockResolvedValue("REVOKED");
    await invoke({ confirm: "DELETE", appleAuthorizationCode: "synthetic-code" });
    expect(JSON.stringify(prismaMock.activityLog.create.mock.calls)).not.toContain("synthetic-code");
    expect(prismaMock.activityLog.create.mock.calls[0][0].data.details).toMatchObject({ appleLinked: true });
  });

  it("rejects an oversized authorization code before any erasure", async () => {
    prismaMock.user.findUnique.mockResolvedValue(user("apple-sub"));
    const { nextErr } = await invoke({ confirm: "DELETE", appleAuthorizationCode: "x".repeat(4097) });
    expect(nextErr).toBeDefined();
    expect(prismaMock.tenant.delete).not.toHaveBeenCalled();
    expect(prismaMock.user.delete).not.toHaveBeenCalled();
  });

  it("records user and tenant tombstones before erasing the last user's tenant", async () => {
    prismaMock.user.findUnique.mockResolvedValue(user(null));
    revokeMock.mockResolvedValue("NOT_LINKED");
    tombstoneMock.mockImplementation(async () => {
      expect(prismaMock.tenant.delete).not.toHaveBeenCalled();
      return [];
    });
    await invoke({ confirm: "DELETE" });
    expect(tombstoneMock).toHaveBeenCalledExactlyOnceWith(
      [{ kind: "user", id: "u1" }, { kind: "tenant", id: "t1" }], { ledgerPath: "/synthetic/erasure-ledger.jsonl" });
    expect(prismaMock.tenant.delete).toHaveBeenCalledTimes(1);
  });

  it("records only the user tombstone when other members keep the tenant", async () => {
    prismaMock.user.findUnique.mockResolvedValue(user(null));
    prismaMock.user.count.mockResolvedValue(2);
    prismaMock.user.delete.mockResolvedValue({});
    revokeMock.mockResolvedValue("NOT_LINKED");
    await invoke({ confirm: "DELETE" });
    expect(tombstoneMock).toHaveBeenCalledExactlyOnceWith([{ kind: "user", id: "u1" }], expect.anything());
    expect(prismaMock.user.delete).toHaveBeenCalledTimes(1);
    expect(prismaMock.tenant.delete).not.toHaveBeenCalled();
  });

  it("does not erase when the tombstone cannot be recorded", async () => {
    prismaMock.user.findUnique.mockResolvedValue(user(null));
    tombstoneMock.mockRejectedValue(new Error("tombstone write failed"));
    const { nextErr } = await invoke({ confirm: "DELETE" });
    expect(nextErr).toBeDefined();
    expect(prismaMock.tenant.delete).not.toHaveBeenCalled();
    expect(prismaMock.user.delete).not.toHaveBeenCalled();
  });
});
