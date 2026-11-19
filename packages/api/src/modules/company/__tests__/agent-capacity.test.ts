/** BRA-UX-API-03k: plan-wide agent quota mechanism (flag default OFF, no invented numbers). */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";

const h = vi.hoisted(() => ({
  env: { AGENT_QUOTA_ENABLED: false },
  prismaCreate: vi.fn(),
  tenantTx: vi.fn(),
}));
vi.mock("../../../config/env", () => ({ env: h.env }));
vi.mock("../../../lib/db", () => ({ prisma: { agent: { create: h.prismaCreate } }, tenantTx: h.tenantTx }));
vi.mock("../../../lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn() } }));
import { AGENT_LIMIT_CODE, AGENT_QUOTA_BY_PLAN, assertAgentCapacity, createAgentGuarded, precheckAgentCapacity } from "../agent-capacity";

function transaction(plan: string | null, count: number) {
  const query = vi.fn().mockResolvedValue(plan === null ? [] : [{ plan }]);
  const agentCount = vi.fn().mockResolvedValue(count);
  const agentCreate = vi.fn().mockResolvedValue({ id: "a1" });
  const tx = {
    $queryRaw: query,
    agent: { count: agentCount, create: agentCreate },
    entitlementEvent: { findMany: vi.fn().mockResolvedValue([]) },
  } as unknown as Prisma.TransactionClient;
  return { tx, query, agentCount, agentCreate };
}

beforeEach(() => {
  h.env.AGENT_QUOTA_ENABLED = false;
  h.prismaCreate.mockReset().mockResolvedValue({ id: "plain" });
  h.tenantTx.mockReset();
});

describe("no invented numbers", () => {
  it("the shipped quota table is empty: the founder sets the numbers", () => {
    expect(AGENT_QUOTA_BY_PLAN).toEqual({});
  });
  it("with the shipped (empty) table nothing is ever limited and nothing is counted", async () => {
    const { tx, agentCount } = transaction("INDIVIDUAL", 10_000);
    await expect(assertAgentCapacity(tx, "tenant-1")).resolves.toBeUndefined();
    expect(agentCount).not.toHaveBeenCalled();
  });
});

describe("assertAgentCapacity (mechanism, injected table)", () => {
  const quota = { INDIVIDUAL: 2, TEAM: 0 };

  it.each([
    ["INDIVIDUAL", 0, 0],
    ["INDIVIDUAL", 1, 0],
    ["INDIVIDUAL", 2, 402],
    ["INDIVIDUAL", 7, 402],
    ["TEAM", 0, 402], // a 0 quota is a real limit, not "unset"
    ["PRO", 999, 402], // keys are the EFFECTIVE plan: legacy PRO resolves to TEAM (quota 0 here)
    ["BUSINESS", 999, 0], // a plan with no entry has no cap
  ])("%s with %i agents -> %i", async (plan, count, expected) => {
    const { tx } = transaction(plan, count);
    const run = assertAgentCapacity(tx, "tenant-1", quota);
    if (expected) await expect(run).rejects.toMatchObject({ statusCode: 402, code: AGENT_LIMIT_CODE });
    else await expect(run).resolves.toBeUndefined();
  });

  it("locks the tenant row first, counts through Agent -> Company -> tenantId, and reports plan/limit/current", async () => {
    const { tx, query, agentCount } = transaction("INDIVIDUAL", 2);
    await expect(assertAgentCapacity(tx, "tenant-1", quota)).rejects.toMatchObject({
      statusCode: 402,
      code: "AGENT_LIMIT_REACHED",
      details: { plan: "INDIVIDUAL", limit: 2, current: 2 },
    });
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0][0].join("?")).toMatch(/FOR UPDATE/);
    expect(query.mock.calls[0][1]).toBe("tenant-1");
    expect(agentCount).toHaveBeenCalledWith({ where: { company: { tenantId: "tenant-1" } } });
  });

  it("unknown tenant -> 401", async () => {
    const { tx } = transaction(null, 0);
    await expect(assertAgentCapacity(tx, "ghost", quota)).rejects.toMatchObject({ statusCode: 401 });
  });
});

describe("createAgentGuarded", () => {
  it("flag OFF (default): plain create, no transaction, no lock, no count", async () => {
    const create = vi.fn(async (db: { agent: { create: unknown } }) => (db.agent.create as typeof h.prismaCreate)({ data: {} }));
    await expect(createAgentGuarded("tenant-1", create)).resolves.toEqual({ id: "plain" });
    expect(h.tenantTx).not.toHaveBeenCalled();
    expect(h.prismaCreate).toHaveBeenCalledOnce();
  });

  it("flag ON: quota check and create run inside ONE tenantTx, check first (empty table = still allowed)", async () => {
    h.env.AGENT_QUOTA_ENABLED = true;
    const { tx, query, agentCreate } = transaction("INDIVIDUAL", 3);
    h.tenantTx.mockImplementation(async (fn: (t: Prisma.TransactionClient) => Promise<unknown>) => fn(tx));
    const create = vi.fn(async (db: { agent: { create: unknown } }) => (db.agent.create as typeof agentCreate)({ data: {} }));
    await expect(createAgentGuarded("tenant-1", create)).resolves.toEqual({ id: "a1" });
    expect(h.tenantTx).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.invocationCallOrder[0]).toBeLessThan(agentCreate.mock.invocationCallOrder[0]);
    expect(h.prismaCreate).not.toHaveBeenCalled();
  });

  it("flag ON + tenant quota error: create is never reached", async () => {
    h.env.AGENT_QUOTA_ENABLED = true;
    const { tx } = transaction(null, 0); // unknown tenant stands in for any assert failure
    h.tenantTx.mockImplementation(async (fn: (t: Prisma.TransactionClient) => Promise<unknown>) => fn(tx));
    const create = vi.fn();
    await expect(createAgentGuarded("ghost", create)).rejects.toMatchObject({ statusCode: 401 });
    expect(create).not.toHaveBeenCalled();
  });
});

describe("misconfigured numbers fail closed", () => {
  it.each([-1, 1.5, Number.NaN, Infinity])("quota %s throws instead of reading as unlimited", async (bad) => {
    const { tx } = transaction("INDIVIDUAL", 0);
    await expect(assertAgentCapacity(tx, "tenant-1", { INDIVIDUAL: bad })).rejects.toThrow(/invalid agent quota/);
  });
});

describe("precheckAgentCapacity (compose: refuse before spending LLM tokens)", () => {
  it("flag OFF: no transaction at all", async () => {
    await expect(precheckAgentCapacity("tenant-1")).resolves.toBeUndefined();
    expect(h.tenantTx).not.toHaveBeenCalled();
  });
  it("flag ON: runs the capacity check in a tenantTx", async () => {
    h.env.AGENT_QUOTA_ENABLED = true;
    const { tx, query } = transaction("INDIVIDUAL", 3);
    h.tenantTx.mockImplementation(async (fn: (t: Prisma.TransactionClient) => Promise<unknown>) => fn(tx));
    await expect(precheckAgentCapacity("tenant-1")).resolves.toBeUndefined(); // empty shipped table: unlimited
    expect(h.tenantTx).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledOnce();
  });
});

describe("router wiring guard (source level)", () => {
  const src = readFileSync(join(__dirname, "../router.ts"), "utf8");
  const handlerBody = (route: string) => {
    const start = src.indexOf(`companyRouter.post("${route}"`);
    expect(start, route).toBeGreaterThan(-1);
    const next = src.indexOf("companyRouter.", start + 10);
    return src.slice(start, next === -1 ? undefined : next);
  };
  it.each(["/:id/agents/compose", "/:id/agents/compose/draft"])("%s prechecks the quota BEFORE the LLM call", (route) => {
    const body = handlerBody(route);
    const pre = body.indexOf("precheckAgentCapacity(");
    const llm = body.indexOf("runComposer(");
    expect(pre, `${route} precheck`).toBeGreaterThan(-1);
    expect(llm, `${route} runComposer`).toBeGreaterThan(-1);
    expect(pre).toBeLessThan(llm);
  });
  it.each(["/:id/agents", "/:id/agents/compose/confirm"])("%s (and compose via persistComposedAgent) insert through createAgentGuarded", (route) => {
    expect(handlerBody(route)).toMatch(/createAgentGuarded|persistComposedAgent/);
  });
  it("no raw prisma.agent.create is left in the company router", () => {
    expect(src).not.toMatch(/prisma\.agent\.create\(/);
  });
});

describe("BRA-ADAY-9 batch rule: count + N", async () => {
  const { assertAgentBatchCapacity } = await import("../agent-capacity");
  const quota = { INDIVIDUAL: 5 };

  it.each([
    [0, 5, 0],
    [1, 4, 0],
    [1, 5, 402],
    [2, 3, 0],
    [3, 3, 402],
    [0, 0, 0],
  ])("count %i + adding %i -> %i (limit 5)", async (count, adding, expected) => {
    const { tx } = transaction("INDIVIDUAL", count);
    const run = assertAgentCapacity(tx, "t", quota, adding);
    if (expected) await expect(run).rejects.toMatchObject({ statusCode: 402, code: AGENT_LIMIT_CODE });
    else await expect(run).resolves.toBeUndefined();
  });

  it("a batch is refused whole and reports how many were being added", async () => {
    const { tx } = transaction("INDIVIDUAL", 4);
    await expect(assertAgentCapacity(tx, "t", quota, 3)).rejects.toMatchObject({
      details: { plan: "INDIVIDUAL", limit: 5, current: 4, adding: 3 },
    });
  });

  it.each([-1, 1.5, Number.NaN])("invalid adding %s throws", async (bad) => {
    const { tx } = transaction("INDIVIDUAL", 0);
    await expect(assertAgentCapacity(tx, "t", quota, bad)).rejects.toThrow(/invalid agent count/);
  });

  it("flag OFF: assertAgentBatchCapacity does no query at all", async () => {
    const { tx, query } = transaction("INDIVIDUAL", 99);
    await expect(assertAgentBatchCapacity(tx, "t", 10)).resolves.toBeUndefined();
    expect(query).not.toHaveBeenCalled();
  });

  it("adding 0: early return, no lock and no count", async () => {
    const { tx, query, agentCount } = transaction("INDIVIDUAL", 99);
    await expect(assertAgentCapacity(tx, "t", { INDIVIDUAL: 1 }, 0)).resolves.toBeUndefined();
    expect(query).not.toHaveBeenCalled();
    expect(agentCount).not.toHaveBeenCalled();
  });

  it("flag ON + injected table: assertAgentBatchCapacity passes flag and table through and throws 402", async () => {
    h.env.AGENT_QUOTA_ENABLED = true;
    AGENT_QUOTA_BY_PLAN.INDIVIDUAL = 5;
    try {
      const over = transaction("INDIVIDUAL", 4);
      await expect(assertAgentBatchCapacity(over.tx, "t", 2)).rejects.toMatchObject({
        statusCode: 402,
        code: AGENT_LIMIT_CODE,
        details: { plan: "INDIVIDUAL", limit: 5, current: 4, adding: 2 },
      });
      const fits = transaction("INDIVIDUAL", 3);
      await expect(assertAgentBatchCapacity(fits.tx, "t", 2)).resolves.toBeUndefined();
      expect(fits.agentCount).toHaveBeenCalledOnce();
    } finally {
      delete AGENT_QUOTA_BY_PLAN.INDIVIDUAL;
    }
  });

  it("flag ON with the shipped empty table: allowed, nothing counted", async () => {
    h.env.AGENT_QUOTA_ENABLED = true;
    const { tx, agentCount } = transaction("INDIVIDUAL", 99);
    await expect(assertAgentBatchCapacity(tx, "t", 10)).resolves.toBeUndefined();
    expect(agentCount).not.toHaveBeenCalled();
  });
});

describe("BRA-ADAY-9 wiring guard (source level)", () => {
  const files = [
    "../../starter/starter.router.ts",
    "../../templates/templates.service.ts",
    "../../onboarding/router.ts",
    "../builder.ts",
    "../../automation-importer/router.ts",
  ];
  it.each(files)("%s checks batch capacity BEFORE its first agent insert", (f) => {
    const src = readFileSync(join(__dirname, f), "utf8");
    const check = src.indexOf("assertAgentBatchCapacity(tx");
    const insert = src.indexOf("tx.agent.create(");
    expect(check, `${f} check`).toBeGreaterThan(-1);
    expect(insert, `${f} insert`).toBeGreaterThan(-1);
    expect(check).toBeLessThan(insert);
  });
});
