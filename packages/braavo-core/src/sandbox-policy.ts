/**
 * Sandbox policy (BRA-P2-02b, ADR-0008): PURE decision function. No I/O, never throws, deterministic.
 * Deny-by-default. It only decides; it is wired to nothing (no flag, route, migration or UI).
 *
 * Symlink contract: the function cannot resolve symlinks. The caller MAY pass `resolvedPath` (what its own
 * realpath returned) together with `realpathVerified: true`; only then is `needsRealpath` closed. With only
 * `resolvedPath` and/or `isSymlink` (no `realpathVerified: true`) the result still carries `needsRealpath: true`
 * (a resolvedPath outside the root still escalates). Network allow results carry `needsResolvedIpCheck: true`:
 * the executor must re-check the DNS-resolved IP with the HOST_SPECIAL rules (DNS rebinding).
 * Inputs are read exactly once into locals (getter drift cannot change a decision mid-evaluation).
 */

export const SANDBOX_REASONS = [
  "POLICY_INVALID",
  "REQUEST_INVALID",
  "PATH_TOO_LONG",
  "PATH_CONTROL_CHAR",
  "PATH_INVISIBLE",
  "PATH_BACKSLASH",
  "PATH_NOT_ABSOLUTE",
  "PATH_CONFUSABLE",
  "PATH_NOT_NORMALIZED",
  "PATH_OUTSIDE_ROOT",
  "SENSITIVE_PATH",
  "SYMLINK_ESCAPE",
  "RESOLVED_PATH_INVALID",
  "ROOT_DELETE",
  "WRITE_DISABLED",
  "WORKSPACE_ALLOWED",
  "NETWORK_CLOSED",
  "NETWORK_ALLOWLISTED",
  "NOT_IN_ALLOWLIST",
  "HOST_INVALID",
  "HOST_SPECIAL",
  "SHELL_DISABLED",
  "INTERNAL_ERROR",
] as const;
export type SandboxReason = (typeof SANDBOX_REASONS)[number];

export interface SandboxPolicy {
  workspaceRoot: string;
  allowWrite: boolean;
  networkAllowlist: Array<{ host: string; port: number }>;
  shell: false;
}

export type SandboxRequest =
  | {
      kind: "fs.read" | "fs.write" | "fs.delete";
      path: string;
      /** Caller-resolved real path. Closes `needsRealpath` only together with `realpathVerified: true`. */
      resolvedPath?: string;
      isSymlink?: boolean;
      /** True only when the caller itself ran realpath on `path` and `resolvedPath` is its result. */
      realpathVerified?: boolean;
    }
  | { kind: "net.connect"; host: string; port: number }
  | { kind: "shell.exec"; command: string };

export interface SandboxDecision {
  decision: "allow" | "deny" | "escape-approval-required";
  reason: SandboxReason;
  normalizedPath?: string;
  needsRealpath?: true;
  needsResolvedIpCheck?: true;
}

type FsKind = "fs.read" | "fs.write" | "fs.delete";

const MAX_PATH = 4096;
const MAX_NAME = 255;
const MAX_HOST = 253;
const MAX_ALLOWLIST = 256;
const CONTROL = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]");
const INVISIBLE = /\p{Default_Ignorable_Code_Point}/u;
const SLASH_LOOK = new RegExp("[\\u2044\\u2215\\u29f8\\u2571\\u1735]");
const SYSTEM_PREFIXES = ["/etc", "/proc", "/sys", "/dev", "/root", "/boot", "/private/etc", "/var", "/usr", "/bin", "/sbin", "/lib", "/system", "/library"];
const SENSITIVE_ROOTS = ["/etc", "/proc", "/sys", "/dev", "/root", "/boot", "/private/etc"];
const FORBIDDEN_ROOTS = ["/", "/users", "/home", "/usr", "/var", "/tmp", "/etc", "/root"];

const deny = (reason: SandboxReason): SandboxDecision => ({ decision: "deny", reason });
const escape = (reason: SandboxReason, normalizedPath?: string): SandboxDecision =>
  normalizedPath === undefined ? { decision: "escape-approval-required", reason } : { decision: "escape-approval-required", reason, normalizedPath };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isPort = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 65535;

/** Canonical comparison form: NFKC, full case fold (upper then lower), trailing dots/spaces dropped. */
function canon(seg: string): string {
  let s = seg.normalize("NFKC").toUpperCase().toLowerCase();
  while (s.length > 0 && (s.endsWith(".") || s.endsWith(" "))) s = s.slice(0, -1);
  return s;
}

/** True when a segment can be mistaken for "." / ".." or contain a separator after Unicode folding. */
function confusable(seg: string): boolean {
  if (seg === "." || seg === "..") return false; // literal dot segments are classified separately
  if (SLASH_LOOK.test(seg)) return true;
  const n = seg.normalize("NFKC");
  return n === "." || n === ".." || n.includes("/") || n.includes("\\");
}

interface SafePolicy { root: string; allowWrite: boolean; allowlist: Array<{ host: string; port: number }> }

function readPolicy(policy: unknown): SafePolicy | null {
  if (!isObj(policy)) return null;
  const root = policy.workspaceRoot;
  const allowWrite = policy.allowWrite;
  const shell = policy.shell;
  const rawList = policy.networkAllowlist;
  if (typeof root !== "string" || !root.startsWith("/") || root.length > MAX_PATH || CONTROL.test(root) || INVISIBLE.test(root) || root.includes("\\")) return null;
  const segs = root.slice(1).split("/");
  if (segs.length < 2) return null; // depth < 2 (/, /Users, /home, /tmp ...)
  if (segs.some((s) => s === "" || s === "." || s === ".." || s.length > MAX_NAME || confusable(s))) return null;
  const lowerRoot = root.toLowerCase();
  if (FORBIDDEN_ROOTS.includes(lowerRoot)) return null;
  if (SENSITIVE_ROOTS.some((p) => lowerRoot === p || lowerRoot.startsWith(p + "/")) || segs.some((s) => canon(s) === ".ssh")) return null;
  if (typeof allowWrite !== "boolean" || shell !== false) return null;
  const list = rawList === undefined ? [] : rawList;
  if (!Array.isArray(list) || list.length > MAX_ALLOWLIST) return null;
  const allowlist: Array<{ host: string; port: number }> = [];
  for (let i = 0; i < list.length; i++) {
    const e: unknown = list[i]; // holes in sparse arrays read as undefined -> invalid
    if (!isObj(e)) return null;
    const host = e.host;
    const port = e.port;
    if (typeof host !== "string" || !isPort(port)) return null;
    if (host.length === 0 || host.length > MAX_HOST || host.includes("*") || /[\s\u0000-\u001f\u007f]/.test(host)) return null;
    allowlist.push({ host: host.toLowerCase(), port });
  }
  return { root, allowWrite, allowlist };
}

const inRoot = (p: string, root: string): boolean => p === root || p.startsWith(root + "/");
/** `p` is the root itself or one of its ancestors. */
const rootOrAncestor = (p: string, root: string): boolean => p === root || p === "/" || root.startsWith(p + "/");

type PathCheck =
  | { ok: true; path: string; segments: string[] }
  | { ok: false; result: SandboxDecision };

/** Syntactic check. Non-normalized paths are never normalized for the caller, only classified. */
function checkPath(raw: unknown, root: string, kind: FsKind): PathCheck {
  if (typeof raw !== "string") return { ok: false, result: deny("REQUEST_INVALID") };
  if (raw.length > MAX_PATH) return { ok: false, result: deny("PATH_TOO_LONG") };
  if (CONTROL.test(raw)) return { ok: false, result: deny("PATH_CONTROL_CHAR") };
  if (INVISIBLE.test(raw)) return { ok: false, result: deny("PATH_INVISIBLE") };
  if (raw.includes("\\")) return { ok: false, result: deny("PATH_BACKSLASH") };
  if (!raw.startsWith("/")) return { ok: false, result: deny("PATH_NOT_ABSOLUTE") };
  if (raw === "/") return { ok: false, result: kind === "fs.delete" ? deny("ROOT_DELETE") : escape("PATH_OUTSIDE_ROOT") };
  const segments = raw.slice(1).split("/");
  if (segments.some((s) => s.length > MAX_NAME)) return { ok: false, result: deny("PATH_TOO_LONG") };
  if (segments.some(confusable)) return { ok: false, result: deny("PATH_CONFUSABLE") };
  if (segments.some((s) => s === "" || s === "." || s === "..")) {
    const stack: string[] = [];
    for (const s of segments) {
      if (s === "" || s === ".") continue;
      if (s === "..") stack.pop();
      else stack.push(s);
    }
    const lexical = "/" + stack.join("/");
    if (kind === "fs.delete" && rootOrAncestor(lexical, root)) return { ok: false, result: deny("ROOT_DELETE") };
    return { ok: false, result: inRoot(lexical, root) ? deny("PATH_NOT_NORMALIZED") : escape(classifyOutside(stack)) };
  }
  if (kind === "fs.delete" && rootOrAncestor(raw, root)) return { ok: false, result: deny("ROOT_DELETE") };
  return { ok: true, path: raw, segments };
}

function classifyOutside(segs: string[]): SandboxReason {
  const c = segs.map(canon);
  const joined = "/" + c.join("/");
  if (SYSTEM_PREFIXES.some((s) => joined === s || joined.startsWith(s + "/")) || c.includes(".ssh")) return "SENSITIVE_PATH";
  return "PATH_OUTSIDE_ROOT";
}

/** Secrets and VCS/hook internals inside the workspace; `rel` = path segments below the root. */
function sensitiveInside(rel: string[], kind: FsKind): boolean {
  const c = rel.map(canon);
  const base = c.length > 0 ? c[c.length - 1] : "";
  const gitAt = c.indexOf(".git");
  // Secrets: never read, never written without approval.
  if (c.some((s) => s === ".ssh" || s === ".aws" || s === ".gnupg" || s === ".kube")) return true;
  if (base === ".git-credentials" || base === ".netrc" || base === ".npmrc") return true;
  if (base.startsWith("id_rsa") || base.startsWith("id_ed25519") || base.startsWith(".env")) return true;
  if (gitAt >= 0 && c[gitAt + 1] === "config") return true;
  if (kind === "fs.read") return false;
  // Write/delete: any .git component, git/husky metadata files.
  if (gitAt >= 0) return true;
  return base === ".gitmodules" || base === ".gitattributes" || c.includes(".husky");
}

const relSegs = (path: string, root: string): string[] => path.slice(root.length + 1).split("/").filter((s) => s !== "");

function evalFs(
  p: SafePolicy, kind: FsKind, path: unknown, rp: unknown, sym: unknown, verified: unknown,
): SandboxDecision {
  if (kind !== "fs.read" && !p.allowWrite) return deny("WRITE_DISABLED"); // before anything path-related
  if ((rp !== undefined && typeof rp !== "string") || (sym !== undefined && typeof sym !== "boolean") || (verified !== undefined && typeof verified !== "boolean")) {
    return deny("REQUEST_INVALID");
  }
  const c = checkPath(path, p.root, kind);
  if (!c.ok) return c.result;
  const target = c.path;
  if (!inRoot(target, p.root)) return escape(classifyOutside(c.segments), target);
  if (sensitiveInside(relSegs(target, p.root), kind)) return escape("SENSITIVE_PATH", target);

  let needsRealpath = true;
  if (typeof rp === "string") {
    const r = checkPath(rp, p.root, "fs.read");
    if (!r.ok) return r.result.decision === "escape-approval-required" ? escape("SYMLINK_ESCAPE", target) : deny("RESOLVED_PATH_INVALID");
    if (!inRoot(r.path, p.root)) return escape("SYMLINK_ESCAPE", target);
    if (kind === "fs.delete" && rootOrAncestor(r.path, p.root)) return deny("ROOT_DELETE");
    if (sensitiveInside(relSegs(r.path, p.root), kind)) return escape("SENSITIVE_PATH", target);
    if (verified === true) needsRealpath = false;
  }
  const out: SandboxDecision = { decision: "allow", reason: "WORKSPACE_ALLOWED", normalizedPath: target };
  if (needsRealpath) out.needsRealpath = true;
  return out;
}

function hostSpecial(h: string): boolean {
  if (h.includes(":") || h.startsWith("[")) return true; // IPv6 literal (incl. v4-mapped)
  if (/^[0-9.]+$/.test(h) || /^0x[0-9a-f.]*$/i.test(h)) return true; // IPv4 literal (decimal/hex forms)
  if (h.split(".").every((l) => /^(0x[0-9a-f]+|[0-9]+)$/i.test(l))) return true;
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".localdomain")) return true;
  return h === "metadata" || h === "instance-data";
}

function evalNet(p: SafePolicy, host: unknown, port: unknown): SandboxDecision {
  if (typeof host !== "string" || !isPort(port)) return deny("REQUEST_INVALID");
  if (p.allowlist.length === 0) return deny("NETWORK_CLOSED");
  if (host.length === 0 || host.length > MAX_HOST || /[\s\u0000-\u001f\u007f*/\\@?#%]/.test(host)) return deny("HOST_INVALID");
  // Non-ASCII or punycode (IDN) hosts and IP-literal/local/metadata hosts always need escape approval.
  if (/[^\u0000-\u007f]/.test(host) || host.toLowerCase().split(".").some((l) => l.startsWith("xn--"))) return escape("HOST_SPECIAL");
  const h = host.toLowerCase();
  if (hostSpecial(h.endsWith(".") ? h.slice(0, -1) : h)) return escape("HOST_SPECIAL");
  if (h.endsWith(".") || h.startsWith(".") || h.includes("..") || !/^[a-z0-9.-]+$/.test(h)) return deny("HOST_INVALID");
  if (p.allowlist.some((e) => e.host === h && e.port === port)) return { decision: "allow", reason: "NETWORK_ALLOWLISTED", needsResolvedIpCheck: true };
  return escape("NOT_IN_ALLOWLIST");
}

export function evaluateSandboxAccess(policy: unknown, request: unknown): SandboxDecision {
  try {
    const p = readPolicy(policy);
    if (!p) return deny("POLICY_INVALID");
    if (!isObj(request)) return deny("REQUEST_INVALID");
    const kind = request.kind;
    switch (kind) {
      case "fs.read":
      case "fs.write":
      case "fs.delete": {
        const path = request.path;
        const rp = request.resolvedPath;
        const sym = request.isSymlink;
        const verified = request.realpathVerified;
        return evalFs(p, kind, path, rp, sym, verified);
      }
      case "net.connect": {
        const host = request.host;
        const port = request.port;
        return evalNet(p, host, port);
      }
      case "shell.exec":
        return deny("SHELL_DISABLED");
      default:
        return deny("REQUEST_INVALID");
    }
  } catch {
    return deny("INTERNAL_ERROR");
  }
}
