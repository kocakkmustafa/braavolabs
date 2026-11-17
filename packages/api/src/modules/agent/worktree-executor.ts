/**
 * BRA-P1-03-N2 — worktree plan executor (dry-run first).
 *
 * Applies a `WorktreePlan` (see worktree-planner.ts, "Executor contract") to a
 * worktree root on the local file system. Flag-off by design: this module is
 * only exported. It is NOT wired to any agent tool, env flag or route. A real
 * write happens only when a caller passes `dryRun: false` explicitly.
 *
 * Sandbox boundary (ADR-0006): path / symlink containment + dry-run default
 * ONLY. No process or network isolation, no command execution, no shell, no
 * network. Paths are used as-is (no URL decoding).
 *
 * Safety model:
 * - Pre-checks (both modes, read-only): root realpath; every component of each
 *   file's parent chain is lstat-ed and may not be a symlink; the deepest
 *   existing parent's realpath must stay under the root realpath; create target
 *   must not exist; modify/delete target must be an existing regular file.
 * - Real mode: all pre-checks first, then writes. Each file's chain is
 *   re-checked right before its write; files are opened with O_NOFOLLOW (create
 *   additionally `wx`). On any failure everything applied so far is rolled back
 *   (originals are held in memory; created files and created dirs are removed).
 */
import { constants as fsc, promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { posix } from "node:path";
import { MAX_CONTENT_BYTES, planWorktree, type PatchInput, type PatchOp, type WorktreePlan } from "./worktree-planner";

export type ExecutorErrorCode =
  | "ROOT_MISSING"
  | "SYMLINK_ESCAPE"
  | "TARGET_EXISTS"
  | "TARGET_MISSING"
  | "TARGET_NOT_REGULAR"
  | "TARGET_TOO_LARGE"
  | "SENSITIVE_NOT_APPROVED"
  | "PLAN_INVALID"
  | "PATCH_PLAN_MISMATCH"
  | "APPLY_FAILED";

export type FileAction =
  | "would-create"
  | "would-modify"
  | "would-delete"
  | "created"
  | "modified"
  | "deleted";

export interface FileReport {
  path: string;
  op: PatchOp;
  action: FileAction;
  bytes: number;
}

export type ApplyResult =
  | { ok: true; dryRun: boolean; files: FileReport[] }
  | {
      ok: false;
      code: ExecutorErrorCode;
      message: string;
      paths?: string[];
      /** true only when every undo step succeeded. */
      rolledBack?: boolean;
      /** Paths whose undo failed (only when rolledBack is false after a real-mode failure). */
      unrestoredPaths?: string[];
    };

export interface ApplyOptions {
  /** Default TRUE. Real writes need an explicit `false`. */
  dryRun?: boolean;
  approveSensitive?: boolean;
}

type Fail = Extract<ApplyResult, { ok: false }>;
const fail = (code: ExecutorErrorCode, message: string, extra: Partial<Fail> = {}): Fail => ({
  ok: false,
  code,
  message,
  ...extra,
});

const errCode = (e: unknown): string | undefined => (e as NodeJS.ErrnoException | undefined)?.code;
const utf8Len = (s: string) => Buffer.byteLength(s, "utf8");
const O_NOFOLLOW = fsc.O_NOFOLLOW ?? 0;
const O_NONBLOCK = fsc.O_NONBLOCK ?? 0;
const CODES = new Set<string>([
  "ROOT_MISSING", "SYMLINK_ESCAPE", "TARGET_EXISTS", "TARGET_MISSING", "TARGET_NOT_REGULAR", "TARGET_TOO_LARGE",
  "SENSITIVE_NOT_APPROVED", "PLAN_INVALID", "PATCH_PLAN_MISMATCH", "APPLY_FAILED",
]);

interface Checked {
  /** Real root directory. */
  realRoot: string;
  /** Existing regular-file target info for modify/delete. */
  exists: boolean;
}

/** Read-only check of one file's parent chain and target. Returns a failure or null. */
async function checkFile(
  realRoot: string,
  root: string,
  file: { path: string; absPath: string; op: PatchOp },
): Promise<Fail | null> {
  try {
    return await checkFileInner(realRoot, root, file);
  } catch (e) {
    return fail("APPLY_FAILED", `${file.path}: check failed (${errCode(e) ?? "error"})`);
  }
}

async function checkFileInner(
  realRoot: string,
  root: string,
  file: { path: string; absPath: string; op: PatchOp },
): Promise<Fail | null> {
  const rel = posix.relative(root, file.absPath);
  if (rel === "" || rel === ".." || rel.startsWith("../") || posix.isAbsolute(rel)) {
    return fail("PLAN_INVALID", `${file.path}: absPath outside root`);
  }
  const parts = rel.split("/");
  const last = parts.pop() as string;
  let cur = realRoot;
  let missingFrom = false;
  for (const comp of parts) {
    cur = posix.join(cur, comp);
    let st;
    try {
      st = await fs.lstat(cur);
    } catch (e) {
      if (errCode(e) === "ENOENT") {
        missingFrom = true;
        break;
      }
      return fail("APPLY_FAILED", `${file.path}: lstat failed (${errCode(e) ?? "error"})`);
    }
    if (st.isSymbolicLink()) return fail("SYMLINK_ESCAPE", `${file.path}: parent component is a symlink`);
    if (!st.isDirectory()) {
      return file.op === "create"
        ? fail("TARGET_EXISTS", `${file.path}: a parent component is not a directory`)
        : fail("TARGET_MISSING", `${file.path}: a parent component is not a directory`);
    }
    const real = await fs.realpath(cur);
    if (real !== realRoot && !real.startsWith(realRoot + "/")) {
      return fail("SYMLINK_ESCAPE", `${file.path}: parent resolves outside root`);
    }
  }
  if (missingFrom) {
    return file.op === "create" ? null : fail("TARGET_MISSING", `${file.path}: target does not exist`);
  }
  const target = posix.join(cur, last);
  let st;
  try {
    st = await fs.lstat(target);
  } catch (e) {
    if (errCode(e) === "ENOENT") {
      return file.op === "create" ? null : fail("TARGET_MISSING", `${file.path}: target does not exist`);
    }
    return fail("APPLY_FAILED", `${file.path}: lstat failed (${errCode(e) ?? "error"})`);
  }
  if (file.op === "create") return fail("TARGET_EXISTS", `${file.path}: target already exists`);
  if (!st.isFile()) return fail("TARGET_NOT_REGULAR", `${file.path}: target is not a regular file`);
  if (st.size > MAX_CONTENT_BYTES) return fail("TARGET_TOO_LARGE", `${file.path}: existing file too large`);
  if (file.op === "modify" && st.nlink > 1) return fail("TARGET_NOT_REGULAR", `${file.path}: target is hard-linked`);
  return null;
}

type Undo = { path: string; run: () => Promise<void> };

async function writeAll(fh: FileHandle, buf: Buffer): Promise<void> {
  let off = 0;
  while (off < buf.length) {
    const { bytesWritten } = await fh.write(buf, off, buf.length - off, null);
    off += bytesWritten;
  }
}

interface Identity { dev: number; ino: number }
const codeErr = (code: ExecutorErrorCode, msg: string) => Object.assign(new Error(msg), { code });

function verify(st: import("node:fs").Stats, forbidLinks: boolean, expect?: Identity): void {
  if (!st.isFile()) throw codeErr("TARGET_NOT_REGULAR", "not regular");
  if (st.size > MAX_CONTENT_BYTES) throw codeErr("TARGET_TOO_LARGE", "too large");
  if (forbidLinks && st.nlink > 1) throw codeErr("TARGET_NOT_REGULAR", "hard-linked");
  if (expect && (st.dev !== expect.dev || st.ino !== expect.ino)) throw codeErr("TARGET_NOT_REGULAR", "target replaced");
}

/**
 * Opens WITHOUT O_TRUNC and verifies the opened handle (fstat) before anything
 * is changed. Callers truncate only after this returns.
 */
async function openRegular(
  path: string,
  flags: number,
  mode?: number,
  forbidLinks = false,
  expect?: Identity,
): Promise<{ fh: FileHandle; id: Identity }> {
  const fh = await fs.open(path, flags | O_NOFOLLOW | O_NONBLOCK, mode);
  try {
    const st = await fh.stat();
    verify(st, forbidLinks, expect);
    return { fh, id: { dev: st.dev, ino: st.ino } };
  } catch (e) {
    await fh.close();
    throw e;
  }
}

/** mkdir -p one level at a time; records each created dir. Refuses symlinks. */
async function ensureDirs(realRoot: string, dirRel: string, created: string[]): Promise<void> {
  if (dirRel === "" || dirRel === ".") return;
  let cur = realRoot;
  for (const comp of dirRel.split("/")) {
    cur = posix.join(cur, comp);
    try {
      const st = await fs.lstat(cur);
      if (st.isSymbolicLink() || !st.isDirectory()) throw Object.assign(new Error("bad dir"), { code: "ESYMLINK" });
      continue;
    } catch (e) {
      if (errCode(e) !== "ENOENT") throw e;
    }
    await fs.mkdir(cur);
    created.push(cur);
  }
}

export async function applyWorktreePlan(
  plan: WorktreePlan,
  patches: PatchInput[],
  opts: ApplyOptions = {},
): Promise<ApplyResult> {
  const dryRun = opts.dryRun !== false;
  if (!plan || plan.ok !== true || !Array.isArray(plan.files)) {
    return fail("PLAN_INVALID", "plan is not ok");
  }
  if (typeof plan.root !== "string" || !posix.isAbsolute(plan.root)) {
    return fail("PLAN_INVALID", "plan root is not absolute");
  }
  if (typeof plan.workDir !== "string") return fail("PLAN_INVALID", "plan workDir missing");
  if (!Array.isArray(patches)) return fail("PATCH_PLAN_MISMATCH", "patches is not an array");
  {
    const seenPlan = new Set<string>();
    for (const f of plan.files) {
      if (!f || typeof f.path !== "string" || seenPlan.has(f.path)) {
        return fail("PLAN_INVALID", "duplicate or malformed plan entry");
      }
      seenPlan.add(f.path);
    }
  }

  // patches <-> plan
  if (patches.length !== plan.files.length) {
    return fail("PATCH_PLAN_MISMATCH", "patch count differs from plan");
  }
  const byPath = new Map<string, PatchInput>();
  for (const p of patches) {
    if (!p || typeof p.path !== "string" || byPath.has(p.path)) {
      return fail("PATCH_PLAN_MISMATCH", "duplicate or malformed patch");
    }
    byPath.set(p.path, p);
  }
  const contents = new Map<string, Buffer>();
  for (const f of plan.files) {
    const p = byPath.get(f.path);
    if (!p) return fail("PATCH_PLAN_MISMATCH", `${f.path}: no patch`);
    if (p.op !== f.op) return fail("PATCH_PLAN_MISMATCH", `${f.path}: op differs`);
    const hasContent = f.op !== "delete";
    if (hasContent && typeof p.content !== "string") return fail("PATCH_PLAN_MISMATCH", `${f.path}: content missing`);
    const bytes = hasContent ? utf8Len(p.content as string) : 0;
    if (bytes !== f.bytes) return fail("PATCH_PLAN_MISMATCH", `${f.path}: bytes differ`);
    if (hasContent) contents.set(f.path, Buffer.from(p.content as string, "utf8"));
  }

  // Do not trust the plan object: re-plan from root/subPath/patches and compare
  // absPath + sensitive (and everything else) with what the planner would say.
  const subPath = posix.relative(plan.root, plan.workDir);
  if (subPath === ".." || subPath.startsWith("../") || posix.isAbsolute(subPath)) return fail("PLAN_INVALID", "workDir outside root");
  const fresh = planWorktree({ root: plan.root, subPath: subPath === "" ? undefined : subPath, patches });
  if (!fresh.ok) return fail("PLAN_INVALID", `re-plan failed: ${fresh.code}`);
  if (fresh.root !== plan.root || fresh.workDir !== plan.workDir) return fail("PLAN_INVALID", "root/workDir differ from re-plan");
  const freshByPath = new Map(fresh.files.map((f) => [f.path, f]));
  for (const f of plan.files) {
    const g = freshByPath.get(f.path);
    if (!g || g.op !== f.op || g.bytes !== f.bytes || g.absPath !== f.absPath || g.sensitive !== f.sensitive) {
      return fail("PLAN_INVALID", `${f.path}: plan entry differs from re-plan`);
    }
  }

  // sensitive gate (also in dry-run)
  const sensitive = plan.files.filter((f) => f.sensitive).map((f) => f.path);
  if (sensitive.length > 0 && opts.approveSensitive !== true) {
    return fail("SENSITIVE_NOT_APPROVED", "sensitive files need approveSensitive: true", { paths: sensitive });
  }

  // root
  let realRoot: string;
  try {
    realRoot = await fs.realpath(plan.root);
    if (!(await fs.stat(realRoot)).isDirectory()) return fail("ROOT_MISSING", "root is not a directory");
  } catch {
    return fail("ROOT_MISSING", "root does not exist");
  }

  // pre-checks, read-only (checkFile never rejects)
  for (const f of plan.files) {
    const r = await checkFile(realRoot, plan.root, f);
    if (r) return r;
  }

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      files: plan.files.map((f) => ({
        path: f.path,
        op: f.op,
        action: (f.op === "create" ? "would-create" : f.op === "modify" ? "would-modify" : "would-delete") as FileAction,
        bytes: f.bytes,
      })),
    };
  }

  // real mode
  const undo: Undo[] = [];
  const createdDirs: string[] = [];
  const reports: FileReport[] = [];
  /** Returns the paths that could NOT be restored (empty = fully rolled back). */
  const rollback = async (): Promise<string[]> => {
    const unrestored: string[] = [];
    for (const u of undo.reverse()) {
      try {
        await u.run();
      } catch {
        unrestored.push(u.path);
      }
    }
    for (const d of createdDirs.reverse()) {
      try {
        await fs.rmdir(d);
      } catch {
        unrestored.push(posix.relative(realRoot, d) + "/");
      }
    }
    return unrestored;
  };

  const recheck = async (f: { path: string; absPath: string }, op: PatchOp) => {
    const r = await checkFile(realRoot, plan.root, { path: f.path, absPath: f.absPath, op });
    if (r) throw Object.assign(new Error(r.message), { code: r.code });
  };

  try {
    for (const f of plan.files) {
      const again = await checkFile(realRoot, plan.root, f);
      if (again) throw Object.assign(new Error(again.message), { code: again.code });
      const rel = posix.relative(plan.root, f.absPath);
      const target = posix.join(realRoot, rel);
      const buf = contents.get(f.path);

      if (f.op === "create") {
        await ensureDirs(realRoot, posix.dirname(rel), createdDirs);
        const { fh } = await openRegular(target, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL, 0o644);
        undo.push({ path: f.path, run: async () => { await recheck(f, "delete"); await fs.unlink(target); } });
        try {
          await writeAll(fh, buf as Buffer);
        } finally {
          await fh.close();
        }
        reports.push({ path: f.path, op: f.op, action: "created", bytes: f.bytes });
      } else if (f.op === "modify") {
        const { fh: rh, id } = await openRegular(target, fsc.O_RDONLY, undefined, true);
        let original: Buffer;
        let mode: number;
        try {
          original = await rh.readFile();
          mode = (await rh.stat()).mode & 0o7777;
        } finally {
          await rh.close();
        }
        // Verified write handle (no O_TRUNC): same inode as the one we read, single link.
        const { fh: wh } = await openRegular(target, fsc.O_WRONLY, undefined, true, id);
        try {
          undo.push({ path: f.path, run: async () => {
            await recheck(f, "modify");
            const { fh: h } = await openRegular(target, fsc.O_WRONLY, undefined, true, id);
            try {
              await h.truncate(0);
              await writeAll(h, original);
              await h.chmod(mode);
            } finally {
              await h.close();
            }
          } });
          await wh.truncate(0);
          await writeAll(wh, buf as Buffer);
        } finally {
          await wh.close();
        }
        reports.push({ path: f.path, op: f.op, action: "modified", bytes: f.bytes });
      } else {
        const { fh: rh } = await openRegular(target, fsc.O_RDONLY);
        let original: Buffer;
        let mode: number;
        try {
          original = await rh.readFile();
          mode = (await rh.stat()).mode & 0o7777;
        } finally {
          await rh.close();
        }
        await fs.unlink(target);
        undo.push({ path: f.path, run: async () => {
          await recheck(f, "create");
          const { fh: h } = await openRegular(target, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL, mode);
          try {
            await writeAll(h, original);
            await h.chmod(mode);
          } finally {
            await h.close();
          }
        } });
        reports.push({ path: f.path, op: f.op, action: "deleted", bytes: f.bytes });
      }
    }
  } catch (e) {
    const unrestored = await rollback();
    const c = errCode(e);
    const code: ExecutorErrorCode = c && CODES.has(c) ? (c as ExecutorErrorCode) : "APPLY_FAILED";
    const rolledBack = unrestored.length === 0;
    return fail(
      code,
      `apply failed (${c ?? "error"}); ${rolledBack ? "rolled back" : "ROLLBACK INCOMPLETE"}`,
      rolledBack ? { rolledBack } : { rolledBack, unrestoredPaths: unrestored },
    );
  }
  return { ok: true, dryRun: false, files: reports };
}
