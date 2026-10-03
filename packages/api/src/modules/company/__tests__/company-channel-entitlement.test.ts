import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ tenant: vi.fn(), events: vi.fn(), company: vi.fn(), update: vi.fn(), activity: vi.fn() }));
vi.mock("../../../lib/db", () => ({
  prisma: {
    tenant: { findUnique: db.tenant }, entitlementEvent: { findMany: db.events },
    company: { findFirst: db.company, updateMany: db.update }, activityLog: { create: db.activity },
  }, tenantTx: vi.fn(),
}));
vi.mock("../../../lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn() } }));
vi.mock("../../../middleware/auth", () => ({ authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next() }));
vi.mock("../../../middleware/rateLimit", () => ({ rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next() }));
vi.mock("../builder", () => ({ startBuildSession: vi.fn(), continueBuildSession: vi.fn(), confirmBuild: vi.fn(), getSession: vi.fn() }));
vi.mock("../../agent/nl-editor", () => ({ applyNaturalLanguageEdit: vi.fn() }));
vi.mock("../../agent/version-control", () => ({ createVersion: vi.fn() }));
vi.mock("../../agent/composer", () => ({ composeAgent: vi.fn() }));
import { companyRouter } from "../router";

const patch = (companyRouter as any).stack.find((layer: any) => layer.route?.path === "/:id" && layer.route.methods.patch).route.stack.at(-1).handle;
async function invoke(channels = ["instagram"]) {
  const res = { json: vi.fn() }; let error: unknown;
  await patch({ auth: { tenantId: "tenant-A", userId: "user-A" }, params: { id: "company-A" }, body: { config: { channels } } }, res, (err: unknown) => { error = err; });
  return { res, error };
}
beforeEach(() => {
  vi.clearAllMocks();
  db.tenant.mockResolvedValue({ plan: "INDIVIDUAL" }); db.events.mockResolvedValue([]);
  db.company.mockResolvedValue({ config: {} }); db.update.mockResolvedValue({ count: 1 }); db.activity.mockResolvedValue({});
});
describe("company channels use current ledger authority", () => {
  it("rejects paid channels after expiry before company or activity writes", async () => {
    db.events.mockResolvedValue([{
      id: "expired", source: "google", streamId: "mobile", sourceTimestamp: new Date("2026-08-01T00:00:00Z"),
      type: "purchase", planTier: "INDIVIDUAL", expiresAt: new Date(Date.now() - 1_000), autoRenew: true,
    }]);
    expect((await invoke()).error).toMatchObject({ statusCode: 403 });
    expect(db.update).not.toHaveBeenCalled(); expect(db.activity).not.toHaveBeenCalled();
    expect(db.events).toHaveBeenCalledWith({ where: { tenantId: "tenant-A" } });
  });
  it.each(["INDIVIDUAL", "TEAM", "CREATOR", "PRO"])("preserves the empty-ledger %s channel baseline", async (plan) => {
    db.tenant.mockResolvedValue({ plan }); expect((await invoke()).error).toBeUndefined(); expect(db.update).toHaveBeenCalledOnce();
  });
  it("keeps a valid Stripe Team stream's YouTube channel even when mobile expires", async () => {
    db.events.mockResolvedValue([
      { id: "mobile", source: "google", streamId: "mobile", sourceTimestamp: new Date("2026-08-01T00:00:00Z"), type: "purchase", planTier: "INDIVIDUAL", expiresAt: new Date(Date.now() - 1_000), autoRenew: true },
      { id: "stripe", source: "stripe", streamId: "stripe", sourceTimestamp: new Date("2026-08-01T00:00:00Z"), type: "purchase", planTier: "TEAM", expiresAt: new Date(Date.now() + 60_000), autoRenew: true },
    ]);
    expect((await invoke(["youtube"])).error).toBeUndefined(); expect(db.update).toHaveBeenCalledOnce();
  });
});
