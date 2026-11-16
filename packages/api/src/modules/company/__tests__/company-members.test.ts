/**
 * BRA-P1-06-N1 — şirket üyeleri. SINIR: Prisma bellek içi taklit; gerçek DB/RLS bu dilimin dışında.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const db = vi.hoisted(() => ({
  companies: [] as any[], users: [] as any[], members: [] as any[], logs: [] as any[], where: [] as any[], seq: 0,
}));

function makeClient() {
  const rec = (w: any) => { db.where.push(w); return w; };
  const match = (m: any, w: any) =>
    Object.entries(w).every(([k, v]) => (k === "id" || k === "tenantId" || k === "companyId" || k === "userId" || k === "role") ? m[k] === v : true);
  return {
    $queryRaw: async (_s: any, id: string, tenantId: string) =>
      db.companies.filter((c) => c.id === id && c.tenantId === tenantId).map((c) => ({ id: c.id })),
    company: { findFirst: async (a: any) => db.companies.find((c) => match(c, rec(a.where))) ?? null },
    user: { findFirst: async (a: any) => db.users.find((u) => match(u, rec(a.where))) ?? null },
    companyMember: {
      findFirst: async (a: any) => {
        const m = db.members.find((x) => match(x, rec(a.where)));
        return m ? { ...m, user: db.users.find((u) => u.id === m.userId) } : null;
      },
      findMany: async (a: any) =>
        db.members.filter((x) => match(x, rec(a.where))).map((m) => ({ ...m, user: db.users.find((u) => u.id === m.userId) })),
      count: async (a: any) => db.members.filter((x) => match(x, rec(a.where))).length,
      create: async (a: any) => { const m = { id: `m-${++db.seq}`, createdAt: new Date(0), ...a.data }; db.members.push(m); return m; },
      updateMany: async (a: any) => {
        const t = db.members.filter((x) => match(x, rec(a.where)));
        t.forEach((x) => Object.assign(x, a.data));
        return { count: t.length };
      },
      deleteMany: async (a: any) => {
        const t = db.members.filter((x) => match(x, rec(a.where)));
        db.members = db.members.filter((x) => !t.includes(x));
        return { count: t.length };
      },
    },
    activityLog: { create: async (a: any) => { db.logs.push(a.data); } },
  };
}

vi.mock("../../../lib/db", () => ({
  prisma: { company: { findFirst: (a: any) => makeClient().company.findFirst(a) }, companyMember: { findMany: (a: any) => makeClient().companyMember.findMany(a) } },
  tenantTx: async (fn: any) => fn(makeClient()),
}));
vi.mock("../../../lib/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { companyMembersRouter } from "../members";

function chain(method: string, path: string) {
  const l = (companyMembersRouter as any).stack.find((x: any) => x.route?.path === path && x.route.methods[method]);
  const hs = l.route.stack.map((x: any) => x.handle);
  return async (req: any, res: any, next: any) => {
    for (const h of hs) {
      let advanced = false;
      await h(req, res, (e?: any) => { advanced = true; if (e) next(e); });
      if (!advanced || res.statusCode >= 400) return;
    }
  };
}
const H = { list: chain("get", "/"), add: chain("post", "/"), patch: chain("patch", "/:userId"), del: chain("delete", "/:userId") };

async function call(h: any, o: { id?: string; userId?: string; body?: unknown; tenantId?: string; role?: string } = {}) {
  const res: any = { statusCode: 200, body: undefined, status(c: number) { this.statusCode = c; return this; }, json(p: unknown) { this.body = p; return this; } };
  let err: any;
  await h({ params: { id: o.id ?? "co-1", userId: o.userId }, body: o.body, auth: { tenantId: o.tenantId ?? "t-1", userId: "admin-1", role: o.role ?? "ADMIN" } }, res, (e?: any) => { err = e; });
  return { res, err };
}
const status = (e: any) => e?.statusCode ?? e?.status;

beforeEach(() => {
  db.logs = []; db.where = []; db.seq = 0;
  db.companies = [{ id: "co-1", tenantId: "t-1" }, { id: "co-B", tenantId: "t-B" }];
  db.users = [
    { id: "u-1", tenantId: "t-1", name: "Ada", email: "ada@example.invalid" },
    { id: "u-2", tenantId: "t-1", name: "Bo", email: "bo@example.invalid" },
    { id: "u-B", tenantId: "t-B", name: "Zed", email: "zed@example.invalid" },
  ];
  db.members = [
    { id: "m-a", tenantId: "t-1", companyId: "co-1", userId: "u-1", role: "OWNER", createdAt: new Date(0) },
  ];
});

describe("POST /", () => {
  it("ekler, 201, varsayılan MEMBER, createdById ve log", async () => {
    const { res, err } = await call(H.add, { body: { userId: "u-2" } });
    expect(err).toBeUndefined();
    expect(res.statusCode).toBe(201);
    expect(res.body).toMatchObject({ userId: "u-2", role: "MEMBER", name: "Bo" });
    expect(db.members.find((m) => m.userId === "u-2")).toMatchObject({ tenantId: "t-1", companyId: "co-1", createdById: "admin-1" });
    expect(db.logs).toEqual([expect.objectContaining({ tenantId: "t-1", actor: "admin-1", action: "company.member.add", resource: "company", resourceId: "co-1" })]);
  });
  it("OWNER rolüyle eklenebilir", async () => {
    const { res } = await call(H.add, { body: { userId: "u-2", role: "OWNER" } });
    expect(res.body.role).toBe("OWNER");
  });
  it("çift ekleme -> 409, log yok", async () => {
    const { err } = await call(H.add, { body: { userId: "u-1" } });
    expect(status(err)).toBe(409);
    expect(db.logs).toHaveLength(0);
  });
  it("yabancı tenant kullanıcı -> 404", async () => {
    const { err } = await call(H.add, { body: { userId: "u-B" } });
    expect(status(err)).toBe(404);
    expect(db.members).toHaveLength(1);
  });
  it("yabancı tenant şirket -> 404", async () => {
    const { err } = await call(H.add, { id: "co-B", body: { userId: "u-2" } });
    expect(status(err)).toBe(404);
    expect(db.members).toHaveLength(1);
  });
  it("MEMBER -> 403, yazma/log yok", async () => {
    const { res } = await call(H.add, { body: { userId: "u-2" }, role: "MEMBER" });
    expect(res.statusCode).toBe(403);
    expect(db.members).toHaveLength(1);
    expect(db.logs).toHaveLength(0);
  });
  it.each(["ADMIN", "OWNER"])("%s yazabilir", async (role) => {
    const { res } = await call(H.add, { body: { userId: "u-2" }, role });
    expect(res.statusCode).toBe(201);
  });
  it("geçersiz rol / fazla alan -> Zod hatası", async () => {
    expect((await call(H.add, { body: { userId: "u-2", role: "ADMIN" } })).err).toBeDefined();
    expect((await call(H.add, { body: { userId: "u-2", lastSeen: 1 } })).err).toBeDefined();
  });
});

describe("PATCH /:userId", () => {
  beforeEach(() => { db.members.push({ id: "m-b", tenantId: "t-1", companyId: "co-1", userId: "u-2", role: "MEMBER", createdAt: new Date(0) }); });
  it("MEMBER -> OWNER terfi, log from/to", async () => {
    const { res, err } = await call(H.patch, { userId: "u-2", body: { role: "OWNER" } });
    expect(err).toBeUndefined();
    expect(res.body).toMatchObject({ userId: "u-2", role: "OWNER" });
    expect(db.members.find((m) => m.userId === "u-2")!.role).toBe("OWNER");
    expect(db.logs[0]).toMatchObject({ action: "company.member.role_update", details: { userId: "u-2", from: "MEMBER", to: "OWNER" } });
  });
  it("son OWNER düşürülemez -> 409", async () => {
    const { err } = await call(H.patch, { userId: "u-1", body: { role: "MEMBER" } });
    expect(status(err)).toBe(409);
    expect(db.members.find((m) => m.userId === "u-1")!.role).toBe("OWNER");
    expect(db.logs).toHaveLength(0);
  });
  it("ikinci OWNER varsa düşürülebilir", async () => {
    await call(H.patch, { userId: "u-2", body: { role: "OWNER" } });
    const { err } = await call(H.patch, { userId: "u-1", body: { role: "MEMBER" } });
    expect(err).toBeUndefined();
    expect(db.members.find((m) => m.userId === "u-1")!.role).toBe("MEMBER");
  });
  it("aynı rol -> no-op, log yok", async () => {
    const { res } = await call(H.patch, { userId: "u-2", body: { role: "MEMBER" } });
    expect(res.body.role).toBe("MEMBER");
    expect(db.logs).toHaveLength(0);
  });
  it("MEMBER -> 403", async () => {
    const { res } = await call(H.patch, { userId: "u-2", body: { role: "OWNER" }, role: "MEMBER" });
    expect(res.statusCode).toBe(403);
  });
  it("olmayan üye / yabancı şirket -> 404", async () => {
    expect(status((await call(H.patch, { userId: "nope", body: { role: "OWNER" } })).err)).toBe(404);
    expect(status((await call(H.patch, { id: "co-B", userId: "u-2", body: { role: "OWNER" } })).err)).toBe(404);
  });
  it("mutasyon where'inde tenantId ve companyId var", async () => {
    await call(H.patch, { userId: "u-2", body: { role: "OWNER" } });
    const upd = db.where.filter((w) => w.id === "m-b");
    expect(upd.length).toBeGreaterThan(0);
    upd.forEach((w) => expect(w).toMatchObject({ tenantId: "t-1", companyId: "co-1" }));
  });
});

describe("DELETE /:userId", () => {
  beforeEach(() => { db.members.push({ id: "m-b", tenantId: "t-1", companyId: "co-1", userId: "u-2", role: "MEMBER", createdAt: new Date(0) }); });
  it("MEMBER silinir, log yazılır", async () => {
    const { res, err } = await call(H.del, { userId: "u-2" });
    expect(err).toBeUndefined();
    expect(res.body).toEqual({ success: true });
    expect(db.members.map((m) => m.userId)).toEqual(["u-1"]);
    expect(db.logs[0]).toMatchObject({ action: "company.member.remove", details: { userId: "u-2", role: "MEMBER" } });
  });
  it("son OWNER silinemez -> 409", async () => {
    const { err } = await call(H.del, { userId: "u-1" });
    expect(status(err)).toBe(409);
    expect(db.members).toHaveLength(2);
    expect(db.logs).toHaveLength(0);
  });
  it("yabancı tenant'tan silme -> 404, kayıt kalır", async () => {
    const { err } = await call(H.del, { userId: "u-2", tenantId: "t-B", id: "co-B" });
    expect(status(err)).toBe(404);
    expect(db.members).toHaveLength(2);
  });
  it("MEMBER silemez -> 403", async () => {
    const { res } = await call(H.del, { userId: "u-2", role: "MEMBER" });
    expect(res.statusCode).toBe(403);
    expect(db.members).toHaveLength(2);
  });
  it("silme where'inde tenantId var", async () => {
    await call(H.del, { userId: "u-2" });
    db.where.forEach((w) => { if ("companyId" in w || "id" in w) expect(w.tenantId ?? w.tenantId).toBeDefined(); });
  });
});

describe("GET /", () => {
  it("MEMBER okuyabilir; şekil: yalnız userId/name/email/role/createdAt", async () => {
    const { res, err } = await call(H.list, { role: "MEMBER" });
    expect(err).toBeUndefined();
    expect(res.body.members).toHaveLength(1);
    expect(Object.keys(res.body.members[0]).sort()).toEqual(["createdAt", "email", "name", "role", "userId"]);
  });
  it("yabancı tenant şirket -> 404", async () => {
    expect(status((await call(H.list, { id: "co-B" })).err)).toBe(404);
  });
  it("tenant başka üyeleri görmez", async () => {
    db.members.push({ id: "m-x", tenantId: "t-B", companyId: "co-B", userId: "u-B", role: "OWNER", createdAt: new Date(0) });
    const { res } = await call(H.list);
    expect(res.body.members.map((m: any) => m.userId)).toEqual(["u-1"]);
  });
});
