/**
 * BRA-P1-03b — pure worktree planner for code agents.
 *
 * `planWorktree` decides WHERE a code agent may work (root + safe sub path)
 * and WHAT it may write (patch plan). It performs no fs / git / network I/O —
 * it only validates strings and returns a deterministic plan that a later,
 * separate executor may apply. Every path is validated segment by segment and
 * the result is re-checked with a normalize + prefix test so it can never
 * leave the root.
 */
import { posix } from "node:path";

export type PatchOp = "create" | "modify" | "delete";

export interface PatchInput {
  /** Path relative to the working directory (POSIX, `/` separated). */
  path: string;
  op: PatchOp;
  /** Required for create/modify; ignored for delete. */
  content?: string;
}

export interface WorktreeInput {
  /** Absolute POSIX root directory, e.g. `/var/work/run-1`. */
  root: string;
  /** Optional safe sub path below root; omitted = root itself. */
  subPath?: string;
  patches?: PatchInput[];
}

export type PlanErrorCode =
  | "ROOT_INVALID"
  | "PATH_EMPTY"
  | "PATH_TOO_LONG"
  | "PATH_ABSOLUTE"
  | "PATH_BACKSLASH"
  | "PATH_DRIVE_OR_UNC"
  | "PATH_CONTROL_CHAR"
  | "PATH_WHITESPACE"
  | "PATH_EMPTY_SEGMENT"
  | "PATH_DOT_SEGMENT"
  | "PATH_TRAVERSAL"
  | "PATH_UNICODE"
  | "PATH_RESERVED"
  | "PATH_ESCAPES_ROOT"
  | "PATCH_INVALID"
  | "PATCH_DUPLICATE"
  | "PATCH_TOO_MANY";

export interface PlannedFile {
  /** Path relative to workDir (validated). */
  path: string;
  /** Absolute path, guaranteed under workDir. */
  absPath: string;
  op: PatchOp;
  bytes: number;
}

export type WorktreePlan =
  | { ok: true; root: string; workDir: string; files: PlannedFile[] }
  | { ok: false; code: PlanErrorCode; message: string };

export const MAX_PATH_LENGTH = 512;
export const MAX_SEGMENT_LENGTH = 255;
export const MAX_PATCHES = 500;
export const MAX_CONTENT_BYTES = 1024 * 1024;

// C0, DEL, C1 controls (includes NUL, newline, CR, tab).
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;
// Zero-width, bidi and other invisible format characters.
const INVISIBLE_RE =
  /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0]/;
// Dot / slash look-alikes (also caught by the NFKC check; listed explicitly).
const LOOKALIKE_RE =
  /[\u2024\u2025\u2044\u2215\u29f5\u29f8\u2571\u2572\u3002\ufe52\uff0e\uff0f\uff3c\uff61]/;
const DRIVE_RE = /^[A-Za-z]:/;

type Check = { ok: true; value: string } | { ok: false; code: PlanErrorCode; message: string };
const bad = (code: PlanErrorCode, message: string): Check => ({ ok: false, code, message });

/** Validate a relative POSIX path; returns it unchanged when safe. */
export function validateRelativePath(input: unknown, label = "path"): Check {
  if (typeof input !== "string" || input.length === 0) return bad("PATH_EMPTY", `${label}: empty`);
  if (input.length > MAX_PATH_LENGTH) return bad("PATH_TOO_LONG", `${label}: too long`);
  if (CONTROL_RE.test(input)) return bad("PATH_CONTROL_CHAR", `${label}: control character`);
  if (input !== input.trim()) return bad("PATH_WHITESPACE", `${label}: leading/trailing whitespace`);
  if (input.includes("\\")) {
    return bad(input.startsWith("\\\\") ? "PATH_DRIVE_OR_UNC" : "PATH_BACKSLASH", `${label}: backslash`);
  }
  if (DRIVE_RE.test(input) || input.startsWith("//")) {
    return bad("PATH_DRIVE_OR_UNC", `${label}: drive or UNC path`);
  }
  if (input.startsWith("/")) return bad("PATH_ABSOLUTE", `${label}: absolute path`);
  if (INVISIBLE_RE.test(input) || LOOKALIKE_RE.test(input)) {
    return bad("PATH_UNICODE", `${label}: invisible or look-alike character`);
  }
  if (input.normalize("NFC") !== input || input.normalize("NFKC") !== input) {
    return bad("PATH_UNICODE", `${label}: not NFC/NFKC-stable`);
  }
  for (const seg of input.split("/")) {
    if (seg === "") return bad("PATH_EMPTY_SEGMENT", `${label}: empty segment`);
    if (seg === "..") return bad("PATH_TRAVERSAL", `${label}: '..' segment`);
    if (seg === ".") return bad("PATH_DOT_SEGMENT", `${label}: '.' segment`);
    if (seg.length > MAX_SEGMENT_LENGTH) return bad("PATH_TOO_LONG", `${label}: segment too long`);
    if (seg.endsWith(".") || seg.endsWith(" ")) {
      return bad("PATH_WHITESPACE", `${label}: segment ends with dot or space`);
    }
    if (seg.toLowerCase() === ".git") return bad("PATH_RESERVED", `${label}: reserved segment`);
  }
  return { ok: true, value: input };
}

function validateRoot(root: unknown): Check {
  if (typeof root !== "string" || root.length === 0) return bad("ROOT_INVALID", "root: empty");
  if (root.length > MAX_PATH_LENGTH) return bad("ROOT_INVALID", "root: too long");
  if (!root.startsWith("/") || root.startsWith("//")) return bad("ROOT_INVALID", "root: must be absolute POSIX");
  if (CONTROL_RE.test(root) || INVISIBLE_RE.test(root) || LOOKALIKE_RE.test(root) || root.includes("\\")) {
    return bad("ROOT_INVALID", "root: forbidden character");
  }
  if (root.normalize("NFKC") !== root) return bad("ROOT_INVALID", "root: not NFKC-stable");
  const segs = root.slice(1).split("/");
  if (segs.some((s) => s === "" || s === "." || s === "..")) {
    return bad("ROOT_INVALID", "root: must be normalized (no empty, '.' or '..' segments)");
  }
  return { ok: true, value: root };
}

/** Join + normalize + prefix check; null if the result is not strictly below base. */
function joinUnder(base: string, rel: string): string | null {
  const abs = posix.resolve(base, rel);
  return abs.startsWith(base + "/") ? abs : null;
}

export function planWorktree(input: WorktreeInput): WorktreePlan {
  const root = validateRoot(input?.root);
  if (!root.ok) return root;

  let workDir = root.value;
  if (input.subPath !== undefined) {
    const sub = validateRelativePath(input.subPath, "subPath");
    if (!sub.ok) return sub;
    const joined = joinUnder(root.value, sub.value);
    if (!joined) return { ok: false, code: "PATH_ESCAPES_ROOT", message: "subPath: escapes root" };
    workDir = joined;
  }

  const patches = input.patches ?? [];
  if (!Array.isArray(patches)) return { ok: false, code: "PATCH_INVALID", message: "patches: not an array" };
  if (patches.length > MAX_PATCHES) return { ok: false, code: "PATCH_TOO_MANY", message: "too many patches" };

  const seen = new Set<string>();
  const files: PlannedFile[] = [];
  for (const [i, p] of patches.entries()) {
    const label = `patches[${i}]`;
    if (!p || (p.op !== "create" && p.op !== "modify" && p.op !== "delete")) {
      return { ok: false, code: "PATCH_INVALID", message: `${label}: bad op` };
    }
    const rel = validateRelativePath(p.path, `${label}.path`);
    if (!rel.ok) return rel;
    const absPath = joinUnder(workDir, rel.value);
    if (!absPath) return { ok: false, code: "PATH_ESCAPES_ROOT", message: `${label}: escapes workDir` };
    let bytes = 0;
    if (p.op !== "delete") {
      if (typeof p.content !== "string") {
        return { ok: false, code: "PATCH_INVALID", message: `${label}: content required` };
      }
      bytes = Buffer.byteLength(p.content, "utf8");
      if (bytes > MAX_CONTENT_BYTES) return { ok: false, code: "PATCH_INVALID", message: `${label}: content too large` };
    }
    const key = rel.value.toLowerCase(); // case-insensitive FS safe
    if (seen.has(key)) return { ok: false, code: "PATCH_DUPLICATE", message: `${label}: duplicate path` };
    seen.add(key);
    files.push({ path: rel.value, absPath, op: p.op, bytes });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { ok: true, root: root.value, workDir, files };
}
