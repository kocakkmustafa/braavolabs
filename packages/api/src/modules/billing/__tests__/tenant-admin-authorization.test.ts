import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Router } from "express";

const integrations = vi.hoisted(() => ({
  createCheckoutSession: vi.fn(),
  createCustomer: vi.fn(),
  createCustomerPortalSession: vi.fn(),
  getSubscription: vi.fn(),
}));

vi.mock("@ai-company-os/integrations", () => ({
  createCheckoutSession: (...args: unknown[]) => integrations.createCheckoutSession(...args),
  createCustomer: (...args: unknown[]) => integrations.createCustomer(...args),
  createCustomerPortalSession: (...args: unknown[]) => integrations.createCustomerPortalSession(...args),
  getSubscription: (...args: unknown[]) => integrations.getSubscription(...args),
  constructWebhookEvent: vi.fn(),
}));

const db = vi.hoisted(() => ({
  tenantFindUnique: vi.fn(),
  tenantUpdate: vi.fn(),
  userCount: vi.fn(),
  activityCreate: vi.fn(),
  usageMeterFindMany: vi.fn(),
  runCount: vi.fn(),
  toolCallCount: vi.fn(),
}));

vi.mock("../../../lib/db", () => ({
  prisma: {
    tenant: {
      findUnique: (...args: unknown[]) => db.tenantFindUnique(...args),
      update: (...args: unknown[]) => db.tenantUpdate(...args),
    },
    user: { count: (...args: unknown[]) => db.userCount(...args) },
    activityLog: { create: (...args: unknown[]) => db.activityCreate(...args) },
    usageMeter: { findMany: (...args: unknown[]) => db.usageMeterFindMany(...args) },
    run: { count: (...args: unknown[]) => db.runCount(...args) },
    toolCall: { count: (...args: unknown[]) => db.toolCallCount(...args) },
    stripeWebhookEvent: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    mobileSubscription: { findMany: vi.fn() },
  },
}));

const services = vi.hoisted(() => ({
  computeSpendForecast: vi.fn(),
  computeTenantSavings: vi.fn(),
  recordEntitlementEvent: vi.fn(),
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
vi.mock("../../../middleware/system-scope", () => ({
  systemScope: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../../../lib/redis", () => ({ redis: { set: vi.fn(), del: vi.fn() } }));
vi.mock("../../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../forecast", () => ({
  computeSpendForecast: (...args: unknown[]) => services.computeSpendForecast(...args),
}));
vi.mock("../savings.service", () => ({
  computeTenantSavings: (...args: unknown[]) => services.computeTenantSavings(...args),
}));
vi.mock("../entitlement-ledger.service", () => ({
  recordEntitlementEvent: (...args: unknown[]) => services.recordEntitlementEvent(...args),
}));
vi.mock("../entitlement-mapping", () => ({
  mapStripeSubscriptionUpdated: vi.fn(),
  mapStripeSubscriptionDeleted: vi.fn(),
  mapStripeChargeRefunded: vi.fn(),
  resolveStripePricePlan: vi.fn(),
}));

import { billingRouter } from "../router";

type Role = "OWNER" | "ADMIN" | "MEMBER" | string | undefined;

function routeStack(router: Router, method: string, path: string): Array<(req: any, res: any, next: any) => unknown> {
  for (const layer of (router as any).stack) {
    if (layer.route?.path === path && layer.route.methods[method.toLowerCase()]) {
      return layer.route.stack.map((entry: any) => entry.handle);
    }
    if (layer.handle?.stack) {
      try { return routeStack(layer.handle as Router, method, path); } catch { /* continue */ }
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

async function invoke(
  method: string,
  path: string,
  role: Role,
  body: unknown = {},
  trackBodyAccess = false,
) {
  let bodyAccesses = 0;
  const req = {
    auth: {
      tenantId: "tenant-1",
      userId: "user-1",
      ...(role === undefined ? {} : { role }),
    },
    params: {},
    query: {},
  };
  Object.defineProperty(req, "body", {
    configurable: false,
    enumerable: true,
    get() {
      bodyAccesses += 1;
      if (trackBodyAccess) throw new Error("denied request body was accessed");
      return body;
    },
  });
  const res = mockResponse();
  let nextError: unknown;
  const handlers = routeStack(billingRouter, method, path);

  async function run(index: number): Promise<void> {
    const handler = handlers[index];
    if (!handler) return;
    let continuation: Promise<void> | undefined;
    const result = handler(req, res, (error?: unknown) => {
      if (error) nextError = error;
      else continuation = run(index + 1);
    });
    await Promise.resolve(result);
    if (continuation) await continuation;
  }

  await run(0);
  return { res, nextError, bodyAccesses };
}

const deniedRoles: Array<[string, Role]> = [
  ["MEMBER", "MEMBER"],
  ["lowercase member", "member"],
  ["lowercase owner", "owner"],
  ["lowercase admin", "admin"],
  ["unknown", "BILLING_ADMIN"],
  ["whitespace variant", "OWNER "],
  ["missing", undefined],
];

const mutationRoutes = [
  ["PATCH", "/budget"],
  ["POST", "/checkout"],
  ["POST", "/portal"],
] as const;

function expectNoMutationEffects() {
  for (const fn of [
    db.tenantFindUnique,
    db.tenantUpdate,
    db.userCount,
    db.activityCreate,
    integrations.createCustomer,
    integrations.createCheckoutSession,
    integrations.createCustomerPortalSession,
    integrations.getSubscription,
    services.recordEntitlementEvent,
  ]) expect(fn).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  db.tenantFindUnique.mockResolvedValue({
    id: "tenant-1",
    name: "Tenant One",
    slug: "tenant-one",
    stripeCustomerId: "cus_existing",
    stripeSubscriptionId: null,
    users: [{ email: "owner@example.test" }],
    plan: "INDIVIDUAL",
  });
  db.tenantUpdate.mockResolvedValue({ id: "tenant-1" });
  db.userCount.mockResolvedValue(3);
  db.activityCreate.mockResolvedValue({ id: "activity-1" });
  db.usageMeterFindMany.mockResolvedValue([]);
  db.runCount.mockResolvedValue(0);
  db.toolCallCount.mockResolvedValue(0);
  integrations.createCheckoutSession.mockResolvedValue("https://checkout.test/session");
  integrations.createCustomerPortalSession.mockResolvedValue("https://portal.test/session");
  services.computeSpendForecast.mockResolvedValue({ status: "under_budget" });
  services.computeTenantSavings.mockResolvedValue({ days: 7, totalSavingsUsd: 0 });
});

describe.each(mutationRoutes)("%s %s tenant billing authorization", (method, path) => {
  it.each(deniedRoles)("denies %s before parsing or side effects", async (_label, role) => {
    const { res, nextError, bodyAccesses } = await invoke(method, path, role, {
      malformed: Symbol("must-not-be-parsed"),
      quantity: 999,
    }, true);

    expect(nextError).toBeUndefined();
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: "Insufficient permissions" });
    expect(bodyAccesses).toBe(0);
    expectNoMutationEffects();
  });

  it.each(["OWNER", "ADMIN"] as const)("allows canonical %s", async (role) => {
    const body = path === "/budget"
      ? { monthlyBudgetUsd: 500 }
      : path === "/checkout"
        ? { plan: "INDIVIDUAL", billingCycle: "monthly" }
        : {};
    const { res, nextError } = await invoke(method, path, role, body);

    expect(nextError).toBeUndefined();
    expect(res.statusCode).toBe(200);
    if (path === "/budget") {
      expect(db.tenantUpdate).toHaveBeenCalledTimes(1);
      expect(db.activityCreate).toHaveBeenCalledTimes(1);
    } else if (path === "/checkout") {
      expect(integrations.createCheckoutSession).toHaveBeenCalledTimes(1);
      expect(db.activityCreate).toHaveBeenCalledTimes(1);
    } else {
      expect(integrations.createCustomerPortalSession).toHaveBeenCalledTimes(1);
    }
  });
});

describe("read-only billing visibility", () => {
  it("keeps usage readable by MEMBER", async () => {
    const { res, nextError } = await invoke("GET", "/usage", "MEMBER");
    expect(nextError).toBeUndefined();
    expect(res.body).toMatchObject({ plan: "INDIVIDUAL", meters: [], live: { runs: 0, toolCalls: 0 } });
  });

  it("keeps forecast readable by MEMBER", async () => {
    const { res, nextError } = await invoke("GET", "/forecast", "MEMBER");
    expect(nextError).toBeUndefined();
    expect(res.body).toEqual({ status: "under_budget" });
    expect(services.computeSpendForecast).toHaveBeenCalledWith("tenant-1");
  });

  it("keeps savings readable by MEMBER", async () => {
    const { res, nextError } = await invoke("GET", "/savings", "MEMBER");
    expect(nextError).toBeUndefined();
    expect(res.body).toEqual({ days: 7, totalSavingsUsd: 0 });
    expect(services.computeTenantSavings).toHaveBeenCalledWith("tenant-1", undefined);
  });

  it("keeps current subscription readable by MEMBER", async () => {
    const { res, nextError } = await invoke("GET", "/subscription", "MEMBER");
    expect(nextError).toBeUndefined();
    expect(res.body).toMatchObject({ plan: "INDIVIDUAL", stripeCustomerId: "cus_existing" });
    expect(db.tenantFindUnique).toHaveBeenCalledTimes(1);
  });
});
