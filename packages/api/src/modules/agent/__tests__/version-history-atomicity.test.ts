import { beforeEach, describe, expect, it, vi } from "vitest";
const db = vi.hoisted(() => ({ prisma: {} as any, tenantTx: vi.fn() }));
const log = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn() }));
vi.mock("../../../lib/db", () => db);
vi.mock("../../../lib/logger", () => ({ logger: log }));
vi.mock("../../../middleware/auth", () => ({ authMiddleware: vi.fn() }));
import { agentVersionRouter } from "../version-router";

let state: any;
let fault: "snapshot" | "update" | "audit" | undefined;
const target = { name: "Target", role: "fixture", systemPrompt: "target prompt", model: "synthetic",
  maxTokens: 2048, tools: [], autonomy: "BALANCED" };
function client(data: any) {
  return {
    $queryRaw: async (sql: TemplateStringsArray, ...values: string[]) => {
      expect(sql.join("?")).toContain("FOR UPDATE OF a");
      return values[0] === "agent-a" && values[1] === "tenant-a" ? [{ id: "agent-a" }] : [];
    },
    agent: {
      findUnique: async () => ({ ...data.agent, company: { tenantId: "tenant-a" } }),
      update: async ({ data: changes }: any) => {
        if (fault === "update") throw new Error("injected update failure");
        Object.assign(data.agent, Object.fromEntries(Object.entries(changes).filter(([,v]) => v !== undefined)));
        return structuredClone(data.agent);
      },
    },
    agentVersion: {
      findFirst: async () => data.versions.at(-1),
      findUnique: async ({ where }: any) => data.versions.find((v: any) => v.version === where.agentId_version.version) ?? null,
      create: async ({ data: version }: any) => {
        if (fault === "snapshot") throw new Error("injected snapshot failure");
        const row = { id: "version-" + version.version, ...structuredClone(version) };
        data.versions.push(row); return row;
      },
    },
    activityLog: { create: async ({ data: audit }: any) => {
      if (fault === "audit") throw new Error("injected audit failure");
      data.audits.push(structuredClone(audit)); return audit;
    } },
  };
}
beforeEach(() => {
  vi.clearAllMocks(); fault = undefined;
  state = { agent: { id: "agent-a", ...target, name: "Current", autonomy: "SUPERVISED" },
    versions: [{ id: "version-1", version: 1, agentId: "agent-a", snapshot: { ...target } }], audits: [] };
  Object.assign(db.prisma, client(state));
  db.tenantTx.mockImplementation(async (fn: any) => {
    const pending = structuredClone(state); const result = await fn(client(pending)); state = pending; return result;
  });
});
async function invoke(kind: "snapshot" | "rollback", tenantId = "tenant-a", body?: any) {
  const path = kind === "snapshot" ? "/:id/versions" : "/:id/rollback";
  const handler = (agentVersionRouter as any).stack.find((l: any) => l.route?.path === path && l.route.methods.post).route.stack.at(-1).handle;
  let error: any;
  const res = { body: undefined as any, statusCode: 200,
    status(code: number) { this.statusCode = code; return this; }, json(value: any) { this.body = value; } };
  await handler({ params: { id: "agent-a" }, auth: { tenantId, userId: "actor-a" },
    body: body ?? (kind === "snapshot" ? { label: "Manual" } : { targetVersion: 1 }) }, res, (err: any) => { error = err; });
  return { error, res };
}

describe.each(["snapshot", "rollback"] as const)("%s history transaction", kind => {
  it("commits its version and actor audit in one transaction", async () => {
    const { error, res } = await invoke(kind);
    expect(error).toBeUndefined(); expect(db.tenantTx).toHaveBeenCalledOnce();
    expect(state.versions).toHaveLength(2); expect(state.audits).toHaveLength(1);
    expect(state.audits[0]).toMatchObject({ tenantId: "tenant-a", actor: "actor-a" });
    expect(log.info).toHaveBeenCalledOnce();
    if (kind === "snapshot") {
      expect(res.statusCode).toBe(201);
      expect(state.versions[1].snapshot).toMatchObject({ name: "Current", autonomy: "SUPERVISED" });
    } else {
      expect(state.agent).toMatchObject(target);
      expect(res.body).toMatchObject({ agent: { name: "Target", autonomy: "BALANCED" }, version: { version: 2 } });
    }
  });
  it.each(kind === "snapshot" ? ["snapshot", "audit"] as const : ["update", "snapshot", "audit"] as const)("rolls back every write on %s failure", async stage => {
    fault = stage; const before = structuredClone(state);
    const { error, res } = await invoke(kind);
    expect(error?.message).toBe(`injected ${stage} failure`);
    expect(res.body).toBeUndefined(); expect(state).toEqual(before);
    expect(log.info).not.toHaveBeenCalled();
  });
  it("denies foreign ownership before reading or writing history", async () => {
    const before = structuredClone(state);
    expect((await invoke(kind, "tenant-b")).error).toMatchObject({ statusCode: 404 });
    expect(state).toEqual(before);
  });
});

it("keeps current autonomy when rolling back a legacy snapshot without that field", async () => {
  delete state.versions[0].snapshot.autonomy;
  expect((await invoke("rollback")).error).toBeUndefined();
  expect(state.agent.autonomy).toBe("SUPERVISED");
});
