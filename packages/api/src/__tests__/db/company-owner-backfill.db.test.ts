/**
 * BRA-P2-07 — 20261116400000_company_owner_backfill SQL'i GERÇEK Postgres'te.
 * TEST_DATABASE_URL yoksa kendini atlar (db-harness.ts); yapısal assert'ler DB'siz her zaman koşar.
 * Not: SQL tüm tenantları tarar; test yalnız kendi tenantlarının satırlarını doğrular.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { dropTenants, hasTestDb, makeClient } from "./db-harness";

const SQL = readFileSync(
  join(__dirname, "../../../../db/prisma/migrations/20261116400000_company_owner_backfill/migration.sql"),
  "utf8",
);

describe("owner backfill SQL (yapısal)", () => {
  it("yalnız INSERT; DROP/ALTER/DELETE yok", () => {
    const code = SQL.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(code).toMatch(/INSERT INTO "company_members"/);
    expect(code).not.toMatch(/\b(DROP|ALTER|DELETE|TRUNCATE)\b/i);
  });
  it("MEMBER çakışmasını OWNER'a yükseltir, OWNER'lı şirketi dışlar, adayı OWNER>ADMIN/en eski seçer", () => {
    expect(SQL).toMatch(/ON CONFLICT \("company_id", "user_id"\) DO UPDATE SET "role" = 'OWNER'/);
    expect(SQL).toMatch(/WHERE NOT EXISTS \(\s*SELECT 1 FROM "company_members" m WHERE m\."company_id" = c\."id" AND m\."role" = 'OWNER'/);
    expect(SQL).toMatch(/us\."tenant_id" = c\."tenant_id" AND us\."role" IN \('OWNER', 'ADMIN'\)/);
    expect(SQL).toMatch(/ORDER BY \(CASE us\."role" WHEN 'OWNER' THEN 0 ELSE 1 END\), us\."created_at" ASC, us\."id" ASC/);
  });
});

const d = hasTestDb ? describe : describe.skip;

d("owner backfill SQL (real Postgres)", () => {
  let db: PrismaClient;
  const tenants: string[] = [];

  beforeAll(async () => { db = makeClient(); await db.$connect(); });
  afterAll(async () => { await dropTenants(db, tenants); await db.$disconnect(); });

  async function tenant(label: string) {
    const id = randomUUID();
    tenants.push(id);
    await db.tenant.create({ data: { id, name: `T-${label}`, slug: `t-${label}-${id.slice(0, 8)}`, plan: "INDIVIDUAL" } });
    return id;
  }
  async function user(tenantId: string, role: "OWNER" | "ADMIN" | "MEMBER", createdAt: string, id = randomUUID()) {
    await db.user.create({ data: { id, tenantId, email: `${id}@example.invalid`, role, createdAt: new Date(createdAt) } });
    return id;
  }
  async function company(tenantId: string) {
    const id = randomUUID();
    await db.company.create({ data: { id, tenantId, name: `C-${id.slice(0, 6)}`, slug: `c-${id.slice(0, 8)}`, status: "ACTIVE" } });
    return id;
  }
  const run = () => db.$executeRawUnsafe(SQL);
  const members = (companyId: string) => db.companyMember.findMany({ where: { companyId }, orderBy: { createdAt: "asc" } });

  it("OWNER'sız şirkete tenant'ın OWNER>ADMIN, en eski adayı OWNER olur; başka tenant'a sızmaz", async () => {
    const t1 = await tenant("bf1");
    const t2 = await tenant("bf2");
    await user(t1, "ADMIN", "2026-01-01T00:00:00Z");
    const owner = await user(t1, "OWNER", "2026-03-01T00:00:00Z");
    await user(t1, "MEMBER", "2025-01-01T00:00:00Z");
    const adminT2 = await user(t2, "ADMIN", "2026-02-01T00:00:00Z");
    const c1 = await company(t1);
    const c2 = await company(t2);
    await run();
    expect((await members(c1)).map((m) => [m.userId, m.role, m.tenantId])).toEqual([[owner, "OWNER", t1]]);
    expect((await members(c2)).map((m) => [m.userId, m.role, m.tenantId])).toEqual([[adminT2, "OWNER", t2]]);
  });

  it("aynı rolde en eski created_at seçilir", async () => {
    const t = await tenant("bf3");
    await user(t, "ADMIN", "2026-05-01T00:00:00Z");
    const oldest = await user(t, "ADMIN", "2026-01-01T00:00:00Z");
    const c = await company(t);
    await run();
    expect((await members(c)).map((m) => m.userId)).toEqual([oldest]);
  });

  it("aday zaten MEMBER ise OWNER'a yükseltilir (şirket sahipsiz kalmaz)", async () => {
    const t = await tenant("bf4");
    const a = await user(t, "ADMIN", "2026-01-01T00:00:00Z");
    const c = await company(t);
    await db.companyMember.create({ data: { tenantId: t, companyId: c, userId: a, role: "MEMBER" } });
    await run();
    expect((await members(c)).map((m) => [m.userId, m.role])).toEqual([[a, "OWNER"]]);
  });

  it("OWNER'ı olan şirkete dokunmaz (mevcut OWNER ve MEMBER'lar aynı kalır)", async () => {
    const t = await tenant("bf5");
    await user(t, "OWNER", "2026-01-01T00:00:00Z");
    const x = await user(t, "MEMBER", "2026-02-01T00:00:00Z");
    const y = await user(t, "MEMBER", "2026-03-01T00:00:00Z");
    const c = await company(t);
    await db.companyMember.create({ data: { tenantId: t, companyId: c, userId: x, role: "OWNER" } });
    await db.companyMember.create({ data: { tenantId: t, companyId: c, userId: y, role: "MEMBER" } });
    await run();
    expect((await members(c)).map((m) => [m.userId, m.role]).sort()).toEqual([[x, "OWNER"], [y, "MEMBER"]].sort());
  });

  it("OWNER/ADMIN adayı yoksa şirket atlanır", async () => {
    const t = await tenant("bf6");
    await user(t, "MEMBER", "2026-01-01T00:00:00Z");
    const c = await company(t);
    await run();
    expect(await members(c)).toEqual([]);
  });

  it("ikinci çalıştırma hiçbir şeyi değiştirmez (idempotent)", async () => {
    const t = await tenant("bf7");
    await user(t, "ADMIN", "2026-01-01T00:00:00Z");
    const c = await company(t);
    await run();
    const first = await members(c);
    await run();
    const second = await members(c);
    expect(second).toEqual(first);
    expect(second).toHaveLength(1);
  });
});
