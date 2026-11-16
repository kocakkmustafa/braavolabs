/**
 * BRA-P2-07 — DELETE /users/me: silme ASLA bloke olmaz; tek-OWNER olunan şirketlerin sahipliği
 * aynı tx'te devredilir (aday yoksa şirket sahipsiz kalır ve loglanır). Bellek içi sahte tx.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Router } from "express";

type U = { id: string; tenantId: string; role: "OWNER" | "ADMIN" | "MEMBER"; createdAt: number };
type M = { tenantId: string; companyId: string; userId: string; role: "OWNER" | "MEMBER" };
const st = vi.hoisted(() => ({
  users: [] as any[], members: [] as any[], logs: [] as any[], vanish: new Set<string>(), deleted: [] as string[],
  order: [] as string[],
}));

const prismaMock = vi.hoisted(() => ({
  user: { findUnique: vi.fn(), count: vi.fn(), delete: vi.fn() },
  tenant: { delete: vi.fn() },
  activityLog: { create: vi.fn() },
}));
const tombstoneMock = vi.hoisted(() => vi.fn());

vi.mock("../../lib/db", () => {
  const tx = {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...vals: any[]) => {
      const q = strings.join("?");
      if (/FROM users[\s\S]*FOR UPDATE/.test(q)) { st.order.push(`lock-user:${vals[0]}`); return [{ id: vals[0] }]; }
      if (/FROM companies[\s\S]*FOR UPDATE/.test(q)) { st.order.push(`lock-company:${vals[0]}`); return [{ id: vals[0] }]; }
      if (/FROM users[\s\S]*FOR SHARE/.test(q)) {
        const gone = st.vanish.has(vals[0]) || !st.users.some((u: U) => u.id === vals[0]);
        return gone ? [] : [{ id: vals[0] }];
      }
      return [];
    }),
    companyMember: {
      findMany: vi.fn(async ({ where }: any) =>
        st.members.filter((m: M) => m.tenantId === where.tenantId && m.userId === where.userId && m.role === where.role)
          .map((m: M) => ({ companyId: m.companyId })).sort((a, b) => a.companyId.localeCompare(b.companyId))),
      count: vi.fn(async ({ where }: any) =>
        st.members.filter((m: M) => m.companyId === where.companyId && m.tenantId === where.tenantId && m.role === where.role && m.userId !== where.userId.not).length),
      upsert: vi.fn(async ({ where, create, update }: any) => {
        const { companyId, userId } = where.companyId_userId;
        const hit = st.members.find((m: M) => m.companyId === companyId && m.userId === userId);
        if (hit) Object.assign(hit, update); else st.members.push({ ...create });
      }),
    },
    user: {
      findMany: vi.fn(async ({ where, take }: any) => {
        const rank: Record<string, number> = { OWNER: 0, ADMIN: 1, MEMBER: 2 };
        return st.users
          .filter((u: U) => u.tenantId === where.tenantId && u.id !== where.id.not && where.role.in.includes(u.role))
          .sort((a: U, b: U) => rank[a.role] - rank[b.role] || a.createdAt - b.createdAt || a.id.localeCompare(b.id))
          .slice(0, take).map((u: U) => ({ id: u.id }));
      }),
      delete: vi.fn(async ({ where }: any) => {
        st.deleted.push(where.id);
        st.users = st.users.filter((u: U) => u.id !== where.id);
        st.members = st.members.filter((m: M) => m.userId !== where.id); // FK cascade
      }),
    },
    activityLog: { create: vi.fn(async ({ data }: any) => { st.logs.push(data); }) },
  };
  return { prisma: prismaMock, tenantTx: async (fn: any) => fn(tx) };
});
vi.mock("../../middleware/auth", () => ({ authMiddleware: (_a: unknown, _b: unknown, next: () => void) => next() }));
vi.mock("../../lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../../services/trial-llm", () => ({ getTrialStatus: vi.fn() }));
vi.mock("../../config/env", () => ({ env: { ERASURE_LEDGER_PATH: "/synthetic/ledger.jsonl" } }));
vi.mock("./apple-revocation", async (orig) => ({
  ...(await orig<typeof import("./apple-revocation")>()),
  revokeAppleAccess: vi.fn().mockResolvedValue("NOT_APPLICABLE"),
}));
vi.mock("./erasure-tombstones", () => ({ recordErasureTombstones: (...a: unknown[]) => tombstoneMock(...a) }));

const { userRouter } = await import("./user.router");

async function del() {
  const layer = (userRouter as Router as any).stack.find((l: any) => l.route?.path === "/me" && l.route.methods.delete);
  const res: any = { statusCode: 200, body: undefined, status(c: number) { this.statusCode = c; return this; }, json(p: unknown) { this.body = p; return this; } };
  let err: any;
  await layer.route.stack.at(-1).handle({ headers: {}, body: { confirm: "DELETE" }, auth: { userId: "u1", tenantId: "t1" } }, res, (e?: any) => { err = e; });
  return { res, err };
}
const u = (id: string, role: U["role"], createdAt: number, tenantId = "t1"): U => ({ id, tenantId, role, createdAt });
const own = (companyId: string, userId: string, role: M["role"] = "OWNER", tenantId = "t1"): M => ({ tenantId, companyId, userId, role });
const ownersOf = (c: string) => st.members.filter((m: M) => m.companyId === c && m.role === "OWNER").map((m: M) => m.userId);

beforeEach(() => {
  vi.clearAllMocks();
  st.users = [u("u1", "ADMIN", 1)];
  st.members = []; st.logs = []; st.deleted = []; st.order = []; st.vanish = new Set();
  prismaMock.user.findUnique.mockResolvedValue({ email: "x@example.invalid", role: "ADMIN", appleId: null, tenant: { plan: "FREE", stripeSubscriptionId: null } });
  prismaMock.user.count.mockResolvedValue(2);
  prismaMock.activityLog.create.mockResolvedValue({});
});

describe("DELETE /users/me sahiplik devri", () => {
  it("tek-OWNER + aday var: 409 YOK, devredilir ve silinir", async () => {
    st.users.push(u("u2", "ADMIN", 5));
    st.members = [own("c1", "u1")];
    const { res, err } = await del();
    expect(err).toBeUndefined();
    expect(res.body).toMatchObject({ success: true, tenantDeleted: false });
    expect(st.deleted).toEqual(["u1"]);
    expect(ownersOf("c1")).toEqual(["u2"]);
    expect(st.logs).toEqual([expect.objectContaining({ action: "company.member.owner_transferred", resourceId: "c1", details: { fromUserId: "u1", toUserId: "u2", reason: "account_deletion" } })]);
  });

  it("aday yok: silme yine geçer, şirket sahipsiz kalır, company.owner_orphaned loglanır", async () => {
    st.users.push(u("u3", "MEMBER", 2)); // MEMBER aday değil
    st.members = [own("c1", "u1")];
    const { err } = await del();
    expect(err).toBeUndefined();
    expect(st.deleted).toEqual(["u1"]);
    expect(ownersOf("c1")).toEqual([]);
    expect(st.logs.map((l: any) => l.action)).toEqual(["company.owner_orphaned"]);
  });

  it("aday seçimi: tenant OWNER > ADMIN, sonra en eski created_at; silinen kullanıcı hariç; başka tenant sızmaz", async () => {
    st.users.push(u("a-old", "ADMIN", 1), u("o-new", "OWNER", 99), u("x-other", "OWNER", 0, "t2"));
    st.members = [own("c1", "u1")];
    await del();
    expect(ownersOf("c1")).toEqual(["o-new"]);
  });

  it("adayın mevcut MEMBER satırı OWNER'a yükseltilir (çift satır yok)", async () => {
    st.users.push(u("u2", "ADMIN", 5));
    st.members = [own("c1", "u1"), own("c1", "u2", "MEMBER")];
    await del();
    expect(st.members.filter((m: M) => m.companyId === "c1")).toEqual([expect.objectContaining({ userId: "u2", role: "OWNER" })]);
  });

  it("birden çok şirket: id sırasıyla kilitlenir, her biri devredilir; başka OWNER'ı olan şirkete dokunulmaz", async () => {
    st.users.push(u("u2", "ADMIN", 5), u("u4", "OWNER", 6));
    st.members = [own("c2", "u1"), own("c1", "u1"), own("c3", "u1"), own("c3", "u4")];
    await del();
    expect(ownersOf("c1")).toEqual(["u4"]); // OWNER > ADMIN
    expect(ownersOf("c2")).toEqual(["u4"]);
    expect(ownersOf("c3")).toEqual(["u4"]);
    expect(st.logs.map((l: any) => l.resourceId)).toEqual(["c1", "c2"]);
    expect(st.order.filter((o) => o.startsWith("lock-company"))).toEqual(["lock-company:c1", "lock-company:c2", "lock-company:c3"]);
    expect(st.order[0]).toBe("lock-user:u1");
  });

  it("yarış: aday eşzamanlı silinirse sıradakine geçilir", async () => {
    st.users.push(u("u2", "ADMIN", 1), u("u3", "ADMIN", 2));
    st.vanish.add("u2"); // FOR SHARE satırı döndürmez
    st.members = [own("c1", "u1")];
    const { err } = await del();
    expect(err).toBeUndefined();
    expect(ownersOf("c1")).toEqual(["u3"]);
  });

  it("yarış: tüm adaylar kaybolursa orphan loglanır, silme yine geçer", async () => {
    st.users.push(u("u2", "ADMIN", 1));
    st.vanish.add("u2");
    st.members = [own("c1", "u1")];
    const { err } = await del();
    expect(err).toBeUndefined();
    expect(st.logs.map((l: any) => l.action)).toEqual(["company.owner_orphaned"]);
    expect(st.deleted).toEqual(["u1"]);
  });

  it("OWNER olmayan kullanıcı: devir yok, normal silme", async () => {
    st.users.push(u("u2", "ADMIN", 5));
    st.members = [own("c1", "u1", "MEMBER"), own("c1", "u2")];
    const { err } = await del();
    expect(err).toBeUndefined();
    expect(st.logs).toEqual([]);
    expect(st.deleted).toEqual(["u1"]);
  });

  it("log ham veri taşımaz (e-posta/ad yok)", async () => {
    st.users.push(u("u2", "ADMIN", 5));
    st.members = [own("c1", "u1")];
    await del();
    expect(JSON.stringify(st.logs)).not.toMatch(/@|email/);
  });

  it("son kullanıcıysa (tenant tamamen silinir) devir atlanır", async () => {
    prismaMock.user.count.mockResolvedValue(0);
    st.members = [own("c1", "u1")];
    const { res, err } = await del();
    expect(err).toBeUndefined();
    expect(prismaMock.tenant.delete).toHaveBeenCalledWith({ where: { id: "t1" } });
    expect(res.body).toMatchObject({ tenantDeleted: true });
    expect(st.logs).toEqual([]);
  });
});
