/** BRA-P1-03-N1: tenant repository allowlist — flag, tenant scope, RBAC, grammar, migration shape. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";

const h = vi.hoisted(() => ({
  flag: false,
  findMany: vi.fn(), findFirst: vi.fn(), count: vi.fn(), create: vi.fn(), deleteMany: vi.fn(), activity: vi.fn(), lock: vi.fn(),
}));
vi.mock("../../../config/env", async (orig) => {
  const actual = await orig<{ env: Record<string, unknown> }>();
  return { ...actual, env: new Proxy(actual.env, { get: (t, k) => (k === "TENANT_REPOS_ENABLED" ? h.flag : (t as Record<string | symbol, unknown>)[k]) }) };
});
const tx = {
  $queryRaw: h.lock,
  tenantRepository: { count: h.count, create: h.create, findFirst: h.findFirst, deleteMany: h.deleteMany },
  activityLog: { create: h.activity },
};
vi.mock("../../../lib/db", () => ({
  prisma: { tenantRepository: { findMany: h.findMany, findFirst: h.findFirst } },
  tenantTx: async (fn: (t: unknown) => unknown) => fn(tx),
}));
vi.mock("../../../lib/logger", () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock("../../../middleware/auth", () => ({ authMiddleware: vi.fn() }));
import { roleCan } from "../../../lib/rbac";
import { MAX_REPOS_PER_TENANT, isValidBranch, isValidInstallationId, isValidOwner, isValidRepo, repoFullName } from "../validate";
import { tenantRepoRouter } from "../router";

type Method = "get" | "post" | "delete";
/** Runs the router's flag gate (2nd layer, after the mocked auth) and the route's own handler stack. */
async function call(method: Method, path: string, opts: { body?: unknown; params?: Record<string, string>; tenantId?: string; role?: string } = {}) {
  const layers = (tenantRepoRouter as any).stack as any[];
  const route = layers.find((l) => l.route?.path === path && l.route.methods[method]).route;
  const flagGate = layers.filter((l) => !l.route)[1].handle;
  const req: any = { params: opts.params ?? {}, body: opts.body, auth: { tenantId: opts.tenantId ?? "tenant-a", userId: "u1", role: opts.role ?? "OWNER" } };
  let error: any;
  let finish!: () => void;
  const finished = new Promise<void>((r) => (finish = r));
  const res: any = {
    statusCode: 200, body: undefined,
    status(c: number) { this.statusCode = c; return this; },
    json(v: unknown) { this.body = v; finish(); return this; },
    end() { finish(); return this; },
  };
  const handlers = [flagGate, ...route.stack.map((x: any) => x.handle)];
  const step = (i: number): void => {
    if (i >= handlers.length) return finish();
    Promise.resolve(handlers[i](req, res, (e?: unknown) => { if (e) { error = e; finish(); } else step(i + 1); })).catch((e) => { error = e; finish(); });
  };
  step(0);
  await finished;
  return { error, res };
}
const row = (over: Record<string, unknown> = {}) => ({ id: "r1", provider: "GITHUB", owner: "Acme", repo: "Widget", fullName: "acme/widget", installationId: null, defaultBranch: null, createdAt: new Date(0), updatedAt: new Date(0), ...over });

beforeEach(() => {
  h.flag = true;
  for (const f of [h.findMany, h.findFirst, h.count, h.create, h.deleteMany, h.activity, h.lock]) f.mockReset();
  h.lock.mockResolvedValue([{ id: "tenant-a" }]);
  h.count.mockResolvedValue(0);
  h.create.mockImplementation(async ({ data }: any) => row({ owner: data.owner, repo: data.repo, fullName: data.fullName }));
});

describe("flag", () => {
  it("OFF (default): every route is 404 and the database is never touched", async () => {
    h.flag = false;
    for (const [m, p] of [["get", "/"], ["get", "/:id"], ["post", "/"], ["delete", "/:id"]] as const) {
      const { error } = await call(m, p, { params: { id: "r1" }, body: { owner: "a", repo: "b" } });
      expect(error, `${m} ${p}`).toMatchObject({ statusCode: 404 });
    }
    expect(h.findMany).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
  });
});

describe("read (tenant scoped)", () => {
  it("lists only the caller's tenant, explicit projection, no credential fields", async () => {
    h.findMany.mockResolvedValue([row()]);
    const { res } = await call("get", "/", { tenantId: "tenant-a" });
    expect(h.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: "tenant-a" }, take: MAX_REPOS_PER_TENANT }));
    const select = h.findMany.mock.calls[0][0].select;
    expect(Object.keys(select).sort()).toEqual(["createdAt", "defaultBranch", "fullName", "id", "installationId", "owner", "provider", "repo", "updatedAt"]);
    expect(res.body).toEqual({ repositories: [row()] });
  });
  it("one repo: id AND tenant in the where; another tenant's id is 404", async () => {
    h.findFirst.mockResolvedValue(null);
    const { error } = await call("get", "/:id", { params: { id: "r-other" }, tenantId: "tenant-a" });
    expect(h.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "r-other", tenantId: "tenant-a" } }));
    expect(error).toMatchObject({ statusCode: 404 });
  });
});

describe("write (ADMIN, validated, audited)", () => {
  it("adds a repo: lowercase identity, tenant from auth, activity row, 201", async () => {
    const { error, res } = await call("post", "/", { body: { owner: "Acme", repo: "Widget", installationId: "12345", defaultBranch: "main" } });
    expect(error).toBeUndefined();
    expect(res.statusCode).toBe(201);
    expect(h.create.mock.calls[0][0].data).toMatchObject({ tenantId: "tenant-a", provider: "GITHUB", owner: "Acme", repo: "Widget", fullName: "acme/widget", installationId: "12345", defaultBranch: "main", createdByUserId: "u1" });
    expect(h.activity).toHaveBeenCalledWith({ data: expect.objectContaining({ tenantId: "tenant-a", actor: "u1", action: "repo.allowlist.add", resource: "tenant_repository" }) });
  });
  it("MEMBER cannot change the list, ADMIN and OWNER can (repo:manage)", () => {
    expect(roleCan("MEMBER" as never, "repo:manage")).toBe(false);
    expect(roleCan("ADMIN" as never, "repo:manage")).toBe(true);
    expect(roleCan("OWNER" as never, "repo:manage")).toBe(true);
  });
  it("route stack carries the permission gate on POST and DELETE", async () => {
    const post = await call("post", "/", { body: { owner: "a", repo: "b" }, role: "MEMBER" });
    expect(post.res.statusCode).toBe(403);
    expect(h.create).not.toHaveBeenCalled();
    h.findFirst.mockResolvedValue({ id: "r1", fullName: "x/y" });
    await call("delete", "/:id", { params: { id: "r1" }, role: "MEMBER" });
    expect(h.deleteMany).not.toHaveBeenCalled();
  });
  it("rejects bad grammar and unknown keys before touching the database", async () => {
    for (const body of [
      { owner: "a b", repo: "x" }, { owner: "-a", repo: "x" }, { owner: "a--b", repo: "x" }, { owner: "a", repo: ".." }, { owner: "a", repo: "x.git" },
      { owner: "a", repo: "x/y" }, { owner: "a", repo: "x", installationId: "12a" }, { owner: "a", repo: "x", defaultBranch: "-rf" },
      { owner: "a", repo: "x", token: "ghp_secret" }, { owner: "a", repo: "x", defaultBranch: "a..b" }, {},
    ]) {
      const { error } = await call("post", "/", { body });
      expect(error, JSON.stringify(body)).toBeInstanceOf(ZodError);
    }
    expect(h.create).not.toHaveBeenCalled();
  });
  it("duplicate -> 409 REPO_ALREADY_REGISTERED; full list -> 409 REPO_ALLOWLIST_FULL", async () => {
    h.create.mockRejectedValue(Object.assign(new Error("dup"), { code: "P2002" }));
    expect((await call("post", "/", { body: { owner: "a", repo: "b" } })).error).toMatchObject({ statusCode: 409, code: "REPO_ALREADY_REGISTERED" });
    h.count.mockResolvedValue(MAX_REPOS_PER_TENANT);
    expect((await call("post", "/", { body: { owner: "a", repo: "c" } })).error).toMatchObject({ statusCode: 409, code: "REPO_ALLOWLIST_FULL" });
  });
  it("add locks the tenant row BEFORE counting (cap cannot be overrun), and counts only that tenant", async () => {
    await call("post", "/", { body: { owner: "a", repo: "b" }, tenantId: "tenant-a" });
    expect(h.lock.mock.calls[0][0].join("?")).toMatch(/FOR UPDATE/);
    expect(h.lock.mock.calls[0][1]).toBe("tenant-a");
    expect(h.lock.mock.invocationCallOrder[0]).toBeLessThan(h.count.mock.invocationCallOrder[0]);
    expect(h.count).toHaveBeenCalledWith({ where: { tenantId: "tenant-a" } });
    h.lock.mockResolvedValue([]);
    expect((await call("post", "/", { body: { owner: "a", repo: "c" } })).error).toMatchObject({ statusCode: 401 });
  });
  it("delete is tenant scoped, audited, 204; missing/other-tenant -> 404", async () => {
    h.findFirst.mockResolvedValueOnce({ id: "r1", fullName: "acme/widget" });
    const ok = await call("delete", "/:id", { params: { id: "r1" }, tenantId: "tenant-a" });
    expect(ok.res.statusCode).toBe(204);
    expect(h.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "r1", tenantId: "tenant-a" } }));
    expect(h.deleteMany).toHaveBeenCalledWith({ where: { id: "r1", tenantId: "tenant-a" } });
    expect(h.activity).toHaveBeenCalledWith({ data: expect.objectContaining({ action: "repo.allowlist.remove", resourceId: "r1" }) });
    h.findFirst.mockResolvedValueOnce(null);
    expect((await call("delete", "/:id", { params: { id: "r-other" } })).error).toMatchObject({ statusCode: 404 });
  });
});

describe("input grammar", () => {
  it("owner / repo / installation / branch accept real GitHub shapes, refuse smuggling", () => {
    for (const o of ["a", "Acme", "acme-corp", "a1", "x".repeat(39)]) expect(isValidOwner(o), o).toBe(true);
    for (const o of ["", "-a", "a-", "a--b", "a b", "a/b", "x".repeat(40), "a" + String.fromCodePoint(0x202e), "a.b", 5]) expect(isValidOwner(o), String(o)).toBe(false);
    for (const r of ["repo", "My.Repo_2-x", ".github", "a".repeat(100)]) expect(isValidRepo(r), r).toBe(true);
    for (const r of ["", ".", "..", "x.git", "X.GIT", "a/b", "a b", "a".repeat(101), "r" + String.fromCodePoint(0x200b)]) expect(isValidRepo(r), r).toBe(false);
    for (const i of ["1", "123456789012345"]) expect(isValidInstallationId(i)).toBe(true);
    for (const i of ["", "0", "000", "1234567890123456", "1a", "-1", " 1"]) expect(isValidInstallationId(i), i).toBe(false);
    for (const b of ["main", "release/1.2", "feat/x_y-z"]) expect(isValidBranch(b), b).toBe(true);
    for (const b of ["", "-rf", "a..b", "a//b", "a@{u}", "a/", "a.", "a.lock", "a.lock/b", "a/.b", ".hidden", "a b", "a~1", "a^"]) expect(isValidBranch(b), b).toBe(false);
    expect(repoFullName("Acme", "Widget")).toBe("acme/widget");
  });
});

describe("migration 20261118200000_tenant_repositories", () => {
  const raw = readFileSync(join(__dirname, "../../../../../db/prisma/migrations/20261118200000_tenant_repositories/migration.sql"), "utf8");
  const sql = raw.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n"); // statements only, comments excluded
  it("is additive only and carries RLS; stores no credential column", () => {
    expect(sql).not.toMatch(/\bDROP\b|\bALTER\s+TYPE\b|(?<!ON )\bDELETE\b|\bTRUNCATE\b/i);
    expect(sql).not.toMatch(/ALTER TABLE "(?!tenant_repositories)/);
    expect(sql).toMatch(/ENABLE ROW LEVEL SECURITY/);
    expect(sql).toMatch(/CREATE POLICY tenant_rls ON "tenant_repositories"/);
    const cols = [...sql.matchAll(/^\s+"([a-z_]+)"/gm)].map((m) => m[1]);
    expect(cols.some((c) => /token|secret|password|key|credential/.test(c))).toBe(false);
  });
});
