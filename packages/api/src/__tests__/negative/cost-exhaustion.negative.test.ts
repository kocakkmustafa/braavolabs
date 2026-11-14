/**
 * BRA-P0-07 — cost / abuse exhaustion (negative, fail-closed).
 * Once a ceiling is reached the next tool call is refused WITHOUT reaching the
 * handler / upstream: connector spend cap, per-tool rate limit, governance
 * cost-anomaly stop (+ missing run). Run-level job budget lives in
 * job-budget.test.ts / hierarchical-budget.test.ts (existing).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const spendUpdate = vi.hoisted(() => vi.fn());
const findFirst = vi.hoisted(() => vi.fn());
const callTool = vi.hoisted(() => vi.fn());
const decrypt = vi.hoisted(() => vi.fn());
const toolCallCount = vi.hoisted(() => vi.fn());
const runFindUnique = vi.hoisted(() => vi.fn());
const activityCreate = vi.hoisted(() => vi.fn());

vi.mock("../../lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("../../lib/db", () => ({
  prisma: {
    tenantConnector: { findFirst, update: spendUpdate, updateMany: async () => ({ count: 1 }) },
    toolCall: { count: toolCallCount, create: vi.fn().mockResolvedValue({}), findMany: vi.fn().mockResolvedValue([]) },
    run: { findUnique: runFindUnique },
    activityLog: { create: activityCreate, findFirst: vi.fn().mockResolvedValue(null) },
  },
}));
vi.mock("../../lib/encryption", () => ({ decrypt }));
vi.mock("../../lib/mcp", () => ({ callTool }));
vi.mock("../../services/push", () => ({ notifyTenantUsers: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../lib/runEvents", () => ({ publishRunEvent: vi.fn().mockResolvedValue(undefined) }));

import { executeMcpTool } from "../../modules/marketplace/dynamic-tools";
import { executeTool } from "../../modules/agent/tool-executor";
import { runGovernanceChecks } from "../../modules/governance/engine";
import type { ToolDefinition } from "../../modules/agent/registry";

const install = (over: Record<string, unknown> = {}) => ({
  id: "inst-1", spendUsd: 0, spendCapUsd: 10, encryptedCredentials: "enc", revokedAt: null,
  audience: "https://mcp.acme.example", scopes: [],
  connector: { id: "conn-1", slug: "acme", mcpServerUrl: "https://mcp.acme.example/rpc", authMethod: "API_KEY" },
  ...over,
});

beforeEach(() => {
  for (const m of [spendUpdate, findFirst, callTool, decrypt, toolCallCount, runFindUnique, activityCreate]) m.mockReset();
  decrypt.mockReturnValue(JSON.stringify({ apiKey: "k" }));
  callTool.mockResolvedValue({ content: [] });
  activityCreate.mockResolvedValue({});
});

describe("connector spend cap", () => {
  it.each([[10], [10.01], [9999]])("spend %s >= cap 10 → refused before decrypt and upstream", async (spent) => {
    findFirst.mockResolvedValue(install({ spendUsd: spent }));
    const out = (await executeMcpTool("tenant-a", "acme", "lookup", {})) as { error: string };
    expect(out.error).toMatch(/spend cap/);
    expect(decrypt).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
  });

  it("just under the cap still runs (control: the refusal above is the cap, not a blanket failure)", async () => {
    findFirst.mockResolvedValue(install({ spendUsd: 9.99 }));
    await executeMcpTool("tenant-a", "acme", "lookup", {});
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it("an upstream cost hint can only raise spend: negative is ignored, a huge hint is clamped to 100", async () => {
    findFirst.mockResolvedValue(install());
    callTool.mockResolvedValueOnce({ content: [], meta: { costUsd: -500 } });
    await executeMcpTool("tenant-a", "acme", "lookup", {});
    expect(spendUpdate).not.toHaveBeenCalled();
    callTool.mockResolvedValueOnce({ content: [], meta: { costUsd: 1e12 } });
    await executeMcpTool("tenant-a", "acme", "lookup", {});
    expect(spendUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: { spendUsd: { increment: 100 } } }));
  });

  it("through executeTool: a capped connector tool never calls the upstream", async () => {
    findFirst.mockResolvedValue(install({ spendUsd: 10 }));
    const tool: ToolDefinition = {
      name: "mcp_acme_lookup", description: "x", inputSchema: { type: "object", properties: {} },
      meta: { requiresApproval: false, riskLevel: "low" },
      handler: (a) => executeMcpTool("tenant-a", "acme", "lookup", a),
    };
    const res = await executeTool(tool.name, {}, { runId: "r", companyId: "c", tenantId: "tenant-a", autonomy: "AUTONOMOUS", extraTools: new Map([[tool.name, tool]]) });
    expect(res.output).toMatchObject({ error: expect.stringMatching(/spend cap/) });
    expect(callTool).not.toHaveBeenCalled();
  });
});

describe("per-tool rate limit", () => {
  const handler = vi.fn().mockResolvedValue({ ok: true });
  const tool: ToolDefinition = {
    name: "mcp_x_ping", description: "x", inputSchema: { type: "object", properties: {} },
    meta: { requiresApproval: false, riskLevel: "low", rateLimit: 5 }, handler,
  };
  const run = () => executeTool(tool.name, {}, { runId: "r", companyId: "c", tenantId: "t", autonomy: "AUTONOMOUS", extraTools: new Map([[tool.name, tool]]) });

  beforeEach(() => handler.mockClear());

  it.each([[5], [6], [1000]])("%s calls in the last minute (limit 5) → FAILED, handler not invoked", async (n) => {
    toolCallCount.mockResolvedValue(n);
    const res = await run();
    expect(res.status).toBe("FAILED");
    expect(res.error).toMatch(/Rate limit exceeded/);
    expect(handler).not.toHaveBeenCalled();
  });

  it("4 calls (limit 5) still runs (control)", async () => {
    toolCallCount.mockResolvedValue(4);
    expect((await run()).status).toBe("COMPLETED");
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe("governance run-level stops", () => {
  const runRow = (over: Record<string, unknown> = {}) => ({
    id: "run-1", jobBudget: null, budgetUsd: 10, tenantId: null, workspaceId: null, retryCount: 0, startedAt: null, steps: [],
    pipeline: { company: { id: "co-1", tenantId: "tenant-1" } }, ...over,
  });

  it("cost above 20% of the run budget → stopped, and the stop is audited", async () => {
    runFindUnique.mockResolvedValue(runRow());
    const res = await runGovernanceChecks("run-1", 2.5);
    expect(res).toMatchObject({ allowed: false, stopType: "cost_anomaly_stop" });
    expect(activityCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ tenantId: "tenant-1", action: "governance.cost_anomaly_stop" }) }));
  });

  it("cost at/below the threshold passes (control)", async () => {
    runFindUnique.mockResolvedValue(runRow());
    expect((await runGovernanceChecks("run-1", 2)).allowed).toBe(true);
  });

  it("a run that cannot be loaded fails closed (hard_stop), never 'allowed'", async () => {
    runFindUnique.mockResolvedValue(null);
    expect(await runGovernanceChecks("ghost", 0)).toMatchObject({ allowed: false, stopType: "hard_stop" });
  });

  it("an exhausted job budget stops the run before any org-wide check runs", async () => {
    runFindUnique.mockResolvedValue(runRow({ jobBudget: { maxUsd: 1 } }));
    const res = await runGovernanceChecks("run-1", 1);
    expect(res).toMatchObject({ allowed: false, stopType: "hard_stop", details: { jobBudget: "exhausted" } });
  });
});
