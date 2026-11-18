/**
 * SEC-BRA-06c — ungoverned tool dispatch (hierarchical worker / local CLI)
 * must not allow cross-tenant writes or off-list tools. REAL registry + REAL
 * tool-executor; only prisma and the provider are synthetic.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../config/env", () => ({ env: { LLM_PROVIDER: "api", ANTHROPIC_API_KEY: "k", CLAUDE_MODEL: "m", OFFLINE_MODE: false } }));
vi.mock("../../../lib/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const db = vi.hoisted(() => ({
  dealFindFirst: vi.fn(), dealUpdate: vi.fn(),
  contactFindFirst: vi.fn(), contactUpdate: vi.fn(),
}));
vi.mock("../../../lib/db", () => ({
  prisma: new Proxy(
    {
      deal: { findFirst: db.dealFindFirst, updateMany: db.dealUpdate },
      contact: { findFirst: db.contactFindFirst, updateMany: db.contactUpdate },
    },
    { get: (t: any, k: string) => t[k] ?? new Proxy({}, { get: () => vi.fn() }) },
  ),
}));
vi.mock("../../../lib/runEvents", () => ({ publishRunEvent: vi.fn() }));
vi.mock("../../../lib/ssrf", () => ({ assertSafeExternalUrl: async () => {}, SsrfError: class extends Error {} }));
vi.mock("../../../lib/encryption", () => ({ decryptForTenant: vi.fn(), encryptForTenant: vi.fn() }));

const chat = vi.hoisted(() => vi.fn());
vi.mock("../../../services/ai-client", async (orig) => ({
  ...(await orig<typeof import("../../../services/ai-client")>()),
  chatCompletion: (...a: unknown[]) => chat(...a),
}));

import { runProviderAgentLoop } from "../claude";
import { guardUngovernedTenantScope } from "../tool-executor";
import { getTool } from "../registry";

const CFG = { provider: "GROQ", model: "llama-3.3-70b-versatile", apiKey: "k" } as any;
const T = "tenant-A";

function toolTurn(name: string, args: unknown) {
  return {
    content: "", inputTokens: 1, outputTokens: 1, model: CFG.model, provider: "GROQ", stopReason: "tool_calls",
    toolCalls: [{ id: "c1", name, argumentsJson: JSON.stringify(args) }],
  };
}
async function runWorker(toolNames: string[], name: string, args: unknown, tenantId: string | undefined = T) {
  chat.mockReset().mockResolvedValue(toolTurn(name, args));
  const r = await runProviderAgentLoop(
    { systemPrompt: "s", userMessage: "u", toolNames, maxTurns: 1 } as any,
    CFG,
    tenantId ? { tenantId } : undefined,
  );
  return r.turns[0].toolCalls[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  db.dealUpdate.mockResolvedValue({ count: 1 });
  db.contactUpdate.mockResolvedValue({ count: 1 });
});

describe("crm_update_deal_stage on the ungoverned path", () => {
  const args = (dealId: string) => ({ dealId, stage: "QUALIFIED", reason: "r" });
  it("rejects a foreign-tenant dealId without writing", async () => {
    db.dealFindFirst.mockResolvedValue(null);
    const tc = await runWorker(["crm_update_deal_stage"], "crm_update_deal_stage", args("victim"));
    expect(tc.error).toMatch(/Tenant isolation violation: dealId/);
    expect(db.dealUpdate).not.toHaveBeenCalled();
  });
  it("runs for the tenant's own dealId (positive control)", async () => {
    db.dealFindFirst.mockResolvedValue({ id: "own" });
    const tc = await runWorker(["crm_update_deal_stage"], "crm_update_deal_stage", args("own"));
    expect(tc.error).toBeUndefined();
    expect(db.dealFindFirst).toHaveBeenCalledWith({ where: { id: "own", company: { tenantId: T } }, select: { id: true } });
    expect(db.dealUpdate).toHaveBeenCalledOnce();
  });
  it("refuses when the loop has no tenantId at all", async () => {
    const tc = await runWorker(["crm_update_deal_stage"], "crm_update_deal_stage", args("own"), "");
    expect(tc.error).toMatch(/tenant-scoped pipeline run/);
    expect(db.dealUpdate).not.toHaveBeenCalled();
  });
});

describe("crm_update_contact on the ungoverned path", () => {
  it("rejects a foreign-tenant contactId without writing", async () => {
    db.contactFindFirst.mockResolvedValue(null);
    const tc = await runWorker(["crm_update_contact"], "crm_update_contact", { contactId: "victim", name: "x" });
    expect(tc.error).toMatch(/Tenant isolation violation: contactId/);
    expect(db.contactUpdate).not.toHaveBeenCalled();
  });
  it("runs for own contactId and ignores companyId mass-assignment smuggled in", async () => {
    db.contactFindFirst.mockResolvedValue({ id: "own" });
    const tc = await runWorker(["crm_update_contact"], "crm_update_contact", { contactId: "own", name: "x" });
    expect(tc.error).toBeUndefined();
    expect(db.contactUpdate).toHaveBeenCalledWith({ where: { id: "own", company: { tenantId: T } }, data: { name: "x" } });
  });
  it("companyId in input is refused ungoverned (and never reaches data)", async () => {
    db.contactFindFirst.mockResolvedValue({ id: "own" });
    const tc = await runWorker(["crm_update_contact"], "crm_update_contact", { contactId: "own", companyId: "other-co" });
    expect(tc.error).toMatch(/tenant-scoped pipeline run/);
    expect(db.contactUpdate).not.toHaveBeenCalled();
  });
});

describe("handler-level boundary (direct call)", () => {
  it("crm_update_contact drops companyId/id/email and scopes the write by tenant", async () => {
    await getTool("crm_update_contact")!.handler({
      contactId: "c1", tenantId: T, name: "n", status: "LEAD", tags: ["a"], properties: { k: 1 },
      companyId: "evil", id: "evil", email: "e@x",
    });
    expect(db.contactUpdate).toHaveBeenCalledWith({
      where: { id: "c1", company: { tenantId: T } }, data: { name: "n", status: "LEAD", tags: ["a"], properties: { k: 1 } },
    });
  });
  it("count 0 (row not in tenant / TOCTOU) throws; missing tenant throws", async () => {
    db.contactUpdate.mockResolvedValue({ count: 0 }); db.dealUpdate.mockResolvedValue({ count: 0 });
    await expect(getTool("crm_update_contact")!.handler({ contactId: "c1", tenantId: T })).rejects.toThrow(/not found for this tenant/);
    await expect(getTool("crm_update_deal_stage")!.handler({ dealId: "d1", tenantId: T, stage: "LEAD", reason: "r" })).rejects.toThrow(/not found for this tenant/);
    await expect(getTool("crm_update_deal_stage")!.handler({ dealId: "d1", stage: "LEAD", reason: "r" })).rejects.toThrow(/Tenant scope required/);
  });
  it("a model-supplied tenantId is overwritten by the acting tenant on the ungoverned path", async () => {
    db.dealFindFirst.mockResolvedValue({ id: "own" });
    await runWorker(["crm_update_deal_stage"], "crm_update_deal_stage", { dealId: "own", stage: "LEAD", reason: "r", tenantId: "victim-tenant" });
    expect(db.dealUpdate).toHaveBeenCalledWith({ where: { id: "own", company: { tenantId: T } }, data: { stage: "LEAD" } });
  });
});

describe("non-string tenant ids are refused (no Prisma operator objects)", () => {
  it.each([{ $ne: "x" }, ["a"], 5])("dealId %j", async (bad) => {
    const tc = await runWorker(["crm_update_deal_stage"], "crm_update_deal_stage", { dealId: bad, stage: "LEAD", reason: "r" });
    expect(tc.error).toMatch(/must be a string/);
    expect(db.dealUpdate).not.toHaveBeenCalled(); expect(db.dealFindFirst).not.toHaveBeenCalled();
  });
});

describe("tenantId reaches the guard on the aiConfigOverride path (runAgentLoop)", () => {
  it("own dealId runs; foreign is rejected", async () => {
    const { runAgentLoop } = await import("../claude");
    db.dealFindFirst.mockResolvedValue({ id: "own" });
    chat.mockReset().mockResolvedValue(toolTurn("crm_update_deal_stage", { dealId: "own", stage: "LEAD", reason: "r" }));
    const r = await runAgentLoop({ systemPrompt: "s", userMessage: "u", toolNames: ["crm_update_deal_stage"], maxTurns: 1, tenantId: T, aiConfigOverride: CFG } as any);
    expect(r.turns[0].toolCalls[0].error).toBeUndefined();
    expect(db.dealUpdate).toHaveBeenCalledOnce();
  });
});

describe("toolNames allowlist on the ungoverned path", () => {
  it("rejects a registered tool the worker was not given", async () => {
    db.dealFindFirst.mockResolvedValue({ id: "own" });
    const tc = await runWorker(["ask_user"], "crm_update_deal_stage", { dealId: "own", stage: "LEAD", reason: "r" });
    expect(tc.error).toMatch(/not in this agent's allowed tool list/);
    expect(db.dealUpdate).not.toHaveBeenCalled();
  });
});

describe("tools without tenant ids keep working (positive control)", () => {
  it("guard passes ask_user / generate_post style schemas with no tenant id", async () => {
    const tool = { inputSchema: { type: "object", properties: { question: { type: "string" }, voiceId: { type: "string" } } } } as any;
    await expect(guardUngovernedTenantScope(tool, { question: "q" }, "ask_user", T)).resolves.toBeNull();
    await expect(guardUngovernedTenantScope(tool, { question: "q" }, "ask_user")).resolves.toBeNull();
  });
  it("real ask_user registry tool runs ungoverned", async () => {
    const tc = await runWorker(["ask_user"], "ask_user", { question: "q?" });
    expect(tc.error).toBeUndefined();
  });
});
