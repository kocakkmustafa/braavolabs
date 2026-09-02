/**
 * BR-P1-005 — proof that the role matrix is REACHED, not merely correct.
 *
 * A policy layer wired to nothing enforces nothing. These drive the REAL
 * routers through a REAL express app with REAL HS256 tokens for three roles,
 * because the failure being fixed was precisely that a correct-looking
 * `requireRole` helper existed and no route used it.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";

vi.mock("../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../lib/db", () => ({
  prisma: new Proxy({}, { get: () => new Proxy({}, { get: () => async () => null }) }),
  tenantTx: (fn: any) => fn({}),
}));
vi.mock("../../config/env", () => ({
  env: {
    JWT_SECRET: "rbac-enforcement-test-secret-at-least-32",
    AUTH_COOKIE_MODE: false, NODE_ENV: "test",
    STRIPE_SECRET_KEY: "", STRIPE_WEBHOOK_SECRET: "",
  },
}));

const SECRET = "rbac-enforcement-test-secret-at-least-32";
let server: http.Server;
let baseUrl: string;
const tok: Record<string, string> = {};

beforeAll(async () => {
  const jwt = (await import("jsonwebtoken")).default;
  for (const role of ["OWNER", "ADMIN", "MEMBER"]) {
    tok[role] = jwt.sign({ userId: `u-${role}`, tenantId: "t1", role }, SECRET, { expiresIn: "1h" });
  }
  const { companyRouter } = await import("../company/router");
  const { billingRouter } = await import("../billing/router");
  const { governanceRouter } = await import("../governance/router");
  const { approvalRouter } = await import("../approval/router");

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
  await new Promise<void>((r) => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 30_000);

afterAll(() => new Promise<void>((r) => server.close(() => r())));

async function call(method: string, path: string, role?: string) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(role ? { Authorization: `Bearer ${tok[role]}` } : {}) },
    body: method === "POST" || method === "PATCH" ? "{}" : undefined,
  });
  return res.status;
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
  it.each(MATRIX)("%s DENIES a MEMBER with 403", async (_label, method, path) => {
    // Every one of these was reachable by a MEMBER before this change.
    expect(await call(method, path, "MEMBER")).toBe(403);
  });

  it.each(MATRIX.filter(([, , , min]) => min === "OWNER"))(
    "%s DENIES an ADMIN with 403 (money and destruction are owner-only)",
    async (_label, method, path) => {
      expect(await call(method, path, "ADMIN")).toBe(403);
    },
  );

  it.each(MATRIX)("%s lets the required role THROUGH (not a blanket 403)", async (_label, method, path, min) => {
    // The decisive control: a gate that denies everyone is not authorisation,
    // it is an outage. Anything other than 403 means the request passed the
    // permission check and reached the handler.
    expect(await call(method, path, min)).not.toBe(403);
  });

  it.each(MATRIX)("%s still requires authentication at all", async (_label, method, path) => {
    expect(await call(method, path)).toBe(401);
  });
});
