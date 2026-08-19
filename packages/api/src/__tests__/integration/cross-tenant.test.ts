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

const PROBE_URL = process.env.XTENANT_DATABASE_URL;
const d = PROBE_URL ? describe : describe.skip;

const SECRET = "xtenant-probe-secret-at-least-32-chars-long";
process.env.DATABASE_URL = PROBE_URL ?? "";
process.env.JWT_SECRET = SECRET;
process.env.ENCRYPTION_KEY = "0".repeat(32);
process.env.NODE_ENV = "test";

interface Seed { tenantId: string; userId: string; companyId: string; runId: string; token: string }

d("cross-tenant isolation (real Postgres, real routers)", () => {
  let server: http.Server;
  let baseUrl: string;
  let db: PrismaClient;
  let A: Seed;
  let B: Seed;

  async function seedTenant(label: string): Promise<Seed> {
    const tenantId = randomUUID();
    await db.tenant.create({
      data: { id: tenantId, name: `T-${label}`, slug: `t-${label}-${tenantId.slice(0, 8)}`, plan: "PRO" },
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
    // ActivityLog has no companyId — it is tenant-scoped with a free-form
    // resource/resourceId pair (see schema.prisma).
    await db.activityLog.create({
      data: {
        id: randomUUID(), tenantId, actor: `actor-${label}`,
        action: `secret-action-${label}`, resource: "company", resourceId: company.id,
      },
    });

    return {
      tenantId, userId: user.id, companyId: company.id, runId: run.id,
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

    const app = express();
    app.use(express.json());
    const api = express.Router();
    api.use("/companies", companyRouter);
    api.use("/runs", runRouter);
    api.use("/dashboard", dashboardRouter);
    api.use("/billing", billingRouter);
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
      ["userId", victim.userId],
    ] as const) {
      expect(text.includes(needle), `${label}: response leaked the other tenant's ${what}`).toBe(false);
    }
  }

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
    const r = await req("GET", "/api/v1/billing/usage", me.token);
    expect([200, 404]).toContain(r.status);
    assertNoLeak(r.text, them, "GET /billing/usage");
  });

  // ── The control: the harness can actually SEE data, so a green run is not
  //    green merely because every request failed for an unrelated reason. ────
  it("CONTROL: each tenant can reach its OWN company (the probe is not vacuous)", async () => {
    const a = await req("GET", `/api/v1/companies/${A.companyId}`, A.token);
    const b = await req("GET", `/api/v1/companies/${B.companyId}`, B.token);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.text).toContain(A.companyId);
    expect(b.text).toContain(B.companyId);
  });
});
