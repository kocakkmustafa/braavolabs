import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  user: { findUnique: vi.fn(), count: vi.fn(), delete: vi.fn() },
  tenant: { delete: vi.fn() },
  activityLog: { create: vi.fn() },
}));
vi.mock("../../../lib/db", () => ({ prisma: db }));
vi.mock("../../../middleware/auth", () => ({ authMiddleware: vi.fn() }));
vi.mock("../../../lib/logger", () => ({ logger: { info: vi.fn() } }));
vi.mock("../../../services/trial-llm", () => ({ getTrialStatus: vi.fn() }));
import { userRouter } from "../user.router";

const route = (userRouter as any).stack.find((layer: any) => layer.route?.path === "/me" && layer.route?.methods.delete);
const handler = route.route.stack.at(-1).handle;
async function invoke(confirm = "DELETE") {
  const res = { json: vi.fn() };
  const next = vi.fn();
  await handler({ body: { confirm }, auth: { userId: "fixture-user", tenantId: "fixture-tenant" } }, res, next);
  return { res, next };
}
beforeEach(() => {
  vi.resetAllMocks();
  db.user.findUnique.mockResolvedValue({ email: "fixture@example.invalid", role: "OWNER", appleId: "PRIVATE_APPLE_SUB", tenant: { plan: "INDIVIDUAL", stripeSubscriptionId: null } });
  db.user.count.mockResolvedValue(0);
});

describe("DELETE /users/me Apple access follow-up", () => {
  for (const siblings of [0, 1]) {
    for (const appleId of [null, "PRIVATE_APPLE_SUB"]) {
      it(`returns only manual-action boolean: siblings=${siblings}, Apple=${!!appleId}`, async () => {
        db.user.count.mockResolvedValue(siblings);
        db.user.findUnique.mockResolvedValue({ email: "fixture@example.invalid", role: "OWNER", appleId, tenant: { plan: "INDIVIDUAL", stripeSubscriptionId: null } });
        const { res, next } = await invoke();
        expect(next).not.toHaveBeenCalled();
        expect(db.user.findUnique.mock.calls[0][0].select.appleId).toBe(true);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, appleAccessRemovalRequired: !!appleId }));
        expect(JSON.stringify(res.json.mock.calls)).not.toContain("PRIVATE_APPLE_SUB");
        expect(JSON.stringify(res.json.mock.calls)).not.toContain("fixture@example.invalid");
        expect(siblings ? db.user.delete : db.tenant.delete).toHaveBeenCalledOnce();
        expect(siblings ? db.tenant.delete : db.user.delete).not.toHaveBeenCalled();
      });
    }
  }
  it("does not turn a failed erasure into a success or follow-up result", async () => {
    const failure = new Error("fixture erasure failure");
    db.tenant.delete.mockRejectedValue(failure);
    const { res, next } = await invoke();
    expect(res.json).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(failure);
  });
  it("preserves confirmation validation and never starts erasure for a bad confirmation", async () => {
    const { res, next } = await invoke("KEEP");
    expect(next).toHaveBeenCalledOnce();
    expect(res.json).not.toHaveBeenCalled();
    expect(db.user.findUnique).not.toHaveBeenCalled();
    expect(db.tenant.delete).not.toHaveBeenCalled();
  });
});
