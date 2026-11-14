/**
 * BRA-P0-07 — tenant isolation at the tool boundary (negative, fail-closed).
 * Real executeTool + real registry tools; persistence synthetic. Complements
 * cross-tenant.test (real Postgres, HTTP routes) and tool-tenant-scope.test.
 * Asserts: a foreign reference is refused with a response that does not reveal
 * whether the record exists elsewhere; connector tools/lookups are keyed by the
 * acting tenant; and (KNOWN GAP, `it.fails`) a tenant-scoped tool called WITHOUT
 * a string companyId reaches Prisma unscoped.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const companyFindFirst = vi.hoisted(() => vi.fn());
const contactFindMany = vi.hoisted(() => vi.fn());
const dealFindFirst = vi.hoisted(() => vi.fn());
const draftFindFirst = vi.hoisted(() => vi.fn());
const sequenceFindFirst = vi.hoisted(() => vi.fn());
const voiceFindFirst = vi.hoisted(() => vi.fn());
const connFindFirst = vi.hoisted(() => vi.fn());
const tcFindFirst = vi.hoisted(() => vi.fn());
const tcFindMany = vi.hoisted(() => vi.fn());
const toolCallCreate = vi.hoisted(() => vi.fn());

vi.mock("../../lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("../../lib/db", () => ({
  prisma: {
    company: { findFirst: companyFindFirst },
    contact: { findMany: contactFindMany, findFirst: vi.fn().mockResolvedValue(null) },
    deal: { findFirst: dealFindFirst },
    draft: { findFirst: draftFindFirst },
    outreachSequence: { findFirst: sequenceFindFirst },
    voiceAgent: { findFirst: voiceFindFirst },
    externalConnection: { findFirst: connFindFirst },
    tenantConnector: { findFirst: tcFindFirst, findMany: tcFindMany },
    toolCall: { create: toolCallCreate, count: vi.fn().mockResolvedValue(0) },
    approval: { create: vi.fn() },
  },
}));
vi.mock("../../services/push", () => ({ notifyTenantUsers: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../lib/runEvents", () => ({ publishRunEvent: vi.fn().mockResolvedValue(undefined) }));

import { executeTool } from "../../modules/agent/tool-executor";
import { executeMcpTool, listConnectorToolsForTenant } from "../../modules/marketplace/dynamic-tools";
import type { ToolDefinition } from "../../modules/agent/registry";

const ctx = { runId: "run-1", runStepId: "step-1", companyId: "co-a", tenantId: "tenant-a", autonomy: "AUTONOMOUS" as const };
const DENIED = "Access denied: referenced record is not in your workspace";

beforeEach(() => {
  for (const m of [companyFindFirst, contactFindMany, dealFindFirst, draftFindFirst, sequenceFindFirst, voiceFindFirst, connFindFirst, tcFindFirst, tcFindMany, toolCallCreate]) m.mockReset();
  contactFindMany.mockResolvedValue([]);
  toolCallCreate.mockResolvedValue({});
  tcFindFirst.mockResolvedValue(null);
  tcFindMany.mockResolvedValue([]);
});

function probe(name: string) {
  const handler = vi.fn().mockResolvedValue({ ok: true });
  const t: ToolDefinition = { name, description: "x", inputSchema: { type: "object", properties: {} }, meta: { requiresApproval: false, riskLevel: "low" }, handler };
  return { handler, extraTools: new Map([[name, t]]) };
}

describe("foreign references are refused, identically, before the handler", () => {
  it("a foreign companyId and a non-existent one yield the SAME response (no existence oracle) and never reach the handler", async () => {
    const { handler, extraTools } = probe("probe_tool");
    companyFindFirst.mockResolvedValue(null); // scoped lookup finds nothing: foreign OR missing, indistinguishable
    const foreign = await executeTool("probe_tool", { companyId: "co-of-tenant-b" }, { ...ctx, extraTools });
    const missing = await executeTool("probe_tool", { companyId: "co-does-not-exist" }, { ...ctx, extraTools });
    for (const r of [foreign, missing]) {
      expect(r).toMatchObject({ status: "FAILED", output: null, error: DENIED });
    }
    expect(foreign.error).toBe(missing.error);
    expect(JSON.stringify([foreign, missing])).not.toMatch(/tenant-b|tenant-a|co-of-tenant/);
    expect(handler).not.toHaveBeenCalled();
    expect(toolCallCreate).not.toHaveBeenCalled();
  });

  it("the company lookup is always constrained by the acting tenant, for id, name and slug alike", async () => {
    const { extraTools } = probe("probe_tool");
    companyFindFirst.mockResolvedValue(null);
    await executeTool("probe_tool", { companyId: "Acme" }, { ...ctx, extraTools });
    const where = companyFindFirst.mock.calls[0]![0].where;
    expect(where.tenantId).toBe("tenant-a");
    expect(where.OR).toEqual([{ id: "Acme" }, { name: "Acme" }, { slug: "Acme" }]);
  });

  it.each([
    ["dealId", dealFindFirst],
    ["sequenceId", sequenceFindFirst],
    ["draftId", draftFindFirst],
    ["voiceAgentId", voiceFindFirst],
    ["connectionId", connFindFirst],
  ])("a foreign %s is refused with the same generic message and the handler never runs", async (field, finder) => {
    const { handler, extraTools } = probe("probe_tool");
    finder.mockResolvedValue(null);
    const res = await executeTool("probe_tool", { [field]: "row-of-tenant-b" }, { ...ctx, extraTools });
    expect(res).toMatchObject({ status: "FAILED", error: DENIED });
    expect(handler).not.toHaveBeenCalled();
    expect(JSON.stringify(finder.mock.calls[0]![0])).toContain("tenant-a"); // validator is tenant-keyed
  });

  it("CONTROL: the tenant's own company passes and the handler receives the canonical id", async () => {
    const { handler, extraTools } = probe("probe_tool");
    companyFindFirst.mockResolvedValue({ id: "co-a", tenantId: "tenant-a" });
    const res = await executeTool("probe_tool", { companyId: "acme-slug" }, { ...ctx, extraTools });
    expect(res.status).toBe("COMPLETED");
    expect(handler).toHaveBeenCalledWith({ companyId: "co-a" });
  });
});

describe("connector tools are tenant-keyed", () => {
  it("tenant A's connector tool is not resolvable by a request that carries no extraTools (tenant B)", async () => {
    const res = await executeTool("mcp_acme_lookup", {}, { ...ctx, tenantId: "tenant-b" });
    expect(res).toMatchObject({ status: "FAILED", error: expect.stringMatching(/not found/) });
  });

  it("the install lookups are filtered by the acting tenant (listing and call)", async () => {
    await listConnectorToolsForTenant("tenant-a");
    expect(tcFindMany.mock.calls[0]![0].where).toMatchObject({ tenantId: "tenant-a", isEnabled: true });
    await executeMcpTool("tenant-a", "acme", "lookup", {});
    expect(tcFindFirst.mock.calls[0]![0].where).toMatchObject({ tenantId: "tenant-a", isEnabled: true });
  });
});

describe("KNOWN GAP (tripwire, see PR): tenant-scoped registry tool without a string companyId", () => {
  // enforceTenantScopedCompany returns null (= "nothing to validate") when
  // companyId is absent or not a string, and the executor does not inject the
  // acting company. crm_search_contacts (plain registerTool, no zod) then runs
  // `contact.findMany({ where: { companyId, ... } })`: with companyId undefined
  // Prisma drops the filter; with an object it is a Prisma operator. Either way
  // the query is not scoped to the tenant. Production code is out of scope for
  // BRA-P0-07; `it.fails` goes red when it is fixed, forcing promotion.
  async function search(input: Record<string, unknown>) {
    return executeTool("crm_search_contacts", { query: "a", ...input }, ctx);
  }
  const scoped = () => {
    const where = contactFindMany.mock.calls[0]?.[0]?.where;
    return typeof where?.companyId === "string" && where.companyId === "co-a";
  };

  it.fails("companyId omitted → the query must still be scoped to the acting company", async () => {
    await search({});
    expect(contactFindMany).toHaveBeenCalledTimes(1); // it ran (so a red here is about scoping)
    expect(scoped()).toBe(true);
  });

  it.fails("companyId as a Prisma operator object → refused or coerced, never passed as a filter", async () => {
    await search({ companyId: { not: "co-of-tenant-b" } });
    expect(contactFindMany).toHaveBeenCalledTimes(1);
    expect(scoped()).toBe(true);
  });

  it("CONTROL: a string foreign companyId is blocked before the query", async () => {
    companyFindFirst.mockResolvedValue(null);
    const res = await search({ companyId: "co-of-tenant-b" });
    expect(res).toMatchObject({ status: "FAILED", error: DENIED });
    expect(contactFindMany).not.toHaveBeenCalled();
  });
});
