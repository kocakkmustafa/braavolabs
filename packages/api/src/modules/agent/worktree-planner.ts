/**
 * BRA-P1-03b — pure worktree planner for code agents.
 *
 * `planWorktree` decides WHERE a code agent may work (root + safe sub path)
 * and WHAT it may write (patch plan). It performs no fs / git / network I/O —
 * it only validates strings and returns a deterministic plan that a later,
 * separate executor may apply. Every path is validated segment by segment and
 * the result is re-checked with a normalize + prefix test so it can never
 * leave the root.
 *
 * Executor contract (the planner does NOT do these):
 * - No URL decoding: `..%2f` is an ordinary file name here and is accepted.
 *   The executor must use paths as-is and never percent-decode them.
 * - Pass `absPath` to APIs with `--` and without a shell. Names starting with
 *   `-` or containing `;`, `$()`, quotes etc. are legal and must stay inert.
 * - Symlink safety (lstat / realpath / O_NOFOLLOW) is the executor's job; the
 *   planner only sees strings.
 * - Files flagged `sensitive: true` are allowed but need an extra approval
 *   gate before being written.
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
  | "PATH_CONFLICT"
  | "PATCH_INVALID"
  | "PATCH_DUPLICATE"
  | "PATCH_TOO_MANY"
  | "PATCH_TOO_LARGE";

export interface PlannedFile {
  /** Path relative to workDir (validated). */
  path: string;
  /** Absolute path, guaranteed under workDir. */
  absPath: string;
  op: PatchOp;
  bytes: number;
  /** True for files that can execute code or change tooling when written. */
  sensitive: boolean;
  reason?: string;
}

export type WorktreePlan =
  | { ok: true; root: string; workDir: string; files: PlannedFile[] }
  | { ok: false; code: PlanErrorCode; message: string };

export const MAX_PATH_LENGTH = 512;
export const MAX_SEGMENT_BYTES = 255;
export const MAX_PATCHES = 500;
export const MAX_CONTENT_BYTES = 1024 * 1024;
export const MAX_TOTAL_BYTES = 8 * 1024 * 1024;

// Character classes are built from code points so the source has no escapes
// that tooling could mangle.
const BS = String.fromCharCode(92);
const hex = (n: number) => BS + "u" + n.toString(16).padStart(4, "0");
function charClass(ranges: Array<[number, number?]>): RegExp {
  return new RegExp("[" + ranges.map(([a, b]) => (b === undefined ? hex(a) : hex(a) + "-" + hex(b))).join("") + "]");
}

// C0, DEL, C1 controls (includes NUL, newline, CR, tab).
const CONTROL_RE = charClass([[0x00, 0x1f], [0x7f, 0x9f]]);
// Zero-width, bidi and other invisible format characters.
const INVISIBLE_RE = charClass([
  [0xad], [0x34f], [0x61c], [0x115f], [0x1160], [0x17b4], [0x17b5], [0x180e],
  [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x206f], [0x3164],
  [0xfe00, 0xfe0f], [0xfeff], [0xffa0],
]);
// Dot / slash look-alikes (also caught by the NFKC check; listed explicitly).
const LOOKALIKE_RE = charClass([
  [0x2024], [0x2025], [0x2044], [0x2215], [0x29f5], [0x29f8], [0x2571], [0x2572],
  [0x3002], [0xfe52], [0xff0e], [0xff0f], [0xff3c], [0xff61],
]);
const DRIVE_RE = /^[A-Za-z]:/;
const SHORT_GIT_RE = /^git~\d+$/i; // NTFS 8.3 short name for .git
const DEVICE_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

type Check = { ok: true; value: string } | { ok: false; code: PlanErrorCode; message: string };
const bad = (code: PlanErrorCode, message: string): Check => ({ ok: false, code, message });

/** True when the string contains an unpaired UTF-16 surrogate. */
function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1);
      if (n >= 0xdc00 && n <= 0xdfff) i++;
      else return true;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

const utf8Len = (s: string) => Buffer.byteLength(s, "utf8");

/** Validate a relative POSIX path; returns it unchanged when safe. */
export function validateRelativePath(input: unknown, label = "path"): Check {
  if (typeof input !== "string" || input.length === 0) return bad("PATH_EMPTY", `${label}: empty`);
  if (input.length > MAX_PATH_LENGTH) return bad("PATH_TOO_LONG", `${label}: too long`);
  if (CONTROL_RE.test(input)) return bad("PATH_CONTROL_CHAR", `${label}: control character`);
  if (input !== input.trim()) return bad("PATH_WHITESPACE", `${label}: leading/trailing whitespace`);
  if (input.includes(BS)) {
    return bad(input.startsWith(BS + BS) ? "PATH_DRIVE_OR_UNC" : "PATH_BACKSLASH", `${label}: backslash`);
  }
  if (DRIVE_RE.test(input) || input.startsWith("//")) {
    return bad("PATH_DRIVE_OR_UNC", `${label}: drive or UNC path`);
  }
  if (input.startsWith("/")) return bad("PATH_ABSOLUTE", `${label}: absolute path`);
  if (hasLoneSurrogate(input)) return bad("PATH_UNICODE", `${label}: lone surrogate`);
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
    if (utf8Len(seg) > MAX_SEGMENT_BYTES) return bad("PATH_TOO_LONG", `${label}: segment too long`);
    if (seg.endsWith(".") || seg.endsWith(" ")) {
      return bad("PATH_WHITESPACE", `${label}: segment ends with dot or space`);
    }
    if (seg.includes(":")) return bad("PATH_RESERVED", `${label}: ':' in segment (NTFS stream)`);
    const lower = seg.toLowerCase();
    if (lower === ".git" || lower === ".gitmodules" || SHORT_GIT_RE.test(seg) || DEVICE_RE.test(seg)) {
      return bad("PATH_RESERVED", `${label}: reserved segment`);
    }
  }
  return { ok: true, value: input };
}

function validateRoot(root: unknown): Check {
  if (typeof root !== "string" || root.length === 0) return bad("ROOT_INVALID", "root: empty");
  if (root.length > MAX_PATH_LENGTH) return bad("ROOT_INVALID", "root: too long");
  if (!root.startsWith("/") || root.startsWith("//")) return bad("ROOT_INVALID", "root: must be absolute POSIX");
  if (
    CONTROL_RE.test(root) || INVISIBLE_RE.test(root) || LOOKALIKE_RE.test(root) ||
    root.includes(BS) || hasLoneSurrogate(root)
  ) {
    return bad("ROOT_INVALID", "root: forbidden character");
  }
  if (root.normalize("NFKC") !== root) return bad("ROOT_INVALID", "root: not NFKC-stable");
  const segs = root.slice(1).split("/");
  if (segs.some((s) => s === "" || s === "." || s === "..")) {
    return bad("ROOT_INVALID", "root: must be normalized (no empty, '.' or '..' segments)");
  }
  if (segs.some((s) => s.toLowerCase() === ".git" || SHORT_GIT_RE.test(s))) {
    return bad("ROOT_INVALID", "root: must not contain a .git segment");
  }
  return { ok: true, value: root };
}

/** Join + normalize + prefix check; null if the result is not strictly below base. */
function joinUnder(base: string, rel: string): string | null {
  const abs = posix.resolve(base, rel);
  return abs.startsWith(base + "/") ? abs : null;
}

const SENSITIVE_BASENAMES: Record<string, string> = {
  ".gitattributes": "git attributes (filters/drivers)",
  "package.json": "npm scripts / dependencies",
  ".npmrc": "npm configuration",
  ".envrc": "direnv auto-executed shell",
  makefile: "build script",
};
const SENSITIVE_PREFIXES: Array<[string, string]> = [
  [".husky/", "git hooks"],
  [".githooks/", "git hooks"],
  [".github/workflows/", "CI workflow"],
];

/** Classify a validated relative path; returns a reason when sensitive. */
function sensitiveReason(rel: string): string | undefined {
  const lower = rel.toLowerCase();
  if (lower === ".vscode/tasks.json") return "editor tasks (auto-runnable)";
  for (const [prefix, reason] of SENSITIVE_PREFIXES) {
    if (lower.startsWith(prefix)) return reason;
  }
  const base = lower.slice(lower.lastIndexOf("/") + 1);
  return Object.prototype.hasOwnProperty.call(SENSITIVE_BASENAMES, base) ? SENSITIVE_BASENAMES[base] : undefined;
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
  let total = 0;
  for (const [i, p] of patches.entries()) {
    const label = `patches[${i}]`;
    const op = p?.op;
    const content = p?.content;
    const path = p?.path;
    if (op !== "create" && op !== "modify" && op !== "delete") {
      return { ok: false, code: "PATCH_INVALID", message: `${label}: bad op` };
    }
    const rel = validateRelativePath(path, `${label}.path`);
    if (!rel.ok) return rel;
    const absPath = joinUnder(workDir, rel.value);
    if (!absPath) return { ok: false, code: "PATH_ESCAPES_ROOT", message: `${label}: escapes workDir` };
    let bytes = 0;
    if (op !== "delete") {
      if (typeof content !== "string") {
        return { ok: false, code: "PATCH_INVALID", message: `${label}: content required` };
      }
      bytes = utf8Len(content);
      if (bytes > MAX_CONTENT_BYTES) return { ok: false, code: "PATCH_INVALID", message: `${label}: content too large` };
      total += bytes;
      if (total > MAX_TOTAL_BYTES) return { ok: false, code: "PATCH_TOO_LARGE", message: "total content too large" };
    }
    const key = rel.value.toLowerCase(); // case-insensitive FS safe
    if (seen.has(key)) return { ok: false, code: "PATCH_DUPLICATE", message: `${label}: duplicate path` };
    seen.add(key);
    const reason = sensitiveReason(rel.value);
    const file: PlannedFile = { path: rel.value, absPath, op, bytes, sensitive: reason !== undefined };
    if (reason !== undefined) file.reason = reason;
    files.push(file);
  }

  // File/dir conflicts: no path may be a proper ancestor of another.
  for (const f of files) {
    const segs = f.path.toLowerCase().split("/");
    for (let n = 1; n < segs.length; n++) {
      if (seen.has(segs.slice(0, n).join("/"))) {
        return { ok: false, code: "PATH_CONFLICT", message: `${f.path}: conflicts with a file at its parent path` };
      }
    }
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { ok: true, root: root.value, workDir, files };
}
