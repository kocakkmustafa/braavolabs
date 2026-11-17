import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  prisma: {
    company: { findFirst: vi.fn() },
    agent: { create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), delete: vi.fn() },
    activityLog: { create: vi.fn() },
  } as any,
  tenantTx: vi.fn(),
}));
vi.mock("../../../lib/db", () => db);
vi.mock("../../../lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../../../middleware/auth", () => ({ authMiddleware: vi.fn() }));
vi.mock("../../../middleware/require-permission", () => ({ requirePermission: () => vi.fn() }));
vi.mock("../../../middleware/rateLimit", () => ({ rateLimit: () => vi.fn() }));
vi.mock("../builder", () => ({ startBuildSession: vi.fn(), continueBuildSession: vi.fn(), confirmBuild: vi.fn(), getSession: vi.fn() }));
const composeAgent = vi.hoisted(() => vi.fn());
vi.mock("../../agent/composer", async () => {
  const { z } = await import("zod");
  return {
    composeAgent,
    ComposedAgentSchema: z.object({
      name: z.string().min(1).max(80),
      role: z.string().min(1).max(40).regex(/^[a-z][a-z0-9_]*$/),
      systemPrompt: z.string().min(20).max(8000),
      tools: z.array(z.string()).max(20),
    }),
  };
});
vi.mock("../../agent/registry", () => ({ getToolNames: () => ["web_search"], getTool: vi.fn() }));
vi.mock("../company-capacity", () => ({ assertCompanyCapacity: vi.fn() }));
vi.mock("../../billing/entitlement-ledger.service", () => ({ getEffectivePlan: vi.fn() }));

import { companyRouter } from "../router";

function route(path: string) {
  return (companyRouter as any).stack.find((l: any) => l.route?.path === path && l.route.methods.post).route.stack.at(-1).handle;
}
function paths() {
  return (companyRouter as any).stack.filter((l: any) => l.route?.methods.post).map((l: any) => l.route.path);
}
async function call(path: string, body: any, tenantId = "tenant-a") {
  const out: any = { status: 200, body: undefined, error: undefined };
  const res = { status(c: number) { out.status = c; return this; }, json(v: any) { out.body = v; return this; } };
  await route(path)({ params: { id: "company-a" }, auth: { tenantId, userId: "u1" }, body }, res, (e: any) => { out.error = e; });
  return out;
}

const LLM = { agent: { name: "Destek", role: "support_bot", systemPrompt: "Müşteri sorularını nazikçe yanıtla ve çöz.", tools: ["web_search"] },
  droppedTools: ["fake_tool"], inputTokens: 10, outputTokens: 20, provider: "anthropic", model: "m" };
const DESC = { description: "Müşteri desteği ajanı oluştur lütfen" };

beforeEach(() => {
  vi.clearAllMocks();
  db.prisma.company.findFirst.mockImplementation(async ({ where }: any) =>
    where.id === "company-a" && where.tenantId === "tenant-a" ? { id: "company-a" } : null);
  db.prisma.agent.create.mockImplementation(async ({ data }: any) => ({ id: "agent-1", ...data }));
  composeAgent.mockResolvedValue(LLM);
});

describe("compose draft/confirm", () => {
  it("draft rotası paramlı ajan rotalarından önce tanımlı", () => {
    const p = paths();
    expect(p.indexOf("/:id/agents/compose/draft")).toBeGreaterThan(-1);
    expect(p.indexOf("/:id/agents/compose/confirm")).toBeGreaterThan(-1);
  });

  it("taslak hiçbir satır yazmaz ve tenant ile arar", async () => {
    const r = await call("/:id/agents/compose/draft", DESC);
    expect(r.error).toBeUndefined();
    expect(r.body.draft).toEqual(LLM.agent);
    expect(r.body.droppedTools).toEqual(["fake_tool"]);
    expect(db.prisma.agent.create).not.toHaveBeenCalled();
    expect(db.prisma.activityLog.create).not.toHaveBeenCalled();
    expect(db.prisma.company.findFirst).toHaveBeenCalledWith({ where: { id: "company-a", tenantId: "tenant-a" } });
  });

  it("taslak → oluştur, eski compose ile aynı ajan alanlarını ve audit'i yazar", async () => {
    const d = await call("/:id/agents/compose/draft", DESC);
    const c = await call("/:id/agents/compose/confirm", { draft: d.body.draft });
    const old = await call("/:id/agents/compose", DESC);
    expect(c.status).toBe(201);
    expect(c.body.agent).toEqual(old.body.agent);
    expect(old.body).toMatchObject({ droppedTools: ["fake_tool"], provider: "anthropic", tokens: { input: 10, output: 20 } });
    expect(db.prisma.agent.create).toHaveBeenCalledTimes(2);
    expect(db.prisma.activityLog.create.mock.calls[0][0].data).toMatchObject({
      tenantId: "tenant-a", actor: "u1", action: "agent.compose", resource: "agent", resourceId: "agent-1" });
    expect(composeAgent).toHaveBeenCalledTimes(2); // confirm LLM çağırmaz
  });

  it("eski compose yanıt şekli değişmez", async () => {
    const r = await call("/:id/agents/compose", DESC);
    expect(r.status).toBe(201);
    expect(Object.keys(r.body).sort()).toEqual(["agent", "droppedTools", "model", "provider", "tokens"]);
    expect(db.prisma.activityLog.create.mock.calls[0][0].data.details).toMatchObject({ provider: "anthropic", descriptionLength: DESC.description.length });
  });

  it("confirm güvenilmez araç adlarını düşürür", async () => {
    const r = await call("/:id/agents/compose/confirm", { draft: { ...LLM.agent, tools: ["web_search", "rm_rf"] } });
    expect(r.body.droppedTools).toEqual(["rm_rf"]);
    expect(db.prisma.agent.create.mock.calls[0][0].data.tools).toEqual(["web_search"]);
  });

  it.each(["draft", "confirm"])("yabancı tenant %s 404, yazma yok", async (k) => {
    const r = await call(`/:id/agents/compose/${k}`, k === "draft" ? DESC : { draft: LLM.agent }, "tenant-b");
    expect(r.error).toMatchObject({ statusCode: 404 });
    expect(db.prisma.agent.create).not.toHaveBeenCalled();
    expect(composeAgent).not.toHaveBeenCalled();
  });

  it.each([
    { draft: { ...LLM.agent, role: "Bad Role" } },
    { draft: { ...LLM.agent, systemPrompt: "kısa" } },
    { draft: { ...LLM.agent, tools: Array(21).fill("web_search") } },
    { draft: null },
    {},
  ])("geçersiz taslak ZodError (400 hata işleyicisi), yazma yok", async (body) => {
    const r = await call("/:id/agents/compose/confirm", body);
    expect(r.error?.name).toBe("ZodError");
    expect(db.prisma.agent.create).not.toHaveBeenCalled();
    expect(db.prisma.activityLog.create).not.toHaveBeenCalled();
  });

  it("kısa açıklama taslakta ZodError; LLM 402 yayılır ve yazma yok", async () => {
    expect((await call("/:id/agents/compose/draft", { description: "kısa" })).error?.name).toBe("ZodError");
    composeAgent.mockRejectedValueOnce(Object.assign(new Error("quota"), { statusCode: 402 }));
    const r = await call("/:id/agents/compose/draft", DESC);
    expect(r.error).toMatchObject({ statusCode: 402 });
    expect(db.prisma.agent.create).not.toHaveBeenCalled();
  });
});
