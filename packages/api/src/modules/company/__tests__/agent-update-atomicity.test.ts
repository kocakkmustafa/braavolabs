import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ prisma: {} as any, tenantTx: vi.fn() }));
vi.mock("../../../lib/db", () => db);
vi.mock("../../../lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../../../middleware/auth", () => ({ authMiddleware: vi.fn() }));
vi.mock("../../../middleware/require-permission", () => ({ requirePermission: () => vi.fn() }));
vi.mock("../../../middleware/rateLimit", () => ({ rateLimit: () => vi.fn() }));
vi.mock("../builder", () => ({ startBuildSession: vi.fn(), continueBuildSession: vi.fn(), confirmBuild: vi.fn(), getSession: vi.fn() }));
vi.mock("../../agent/composer", () => ({ composeAgent: vi.fn() }));
vi.mock("../company-capacity", () => ({ assertCompanyCapacity: vi.fn() }));
vi.mock("../../billing/entitlement-ledger.service", () => ({ getEffectivePlan: vi.fn() }));

import { companyRouter } from "../router";
import { errorHandler } from "../../../middleware/error";
import { Prisma } from "@prisma/client";

// Model the Prisma argument boundary from the real generated schema metadata.
// No database/engine call: the old fixture accepted fields Prisma cannot store.
const agentFields = new Set(Prisma.dmmf.datamodel.models.find(model => model.name === "Agent")!.fields.map(field => field.name));

type State = { agent: any; versions: any[]; audits: any[] };
let committed: State;
let failure: "snapshot" | "update" | "audit" | undefined;
let order: string[];
let scopedQueries: Array<{ operation: string; where: any }>;

function client(state: State) {
  return {
    $queryRaw: async (sql: TemplateStringsArray, ...values: string[]) => {
      order.push("lock");
      expect(sql.join("?")).toContain("FOR UPDATE OF a");
      expect(values).toEqual(["agent-a", "company-a", "tenant-a"]);
      return state.agent ? [{ id: "agent-a" }] : [];
    },
    company: { findFirst: async ({ where }: any) =>
      where.id === "company-a" && where.tenantId === "tenant-a" ? { id: "company-a" } : null },
    agent: {
      findFirst: async ({ where }: any) => {
        scopedQueries.push({ operation: "agent.read", where });
        order.push("read"); return state.agent ? structuredClone(state.agent) : null;
      },
      findUnique: async () => state.agent ? structuredClone(state.agent) : null,
      update: async ({ where, data }: any) => {
        scopedQueries.push({ operation: "agent.update", where });
        order.push("update");
        for (const [field, value] of Object.entries(data)) {
          if (value !== undefined && !agentFields.has(field)) {
            throw new Prisma.PrismaClientValidationError(`Unknown argument ${field}`, { clientVersion: Prisma.prismaVersion.client });
          }
        }
        if (failure === "update") throw new Error("injected update failure");
        Object.assign(state.agent, data);
        return structuredClone(state.agent);
      },
    },
    agentVersion: {
      findFirst: async ({ where }: any) => {
        scopedQueries.push({ operation: "history.read", where });
        return state.versions.at(-1) ?? null;
      },
      create: async ({ data }: any) => {
        order.push("snapshot");
        if (failure === "snapshot") throw new Error("injected snapshot failure");
        state.versions.push(structuredClone(data));
        return data;
      },
    },
    activityLog: { create: async ({ data }: any) => {
      order.push("audit");
      if (failure === "audit") throw new Error("injected audit failure");
      state.audits.push(structuredClone(data));
      return data;
    } },
  };
}

beforeEach(() => {
  failure = undefined; order = []; scopedQueries = [];
  committed = { agent: { id: "agent-a", companyId: "company-a", name: "Old", role: "test",
    systemPrompt: "old prompt", tools: [], model: "synthetic-model", maxTokens: 4096, autonomy: "BALANCED" },
  versions: [], audits: [] };
  Object.assign(db.prisma, client(committed));
  db.tenantTx.mockReset().mockImplementation(async (fn: any) => {
    const pending = structuredClone(committed);
    const result = await fn(client(pending));
    committed = pending;
    return result;
  });
});

const modes = ["patch", "nl"] as const;
function handler(mode: typeof modes[number]) {
  const path = mode === "patch" ? "/:companyId/agents/:agentId" : "/:companyId/agents/:agentId/nl-edit/apply";
  return (companyRouter as any).stack.find((l: any) => l.route?.path === path &&
    l.route.methods[mode === "patch" ? "patch" : "post"]).route.stack.at(-1).handle;
}
async function invoke(mode: typeof modes[number], tenantId = "tenant-a", body?: any) {
  const res = { body: undefined as any, json(value: any) { this.body = value; return this; } };
  let error: any;
  await handler(mode)({
    params: { companyId: "company-a", agentId: "agent-a" }, auth: { tenantId, userId: "actor-a" },
    body: body ?? (mode === "patch" ? { autonomy: "SUPERVISED" } : { updatedConfig: {
      name: "New", role: "edited", systemPrompt: "new prompt", model: "synthetic-model-2",
      temperature: 0.4, maxTokens: 2048, tools: [],
    } }),
  }, res, (err: any) => { error = err; });
  return { res, error };
}

describe.each(modes)("%s agent history transaction", mode => {
  it("commits the pre-edit snapshot, update and actor audit together", async () => {
    const { res, error } = await invoke(mode);
    expect(error).toBeUndefined();
    expect(db.tenantTx).toHaveBeenCalledOnce();
    expect(order).toEqual(["lock", "read", "snapshot", "update", "audit"]);
    expect(committed.versions).toHaveLength(1);
    expect(committed.versions[0]).toMatchObject({ version: 1, createdBy: "actor-a",
      snapshot: { name: "Old", autonomy: "BALANCED" } });
    expect(committed.audits).toHaveLength(1);
    expect(committed.audits[0]).toMatchObject({ tenantId: "tenant-a", actor: "actor-a", resourceId: "agent-a" });
    if (mode === "patch") expect(res.body.autonomy).toBe("SUPERVISED");
    else expect(res.body).toMatchObject({ success: true, version: 1, agent: { name: "New" } });
  });

  it.each(["snapshot", "update", "audit"] as const)("rolls back every write after %s fails", async stage => {
    failure = stage;
    const before = structuredClone(committed);
    const { res, error } = await invoke(mode);
    expect(error?.message).toBe(`injected ${stage} failure`);
    expect(res.body).toBeUndefined();
    expect(committed).toEqual(before);
  });

  it("denies a foreign company without snapshot, update or audit", async () => {
    const before = structuredClone(committed);
    const { error } = await invoke(mode, "tenant-b");
    expect(error).toMatchObject({ statusCode: 404 });
    expect(committed).toEqual(before);
    expect(order).toEqual([]);
  });

  it("denies a missing agent before history writes", async () => {
    committed.agent = null;
    const { error } = await invoke(mode);
    expect(error).toMatchObject({ statusCode: 404 });
    expect(committed.versions).toEqual([]);
    expect(committed.audits).toEqual([]);
  });

  it("rejects invalid edits before starting a transaction", async () => {
    const { error } = await invoke(mode, "tenant-a", mode === "patch" ? { autonomy: "INVALID" } : { updatedConfig: {} });
    expect(error?.name).toBe("ZodError");
    expect(db.tenantTx).not.toHaveBeenCalled();
  });
});


describe("unsupported PATCH config — native validation response", () => {
  it.each([
    { config: {} },
    { name: "New", config: {} },
    { model: "synthetic-model-2", config: { model: "nested-model" } },
    { config: { customFlag: true } },
  ])("rejects $config before a history transaction", async body => {
    const before = structuredClone(committed);
    const { res, error } = await invoke("patch", "tenant-a", body);
    const http = {
      code: 200, body: undefined as any,
      status(code: number) { this.code = code; return this; },
      json(body: any) { this.body = body; return this; },
    };
    if (error) errorHandler(error, { path: "/agents/agent-a", method: "PATCH" } as any, http as any, vi.fn());
    expect(http.code).toBe(400);
    expect(http.body).toMatchObject({ error: "Validation error", details: expect.arrayContaining([
      expect.objectContaining({ path: ["config"] }),
    ]) });
    expect(res.body).toBeUndefined();
    expect(db.tenantTx).not.toHaveBeenCalled();
    expect(order).toEqual([]);
    expect(committed).toEqual(before);
  });

  it("keeps all supported flat configuration fields and atomic history/audit", async () => {
    const fields = { name: "New", role: "edited", systemPrompt: "new prompt", model: "synthetic-model-2",
      maxTokens: 2048, tools: ["web_search"], autonomy: "SUPERVISED" };
    const { res, error } = await invoke("patch", "tenant-a", fields);
    expect(error).toBeUndefined();
    expect(res.body).toMatchObject(fields);
    expect(res.body).not.toHaveProperty("config");
    expect(committed.versions[0].snapshot).toMatchObject({ name: "Old", model: "synthetic-model", autonomy: "BALANCED" });
    expect(committed.audits[0]).toMatchObject({ action: "agent.update", tenantId: "tenant-a", actor: "actor-a" });
  });

  it("preserves the existing unknown-key stripping contract", async () => {
    const { res, error } = await invoke("patch", "tenant-a", { model: "synthetic-model-2", unrecognizedField: true });
    expect(error).toBeUndefined();
    expect(res.body.model).toBe("synthetic-model-2");
    expect(res.body).not.toHaveProperty("unrecognizedField");
  });
});

describe.each(modes)("%s per-query tenant predicate policy", mode => {
  it("scopes both agent queries and the version read while preserving their IDs", async () => {
    const { error } = await invoke(mode);
    expect(error).toBeUndefined();
    expect(scopedQueries).toEqual([
      { operation: "agent.read", where: { id: "agent-a", companyId: "company-a", company: { tenantId: "tenant-a" } } },
      { operation: "history.read", where: { agentId: "agent-a", agent: { company: { tenantId: "tenant-a" } } } },
      { operation: "agent.update", where: { id: "agent-a", company: { tenantId: "tenant-a" } } },
    ]);
    expect(order).toEqual(["lock", "read", "snapshot", "update", "audit"]);
  });
});
