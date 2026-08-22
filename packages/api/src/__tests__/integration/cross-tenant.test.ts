/**
 * BR-P0-004 slice 4 — two-way adversarial cross-tenant matrix.
 *
 * The roadmap requires proving zero leakage in BOTH directions across CRUD,
 * search, run, audit and billing routes. The RLS-STAGE2 runbook asserts the
 * app-layer `where tenantId` is already "airtight"; this is the test that
 * refuses to take that on faith.
 *
 * It runs against a REAL Postgres with the real schema, the real routers and
 * real HS256 tokens for two tenants — not mocks. RLS itself is still a NO-OP
 * here (STAGE2 is founder-gated and unactivated in production too), which is
 * precisely why this matters: today the application layer is the ONLY
 * isolation boundary, so it is the layer that has to be proven.
 *
 * Skips itself when no probe database is configured, so the normal unit suite
 * is unaffected.
 *
 * HOW TO RUN:
 *
 *   createdb aicos_xtenant
 *   psql -d aicos_xtenant -c 'CREATE EXTENSION IF NOT EXISTS vector;'
 *   DATABASE_URL=postgresql://$USER@localhost:5432/aicos_xtenant \
 *     pnpm --filter @ai-company-os/db exec prisma db push --skip-generate
 *   XTENANT_DATABASE_URL=postgresql://$USER@localhost:5432/aicos_xtenant \
 *     pnpm --filter @ai-company-os/api test:xtenant
 *   dropdb aicos_xtenant
 *
 * Use a THROWAWAY database. The suite writes tenants, users, companies,
 * pipelines, runs and activity rows, and does not clean up after itself —
 * pointing it at a real database would pollute it.
 *
 * The suite is only meaningful if it can FAIL. Verified by mutation: removing
 * `tenantId` from the `where` in companyRouter GET /:id turns exactly the two
 * READ cases red, in both directions. The CONTROL case at the end guards the
 * other way — it asserts each tenant CAN reach its own company, so a green run
 * can never mean "every request happened to fail for an unrelated reason".
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { PrismaClient } from "@prisma/client";
import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROBE_URL = process.env.XTENANT_DATABASE_URL;
const d = PROBE_URL ? describe : describe.skip;

/**
 * The gate needs a gate.
 *
 * `describe.skip` is right for a laptop — nobody should need a database to run
 * `pnpm test`. But vitest exits 0 when everything skips, so a CI step that runs
 * this suite is GREEN whether the matrix executed or not. That is exactly how
 * these 15 tests sat skipped in every CI run while appearing to pass. One typo
 * in the env var name, or one change to the service container, and the silence
 * returns with no signal.
 *
 * This test is deliberately NOT inside the skipped describe.
 */
it("the isolation matrix must actually run in CI", () => {
  if (process.env.CI) {
    expect(PROBE_URL, "XTENANT_DATABASE_URL is unset in CI — the cross-tenant matrix would silently skip").toBeTruthy();
  }
});

it("keeps the Stage 2 handoff fail-closed, explicit and unapplied", () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../");
  const compose = readFileSync(resolve(repoRoot, "ENV/compose.prod.yaml"), "utf8");
  const runbook = readFileSync(
    resolve(repoRoot, "docs/security/tenant-rls-stage2-runbook.md"),
    "utf8",
  );

  expect(compose).toMatch(/TENANT_CONTEXT_FAIL_CLOSED:\s*\$\{TENANT_CONTEXT_FAIL_CLOSED:-true\}/);
  expect(compose).toMatch(/DATABASE_URL:\s*\$\{RUNTIME_DATABASE_URL:-postgresql:\/\/aicos:/);
  expect(runbook).toMatch(/MANUAL-BRAAVO-SECURITY-ROOTS/);
  expect(runbook).toMatch(/rolsuper\s*=\s*false/i);
  expect(runbook).toMatch(/rolbypassrls\s*=\s*false/i);
  expect(runbook).toMatch(/pg_get_userbyid\(n\.nspowner\)\s+AS\s+schema_owner/i);
  expect(runbook).toMatch(
    /has_schema_privilege\(\s*'aicos_app'\s*,\s*'public'\s*,\s*'CREATE'\s*\)\s+AS\s+aicos_app_can_create/i,
  );
  expect(runbook).toMatch(/aicos_app_can_create\s*=\s*false/i);
  expect(runbook).toContain("REVOKE CREATE ON SCHEMA public FROM PUBLIC;");
  expect(runbook).toContain("REVOKE CREATE ON SCHEMA public FROM aicos_app;");
  expect(runbook).toMatch(/recorded privilege snapshot/i);
  expect(runbook).toMatch(/do not.*blind.*GRANT CREATE/is);
  expect(runbook).toMatch(/TENANT_CONTEXT_FAIL_CLOSED=true/);
  expect(runbook).toMatch(/rollback/i);
  expect(runbook).toMatch(/must not be treated\s+as production proof/i);
});

const SECRET = "xtenant-probe-secret-at-least-32-chars-long";
process.env.DATABASE_URL = PROBE_URL ?? "";
process.env.JWT_SECRET = SECRET;
process.env.ENCRYPTION_KEY = "0".repeat(32);
process.env.NODE_ENV = "test";

interface Seed {
  tenantId: string;
  userId: string;
  companyId: string;
  runId: string;
  contactId: string;
  token: string;
}

d("cross-tenant isolation (real Postgres, real routers)", () => {
  let server: http.Server;
  let baseUrl: string;
  let db: PrismaClient;
  let A: Seed;
  let B: Seed;

  async function seedTenant(label: string): Promise<Seed> {
    const tenantId = randomUUID();
    const plan = label === "alpha" ? "INDIVIDUAL" : "TEAM";
    await db.tenant.create({
      data: { id: tenantId, name: `T-${label}`, slug: `t-${label}-${tenantId.slice(0, 8)}`, plan },
    });
    const user = await db.user.create({
      data: {
        id: randomUUID(), tenantId, email: `${label}-${tenantId.slice(0, 8)}@probe.test`,
        passwordHash: "x", name: `U-${label}`, role: "OWNER",
      },
    });
    const company = await db.company.create({
      data: { id: randomUUID(), tenantId, name: `Co-${label}`, slug: `co-${label}-${tenantId.slice(0, 8)}`, status: "ACTIVE" },
    });
    const pipeline = await db.pipeline.create({
      data: { id: randomUUID(), companyId: company.id, name: `P-${label}`, trigger: "MANUAL", steps: [] as any },
    });
    const run = await db.run.create({
      data: { id: randomUUID(), pipelineId: pipeline.id, status: "COMPLETED" },
    });
    const contact = await db.contact.create({
      data: {
        id: randomUUID(),
        companyId: company.id,
        email: `secret-${label}@probe.test`,
        name: `secret-contact-${label}`,
      },
    });
    // ActivityLog has no companyId — it is tenant-scoped with a free-form
    // resource/resourceId pair (see schema.prisma).
    await db.activityLog.create({
      data: {
        id: randomUUID(), tenantId, actor: `actor-${label}`,
        action: `secret-action-${label}`, resource: "company", resourceId: company.id,
      },
    });
    const now = new Date();
    const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    await db.usageMeter.create({
      data: {
        tenantId,
        metric: `own-meter-${label}`,
        value: label === "alpha" ? 11 : 22,
        periodStart,
        periodEnd,
      },
    });

    return {
      tenantId, userId: user.id, companyId: company.id, runId: run.id,
      contactId: contact.id,
      token: jwt.sign({ userId: user.id, tenantId, role: "OWNER" }, SECRET, { expiresIn: "1h" }),
    };
  }

  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url: PROBE_URL! } } });
    await db.$connect();
    A = await seedTenant("alpha");
    B = await seedTenant("bravo");

    const { companyRouter } = await import("../../modules/company/router");
    const { runRouter } = await import("../../modules/run/router");
    const { dashboardRouter } = await import("../../modules/dashboard/router");
    const { billingRouter } = await import("../../modules/billing/router");
    const { crmRouter } = await import("../../modules/crm/router");

    const app = express();
    app.use(express.json());
    const api = express.Router();
    api.use("/companies", companyRouter);
    api.use("/runs", runRouter);
    api.use("/dashboard", dashboardRouter);
    api.use("/billing", billingRouter);
    api.use("/crm", crmRouter);
    app.use("/api/v1", api);
    app.use((err: any, _q: any, res: any, _n: any) =>
      res.status(err?.statusCode ?? err?.status ?? 500).json({ error: err?.message ?? "error" }));

    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 60_000);

  afterAll(async () => {
    if (server) await new Promise<void>((r) => server.close(() => r()));
    if (db) await db.$disconnect();
  });

  async function req(method: string, path: string, token: string, body?: unknown) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
  }

  /** A response must never contain the other tenant's identifiers or secrets. */
  function assertNoLeak(text: string, victim: Seed, label: string) {
    for (const [what, needle] of [
      ["tenantId", victim.tenantId],
      ["companyId", victim.companyId],
      ["runId", victim.runId],
      ["contactId", victim.contactId],
      ["userId", victim.userId],
    ] as const) {
      expect(text.includes(needle), `${label}: response leaked the other tenant's ${what}`).toBe(false);
    }
  }

  type BillingMeterSnapshot = { metric: string; value: number };

  function canonicalBillingMeters(value: unknown, label: string): BillingMeterSnapshot[] {
    expect(Array.isArray(value), `${label}: meters must be an array`).toBe(true);
    return (value as unknown[])
      .map((meter, index) => {
        expect(meter, `${label}: meter ${index} must be an object`).toBeTypeOf("object");
        const candidate = meter as Partial<BillingMeterSnapshot>;
        expect(candidate.metric, `${label}: meter ${index} metric`).toBeTypeOf("string");
        expect(candidate.value, `${label}: meter ${index} value`).toBeTypeOf("number");
        return { metric: candidate.metric!, value: candidate.value! };
      })
      .sort((left, right) => left.metric.localeCompare(right.metric) || left.value - right.value);
  }

  function assertExactOwnBillingMeters(
    value: unknown,
    own: BillingMeterSnapshot,
    victim: BillingMeterSnapshot,
    label: string,
  ) {
    const actual = canonicalBillingMeters(value, label);
    const expected = [own].sort(
      (left, right) => left.metric.localeCompare(right.metric) || left.value - right.value,
    );
    expect(actual, `${label}: extra, duplicate or victim meters are forbidden`).toEqual(expected);
    expect(
      actual.some((meter) => meter.metric === victim.metric && meter.value === victim.value),
      `${label}: victim meter marker ${victim.metric}/${victim.value} leaked`,
    ).toBe(false);
  }

  // ── Positive controls run first: a broken/empty/404 endpoint must fail ────
  it("CONTROL: each tenant can reach its OWN company", async () => {
    const a = await req("GET", `/api/v1/companies/${A.companyId}`, A.token);
    const b = await req("GET", `/api/v1/companies/${B.companyId}`, B.token);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.text).toContain(A.companyId);
    expect(b.text).toContain(B.companyId);
  });

  it.each([
    ["A", () => A, "alpha"],
    ["B", () => B, "bravo"],
  ])("CONTROL: %s can PATCH and DELETE its own disposable company", async (_dir, tenant, label) => {
    const me = tenant();
    const disposable = await db.company.create({
      data: {
        id: randomUUID(),
        tenantId: me.tenantId,
        name: `Disposable-${label}`,
        slug: `disposable-${label}-${randomUUID().slice(0, 8)}`,
        status: "ACTIVE",
      },
    });

    const patchedName = `Disposable-${label}-patched`;
    const patched = await req(
      "PATCH",
      `/api/v1/companies/${disposable.id}`,
      me.token,
      { name: patchedName },
    );
    expect(patched.status).toBe(200);
    expect((await db.company.findUnique({ where: { id: disposable.id } }))?.name).toBe(patchedName);

    const deleted = await req("DELETE", `/api/v1/companies/${disposable.id}`, me.token);
    expect(deleted.status).toBe(200);
    expect(deleted.json).toMatchObject({ success: true, status: "ARCHIVED" });
    expect((await db.company.findUnique({ where: { id: disposable.id } }))?.status).toBe("ARCHIVED");
  });

  it.each([
    ["A", () => A, "alpha"],
    ["B", () => B, "bravo"],
  ])("CONTROL: %s can search its own CRM corpus", async (_dir, tenant, label) => {
    const me = tenant();
    const r = await req(
      "GET",
      `/api/v1/crm/contacts?companyId=${encodeURIComponent(me.companyId)}&search=${encodeURIComponent(`secret-contact-${label}`)}`,
      me.token,
    );
    expect(r.status).toBe(200);
    expect(r.text).toContain(me.contactId);
  });

  it.each([
    ["A", () => A],
    ["B", () => B],
  ])("CONTROL: %s can read its own run marker", async (_dir, tenant) => {
    const me = tenant();
    const r = await req("GET", `/api/v1/runs/${me.runId}`, me.token);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      id: me.runId,
      pipeline: { company: { id: me.companyId, tenantId: me.tenantId } },
    });
  });

  it.each([
    ["A", () => A, "secret-action-alpha"],
    ["B", () => B, "secret-action-bravo"],
  ])("CONTROL: %s can read its own audit action", async (_dir, tenant, action) => {
    const me = tenant();
    const r = await req("GET", "/api/v1/dashboard/activity", me.token);
    expect(r.status).toBe(200);
    expect(r.json?.logs).toEqual(expect.arrayContaining([expect.objectContaining({ action })]));
  });

  it.each([
    ["A", () => A, "INDIVIDUAL", "own-meter-alpha", 11, "own-meter-bravo", 22],
    ["B", () => B, "TEAM", "own-meter-bravo", 22, "own-meter-alpha", 11],
  ])(
    "CONTROL: %s receives status 200 and its own billing plan/run/meter shape",
    async (_dir, tenant, plan, metric, value, victimMetric, victimValue) => {
      const me = tenant();
      const r = await req("GET", "/api/v1/billing/usage", me.token);
      expect(r.status).toBe(200);
      expect(r.json).toMatchObject({ plan, live: { runs: 1, toolCalls: 0 } });
      assertExactOwnBillingMeters(
        r.json?.meters,
        { metric, value },
        { metric: victimMetric, value: victimValue },
        `${_dir} own billing`,
      );
    },
  );

  // ── CRUD: read, mutate and delete the OTHER tenant's company ───────────────
  it.each([
    ["A→B", () => A, () => B],
    ["B→A", () => B, () => A],
  ])("%s cannot READ the other tenant's company", async (_dir, attacker, victim) => {
    const me = attacker(), them = victim();
    const r = await req("GET", `/api/v1/companies/${them.companyId}`, me.token);
    expect(r.status).not.toBe(200);
    assertNoLeak(r.text, them, "GET /companies/:id");
  });

  it.each([
    ["A→B", () => A, () => B],
    ["B→A", () => B, () => A],
  ])("%s cannot MUTATE the other tenant's company", async (_dir, attacker, victim) => {
    const me = attacker(), them = victim();
    const before = await db.company.findUnique({ where: { id: them.companyId } });
    const r = await req("PATCH", `/api/v1/companies/${them.companyId}`, me.token, { name: "PWNED" });
    expect(r.status).not.toBe(200);
    const after = await db.company.findUnique({ where: { id: them.companyId } });
    // The decisive check: the victim's row is byte-identical afterwards.
    expect(after?.name).toBe(before?.name);
    expect(after?.name).not.toBe("PWNED");
  });

  it.each([
    ["A→B", () => A, () => B],
    ["B→A", () => B, () => A],
  ])("%s cannot DELETE the other tenant's company", async (_dir, attacker, victim) => {
    const me = attacker(), them = victim();
    const r = await req("DELETE", `/api/v1/companies/${them.companyId}`, me.token);
    expect(r.status).not.toBe(200);
    expect(await db.company.findUnique({ where: { id: them.companyId } })).not.toBeNull();
  });

  // ── LIST: the other tenant must not appear in a collection response ────────
  it.each([
    ["A", () => A, () => B],
    ["B", () => B, () => A],
  ])("%s's company list contains only its own rows", async (_dir, attacker, victim) => {
    const me = attacker(), them = victim();
    const r = await req("GET", "/api/v1/companies", me.token);
    expect(r.status).toBe(200);
    expect(r.text).toContain(me.companyId);
    assertNoLeak(r.text, them, "GET /companies");
  });

  // ── SEARCH: both the company boundary and search results stay tenant scoped
  it.each([
    ["A→B", () => A, () => B],
    ["B→A", () => B, () => A],
  ])("%s cannot search the other tenant's CRM corpus", async (_dir, attacker, victim) => {
    const me = attacker(), them = victim();
    const victimCompany = await req(
      "GET",
      `/api/v1/crm/contacts?companyId=${encodeURIComponent(them.companyId)}&search=secret`,
      me.token,
    );
    expect(victimCompany.status).toBe(404);
    assertNoLeak(victimCompany.text, them, "GET /crm/contacts victim company");

    const ownCompanyVictimNeedle = await req(
      "GET",
      `/api/v1/crm/contacts?companyId=${encodeURIComponent(me.companyId)}&search=${encodeURIComponent(`secret-contact-${them === B ? "bravo" : "alpha"}`)}`,
      me.token,
    );
    expect(ownCompanyVictimNeedle.status).toBe(200);
    assertNoLeak(ownCompanyVictimNeedle.text, them, "GET /crm/contacts victim search term");
  });

  // ── RUN ───────────────────────────────────────────────────────────────────
  it.each([
    ["A→B", () => A, () => B],
    ["B→A", () => B, () => A],
  ])("%s cannot read the other tenant's run", async (_dir, attacker, victim) => {
    const me = attacker(), them = victim();
    const r = await req("GET", `/api/v1/runs/${them.runId}`, me.token);
    expect(r.status).not.toBe(200);
    assertNoLeak(r.text, them, "GET /runs/:id");
  });

  // ── AUDIT / activity ──────────────────────────────────────────────────────
  it.each([
    ["A", () => A, () => B],
    ["B", () => B, () => A],
  ])("%s's activity feed excludes the other tenant", async (_dir, attacker, victim) => {
    const me = attacker(), them = victim();
    const r = await req("GET", "/api/v1/dashboard/activity", me.token);
    expect(r.status).toBe(200);
    assertNoLeak(r.text, them, "GET /dashboard/activity");
    const other = them === B ? "secret-action-bravo" : "secret-action-alpha";
    expect(r.text.includes(other), "activity feed leaked the other tenant's action").toBe(false);
  });

  // ── BILLING ───────────────────────────────────────────────────────────────
  it.each([
    ["A", () => A, () => B],
    ["B", () => B, () => A],
  ])("%s's billing usage excludes the other tenant", async (_dir, attacker, victim) => {
    const me = attacker(), them = victim();
    const r = await req(
      "GET",
      `/api/v1/billing/usage?tenantId=${encodeURIComponent(them.tenantId)}`,
      me.token,
    );
    const ownBilling = me === A
      ? { plan: "INDIVIDUAL", metric: "own-meter-alpha", value: 11 }
      : { plan: "TEAM", metric: "own-meter-bravo", value: 22 };
    const victimBilling = me === A
      ? { metric: "own-meter-bravo", value: 22 }
      : { metric: "own-meter-alpha", value: 11 };
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      plan: ownBilling.plan,
      live: { runs: 1, toolCalls: 0 },
    });
    assertExactOwnBillingMeters(
      r.json?.meters,
      { metric: ownBilling.metric, value: ownBilling.value },
      victimBilling,
      `${_dir} forged billing tenantId`,
    );
    assertNoLeak(r.text, them, "GET /billing/usage");
  });

});
