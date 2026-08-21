/**
 * BR-P1-005 — proof the audit export is REACHED and SCOPED, not merely shaped.
 *
 * Driven through a real express app with real HS256 tokens, for the same
 * reason as rbac-enforcement.test.ts: the failure this task exists to fix was
 * a correct-looking layer that nothing called.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";

const SECRET = "audit-export-test-secret-at-least-32-chars";

/** Every findMany the router issues, so scoping can be asserted on the QUERY. */
const queries: any[] = [];

const ROWS = [
  {
    id: "a1",
    createdAt: new Date("2026-08-20T09:00:00Z"),
    actor: "u-1",
    action: "company.delete",
    resource: "company",
    resourceId: "c1",
    result: "denied",
    policy: "company:delete",
    ip: "203.0.113.4",
    details: { reason: "insufficient role" },
    tenantId: "t1",
  },
];

vi.mock("../../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
const created: any[] = [];
vi.mock("../../../middleware/rateLimit", () => ({ rateLimit: () => (_q: any, _s: any, n: any) => n() }));
vi.mock("../../../lib/db", () => ({
  prisma: {
    activityLog: {
      create: async (args: any) => {
        created.push(args);
        return { id: "logged" };
      },
      // Anchor lookup for the cursor. Only tenant t1 owns "A1"; "B9" belongs
      // to another tenant, so a tenant-scoped lookup must NOT find it — the
      // double enforces the constraint the real query enforces, otherwise the
      // suite would be green about the exact thing it is checking.
      findFirst: async (args: any) => {
        queries.push(args);
        const id = args?.where?.id;
        if (id === "A1" && args?.where?.tenantId === "t1") {
          return { id: "A1", createdAt: new Date("2026-08-20T08:00:00Z") };
        }
        return null;
      },
      findMany: async (args: any) => {
        queries.push(args);
        // The double APPLIES `select`, because real Prisma does. A fake that
        // hands back the whole fixture would let a router that forgot to
        // project still pass the "no more, no less" assertion — the suite
        // would be green about the one thing it exists to check.
        const project = (row: any) =>
          args?.select
            ? Object.fromEntries(Object.keys(args.select).filter((k) => args.select[k]).map((k) => [k, row[k]]))
            : row;
        return ROWS.map(project);
      },
    },
  },
  tenantTx: (fn: any) => fn({}),
}));
vi.mock("../../../config/env", () => ({
  env: {
    JWT_SECRET: "audit-export-test-secret-at-least-32-chars",
    AUTH_COOKIE_MODE: false,
    NODE_ENV: "test",
  },
}));

let server: http.Server;
let baseUrl: string;
const tok: Record<string, string> = {};

beforeAll(async () => {
  const jwt = (await import("jsonwebtoken")).default;
  for (const role of ["OWNER", "ADMIN", "MEMBER"]) {
    tok[role] = jwt.sign({ userId: `u-${role}`, tenantId: "t1", role }, SECRET, { expiresIn: "1h" });
  }
  const { auditRouter } = await import("../router");
  const app = express();
  app.use(express.json());
  const api = express.Router();
  api.use("/audit", auditRouter);
  app.use("/api/v1", api);
  app.use((err: any, _q: any, res: any, _n: any) =>
    res.status(err?.statusCode ?? err?.status ?? 500).json({ error: err?.message ?? "error" }));
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 30_000);

afterAll(() => new Promise<void>((r) => server.close(() => r())));

async function get(path: string, role?: string) {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: role ? { Authorization: `Bearer ${tok[role]}` } : {},
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe("GET /audit/export (BR-P1-005)", () => {
  it("refuses an unauthenticated caller", async () => {
    expect((await get("/api/v1/audit/export")).status).toBe(401);
  });

  it("refuses a MEMBER", async () => {
    expect((await get("/api/v1/audit/export", "MEMBER")).status).toBe(403);
  });

  it("allows the roles that are supposed to have it", async () => {
    // A gate that denies EVERYONE is an outage, not authorisation, and a
    // deny-only suite cannot tell the two apart.
    expect((await get("/api/v1/audit/export", "ADMIN")).status).toBe(200);
    expect((await get("/api/v1/audit/export", "OWNER")).status).toBe(200);
  });

  it("scopes the QUERY to the caller's tenant", async () => {
    queries.length = 0;
    await get("/api/v1/audit/export", "OWNER");
    expect(queries.length).toBeGreaterThan(0);
    for (const q of queries) {
      expect(q?.where?.tenantId, "every audit query must be tenant-scoped").toBe("t1");
    }
  });

  it("cannot be widened to another tenant through the query string", async () => {
    queries.length = 0;
    await get("/api/v1/audit/export?tenantId=t2&where[tenantId]=t2", "OWNER");
    for (const q of queries) {
      expect(q?.where?.tenantId, "caller-supplied tenantId must be ignored").toBe("t1");
    }
  });

  it("returns exactly the declared field set — no more, no less", async () => {
    const { AUDIT_EXPORT_FIELDS } = await import("../router");
    const { body } = await get("/api/v1/audit/export", "OWNER");
    expect(Array.isArray(body?.rows)).toBe(true);
    expect(body.rows.length).toBeGreaterThan(0);
    for (const row of body.rows) {
      // Sorted comparison: an export that quietly grows a field is as much a
      // drift as one that quietly loses one.
      expect(Object.keys(row).sort()).toEqual([...AUDIT_EXPORT_FIELDS].sort());
    }
  });

  it("carries the four fields the roadmap names, with values", async () => {
    const { body } = await get("/api/v1/audit/export", "OWNER");
    const row = body.rows[0];
    expect(row.actor).toBe("u-1");
    expect(row.action).toBe("company.delete");
    expect(row.result).toBe("denied");
    expect(row.policy).toBe("company:delete");
  });

  it("bounds the page size, and does not let the caller remove the bound", async () => {
    const { AUDIT_MAX_PAGE } = await import("../router");
    queries.length = 0;
    const { body } = await get("/api/v1/audit/export?limit=999999", "OWNER");
    for (const q of queries) {
      expect(typeof q?.take).toBe("number");
      // +1 is the sentinel row used to detect a next page without a COUNT
      // over a table growing ~180M rows/year. The bound that matters to the
      // caller is the size of the page they actually receive.
      expect(q.take).toBeLessThanOrEqual(AUDIT_MAX_PAGE + 1);
    }
    expect(body.rows.length).toBeLessThanOrEqual(AUDIT_MAX_PAGE);
  });
});

describe("audit export refuses bad input instead of reinterpreting it", () => {
  it("rejects a cursor belonging to another tenant", async () => {
    // Proven by review against a real database: Prisma's cursor sub-select is
    // NOT tenant-filtered, so returning 200 made the row count a monotone
    // oracle for a foreign row's timestamp. RLS does not cover this — the
    // production role still holds BYPASSRLS until STAGE 2.
    const { status } = await get("/api/v1/audit/export?cursor=B9", "OWNER");
    expect(status).toBe(400);
  });

  it("rejects an unknown cursor rather than returning an empty page", async () => {
    expect((await get("/api/v1/audit/export?cursor=nope", "OWNER")).status).toBe(400);
  });

  it("accepts a cursor from the caller's own tenant", async () => {
    expect((await get("/api/v1/audit/export?cursor=A1", "OWNER")).status).toBe(200);
  });

  it("pages by keyset, never by a blind OFFSET", async () => {
    // `skip: 1` drops a real row whenever the cursor row is not in the
    // filtered set — a narrowed filter, or the row aged out under retention.
    // A quietly-short audit trail is the one failure an audit artifact must
    // not have.
    queries.length = 0;
    await get("/api/v1/audit/export?cursor=A1", "OWNER");
    const page = queries.find((q) => q?.take);
    expect(page.skip, "keyset paging must not use skip").toBeUndefined();
    expect(page.cursor, "keyset paging must not use prisma cursor").toBeUndefined();
    expect(Array.isArray(page.where?.OR), "expected an explicit (createdAt, id) keyset predicate").toBe(true);
  });

  it("refuses an unparseable date rather than silently ignoring the filter", async () => {
    // An auditor who typos a date must not receive the whole table and read
    // it as "this is what happened in that window".
    for (const q of ["from=garbage", "from=2026-13-45", "to=%00"]) {
      expect((await get(`/api/v1/audit/export?${q}`, "OWNER")).status, q).toBe(400);
    }
  });

  it("refuses a malformed limit rather than reinterpreting it", async () => {
    for (const q of ["limit=abc", "limit=-1", "limit=0", "limit=1e9"]) {
      expect((await get(`/api/v1/audit/export?${q}`, "OWNER")).status, q).toBe(400);
    }
  });

  it("refuses a non-scalar filter", async () => {
    expect((await get("/api/v1/audit/export?result[gt]=x", "OWNER")).status).toBe(400);
    expect((await get("/api/v1/audit/export?actor[not]=y", "OWNER")).status).toBe(400);
  });

  it("refuses a non-scalar DATE too — the shape that slipped through", async () => {
    // parseInstant returned undefined for non-strings while parseScalar threw,
    // so array/object date shapes silently discarded the filter and returned
    // the whole table: exactly what the parser's own comment forbids.
    for (const q of ["from[]=a&from[]=b", "to[]=z", "to[x][y]=1"]) {
      expect((await get(`/api/v1/audit/export?${q}`, "OWNER")).status, q).toBe(400);
    }
  });
});

describe("the export appears in the trail it exports", () => {
  it("records itself, with a real result and policy", async () => {
    created.length = 0;
    await get("/api/v1/audit/export", "OWNER");
    expect(created.length, "draining the audit log must leave a trace in it").toBe(1);
    const row = created[0].data;
    expect(row.action).toBe("audit.export");
    expect(row.result).toBe("allowed");
    expect(row.policy).toBe("audit:export");
    expect(row.tenantId).toBe("t1");
  });

  it("refuses an over-long filter value", async () => {
    // The previous version of the assertion below was a TAUTOLOGY: it sent
    // `actor=u-1` and then checked the recorded value was under 64 chars,
    // proving only that 4 characters stay 4 characters. The blob never
    // reached the assertion. A length check is a length check only if the
    // test supplies something long — review wrote 1671 bytes into the trail
    // with the suite green.
    const long = "P".repeat(800);
    expect((await get(`/api/v1/audit/export?actor=${long}`, "OWNER")).status).toBe(400);
    expect((await get(`/api/v1/audit/export?result=${long}`, "OWNER")).status).toBe(400);
    expect((await get(`/api/v1/audit/export?from=${long}`, "OWNER")).status).toBe(400);
  });

  it("refuses a date that is valid to JS but not to the database", async () => {
    // JS max/min Date: Number.isNaN passes, Postgres rejects, so these
    // reached the query and came back 500 with a raw Prisma error in the body.
    for (const q of ["from=%2B275760-09-13T00:00:00.000Z", "from=-271821-04-20T00:00:00.000Z"]) {
      expect((await get(`/api/v1/audit/export?${q}`, "OWNER")).status, q).toBe(400);
    }
  });

  it("refuses a bare numeric rather than reinterpreting it as a year", async () => {
    // `?from=0` silently became 1999-12-31 and `?from=1` became 2000-12-31:
    // real dates, so nothing errored, but not the filter the caller asked for.
    for (const q of ["from=0", "from=1", "from=1970", "from=10000-01-01"]) {
      expect((await get(`/api/v1/audit/export?${q}`, "OWNER")).status, q).toBe(400);
    }
    // Legitimate forms still pass.
    for (const q of ["from=2026-08-20", "from=2026-08-20T00:00:00.000Z"]) {
      expect((await get(`/api/v1/audit/export?${q}`, "OWNER")).status, q).toBe(200);
    }
  });

  it("records only PARSED filter values, never raw caller input", async () => {
    // The raw query was the one input that had not been validated, and it was
    // being written straight into the trail — review pushed a 1282-byte
    // attacker-chosen blob through it against rows that normally run ~80.
    created.length = 0;
    await get("/api/v1/audit/export?from=2026-08-01T00:00:00Z&actor=u-1", "OWNER");
    const filters = created[0].data.details.filters;
    expect(filters.from).toBe(new Date("2026-08-01T00:00:00Z").toISOString());
    expect(filters.actor).toBe("u-1");
    // Bound asserted against the LONGEST value the endpoint will accept,
    // not against a short fixture — see the tautology note above.
    for (const v of Object.values(filters)) {
      expect(v === null || typeof v === "string").toBe(true);
      if (typeof v === "string") expect(v.length).toBeLessThanOrEqual(200);
    }
  });

  it("records where the export came from, not just who ran it", async () => {
    created.length = 0;
    await get("/api/v1/audit/export", "OWNER");
    expect(Object.prototype.hasOwnProperty.call(created[0].data, "ip")).toBe(true);
  });

  it("states its own coverage, so NULL is not mistaken for 'allowed'", async () => {
    const { body } = await get("/api/v1/audit/export", "OWNER");
    expect(Object.prototype.hasOwnProperty.call(body, "resultCoverageSince")).toBe(true);
  });
});
