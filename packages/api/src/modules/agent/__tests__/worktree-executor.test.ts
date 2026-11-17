import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyWorktreePlan } from "../worktree-executor";
import { planWorktree, type PatchInput } from "../worktree-planner";

let base: string;
let root: string;
let outside: string;

beforeEach(async () => {
  base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "wt-exec-")));
  root = join(base, "root");
  outside = join(base, "outside");
  await fs.mkdir(root);
  await fs.mkdir(outside);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.chmod(join(root, "ro"), 0o755).catch(() => undefined);
  await fs.rm(base, { recursive: true, force: true });
});

const plan = (patches: PatchInput[]) => {
  const p = planWorktree({ root, patches });
  if (!p.ok) throw new Error("plan failed " + p.code);
  return p;
};

/** Sorted snapshot of the whole tree: path -> type/content. */
async function snapshot(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const rel = prefix + e.name;
    if (e.isSymbolicLink()) out.push(`L ${rel} -> ${await fs.readlink(join(dir, e.name))}`);
    else if (e.isDirectory()) {
      out.push(`D ${rel} ${((await fs.stat(join(dir, e.name))).mode & 0o7777).toString(8)}`);
      out.push(...(await snapshot(join(dir, e.name), rel + "/")));
    } else {
      const mode = (await fs.stat(join(dir, e.name))).mode & 0o7777;
      out.push(`F ${rel} ${mode.toString(8)} ${await fs.readFile(join(dir, e.name), "utf8")}`);
    }
  }
  return out;
}

const code = (r: Awaited<ReturnType<typeof applyWorktreePlan>>) => (r.ok ? "OK" : r.code);

describe("applyWorktreePlan", () => {
  it("dry-run is the default and never writes", async () => {
    await fs.writeFile(join(root, "m.txt"), "old");
    await fs.writeFile(join(root, "d.txt"), "gone");
    const patches: PatchInput[] = [
      { path: "a/new.txt", op: "create", content: "hi" },
      { path: "m.txt", op: "modify", content: "newer" },
      { path: "d.txt", op: "delete" },
    ];
    const before = await snapshot(base);
    const r = await applyWorktreePlan(plan(patches), patches);
    expect(await snapshot(base)).toEqual(before);
    expect(r).toMatchObject({ ok: true, dryRun: true });
    if (r.ok) {
      expect(r.files.map((f) => f.action)).toEqual(["would-create", "would-delete", "would-modify"]);
    }
  });

  it("real mode creates, modifies and deletes", async () => {
    await fs.writeFile(join(root, "m.txt"), "old");
    await fs.writeFile(join(root, "d.txt"), "gone");
    const patches: PatchInput[] = [
      { path: "a/b/new.txt", op: "create", content: "héllo" },
      { path: "m.txt", op: "modify", content: "newer" },
      { path: "d.txt", op: "delete" },
    ];
    const r = await applyWorktreePlan(plan(patches), patches, { dryRun: false });
    expect(r).toMatchObject({ ok: true, dryRun: false });
    if (r.ok) {
      expect(r.files.map((f) => `${f.path}:${f.action}:${f.bytes}`).sort()).toEqual(
        ["a/b/new.txt:created:6", "d.txt:deleted:0", "m.txt:modified:5"].sort(),
      );
    }
    expect(readFileSync(join(root, "a/b/new.txt"), "utf8")).toBe("héllo");
    expect(readFileSync(join(root, "m.txt"), "utf8")).toBe("newer");
    await expect(fs.stat(join(root, "d.txt"))).rejects.toThrow();
  });

  it("rejects a plan that is not ok", async () => {
    const p = planWorktree({ root, patches: [{ path: "../x", op: "create", content: "" }] });
    expect(code(await applyWorktreePlan(p, []))).toBe("PLAN_INVALID");
  });

  it("ROOT_MISSING", async () => {
    const patches: PatchInput[] = [{ path: "a.txt", op: "create", content: "x" }];
    const p = plan(patches);
    await fs.rm(root, { recursive: true });
    expect(code(await applyWorktreePlan(p, patches))).toBe("ROOT_MISSING");
  });

  it("symlinked parent escape is rejected in both modes", async () => {
    await fs.symlink(outside, join(root, "link"));
    const patches: PatchInput[] = [{ path: "link/evil.txt", op: "create", content: "x" }];
    const p = plan(patches);
    expect(code(await applyWorktreePlan(p, patches))).toBe("SYMLINK_ESCAPE");
    expect(code(await applyWorktreePlan(p, patches, { dryRun: false }))).toBe("SYMLINK_ESCAPE");
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it("symlink target is rejected for modify/delete", async () => {
    await fs.writeFile(join(outside, "t.txt"), "secret");
    await fs.symlink(join(outside, "t.txt"), join(root, "s.txt"));
    for (const op of ["modify", "delete"] as const) {
      const patches: PatchInput[] = [{ path: "s.txt", op, content: op === "modify" ? "x" : undefined }];
      const r = await applyWorktreePlan(plan(patches), patches, { dryRun: false });
      expect(code(r)).toBe("TARGET_NOT_REGULAR");
    }
    expect(readFileSync(join(outside, "t.txt"), "utf8")).toBe("secret");
  });

  it("directory target is not regular", async () => {
    await fs.mkdir(join(root, "dir"));
    const patches: PatchInput[] = [{ path: "dir", op: "delete" }];
    expect(code(await applyWorktreePlan(plan(patches), patches))).toBe("TARGET_NOT_REGULAR");
  });

  it("create over an existing file (and over a dangling symlink)", async () => {
    await fs.writeFile(join(root, "e.txt"), "keep");
    await fs.symlink(join(outside, "nope"), join(root, "dangling"));
    const a: PatchInput[] = [{ path: "e.txt", op: "create", content: "x" }];
    const b: PatchInput[] = [{ path: "dangling", op: "create", content: "x" }];
    expect(code(await applyWorktreePlan(plan(a), a, { dryRun: false }))).toBe("TARGET_EXISTS");
    expect(code(await applyWorktreePlan(plan(b), b, { dryRun: false }))).toBe("TARGET_EXISTS");
    expect(readFileSync(join(root, "e.txt"), "utf8")).toBe("keep");
    await expect(fs.stat(join(outside, "nope"))).rejects.toThrow();
  });

  it("modify/delete of a missing file", async () => {
    const m: PatchInput[] = [{ path: "x/none.txt", op: "modify", content: "x" }];
    const d: PatchInput[] = [{ path: "none.txt", op: "delete" }];
    expect(code(await applyWorktreePlan(plan(m), m))).toBe("TARGET_MISSING");
    expect(code(await applyWorktreePlan(plan(d), d))).toBe("TARGET_MISSING");
  });

  it("sensitive files need approval, also in dry-run", async () => {
    const patches: PatchInput[] = [{ path: ".github/workflows/x.yml", op: "create", content: "on: push" }];
    const p = plan(patches);
    expect(p.files[0].sensitive).toBe(true);
    const before = await snapshot(base);
    const r1 = await applyWorktreePlan(p, patches);
    expect(r1).toMatchObject({ ok: false, code: "SENSITIVE_NOT_APPROVED", paths: [".github/workflows/x.yml"] });
    expect(code(await applyWorktreePlan(p, patches, { dryRun: false }))).toBe("SENSITIVE_NOT_APPROVED");
    expect(await snapshot(base)).toEqual(before);
    expect(code(await applyWorktreePlan(p, patches, { approveSensitive: true }))).toBe("OK");
    expect(code(await applyWorktreePlan(p, patches, { dryRun: false, approveSensitive: true }))).toBe("OK");
    expect(readFileSync(join(root, ".github/workflows/x.yml"), "utf8")).toBe("on: push");
  });

  it.skipIf(process.getuid?.() === 0)("rolls back when a later step cannot write", async () => {
    await fs.writeFile(join(root, "b-mod.txt"), "orig");
    await fs.writeFile(join(root, "c-del.txt"), "del-me");
    await fs.mkdir(join(root, "ro"));
    await fs.chmod(join(root, "ro"), 0o555);
    const patches: PatchInput[] = [
      { path: "a/new.txt", op: "create", content: "n" },
      { path: "b-mod.txt", op: "modify", content: "changed" },
      { path: "c-del.txt", op: "delete" },
      { path: "ro/z.txt", op: "create", content: "fails" },
    ];
    const before = await snapshot(base);
    const r = await applyWorktreePlan(plan(patches), patches, { dryRun: false });
    expect(r).toMatchObject({ ok: false, code: "APPLY_FAILED", rolledBack: true });
    expect(await snapshot(base)).toEqual(before);
  });

  it("patches vs plan mismatch", async () => {
    const patches: PatchInput[] = [{ path: "a.txt", op: "create", content: "abc" }];
    const p = plan(patches);
    const cases: PatchInput[][] = [
      [],
      [{ path: "a.txt", op: "create", content: "abcd" }],
      [{ path: "a.txt", op: "modify", content: "abc" }],
      [{ path: "b.txt", op: "create", content: "abc" }],
      [patches[0], patches[0]],
    ];
    for (const c of cases) expect(code(await applyWorktreePlan(p, c))).toBe("PATCH_PLAN_MISMATCH");
  });

  it("executor source has no process / network access", () => {
    const src = readFileSync(join(__dirname, "..", "worktree-executor.ts"), "utf8");
    for (const bad of ["child_process", "node:net", "node:http", "node:https", "node:dgram", "node:tls", "fetch(", "spawn", "exec("]) {
      expect(src.includes(bad), bad).toBe(false);
    }
    expect(src).not.toMatch(/from "(net|http|https|child_process)"/);
  });

  it("rejects a forged plan: absPath/sensitive not matching the planner", async () => {
    const patches: PatchInput[] = [{ path: "docs/a.md", op: "create", content: "x" }];
    const p = plan(patches);
    const forged = { ...p, files: [{ ...p.files[0], absPath: join(root, ".github/workflows/ci.yml"), sensitive: false }] };
    const before = await snapshot(base);
    expect(code(await applyWorktreePlan(forged, patches, { dryRun: false }))).toBe("PLAN_INVALID");
    // sensitive flag stripped from a genuinely sensitive path
    const sp: PatchInput[] = [{ path: ".github/workflows/ci.yml", op: "create", content: "x" }];
    const splan = plan(sp);
    const stripped = { ...splan, files: [{ ...splan.files[0], sensitive: false }] };
    expect(code(await applyWorktreePlan(stripped, sp, { dryRun: false }))).toBe("PLAN_INVALID");
    // workDir outside root
    expect(code(await applyWorktreePlan({ ...p, workDir: outside }, patches))).toBe("PLAN_INVALID");
    expect(await snapshot(base)).toEqual(before);
  });

  it("rejects duplicate plan entries", async () => {
    const patches: PatchInput[] = [{ path: "a.txt", op: "create", content: "x" }];
    const p = plan(patches);
    const dup = { ...p, files: [p.files[0], p.files[0]] };
    expect(code(await applyWorktreePlan(dup, [patches[0], patches[0]]))).toBe("PLAN_INVALID");
    expect(code(await applyWorktreePlan(dup, patches))).toBe("PLAN_INVALID");
  });

  it("honours subPath derived from workDir", async () => {
    const patches: PatchInput[] = [{ path: "x.txt", op: "create", content: "x" }];
    const p = planWorktree({ root, subPath: "repo", patches });
    if (!p.ok) throw new Error("plan");
    expect(code(await applyWorktreePlan(p, patches, { dryRun: false }))).toBe("OK");
    expect(readFileSync(join(root, "repo/x.txt"), "utf8")).toBe("x");
  });

  it("byte/char mismatch with multi-byte content", async () => {
    const patches: PatchInput[] = [{ path: "u.txt", op: "create", content: "ééé€😀" }];
    const p = plan(patches);
    expect(p.files[0].bytes).toBe(Buffer.byteLength("ééé€😀"));
    const forged = { ...p, files: [{ ...p.files[0], bytes: "ééé€😀".length }] };
    expect(code(await applyWorktreePlan(forged, patches))).toBe("PATCH_PLAN_MISMATCH");
    const r = await applyWorktreePlan(p, patches, { dryRun: false });
    expect(code(r)).toBe("OK");
    expect(readFileSync(join(root, "u.txt"), "utf8")).toBe("ééé€😀");
  });

  it("hard-linked modify target is rejected", async () => {
    await fs.writeFile(join(outside, "orig.txt"), "shared");
    await fs.link(join(outside, "orig.txt"), join(root, "h.txt"));
    const patches: PatchInput[] = [{ path: "h.txt", op: "modify", content: "pwn" }];
    expect(code(await applyWorktreePlan(plan(patches), patches))).toBe("TARGET_NOT_REGULAR");
    expect(code(await applyWorktreePlan(plan(patches), patches, { dryRun: false }))).toBe("TARGET_NOT_REGULAR");
    expect(readFileSync(join(outside, "orig.txt"), "utf8")).toBe("shared");
  });

  it("oversized existing file is rejected for modify/delete", async () => {
    await fs.writeFile(join(root, "big.bin"), Buffer.alloc(1024 * 1024 + 1));
    const m: PatchInput[] = [{ path: "big.bin", op: "modify", content: "x" }];
    const d: PatchInput[] = [{ path: "big.bin", op: "delete" }];
    expect(code(await applyWorktreePlan(plan(m), m))).toBe("TARGET_TOO_LARGE");
    expect(code(await applyWorktreePlan(plan(d), d))).toBe("TARGET_TOO_LARGE");
  });

  it("re-check failure keeps its specific code and rolls back", async () => {
    const patches: PatchInput[] = [
      { path: "a.txt", op: "create", content: "a" },
      { path: "link/z.txt", op: "create", content: "z" },
    ];
    const p = plan(patches);
    // swap in a symlink right after the first file is written
    const realOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const h = await realOpen(...args);
      if (String(args[0]).endsWith("/a.txt")) await fs.symlink(outside, join(root, "link"));
      return h;
    });
    const r = await applyWorktreePlan(p, patches, { dryRun: false });
    expect(r).toMatchObject({ ok: false, code: "SYMLINK_ESCAPE", rolledBack: true });
    await expect(fs.stat(join(root, "a.txt"))).rejects.toThrow();
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it("reports an incomplete rollback honestly (injected failures, works as root)", async () => {
    const patches: PatchInput[] = [
      { path: "a.txt", op: "create", content: "a" },
      { path: "z.txt", op: "create", content: "z" },
    ];
    const p = plan(patches);
    const realOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      if (String(args[0]).endsWith("/z.txt")) throw Object.assign(new Error("denied"), { code: "EACCES" });
      return realOpen(...args);
    });
    vi.spyOn(fs, "unlink").mockRejectedValue(Object.assign(new Error("busy"), { code: "EBUSY" }));
    const r = await applyWorktreePlan(p, patches, { dryRun: false });
    expect(r).toMatchObject({ ok: false, code: "APPLY_FAILED", rolledBack: false, unrestoredPaths: ["a.txt"] });
  });

  it("rolledBack is true when all undo steps succeed (injected failure)", async () => {
    await fs.writeFile(join(root, "m.txt"), "orig");
    const patches: PatchInput[] = [
      { path: "m.txt", op: "modify", content: "changed" },
      { path: "z.txt", op: "create", content: "z" },
    ];
    const p = plan(patches);
    const realOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      if (String(args[0]).endsWith("/z.txt")) throw Object.assign(new Error("denied"), { code: "EACCES" });
      return realOpen(...args);
    });
    const before = await snapshot(base);
    const r = await applyWorktreePlan(p, patches, { dryRun: false });
    expect(r).toMatchObject({ ok: false, code: "APPLY_FAILED", rolledBack: true });
    vi.restoreAllMocks();
    expect(await snapshot(base)).toEqual(before);
  });

  it("race: hardlink swapped in between check and write open leaves the outside file untouched", async () => {
    await fs.writeFile(join(root, "m.txt"), "orig");
    await fs.writeFile(join(outside, "victim.txt"), "VICTIM");
    const patches: PatchInput[] = [{ path: "m.txt", op: "modify", content: "pwn" }];
    const p = plan(patches);
    const realOpen = fs.open.bind(fs);
    let swapped = false;
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const flags = Number(args[1] ?? 0);
      if (!swapped && String(args[0]).endsWith("/m.txt") && (flags & 3) === 1 /* O_WRONLY */) {
        swapped = true;
        await fs.unlink(join(root, "m.txt"));
        await fs.link(join(outside, "victim.txt"), join(root, "m.txt"));
      }
      return realOpen(...args);
    });
    const r = await applyWorktreePlan(p, patches, { dryRun: false });
    expect(swapped).toBe(true);
    expect(r).toMatchObject({ ok: false, code: "TARGET_NOT_REGULAR" });
    expect(readFileSync(join(outside, "victim.txt"), "utf8")).toBe("VICTIM");
  });

  it("race: inode replaced between read and write open is rejected (dev/ino mismatch)", async () => {
    await fs.writeFile(join(root, "m.txt"), "orig");
    await fs.writeFile(join(outside, "other.txt"), "OTHER");
    const patches: PatchInput[] = [{ path: "m.txt", op: "modify", content: "pwn" }];
    const p = plan(patches);
    const realOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      if (String(args[0]).endsWith("/m.txt") && (Number(args[1] ?? 0) & 3) === 1) {
        await fs.unlink(join(root, "m.txt"));
        await fs.writeFile(join(root, "m.txt"), "replacement");
      }
      return realOpen(...args);
    });
    const r = await applyWorktreePlan(p, patches, { dryRun: false });
    expect(r).toMatchObject({ ok: false, code: "TARGET_NOT_REGULAR" });
    expect(readFileSync(join(root, "m.txt"), "utf8")).toBe("replacement");
  });

  it("precheck APPLY_FAILED carries no rollback fields", async () => {
    const patches: PatchInput[] = [{ path: "a.txt", op: "create", content: "x" }];
    const p = plan(patches);
    vi.spyOn(fs, "lstat").mockRejectedValue(Object.assign(new Error("io"), { code: "EIO" }));
    const r = await applyWorktreePlan(p, patches);
    expect(r).toMatchObject({ ok: false, code: "APPLY_FAILED" });
    expect(r).not.toHaveProperty("rolledBack");
    expect(r).not.toHaveProperty("unrestoredPaths");
  });

  it("a directory named '..foo' is a legitimate subPath", async () => {
    const patches: PatchInput[] = [{ path: "x.txt", op: "create", content: "x" }];
    const p = planWorktree({ root, subPath: "..foo", patches });
    if (!p.ok) throw new Error("plan " + p.code);
    expect(code(await applyWorktreePlan(p, patches, { dryRun: false }))).toBe("OK");
    expect(readFileSync(join(root, "..foo/x.txt"), "utf8")).toBe("x");
  });

  it("root/workDir differ from re-plan is PLAN_INVALID", async () => {
    const patches: PatchInput[] = [{ path: "a.txt", op: "create", content: "x" }];
    const p = plan(patches);
    expect(code(await applyWorktreePlan({ ...p, root: root + "/" }, patches))).toBe("PLAN_INVALID");
    expect(code(await applyWorktreePlan({ ...p, workDir: root + "/./" }, patches))).toBe("PLAN_INVALID");
  });

  it("modify undo failure is reported (injected)", async () => {
    await fs.writeFile(join(root, "m.txt"), "orig");
    const patches: PatchInput[] = [
      { path: "m.txt", op: "modify", content: "changed" },
      { path: "z.txt", op: "create", content: "z" },
    ];
    const p = plan(patches);
    const realOpen = fs.open.bind(fs);
    // undo of modify re-checks the chain via lstat: make it fail once z.txt open has failed
    const realLstat = fs.lstat.bind(fs);
    let armed = false;
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      if (String(args[0]).endsWith("/z.txt")) {
        armed = true;
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      }
      return realOpen(...args);
    });
    vi.spyOn(fs, "lstat").mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
      if (armed) throw Object.assign(new Error("io"), { code: "EIO" });
      return realLstat(...args);
    });
    const r = await applyWorktreePlan(p, patches, { dryRun: false });
    expect(r).toMatchObject({ ok: false, code: "APPLY_FAILED", rolledBack: false, unrestoredPaths: ["m.txt"] });
  });

  it("delete undo failure is reported (injected)", async () => {
    await fs.writeFile(join(root, "d.txt"), "del");
    const patches: PatchInput[] = [
      { path: "d.txt", op: "delete" },
      { path: "z.txt", op: "create", content: "z" },
    ];
    const p = plan(patches);
    const realOpen = fs.open.bind(fs);
    const realLstat = fs.lstat.bind(fs);
    let armed = false;
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      if (String(args[0]).endsWith("/z.txt")) {
        armed = true;
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      }
      return realOpen(...args);
    });
    vi.spyOn(fs, "lstat").mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
      if (armed) throw Object.assign(new Error("io"), { code: "EIO" });
      return realLstat(...args);
    });
    const r = await applyWorktreePlan(p, patches, { dryRun: false });
    expect(r).toMatchObject({ ok: false, code: "APPLY_FAILED", rolledBack: false, unrestoredPaths: ["d.txt"] });
  });
});
