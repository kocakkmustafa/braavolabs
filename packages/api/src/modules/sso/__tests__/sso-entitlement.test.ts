import { beforeEach, describe, expect, it, vi } from "vitest";
const db = vi.hoisted(() => ({ tenant: vi.fn(), tenantOrThrow: vi.fn(), events: vi.fn(), user: vi.fn(), createUser: vi.fn(), updateUser: vi.fn(), activity: vi.fn() }));
const sso = vi.hoisted(() => ({ upsert: vi.fn(), build: vi.fn(), consume: vi.fn(), tokens: vi.fn(), exchange: vi.fn() }));
vi.mock("../../../lib/db", () => ({ prisma: {
  tenant: { findUnique: db.tenant, findUniqueOrThrow: db.tenantOrThrow }, entitlementEvent: { findMany: db.events },
  user: { findFirst: db.user, create: db.createUser, update: db.updateUser }, activityLog: { create: db.activity },
}, tenantTx: vi.fn() }));
vi.mock("../../../lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn() } }));
vi.mock("../../../lib/redis", () => ({ redis: {} }));
vi.mock("../../../lib/encryption", () => ({ encrypt: vi.fn(), decrypt: vi.fn() }));
vi.mock("../../../config/env", () => ({ env: { APP_URL: "https://app.braavolabs.com" } }));
vi.mock("../../../middleware/auth", () => ({ authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next() }));
vi.mock("../../../middleware/system-scope", () => ({ systemScope: () => (_req: unknown, _res: unknown, next: () => void) => next() }));
vi.mock("../../../middleware/rateLimit", () => ({ rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next() }));
vi.mock("../../auth/auth.service", () => ({ issueTokenPair: sso.tokens, stashOAuthExchange: sso.exchange }));
vi.mock("../sso.service", async (importOriginal) => ({
  ...await importOriginal<typeof import("../sso.service")>(),
  upsertOidcConnection: sso.upsert, buildAuthUrl: sso.build, consumeCallback: sso.consume,
}));
import { ssoAuthRouter, ssoConfigRouter } from "../sso.router";

function handler(router: any, method: string, path: string) {
  return router.stack.find((layer: any) => layer.route?.path === path && layer.route.methods[method]).route.stack.at(-1).handle;
}
async function invoke(router: any, method: string, path: string) {
  const res = { statusCode: 200, body: undefined as unknown, status(code: number) { this.statusCode = code; return this; }, json(value: unknown) { this.body = value; return this; }, redirect: vi.fn() };
  let error: unknown;
  await handler(router, method, path)({ auth: { tenantId: "tenant-A", userId: "user-A", role: "OWNER" }, params: { tenantSlug: "local-workspace" }, query: { code: "local-idp-code", state: "local-state" }, body: { issuer: "https://idp.example.invalid", clientId: "local-client", clientSecret: "local-test-secret", redirectUri: "https://api.braavolabs.com/api/v1/auth/sso/local-workspace/callback" } }, res, (err: unknown) => { error = err; });
  return { res, error };
}
beforeEach(() => {
  vi.clearAllMocks();
  const tenant = { id: "tenant-A", plan: "BUSINESS", name: "Local workspace", slug: "local-workspace" };
  db.tenant.mockResolvedValue(tenant); db.tenantOrThrow.mockResolvedValue(tenant); db.events.mockResolvedValue([]);
  db.user.mockResolvedValue({ id: "user-A", tenantId: "tenant-A", oidcSubject: "local-subject", email: "user@example.invalid", name: "Local user", role: "MEMBER" });
  db.activity.mockResolvedValue({}); sso.upsert.mockResolvedValue({ id: "local-oidc" }); sso.build.mockResolvedValue({ url: "https://idp.example.invalid/authorize" });
  sso.consume.mockResolvedValue({ tenantId: "tenant-A", sub: "local-subject", email: "user@example.invalid", name: "Local user" }); sso.tokens.mockResolvedValue({ token: "local-access", refreshToken: "local-refresh" }); sso.exchange.mockResolvedValue("local-exchange-code");
});
const expired = { id: "expired", source: "google", streamId: "mobile", sourceTimestamp: new Date("2026-08-01T00:00:00Z"), type: "purchase", planTier: "BUSINESS", expiresAt: new Date("2020-01-01T00:00:00Z"), autoRenew: true };
describe("SSO consults current paid authority before effects", () => {
  it("denies config upsert after ledger expiry despite a stale legacy Business plan", async () => {
    db.events.mockResolvedValue([expired]); const { error } = await invoke(ssoConfigRouter, "put", "/oidc");
    expect(error).toMatchObject({ statusCode: 402 }); expect(sso.upsert).not.toHaveBeenCalled(); expect(db.activity).not.toHaveBeenCalled();
    expect(db.events).toHaveBeenCalledWith({ where: { tenantId: "tenant-A" } });
  });
  it("denies public init after expiry before an IdP redirect", async () => {
    db.events.mockResolvedValue([expired]); const { res, error } = await invoke(ssoAuthRouter, "get", "/:tenantSlug");
    expect(error).toBeUndefined(); expect(res.statusCode).toBe(402); expect(sso.build).not.toHaveBeenCalled(); expect(res.redirect).not.toHaveBeenCalled();
  });
  it("rechecks a completed IdP callback before user mutation or token issuance", async () => {
    db.events.mockResolvedValue([expired]); const { error, res } = await invoke(ssoAuthRouter, "get", "/:tenantSlug/callback");
    expect(error).toMatchObject({ statusCode: 402 }); expect(db.user).not.toHaveBeenCalled(); expect(db.createUser).not.toHaveBeenCalled(); expect(db.updateUser).not.toHaveBeenCalled();
    expect(sso.tokens).not.toHaveBeenCalled(); expect(sso.exchange).not.toHaveBeenCalled(); expect(res.redirect).not.toHaveBeenCalled();
  });
  it.each(["INDIVIDUAL", "TEAM", "CREATOR", "PRO", "MANUAL_REVIEW", "BUSINESS"])("does not invent SSO for the normalized empty-ledger %s tier", async (plan) => {
    db.tenant.mockResolvedValue({ id: "tenant-A", plan }); const { error } = await invoke(ssoConfigRouter, "put", "/oidc");
    expect(error).toMatchObject({ statusCode: 402 }); expect(sso.upsert).not.toHaveBeenCalled();
  });
});
