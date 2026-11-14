/**
 * BRA-P0-07 — tenant isolation at the tool boundary (negative, fail-closed).
 * Real executeTool + real registry tools; persistence synthetic. Complements
 * cross-tenant.test (real Postgres, HTTP routes) and tool-tenant-scope.test.
 * Asserts: a foreign reference is refused with a response that does not reveal
 * whether the record exists elsewhere; connector tools/lookups are keyed by the
 * acting tenant; and (SEC-BRA-06) tenant-scoped registry tools always run
 * against the acting company, whatever companyId the model supplies.
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
const tcCountFn = vi.hoisted(() => vi.fn());
const runCountFn = vi.hoisted(() => vi.fn());
const draftCountFn = vi.hoisted(() => vi.fn());
const stepCountFn = vi.hoisted(() => vi.fn());

vi.mock("../../lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("../../lib/db", () => ({
  prisma: {
    company: { findFirst: companyFindFirst },
    contact: { findMany: contactFindMany, findFirst: vi.fn().mockResolvedValue(null) },
    deal: { findFirst: dealFindFirst },
    outreachSequence: { findFirst: sequenceFindFirst },
    voiceAgent: { findFirst: voiceFindFirst },
    externalConnection: { findFirst: connFindFirst },
    tenantConnector: { findFirst: tcFindFirst, findMany: tcFindMany },
    toolCall: { create: toolCallCreate, count: tcCountFn },
    run: { count: runCountFn },
    draft: { count: draftCountFn, findFirst: draftFindFirst },
    runStep: { count: stepCountFn },
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
  for (const m of [companyFindFirst, contactFindMany, dealFindFirst, draftFindFirst, sequenceFindFirst, voiceFindFirst, connFindFirst, tcFindFirst, tcFindMany, toolCallCreate, tcCountFn]) m.mockReset();
  tcCountFn.mockResolvedValue(0);
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

describe("SEC-BRA-06: tenant-scoped registry tools always run against the ACTING company", () => {
  // The model's companyId is never trusted: absent -> injected, other company /
  // non-string (Prisma operator object, array, null) -> refused before the handler.
  const prismaRun = { count: runCountFn }, prismaDraft = { count: draftCountFn }, prismaStep = { count: stepCountFn }, prismaTc = { count: tcCountFn };
  const TOOLS: Array<[string, Record<string, unknown>]> = [
    ["crm_search_contacts", { query: "a" }],
    ["fetch_metrics", { metric: "all" }],
    ["generate_report", { reportType: "weekly" }],
    ["compare_performance", {}],
  ];
  const BAD: Array<[string, unknown]> = [
    ["another tenant's company", "co-of-tenant-b"],
    ["Prisma operator object", { not: "x" }],
    ["array", ["co-a", "co-of-tenant-b"]],
    ["null", null],
  ];

  /** every `companyId` value that reached a Prisma query, at any depth */
  function seenCompanyIds(): unknown[] {
    const out: unknown[] = [];
    const walk = (v: unknown) => {
      if (!v || typeof v !== "object") return;
      for (const [k, x] of Object.entries(v)) { if (k === "companyId") out.push(x); walk(x); }
    };
    for (const m of [contactFindMany, prismaRun.count, prismaDraft.count, prismaStep.count, prismaTc.count]) walk(m.mock.calls);
    return out;
  }

  beforeEach(() => {
    companyFindFirst.mockImplementation(async ({ where }: any) =>
      where.OR.some((o: any) => o.id === "co-a") ? { id: "co-a", tenantId: "tenant-a" } : null);
    for (const m of [prismaRun.count, prismaDraft.count, prismaStep.count, prismaTc.count]) m.mockReset().mockResolvedValue(0);
  });

  it.each(TOOLS)("%s: companyId omitted -> runs, and every query is scoped to the acting company", async (name, extra) => {
    const res = await executeTool(name, { ...extra }, ctx);
    expect(res.status).toBe("COMPLETED");
    const ids = seenCompanyIds();
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.every((id) => id === "co-a")).toBe(true);
  });

  it.each(TOOLS)("%s: the acting company's own id still works (no regression)", async (name, extra) => {
    const res = await executeTool(name, { ...extra, companyId: "co-a" }, ctx);
    expect(res.status).toBe("COMPLETED");
    expect(seenCompanyIds().every((id) => id === "co-a")).toBe(true);
  });

  describe.each(TOOLS)("%s", (name, extra) => {
    it.each(BAD)("companyId = %s -> FAILED, generic message, no query", async (_label, bad) => {
      const res = await executeTool(name, { ...extra, companyId: bad }, ctx);
      expect(res.status).toBe("FAILED");
      expect(res.error).toBe(DENIED);
      expect(JSON.stringify(res)).not.toMatch(/tenant-b|tenant-a|co-of-tenant|co-a/);
      expect(seenCompanyIds()).toEqual([]);
      expect(contactFindMany).not.toHaveBeenCalled();
    });
  });

  it("a connector tool's own companyId argument is not rewritten (belongs to the remote server)", async () => {
    const { handler, extraTools } = probe("mcp_x_remote");
    await executeTool("mcp_x_remote", { note: "n" }, { ...ctx, extraTools });
    expect(handler).toHaveBeenCalledWith({ note: "n" });
  });
});
