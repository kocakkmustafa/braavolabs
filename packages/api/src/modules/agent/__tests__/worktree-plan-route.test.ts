/** BRA-P2-02e: POST /agents/:id/worktree/plan — flag-gated, tenant-scoped, metadata-only dry-run preview. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";

const h = vi.hoisted(() => ({ flag: false, findUnique: vi.fn() }));
vi.mock("../../../config/env", async (orig) => {
  const actual = await orig<{ env: Record<string, unknown> }>();
  return { ...actual, env: new Proxy(actual.env, { get: (t, k) => (k === "WORKTREE_PLAN_ENABLED" ? h.flag : (t as Record<string | symbol, unknown>)[k]) }) };
});
vi.mock("../../../lib/db", () => ({ prisma: { agent: { findUnique: h.findUnique } }, tenantTx: vi.fn() }));
vi.mock("../../../lib/logger", () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock("../../../middleware/auth", () => ({ authMiddleware: vi.fn() }));
import { authMiddleware } from "../../../middleware/auth";
import { agentVersionRouter } from "../version-router";
import { SNAPSHOT_MAX_ENTRIES, buildWorktreePreview, isPreviewSafeName } from "../worktree-preview";
import { planWorktree } from "../worktree-planner";
// Contract oracle: the REAL core parser (tests are outside the API tsc scope, so the relative import is fine).
import { isSafeFileName, parseMetadataSyncMessage } from "../../../../../braavo-core/src/metadata-sync";

const SENTINEL = "TOP-SECRET-FILE-BODY-9f3a";

async function invoke(body: unknown, opts: { tenantId?: string; agentId?: string } = {}) {
  const handler = (agentVersionRouter as any).stack.find((l: any) => l.route?.path === "/:id/worktree/plan" && l.route.methods.post).route.stack.at(-1).handle;
  let error: any;
  const res = { body: undefined as any, statusCode: 200, status(c: number) { this.statusCode = c; return this; }, json(v: any) { this.body = v; return this; } };
  await handler({ params: { id: opts.agentId ?? "agent-a" }, auth: { tenantId: opts.tenantId ?? "tenant-a", userId: "u1" }, body }, res, (e: any) => { error = e; });
  return { error, res };
}
const ok = (patches: unknown[], extra: Record<string, unknown> = {}) => ({ root: "/var/work/run-1", patches, ...extra });
const create = (path: string, content = "hello") => ({ path, op: "create", content });

beforeEach(() => {
  h.flag = true;
  h.findUnique.mockReset().mockImplementation(async ({ where }: any) =>
    where.id === "agent-a" ? { id: "agent-a", company: { tenantId: "tenant-a" } } : null);
});

describe("flag and tenant scope", () => {
  it("flag OFF (default): 404 before anything is read", async () => {
    h.flag = false;
    const { error } = await invoke(ok([create("a.ts")]));
    expect(error).toMatchObject({ statusCode: 404 });
    expect(h.findUnique).not.toHaveBeenCalled();
  });
  it("the lookup really joins agent -> company -> tenantId, and authMiddleware is the router's first layer", async () => {
    await invoke(ok([create("a.ts")]));
    expect(h.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "agent-a" }, include: { company: { select: { tenantId: true } } } }));
    const first = (agentVersionRouter as any).stack[0];
    expect(first.handle).toBe(authMiddleware);
  });
  it("another tenant's agent and an unknown agent are both 404 (agent -> company -> tenantId)", async () => {
    expect((await invoke(ok([create("a.ts")]), { tenantId: "tenant-b" })).error).toMatchObject({ statusCode: 404 });
    expect((await invoke(ok([create("a.ts")]), { agentId: "ghost" })).error).toMatchObject({ statusCode: 404 });
  });
  it("body is validated strictly (unknown keys, bad op, missing root)", async () => {
    for (const body of [ok([create("a.ts")], { extra: 1 }), ok([{ path: "a", op: "chmod" }]), { patches: [] }, ok([{ path: "a", op: "create", content: "x", mode: 7 }])]) {
      expect((await invoke(body)).error).toBeInstanceOf(ZodError);
    }
  });
});

describe("preview shape", () => {
  it("returns a dry-run, snapshot-shaped, metadata-only body that the REAL core parser accepts", async () => {
    const { error, res } = await invoke(ok([create("src/a.ts", SENTINEL), { path: "src/b.ts", op: "modify", content: "b" }, { path: "old.txt", op: "delete" }]));
    expect(error).toBeUndefined();
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ dryRun: true, ok: true, summary: { files: 3, byOp: { create: 1, modify: 1, delete: 1 }, entries: 2, omittedEntries: 0 } });
    expect(parseMetadataSyncMessage(res.body.snapshot)).toMatchObject({ ok: true });
    expect(res.body.snapshot.entries.map((e: any) => e.fileName).sort()).toEqual(["a.ts", "b.ts"]); // names only, deletes excluded
  });
  it("never carries content, any path, the root or the work dir", async () => {
    const { res } = await invoke(ok([create("deep/dir/secret.ts", SENTINEL)], { subPath: "pkg/inner" }));
    const text = JSON.stringify(res.body);
    for (const leak of [SENTINEL, "deep/dir", "/var/work", "run-1", "pkg/inner", "absPath", "workDir"]) expect(text).not.toContain(leak);
  });
  it("worktreeId is a stable opaque label per tenant+agent+workdir (no path inside)", async () => {
    const a = (await invoke(ok([create("a.ts")]))).res.body.snapshot.worktreeId;
    const b = (await invoke(ok([create("a.ts")]))).res.body.snapshot.worktreeId;
    const c = (await invoke({ ...ok([create("a.ts")]), root: "/var/work/run-2" })).res.body.snapshot.worktreeId;
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^wp-[0-9a-f]{24}$/);
  });
  it("planner rejection -> 422 with the code only (message can echo the path)", async () => {
    const { res, error } = await invoke(ok([create("../escape.ts")]));
    expect(error).toBeUndefined();
    expect(res.statusCode).toBe(422);
    expect(res.body).toEqual({ dryRun: true, ok: false, code: "PATH_TRAVERSAL" });
  });
  it("counts sensitive files and omits (but counts) names the contract would not carry", async () => {
    const { res } = await invoke(ok([
      create("package.json", "{}"),
      create("dosya-" + String.fromCodePoint(0x15f) + ".ts"), // non-ASCII -> omitted
      create("t".repeat(45) + ".ts"), // token-shaped single run -> omitted
      create("fine.ts"),
    ]));
    expect(res.body.summary).toMatchObject({ files: 4, sensitive: 1, entries: 2, omittedEntries: 2 });
    expect(parseMetadataSyncMessage(res.body.snapshot).ok).toBe(true);
  });
  it("entry cap: more files than the snapshot allows are counted, never emitted", async () => {
    const patches = Array.from({ length: SNAPSHOT_MAX_ENTRIES + 50 }, (_, i) => create(`d/f${i}.ts`, String(i)));
    const { res } = await invoke(ok(patches));
    expect(res.body.snapshot.entries).toHaveLength(SNAPSHOT_MAX_ENTRIES);
    expect(res.body.summary).toMatchObject({ files: SNAPSHOT_MAX_ENTRIES + 50, entries: SNAPSHOT_MAX_ENTRIES, omittedEntries: 50 });
    expect(parseMetadataSyncMessage(res.body.snapshot).ok).toBe(true);
  });
});

describe("contract alignment with braavo-core (drift guard)", () => {
  it("every name the preview would emit is accepted by core's isSafeFileName (stricter subset)", () => {
    const c = (n: number) => String.fromCodePoint(n);
    const names = [
      "a.ts", "my file.txt", ".env.example", "report (1).md", "x=y,z@1+2.txt", "n".repeat(120), "a".repeat(39) + ".ts", "task-management-overview.md", "sk-" + "a".repeat(12) + ".txt",
      "a" + c(0x202e), "a" + c(0x00ad) + "b", "a\x07b", " lead", "trail ", "..", ".", "dir/x", "a\\b", "a".repeat(121), "A1".repeat(25), "-----BEGIN KEY", "Bearer abc", c(0x6587),
    ];
    for (const n of names) if (isPreviewSafeName(n)) expect(isSafeFileName(n), JSON.stringify(n)).toBe(true);
  });
  it("seeded fuzz: any plan the preview builds parses with the core parser", () => {
    let seed = 20261118;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const alphabet = "abcXYZ019._-() +=,@~$%^&!";
    for (let i = 0; i < 300; i++) {
      const patches = Array.from({ length: 1 + Math.floor(rnd() * 6) }, (_, j) => {
        const len = 1 + Math.floor(rnd() * 60);
        let name = "";
        for (let k = 0; k < len; k++) name += alphabet[Math.floor(rnd() * alphabet.length)];
        return { path: `d${j}/${name}`, op: "create" as const, content: SENTINEL + i };
      });
      const plan = planWorktree({ root: "/var/work/x", patches });
      if (!plan.ok) continue;
      const preview = buildWorktreePreview(plan, patches, { tenantId: "t", agentId: "a", now: new Date(0) });
      expect(parseMetadataSyncMessage(preview.snapshot).ok, JSON.stringify(preview.snapshot.entries.map((e) => e.fileName))).toBe(true);
    }
  });
});
