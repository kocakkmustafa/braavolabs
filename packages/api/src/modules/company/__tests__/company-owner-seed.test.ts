/**
 * BRA-P2-07 — oluşturan kullanıcı şirketin OWNER'ı olur (aynı transaction).
 * Bellek içi sahte tx: tenantTx hata fırlatırsa üyelik listesi geri alınır (rollback taklidi).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Router } from "express";

type Member = { tenantId: string; companyId: string; userId: string; role: string; createdById?: string };
const state = vi.hoisted(() => ({ members: [] as any[], users: [] as Array<{ id: string; tenantId: string }>, seq: 0, failActivity: false }));

vi.mock("../../../lib/db", () => {
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ plan: "TEAM" }]),
    company: {
      create: vi.fn(async ({ data }: any) => ({ id: `co-${++state.seq}`, name: data.name, slug: data.slug ?? "s", tenantId: data.tenantId })),
      findFirst: vi.fn().mockResolvedValue(null),
      count: vi.fn().mockResolvedValue(0),
    },
    agent: { create: vi.fn().mockResolvedValue({ id: "agent-1" }) },
    pipeline: { create: vi.fn().mockResolvedValue({ id: "pipe-1" }) },
    activityLog: {
      create: vi.fn(async () => {
        if (state.failActivity) throw new Error("activity boom");
        return {};
      }),
    },
    companyTemplate: { update: vi.fn() },
    templateInstall: { create: vi.fn() },
    entitlementEvent: { findMany: vi.fn().mockResolvedValue([]) },
    user: {
      findFirst: vi.fn(async ({ where }: any) => state.users.find((u) => u.id === where.id && u.tenantId === where.tenantId) ?? null),
    },
    companyMember: {
      upsert: vi.fn(async ({ where, create }: any) => {
        const { companyId, userId } = where.companyId_userId;
        const hit = state.members.find((m: Member) => m.companyId === companyId && m.userId === userId);
        if (hit) return hit;
        state.members.push({ ...create });
        return create;
      }),
    },
  };
  return {
    prisma: { company: { findMany: vi.fn(), findFirst: vi.fn() }, tenant: { findUnique: vi.fn() } },
    tenantTx: async (fn: (c: typeof tx) => unknown) => {
      const snap = state.members.map((m: Member) => ({ ...m }));
      try {
        return await fn(tx);
      } catch (e) {
        state.members = snap; // rollback
        throw e;
      }
    },
  };
});
vi.mock("../../../lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("../../../config/env", () => ({ env: { NODE_ENV: "test", LLM_PROVIDER: "api" } }));
vi.mock("../../../middleware/auth", () => ({ authMiddleware: (_a: unknown, _b: unknown, next: () => void) => next() }));
vi.mock("../../../middleware/rateLimit", () => ({ rateLimit: () => (_a: unknown, _b: unknown, next: () => void) => next() }));

import { companyRouter } from "../router";
import { starterRouter } from "../../starter/starter.router";
import { STARTER_TEMPLATE_IDS } from "../../starter/starter-templates";
import { onboardingRouter } from "../../onboarding/router";
import { materialiseTemplate } from "../../templates/templates.service";
import { seedCreatorAsOwner } from "../owner-seed";

function handler(router: Router, path: string) {
  const layer = (router as any).stack.find((e: any) => e.route?.path === path && e.route.methods.post);
  if (!layer) throw new Error(`Missing POST ${path}`);
  return layer.route.stack.at(-1).handle;
}
async function invoke(route: any, body: unknown, params = {}, auth = { tenantId: "tenant-1", userId: "user-1" }) {
  const res = { statusCode: 200, status(c: number) { this.statusCode = c; return this; }, json: vi.fn() };
  let error: unknown;
  await route({ auth, body, params }, res, (e: unknown) => { error = e; });
  return { res, error };
}
const snapshot = { name: "T", description: null, primitives: ["CONTENT"], agents: [], pipelines: [], memorySeeds: [] } as any;

beforeEach(() => {
  state.members = [];
  state.users = [
    { id: "user-1", tenantId: "tenant-1" }, { id: "user-9", tenantId: "tenant-9" },
    { id: "uA", tenantId: "tenant-A" }, { id: "uB", tenantId: "tenant-B" }, { id: "u", tenantId: "t" },
  ];
  state.seq = 0;
  state.failActivity = false;
});

describe("oluşturan OWNER olur", () => {
  it("POST /companies", async () => {
    const { error } = await invoke(handler(companyRouter, "/"), { name: "A", slug: "a", primitives: ["CONTENT"] });
    expect(error).toBeUndefined();
    expect(state.members).toEqual([expect.objectContaining({ tenantId: "tenant-1", companyId: "co-1", userId: "user-1", role: "OWNER" })]);
  });

  it("starter clone", async () => {
    const { error } = await invoke(handler(starterRouter, "/:id/clone"), {}, { id: STARTER_TEMPLATE_IDS[0] });
    expect(error).toBeUndefined();
    expect(state.members).toHaveLength(1);
    expect(state.members[0]).toMatchObject({ userId: "user-1", role: "OWNER", tenantId: "tenant-1" });
  });

  it("onboarding hero-company", async () => {
    const { error } = await invoke(handler(onboardingRouter, "/hero-company"), { companyName: "Hero" });
    expect(error).toBeUndefined();
    expect(state.members).toEqual([expect.objectContaining({ userId: "user-1", role: "OWNER" })]);
  });

  it("materialiseTemplate (marketplace install) kullanıcı verilince", async () => {
    await materialiseTemplate("tpl", "tenant-9", snapshot, {}, "user-9");
    expect(state.members).toEqual([expect.objectContaining({ tenantId: "tenant-9", userId: "user-9", role: "OWNER" })]);
  });

  it("sistem yolu: materialiseTemplate kullanıcısız -> OWNER eklenmez", async () => {
    await materialiseTemplate("tpl", "tenant-9", snapshot);
    expect(state.members).toEqual([]);
  });

  it("her yeni şirket kendi OWNER'ını alır", async () => {
    await invoke(handler(companyRouter, "/"), { name: "A", slug: "a", primitives: ["CONTENT"] });
    await invoke(handler(companyRouter, "/"), { name: "B", slug: "b", primitives: ["CONTENT"] });
    expect(state.members.map((m: Member) => m.companyId)).toEqual(["co-1", "co-2"]);
  });
});

describe("aynı transaction / idempotent / izolasyon", () => {
  it("create sonrası tx başarısızsa üyelik de kalmaz (POST /companies)", async () => {
    state.failActivity = true;
    const { error } = await invoke(handler(companyRouter, "/"), { name: "A", slug: "a", primitives: ["CONTENT"] });
    expect(error).toBeDefined();
    expect(state.members).toEqual([]);
  });

  it("helper tx içinde: sonradan hata olursa üyelik geri alınır", async () => {
    const { tenantTx } = await import("../../../lib/db");
    await expect(
      tenantTx(async (tx: any) => {
        await seedCreatorAsOwner(tx, { tenantId: "t", companyId: "c", userId: "u" });
        throw new Error("sonradan hata");
      }),
    ).rejects.toThrow("sonradan hata");
    expect(state.members).toEqual([]);
  });

  it("helper iki kez çağrılınca çift satır oluşmaz", async () => {
    const { tenantTx } = await import("../../../lib/db");
    await tenantTx(async (tx: any) => {
      await seedCreatorAsOwner(tx, { tenantId: "t", companyId: "c", userId: "u" });
      await seedCreatorAsOwner(tx, { tenantId: "t", companyId: "c", userId: "u" });
    });
    expect(state.members).toHaveLength(1);
  });

  it("helper userId null/undefined/boş ise hiçbir şey yazmaz", async () => {
    const { tenantTx } = await import("../../../lib/db");
    await tenantTx(async (tx: any) => {
      await seedCreatorAsOwner(tx, { tenantId: "t", companyId: "c", userId: null });
      await seedCreatorAsOwner(tx, { tenantId: "t", companyId: "c", userId: undefined });
      await seedCreatorAsOwner(tx, { tenantId: "t", companyId: "c", userId: "" });
    });
    expect(state.members).toEqual([]);
  });

  it("tenant izolasyonu: üyelik oluşturanın tenantId'siyle yazılır", async () => {
    await invoke(handler(companyRouter, "/"), { name: "A", slug: "a", primitives: ["CONTENT"] }, {}, { tenantId: "tenant-A", userId: "uA" });
    await invoke(handler(companyRouter, "/"), { name: "B", slug: "b", primitives: ["CONTENT"] }, {}, { tenantId: "tenant-B", userId: "uB" });
    expect(state.members.map((m: Member) => [m.tenantId, m.userId])).toEqual([["tenant-A", "uA"], ["tenant-B", "uB"]]);
  });

  it("createdById oluşturanı gösterir", async () => {
    await invoke(handler(companyRouter, "/"), { name: "A", slug: "a", primitives: ["CONTENT"] });
    expect(state.members[0].createdById).toBe("user-1");
  });

  it("kullanıcı silinmişse OWNER eklenmez ama şirket yine oluşur (500 yok)", async () => {
    state.users = [];
    const { res, error } = await invoke(handler(companyRouter, "/"), { name: "A", slug: "a", primitives: ["CONTENT"] });
    expect(error).toBeUndefined();
    expect(res.statusCode).toBe(201);
    expect(state.members).toEqual([]);
  });

  it("kullanıcı başka tenant'ta ise OWNER eklenmez", async () => {
    state.users = [{ id: "user-1", tenantId: "baska-tenant" }];
    const { error } = await invoke(handler(companyRouter, "/"), { name: "A", slug: "a", primitives: ["CONTENT"] });
    expect(error).toBeUndefined();
    expect(state.members).toEqual([]);
  });
});
