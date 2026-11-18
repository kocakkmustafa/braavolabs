/** BRA-UX-API-03k: plan-wide agent quota mechanism (flag default OFF, no invented numbers). */
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
import { AGENT_LIMIT_CODE, AGENT_QUOTA_BY_PLAN, assertAgentCapacity, createAgentGuarded } from "../agent-capacity";

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
