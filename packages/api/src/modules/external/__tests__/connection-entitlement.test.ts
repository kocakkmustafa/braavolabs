import { beforeEach, describe, expect, it, vi } from "vitest";
const db = vi.hoisted(() => ({ tenant: vi.fn(), events: vi.fn(), count: vi.fn(), create: vi.fn(), update: vi.fn(), activity: vi.fn() }));
const validation = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/db", () => ({ prisma: {
  tenant: { findUnique: db.tenant }, entitlementEvent: { findMany: db.events },
  externalConnection: { count: db.count, create: db.create, update: db.update }, activityLog: { create: db.activity },
}, tenantTx: vi.fn() }));
vi.mock("../../../lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn() } }));
vi.mock("../../../middleware/auth", () => ({ authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next() }));
vi.mock("../../../lib/encryption", () => ({ encrypt: vi.fn(() => "opaque-local-fixture") }));
vi.mock("../adapters/types", () => ({ assertPublicUrl: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../poller", () => ({ pollConnection: vi.fn(), credentialsAad: vi.fn(), validateConnectionCredentials: validation }));
vi.mock("../control", () => ({ capabilitiesFor: vi.fn(), listExternalWorkflows: vi.fn(), runControlAction: vi.fn() }));
import { externalRouter } from "../router";
const create = (externalRouter as any).stack.find((layer: any) => layer.route?.path === "/" && layer.route.methods.post).route.stack.at(-1).handle;
async function invoke() {
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }; let error: unknown;
  await create({ auth: { tenantId: "tenant-A", userId: "user-A" }, body: { platform: "GENERIC", label: "Local fixture", baseUrl: "https://automation.example.invalid", apiKey: "local-test-key" } }, res, (err: unknown) => { error = err; });
  return error;
}
beforeEach(() => {
  vi.clearAllMocks(); db.tenant.mockResolvedValue({ plan: "INDIVIDUAL" }); db.events.mockResolvedValue([]); db.count.mockResolvedValue(0);
  validation.mockResolvedValue({ validated: true }); db.create.mockResolvedValue({ id: "local-connection" }); db.update.mockResolvedValue({ id: "local-connection" }); db.activity.mockResolvedValue({});
});
const expired = { id: "expired", source: "google", streamId: "mobile", sourceTimestamp: new Date("2026-08-01T00:00:00Z"), type: "purchase", planTier: "INDIVIDUAL", expiresAt: new Date("2020-01-01T00:00:00Z"), autoRenew: true };
describe("external connection paid authority", () => {
  it("denies after ledger expiry before credential validation or connection persistence", async () => {
    db.events.mockResolvedValue([expired]); expect(await invoke()).toMatchObject({ statusCode: 402 });
    expect(validation).not.toHaveBeenCalled(); expect(db.create).not.toHaveBeenCalled(); expect(db.update).not.toHaveBeenCalled();
    expect(db.events).toHaveBeenCalledWith({ where: { tenantId: "tenant-A" } });
  });
  it.each(["INDIVIDUAL", "TEAM", "CREATOR", "PRO"])("preserves the empty-ledger %s connection baseline", async (plan) => {
    db.tenant.mockResolvedValue({ plan }); expect(await invoke()).toBeUndefined(); expect(db.create).toHaveBeenCalledOnce();
  });
  it("uses an active Stripe Team allowance above a stale Individual connection cap", async () => {
    db.count.mockResolvedValue(5); db.events.mockResolvedValue([expired, { ...expired, id: "stripe", source: "stripe", streamId: "stripe", planTier: "TEAM", expiresAt: new Date(Date.now() + 60_000) }]);
    expect(await invoke()).toBeUndefined(); expect(db.create).toHaveBeenCalledOnce();
  });
  it("denies manual-review plans before credential work", async () => {
    db.tenant.mockResolvedValue({ plan: "MANUAL_REVIEW" }); expect(await invoke()).toMatchObject({ statusCode: 402 }); expect(validation).not.toHaveBeenCalled();
  });
});
