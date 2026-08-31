import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Router } from "express";
import { ZodError } from "zod";

const integrations = vi.hoisted(() => ({
  createCheckoutSession: vi.fn(),
  createCustomer: vi.fn(),
}));

vi.mock("@ai-company-os/integrations", () => ({
  createCheckoutSession: (...args: unknown[]) => integrations.createCheckoutSession(...args),
  createCustomer: (...args: unknown[]) => integrations.createCustomer(...args),
  createCustomerPortalSession: vi.fn(),
  getSubscription: vi.fn(),
  constructWebhookEvent: vi.fn(),
}));

const db = vi.hoisted(() => ({
  tenantFindUnique: vi.fn(),
  tenantUpdate: vi.fn(),
  userCount: vi.fn(),
  activityCreate: vi.fn(),
}));

vi.mock("../../../lib/db", () => ({
  prisma: {
    tenant: {
      findUnique: (...args: unknown[]) => db.tenantFindUnique(...args),
      update: (...args: unknown[]) => db.tenantUpdate(...args),
    },
    user: { count: (...args: unknown[]) => db.userCount(...args) },
    activityLog: { create: (...args: unknown[]) => db.activityCreate(...args) },
    usageMeter: { findMany: vi.fn() },
    run: { count: vi.fn() },
    toolCall: { count: vi.fn() },
    stripeWebhookEvent: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    mobileSubscription: { findMany: vi.fn() },
  },
}));

vi.mock("../../../config/env", () => ({
  env: {
    STRIPE_SECRET_KEY: "sk_test_server",
    STRIPE_WEBHOOK_SECRET: "whsec_server",
    STRIPE_CREATOR_PRICE_ID: "price_individual",
    STRIPE_PRO_PRICE_ID: "price_team",
    APP_URL: "https://app.braavolabs.com",
  },
}));

vi.mock("../../../middleware/auth", () => ({
  authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../../../middleware/require-permission", () => ({
  requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../../../middleware/system-scope", () => ({
  systemScope: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../../../lib/redis", () => ({ redis: { set: vi.fn(), del: vi.fn() } }));
vi.mock("../../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../forecast", () => ({ computeSpendForecast: vi.fn() }));
vi.mock("../savings.service", () => ({ computeTenantSavings: vi.fn() }));
vi.mock("../entitlement-ledger.service", () => ({ recordEntitlementEvent: vi.fn() }));
vi.mock("../entitlement-mapping", () => ({
  mapStripeSubscriptionUpdated: vi.fn(),
  mapStripeSubscriptionDeleted: vi.fn(),
  mapStripeChargeRefunded: vi.fn(),
  resolveStripePricePlan: vi.fn(),
}));

import { billingRouter } from "../router";

function getHandler(router: Router, method: string, path: string): (req: any, res: any, next: any) => Promise<void> {
  for (const layer of (router as any).stack) {
    if (layer.route?.path === path && layer.route.methods[method.toLowerCase()]) {
      const stack = layer.route.stack;
      return stack[stack.length - 1].handle;
    }
    if (layer.handle?.stack) {
      try { return getHandler(layer.handle as Router, method, path); } catch { /* continue */ }
    }
  }
  throw new Error(`No route ${method} ${path}`);
}

function mockResponse() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
  };
}

async function invoke(body: Record<string, unknown>) {
  const res = mockResponse();
  let nextError: unknown;
  await getHandler(billingRouter, "post", "/checkout")(
    { auth: { tenantId: "tenant-1", userId: "owner-1" }, body, params: {}, query: {} },
    res,
    (error?: unknown) => { nextError = error; },
  );
  return { res, nextError };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.tenantFindUnique.mockResolvedValue({
    id: "tenant-1",
    name: "Tenant One",
    slug: "tenant-one",
    stripeCustomerId: "cus_existing",
    users: [{ email: "owner@example.test" }],
  });
  db.activityCreate.mockResolvedValue({});
  integrations.createCheckoutSession.mockResolvedValue("https://checkout.test/session");
});

describe("POST /billing/checkout seat authority", () => {
  it("derives Team quantity 3 from the server-side tenant user count", async () => {
    db.userCount.mockResolvedValue(3);

    const { res, nextError } = await invoke({ plan: "TEAM", billingCycle: "monthly" });

    expect(nextError).toBeUndefined();
    expect(res.body).toEqual({ url: "https://checkout.test/session" });
    expect(db.userCount).toHaveBeenCalledExactlyOnceWith({ where: { tenantId: "tenant-1" } });
    expect(integrations.createCheckoutSession).toHaveBeenCalledWith(
      expect.any(Object),
      "cus_existing",
      "price_team",
      "https://app.braavolabs.com/settings?billing=success",
      "https://app.braavolabs.com/settings?billing=cancelled",
      3,
    );
    expect(db.activityCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        details: { plan: "TEAM", billingCycle: "monthly", seatQuantity: 3 },
      }),
    });
    expect(JSON.stringify(db.activityCreate.mock.calls)).not.toContain("price_team");
    expect(JSON.stringify(db.activityCreate.mock.calls)).not.toContain("sk_test_server");
  });

  it("keeps Individual quantity 1 even when the tenant has seven users", async () => {
    db.userCount.mockResolvedValue(7);

    const { nextError } = await invoke({ plan: "INDIVIDUAL", billingCycle: "monthly" });

    expect(nextError).toBeUndefined();
    expect(integrations.createCheckoutSession.mock.calls[0][5]).toBe(1);
    expect(db.activityCreate.mock.calls[0][0].data.details.seatQuantity).toBe(1);
  });

  it("fails a zero-user Team safely to one billed seat", async () => {
    db.userCount.mockResolvedValue(0);

    const { nextError } = await invoke({ plan: "TEAM", billingCycle: "monthly" });

    expect(nextError).toBeUndefined();
    expect(integrations.createCheckoutSession.mock.calls[0][5]).toBe(1);
  });

  it.each([1, 999])("rejects client quantity tampering (%s) before counting or opening checkout", async (quantity) => {
    const { nextError } = await invoke({ plan: "TEAM", billingCycle: "monthly", quantity });

    expect(nextError).toBeInstanceOf(ZodError);
    expect(db.userCount).not.toHaveBeenCalled();
    expect(integrations.createCheckoutSession).not.toHaveBeenCalled();
  });
});
