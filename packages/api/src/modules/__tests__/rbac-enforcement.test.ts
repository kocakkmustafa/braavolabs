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
  const { dashboardRouter } = await import("../dashboard/router");

  const app = express();
  app.use(express.json());
  const api = express.Router();
  api.use("/companies", companyRouter);
  api.use("/billing", billingRouter);
  api.use("/governance", governanceRouter);
  api.use("/approvals", approvalRouter);
  api.use("/dashboard", dashboardRouter);
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
  ["billing:checkout", "POST", "/api/v1/billing/checkout", "OWNER"],
  ["billing:portal", "POST", "/api/v1/billing/portal", "OWNER"],
  // The spend CAP, not just the act of paying — a review caught that shipping
  // "money is OWNER-only" with this open made the claim false.
  ["billing:budget", "PATCH", "/api/v1/billing/budget", "OWNER"],
  ["governance:hard-stop", "POST", "/api/v1/governance/hard-stop/r1", "ADMIN"],
];

// approval:decide is deliberately NOT here: it is held at MEMBER because SSO
// provisions every user as MEMBER and no member-management endpoint exists, so
// an ADMIN tier would be unreachable. See lib/rbac.ts for the full reasoning.

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

/**
 * The audit trail must not have a second, ungated door.
 *
 * Independent review found that `/dashboard/activity?includeReads=1` returned
 * the unfiltered audit stream — a SUPERSET of the ADMIN-gated /audit/export —
 * to any MEMBER. A suite that only exercises the new endpoint can never see
 * that; the defect lives at the seam between two routes, which is where all
 * three of this codebase's authorisation failures have lived.
 *
 * NAMED CAREFULLY. An earlier title claimed the audit TRAIL has one door, and
 * that was false: the DEFAULT feed subtracts only 7 read-shaped suffixes, so
 * 130 of 135 distinct actions still reach any MEMBER through it. What is
 * gated here is the UNFILTERED stream. The payload columns (`details`, `ip`)
 * were separately moved behind the same permission — see
 * lib/activity-projection.ts — but the action names themselves are still
 * broadly visible by design. A test title is an artifact people quote.
 */
describe("the UNFILTERED audit stream has exactly one door (BR-P1-005)", () => {
  it("refuses the unfiltered stream to a MEMBER", async () => {
    expect(await call("GET", "/api/v1/dashboard/activity?includeReads=1", "MEMBER")).toBe(403);
    expect(await call("GET", "/api/v1/dashboard/activity?includeReads=true", "MEMBER")).toBe(403);
  });

  it("still serves the ordinary business-event feed to a MEMBER", async () => {
    // The gate must be a gate, not an outage. Members render this on their
    // dashboard; putting the whole route behind ADMIN would break the product
    // exactly the way holding approval:decide at ADMIN would have.
    expect(await call("GET", "/api/v1/dashboard/activity", "MEMBER")).not.toBe(403);
  });

  it("grants the unfiltered stream to the roles that hold audit:export", async () => {
    expect(await call("GET", "/api/v1/dashboard/activity?includeReads=1", "ADMIN")).not.toBe(403);
    expect(await call("GET", "/api/v1/dashboard/activity?includeReads=1", "OWNER")).not.toBe(403);
  });

  it("refuses the unfiltered stream to an unauthenticated caller", async () => {
    expect(await call("GET", "/api/v1/dashboard/activity?includeReads=1")).toBe(401);
  });

  it("cannot be reached by an unrecognised spelling of includeReads", async () => {
    // The gate is CONDITIONAL, so the obvious attack is a spelling the gate
    // misses. It is safe by construction rather than by luck: the middleware
    // and the handler call the SAME predicate, so a spelling the gate does
    // not recognise is equally unrecognised downstream and the request falls
    // through to the FILTERED feed, never the stream.
    //
    // Pinned behaviourally because that property is one careless refactor
    // away — duplicating the predicate would silently restore the seam. An
    // independent review drove 14 spellings against a real database and got
    // 403 or the filtered feed for every one.
    for (const q of [
      "includeReads=1&includeReads=0",
      "includeReads[]=1",
      "INCLUDEREADS=1",
      "includeReads=TRUE",
      "includeReads=True",
      "includeReads=01",
      "includeReads=%31",
    ]) {
      const status = await call("GET", `/api/v1/dashboard/activity?${q}`, "MEMBER");
      expect([200, 403], `${q} produced ${status}`).toContain(status);
    }
  });
});
