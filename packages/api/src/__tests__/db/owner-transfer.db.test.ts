/**
 * BRA-P2-07 — owner-transfer.ts ham SQL'i GERÇEK Postgres'te (TEST_DATABASE_URL yoksa skip).
 * Aday sırası (enum OWNER<ADMIN), FOR SHARE SKIP LOCKED (iki bağlantı), A<->B karşılıklı aday: deadlock yok.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { dropTenants, hasTestDb, makeClient } from "./db-harness";
import { transferSoleOwnerships } from "../../modules/user/owner-transfer";

const d = hasTestDb ? describe : describe.skip;

d("transferSoleOwnerships (real Postgres)", () => {
  let db: PrismaClient;
  const tenants: string[] = [];
  beforeAll(async () => { db = makeClient(); await db.$connect(); });
  afterAll(async () => { await dropTenants(db, tenants); await db.$disconnect(); });

  async function tenant() {
    const id = randomUUID();
    tenants.push(id);
    await db.tenant.create({ data: { id, name: "T-ot", slug: `t-ot-${id.slice(0, 8)}`, plan: "INDIVIDUAL" } });
    return id;
  }
  async function user(tenantId: string, role: "OWNER" | "ADMIN" | "MEMBER", createdAt: string) {
    const id = randomUUID();
    await db.user.create({ data: { id, tenantId, email: `${id}@example.invalid`, role, createdAt: new Date(createdAt) } });
    return id;
  }
  async function company(tenantId: string, ownerId: string) {
    const id = randomUUID();
    // Tek atomik yazım: eşzamanlı koşan backfill testi OWNER'sız ara durumu görüp araya OWNER ekleyemesin.
    await db.company.create({
      data: { id, tenantId, name: "C", slug: `c-${id.slice(0, 8)}`, status: "ACTIVE", members: { create: { tenantId, userId: ownerId, role: "OWNER" } } },
    });
    return id;
  }
  const owners = async (c: string) => (await db.companyMember.findMany({ where: { companyId: c, role: "OWNER" } })).map((m) => m.userId);

  /** Bir kullanıcı satırını FOR UPDATE tutan, serbest bırakılana dek açık kalan ayrı bağlantı. */
  async function holdRowLock(userId: string) {
    let release!: () => void;
    const hold = new Promise<void>((r) => { release = r; });
    let ready!: () => void;
    const gotLock = new Promise<void>((r) => { ready = r; });
    const holder = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
      ready();
      await hold;
    });
    await gotLock;
    return async () => { release(); await holder; };
  }

  it("aday sırası: tenant OWNER > daha eski ADMIN; başka tenant ve MEMBER hariç", async () => {
    const t = await tenant();
    const t2 = await tenant();
    const me = await user(t, "ADMIN", "2026-01-01T00:00:00Z");
    await user(t, "ADMIN", "2026-01-02T00:00:00Z");
    const owner = await user(t, "OWNER", "2026-06-01T00:00:00Z");
    await user(t, "MEMBER", "2025-01-01T00:00:00Z");
    await user(t2, "OWNER", "2024-01-01T00:00:00Z");
    const c = await company(t, me);
    const res = await db.$transaction((tx) => transferSoleOwnerships(tx, { tenantId: t, userId: me }));
    expect(res).toEqual({ transferred: 1, orphaned: 0 });
    expect(await owners(c)).toContain(owner);
    expect(await db.activityLog.count({ where: { tenantId: t, action: "company.member.owner_transferred" } })).toBe(1);
  });

  it("SKIP LOCKED: başka bağlantının kilitlediği aday atlanır, sıradakine geçilir (bekleme yok)", async () => {
    const t = await tenant();
    const me = await user(t, "ADMIN", "2026-01-01T00:00:00Z");
    const locked = await user(t, "OWNER", "2026-01-02T00:00:00Z");
    const free = await user(t, "ADMIN", "2026-01-03T00:00:00Z");
    const c = await company(t, me);
    const unlock = await holdRowLock(locked);
    const res = await db.$transaction((tx) => transferSoleOwnerships(tx, { tenantId: t, userId: me }));
    await unlock();
    expect(res.transferred).toBe(1);
    expect(await owners(c)).toContain(free);
    expect(await owners(c)).not.toContain(locked);
  });

  it("tüm adaylar kilitliyse orphan: bekleme yok, orphan log", async () => {
    const t = await tenant();
    const me = await user(t, "ADMIN", "2026-01-01T00:00:00Z");
    const only = await user(t, "ADMIN", "2026-01-02T00:00:00Z");
    const c = await company(t, me);
    const unlock = await holdRowLock(only);
    const res = await db.$transaction((tx) => transferSoleOwnerships(tx, { tenantId: t, userId: me }));
    await unlock();
    expect(res).toEqual({ transferred: 0, orphaned: 1 });
    expect(await db.activityLog.count({ where: { tenantId: t, action: "company.owner_orphaned", resourceId: c } })).toBe(1);
  });

  it("A<->B karşılıklı aday: eşzamanlı iki silme deadlock olmadan biter", async () => {
    const t = await tenant();
    const a = await user(t, "ADMIN", "2026-01-01T00:00:00Z");
    const b = await user(t, "ADMIN", "2026-01-02T00:00:00Z");
    await company(t, a);
    await company(t, b);
    const del = (id: string) => db.$transaction(async (tx) => {
      await transferSoleOwnerships(tx, { tenantId: t, userId: id });
      await tx.user.delete({ where: { id } });
    });
    const results = await Promise.allSettled([del(a), del(b)]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
  });
});
