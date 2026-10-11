/**
 * BR-P1-005 — proof that the role matrix is REACHED, not merely correct.
 *
 * A policy layer wired to nothing enforces nothing. These drive the REAL
 * routers through a REAL express app with REAL HS256 tokens for three roles,
 * because the failure being fixed was precisely that a correct-looking
 * `requireRole` helper existed and no route used it.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { currentTenantContext } from "../../lib/tenant-context";
import { logger } from "../../lib/logger";

const findMember = vi.hoisted(() => vi.fn());
const businessQuery = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => null));
const handlerReached = vi.hoisted(() => vi.fn());

vi.mock("../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../lib/db", () => ({
  prisma: new Proxy({}, { get: (_target, model) => new Proxy({}, {
    get: (_model, method) => model === "user" && method === "findFirst"
      ? findMember : (...args: unknown[]) => businessQuery(model, method, args),
  }) }),
  tenantTx: (fn: any) => { businessQuery("transaction", "begin", []); return fn({}); },
}));
vi.mock("../../config/env", () => ({
  env: {
    JWT_SECRET: "rbac-enforcement-test-secret-at-least-32",
    AUTH_COOKIE_MODE: false, NODE_ENV: "test",
    // Handler controls can pass configuration without contacting Stripe:
    // checkout has an invalid body and portal's tenant lookup returns null.
    STRIPE_SECRET_KEY: "sk_test_fixture_not_sent", STRIPE_WEBHOOK_SECRET: "whsec_fixture_not_sent",
  },
}));

const SECRET = "rbac-enforcement-test-secret-at-least-32";
let server: http.Server;
let baseUrl: string;
const tok: Record<string, string> = {};

beforeEach(() => {
  vi.clearAllMocks();
  findMember.mockImplementation(async ({ where, select }) => {
    expect(currentTenantContext()).toEqual({ kind: "tenant", tenantId: where.tenantId });
    expect(select).toEqual({ id: true, tenantId: true, role: true });
    const role = ["OWNER", "ADMIN", "MEMBER"].find(value => where.id === `u-${value}`);
    return role && where.tenantId === "t1" ? { id: where.id, tenantId: "t1", role } : null;
  });
});

function terminalRoute(router: any, method: string, path: string): any {
  for (const layer of router.stack) {
    if (layer.route?.path === path && layer.route.methods[method.toLowerCase()]) return layer.route.stack.at(-1);
    if (layer.handle?.stack) {
      const nested = terminalRoute(layer.handle, method, path);
      if (nested) return nested;
    }
  }
}

beforeAll(async () => {
  const jwt = (await import("jsonwebtoken")).default;
  for (const role of ["OWNER", "ADMIN", "MEMBER"]) {
    // Stale JWT roles deliberately disagree with current DB memberships.
    const claimedRole = role === "OWNER" ? "MEMBER" : "OWNER";
    tok[role] = jwt.sign({ userId: `u-${role}`, tenantId: "t1", role: claimedRole }, SECRET, { expiresIn: "1h" });
  }
  const { companyRouter } = await import("../company/router");
  const { billingRouter } = await import("../billing/router");
  const { governanceRouter } = await import("../governance/router");
  const { approvalRouter } = await import("../approval/router");

  const routers: Record<string, any> = { company: companyRouter, billing: billingRouter, governance: governanceRouter, approval: approvalRouter };
  const paths: Record<string, string> = { "company:delete": "/:id", "billing:checkout": "/checkout", "billing:portal": "/portal",
    "billing:budget": "/budget", "governance:hard-stop": "/hard-stop/:runId", "approval:decide": "/:id/decide" };
  for (const [label, method] of MATRIX) {
    const terminal = terminalRoute(routers[label.split(":")[0]], method, paths[label]);
    if (!terminal) throw new Error(`Missing actual handler ${label}`);
    const actual = terminal.handle;
    terminal.handle = function(this: unknown, ...args: any[]) {
      expect(currentTenantContext()).toEqual({ kind: "tenant", tenantId: "t1" });
      handlerReached(label, { ...args[0].auth });
      return actual.apply(this, args);
    };
  }

  const app = express();
  app.use(express.json());
  const api = express.Router();
  api.use("/companies", companyRouter);
  api.use("/billing", billingRouter);
  api.use("/governance", governanceRouter);
  api.use("/approvals", approvalRouter);
  app.use("/api/v1", api);
  app.use((err: any, _q: any, res: any, _n: any) =>
    res.status(err?.statusCode ?? err?.status ?? 500).json({ error: err?.message ?? "error" }));
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 30_000);

afterAll(() => new Promise<void>((r) => server?.listening ? server.close(() => r()) : r()));

async function call(method: string, path: string, role?: string) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(role ? { Authorization: `Bearer ${tok[role]}` } : {}) },
    body: method === "POST" || method === "PATCH" ? "{}" : undefined,
  });
  return { status: res.status, body: await res.json() };
}

function expectMembership(role: string) {
  expect(findMember).toHaveBeenCalledOnce();
  expect(findMember).toHaveBeenCalledWith({ where: { id: `u-${role}`, tenantId: "t1" }, select: { id: true, tenantId: true, role: true } });
}

function expectDenied(label: string, role: string) {
  expectMembership(role);
  expect(logger.warn).toHaveBeenCalledWith({ action: label, role, userId: `u-${role}`, tenantId: "t1" }, "authorisation denied");
  expect(handlerReached).not.toHaveBeenCalled();
  expect(businessQuery).not.toHaveBeenCalled();
}

/** [label, method, path, minimum role] */
const MATRIX: [string, string, string, "OWNER" | "ADMIN"][] = [
  ["company:delete", "DELETE", "/api/v1/companies/c1", "OWNER"],
  ["billing:checkout", "POST", "/api/v1/billing/checkout", "ADMIN"],
  ["billing:portal", "POST", "/api/v1/billing/portal", "ADMIN"],
  // The spend CAP, not just the act of paying — a review caught that shipping
  // "money is OWNER-only" with this open made the claim false.
  ["billing:budget", "PATCH", "/api/v1/billing/budget", "ADMIN"],
  ["governance:hard-stop", "POST", "/api/v1/governance/hard-stop/r1", "ADMIN"],
  ["approval:decide", "POST", "/api/v1/approvals/a1/decide", "ADMIN"],
];

describe("privileged routes actually enforce the matrix", () => {
  it.each(MATRIX)("%s DENIES a MEMBER with 403", async (label, method, path) => {
    // Every one of these was reachable by a MEMBER before this change.
    expect(await call(method, path, "MEMBER")).toEqual({ status: 403, body: { error: "Insufficient permissions" } });
    expectDenied(label, "MEMBER");
  });

  it.each(MATRIX.filter(([, , , min]) => min === "OWNER"))(
    "%s DENIES an ADMIN with 403 (money and destruction are owner-only)",
    async (label, method, path) => {
      expect(await call(method, path, "ADMIN")).toEqual({ status: 403, body: { error: "Insufficient permissions" } });
      expectDenied(label, "ADMIN");
    },
  );

  it.each(MATRIX)("%s lets the required role THROUGH (not a blanket 403)", async (label, method, path, min) => {
    // The decisive control: a gate that denies everyone is not authorisation,
    // it is an outage. Missing membership (401) or failed lookup (503) must
    // not count as admission. The real terminal handler is instrumented above.
    expect([401, 403, 503]).not.toContain((await call(method, path, min)).status);
    expectMembership(min);
    expect(handlerReached).toHaveBeenCalledExactlyOnceWith(label, { userId: `u-${min}`, tenantId: "t1", role: min });
  });

  it.each(MATRIX)("%s still requires authentication at all", async (_label, method, path) => {
    expect(await call(method, path)).toEqual({ status: 401, body: { error: "Missing or invalid authorization header" } });
    expect(findMember).not.toHaveBeenCalled();
    expect(handlerReached).not.toHaveBeenCalled();
    expect(businessQuery).not.toHaveBeenCalled();
  });
});
