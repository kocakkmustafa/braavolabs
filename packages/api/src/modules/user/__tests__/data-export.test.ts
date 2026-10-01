import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Portability export (BR-P1-005 #4, roadmap §7.4 "Retention/delete/export").
 *
 * WHAT WAS MEASURED BEFORE WRITING THIS
 *
 *   - `DELETE /user/me` exists and really erases (it even records the request
 *     with `actor: "system"` so the row survives the cascade).
 *   - There is NO export endpoint. `gdpr/page.tsx` tells the data subject
 *     they have the right to "port your data", and the only way to exercise
 *     it is to email a mailbox.
 *
 * The claimed-but-unimplemented right is the gap. The risk on the way to
 * closing it is the OPPOSITE of the audit export's: there the danger was
 * showing too little; here it is showing too MUCH. `User` carries
 * `passwordHash`, `emailVerifyTokenHash` and `passwordResetTokenHash`, and a
 * portability file is something the subject downloads, stores and forwards.
 */

const SCHEMA = readFileSync(
  join(__dirname, "..", "..", "..", "..", "..", "db", "prisma", "schema.prisma"),
  "utf8",
);

/** Declared model names — a relation ARRAY has no @relation on its own line. */
function modelNames(): Set<string> {
  return new Set([...SCHEMA.matchAll(/^\s*model\s+(\w+)\s*\{/gm)].map((m) => m[1]));
}

/**
 * Scalar columns, and it FAILS on a line it cannot classify.
 *
 * An earlier version skipped them, so an uppercase-initial field name — which
 * Prisma permits — passed the completeness check silently. The allowlist
 * meant such a column was withheld rather than leaked, so it was gate
 * integrity rather than a leak; but the file's claim is that every column is
 * accounted for, and it was not.
 */
function scalarFields(model: string): string[] {
  const m = SCHEMA.match(new RegExp(`model\\s+${model}\\s*\\{([\\s\\S]*?)\\n\\}`));
  expect(m, `model ${model} not found`).toBeTruthy();
  const out: string[] = [];
  for (const raw of m![1].split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("//") || line.startsWith("@@") || line.startsWith("@")) continue;
    const [name, type] = line.split(/\s+/);
    if (!/^[A-Za-z_]\w*$/.test(name) || !type) {
      throw new Error(`User: cannot classify ${JSON.stringify(line)} — refusing to skip it`);
    }
    const base = type.replace(/[\[\]?]/g, "");
    if (/^(String|Int|Float|Boolean|DateTime|Json|Bytes|Decimal|BigInt)$/.test(base)) out.push(name);
    else if (/^[A-Z]/.test(base) && !line.includes("@relation") && !modelNames().has(base)) {
      out.push(name); // an enum column
    }
  }
  return out;
}

const SECRET_SHAPED = /hash|token|secret|password/i;
const SECRET = "data-export-test-secret-at-least-32-chars";
const created: any[] = [];
let server: http.Server;
let baseUrl: string;
let token = "";

vi.mock("../../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../../middleware/rateLimit", () => ({ rateLimit: () => (_q: any, _s: any, n: any) => n() }));
vi.mock("../../../lib/db", () => ({
  prisma: {
    user: {
      // Returns SECRETS TOO, deliberately: if the router forgets to project,
      // the test must see them rather than be protected by a fixture that
      // never had them. A double that cannot fail proves nothing.
      findUnique: async () => ({
        id: "u-1", tenantId: "t1", email: "a@b.c", name: "A", avatarUrl: null, role: "MEMBER",
        passwordHash: "SHOULD-NEVER-APPEAR", emailVerifyTokenHash: "SHOULD-NEVER-APPEAR",
        googleId: null, githubId: null, appleId: null, emailVerifiedAt: null, aiConsentAt: null,
        createdAt: new Date("2026-01-01"), updatedAt: new Date("2026-01-02"),
      }),
      update: async () => ({}),
      delete: async () => ({}),
    },
    device: {
      findMany: async () => [{
        id: "d1", platform: "ios", deviceName: "phone", lastSeenAt: new Date(),
        createdAt: new Date(), pushToken: "SHOULD-NEVER-APPEAR",
      }],
    },
    notificationPref: {
      // Carries the columns the REAL row carries. The earlier fixture returned
      // exactly the four exported fields, so a raw passthrough produced an
      // identical key set and the projection assertion could not fail — a
      // decorative double sitting beside two (user, device) that plant
      // SHOULD-NEVER-APPEAR and genuinely can.
      findUnique: async () => ({
        id: "np-1", userId: "u-1", approvals: true, risks: true, runs: false, drafts: false,
        createdAt: new Date("2026-01-01"), updatedAt: new Date("2026-01-02"),
      }),
    },
    activityLog: {
      // Applies the `actor` predicate, like the real query. A double that
      // returns the same row whatever it is asked cannot tell "my activity"
      // from "everyone in the tenant" — which is precisely the leak.
      findMany: async (args: any) => {
        const rows = [
          { id: "a1", action: "company.create", resource: "company", resourceId: null, createdAt: new Date(), actor: "u-1" },
          { id: "a2", action: "company.delete", resource: "company", resourceId: null, createdAt: new Date(), actor: "SOMEONE-ELSE" },
        ];
        return rows
          .filter((r) => !args?.where?.actor || r.actor === args.where.actor)
          .map(({ actor, ...rest }) => rest);
      },
      create: async (a: any) => { created.push(a); return { id: "x" }; },
    },
  },
  tenantTx: (fn: any) => fn({}),
}));
vi.mock("../../../config/env", () => ({
  env: { JWT_SECRET: SECRET, AUTH_COOKIE_MODE: false, NODE_ENV: "test" },
}));

beforeAll(async () => {
  const jwt = (await import("jsonwebtoken")).default;
  token = jwt.sign({ userId: "u-1", tenantId: "t1", role: "MEMBER" }, SECRET, { expiresIn: "1h" });
  const { userRouter } = await import("../user.router");
  const app = express();
  app.use(express.json());
  app.use("/api/v1/users", userRouter);
  app.use((err: any, _q: any, res: any, _n: any) =>
    res.status(err?.statusCode ?? 500).json({ error: err?.message ?? "error" }));
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 30_000);

afterAll(() => new Promise<void>((r) => server.close(() => r())));

async function get(path: string, auth = true) {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: auth ? { Authorization: `Bearer ${token}` } : {},
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe("GET /user/me/export (BR-P1-005 #4)", () => {
  it("refuses an unauthenticated caller", async () => {
    expect((await get("/api/v1/users/me/export", false)).status).toBe(401);
  });

  it("returns the subject's own data", async () => {
    const { body, status } = await get("/api/v1/users/me/export");
    expect(status).toBe(200);
    expect(body.account.email).toBe("a@b.c");
    expect(Array.isArray(body.devices)).toBe(true);
    expect(body.notificationPreferences).toBeTruthy();
    expect(Array.isArray(body.activity)).toBe(true);
  });

  it("NEVER emits a credential, however deeply nested", async () => {
    const { body } = await get("/api/v1/users/me/export");
    expect(JSON.stringify(body)).not.toContain("SHOULD-NEVER-APPEAR");
    for (const key of Object.keys(body.account)) {
      expect(SECRET_SHAPED.test(key), `account.${key} is credential-shaped`).toBe(false);
    }
  });

  it("accounts for every User column — exported, or excluded with a reason", async () => {
    const { USER_EXPORT_FIELDS, USER_EXPORT_OMITTED } = await import("../data-export");
    const declared = new Set<string>([...USER_EXPORT_FIELDS, ...Object.keys(USER_EXPORT_OMITTED)]);
    const missing = scalarFields("User").filter((f) => !declared.has(f));
    expect(missing, `User columns neither exported nor omitted: ${missing.join(", ")}`).toEqual([]);
  });

  it("refuses a silent omission, and never exports a credential-shaped column", async () => {
    const { USER_EXPORT_FIELDS, USER_EXPORT_OMITTED } = await import("../data-export");
    for (const [f, why] of Object.entries(USER_EXPORT_OMITTED)) {
      expect(typeof why === "string" && why.trim().length > 10, `omission of ${f} needs a reason`).toBe(true);
    }
    for (const f of USER_EXPORT_FIELDS) {
      expect(SECRET_SHAPED.test(f), `${f} is credential-shaped and must not be exported`).toBe(false);
    }
  });

  it("carries only the SUBJECT's own activity, not the whole tenant's", async () => {
    // Dropping `actor` from the query turns a personal-data export into a
    // window onto colleagues' actions. Nothing in the response shape shows
    // it — the rows look identical — so this asserts the CONTENT.
    const { body } = await get("/api/v1/users/me/export");
    expect(body.activity.map((a: any) => a.id)).toEqual(["a1"]);
  });

  it("records the export in the audit trail", async () => {
    created.length = 0;
    await get("/api/v1/users/me/export");
    expect(created.length, "a bulk personal-data read must leave a trace").toBe(1);
    expect(created[0].data.action).toBe("user.data_export");
    expect(created[0].data.result).toBe("allowed");
  });
});

describe("the artifact speaks to the subject, not to us", () => {
  it("never makes a blanket compliance or completeness claim", async () => {
    // Roadmap §7.4 forbids a general "GDPR compliant" claim, and a
    // portability file saying "this is ALL your data" is the same overclaim
    // in the same breath. Anchored to the literal phrases, which is a
    // behaviour anchor rather than a paraphrase a reviewer could argue with.
    const { body } = await get("/api/v1/users/me/export");
    const text = JSON.stringify(body.scope).toLowerCase();
    for (const forbidden of ["gdpr compliant", "all personal data", "complete record", "everything we hold"]) {
      expect(text, `scope must not claim "${forbidden}"`).not.toContain(forbidden);
    }
  });

  it("tells the subject what was withheld, in the file", async () => {
    // Pointing them at a source file in a private repo is not a disclosure.
    const { body } = await get("/api/v1/users/me/export");
    expect(Object.keys(body.scope.withheldFields).length).toBeGreaterThan(3);
    for (const reason of Object.values(body.scope.withheldFields)) {
      expect(typeof reason === "string" && (reason as string).length > 10).toBe(true);
    }
    expect(body.scope.notIncluded).toContain("truncated");
  });

  it("projects notification preferences through the same allowlist", async () => {
    const { body } = await get("/api/v1/users/me/export");
    const { NOTIFICATION_PREF_EXPORT_FIELDS } = await import("../data-export");
    expect(Object.keys(body.notificationPreferences).sort()).toEqual(
      [...NOTIFICATION_PREF_EXPORT_FIELDS].sort(),
    );
  });
});
