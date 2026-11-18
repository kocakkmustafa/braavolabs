/**
 * Sandbox policy (BRA-P2-02b, ADR-0008): PURE decision function. No I/O, never throws, deterministic.
 * Deny-by-default. It only decides; it is wired to nothing (no flag, route, migration or UI).
 * Symlinks cannot be resolved here: the caller may pass `resolvedPath`/`isSymlink` hints; without a hint
 * only the syntactic check runs and an allow result carries `needsRealpath: true`.
 */

export const SANDBOX_REASONS = [
  "POLICY_INVALID",
  "REQUEST_INVALID",
  "PATH_TOO_LONG",
  "PATH_CONTROL_CHAR",
  "PATH_BACKSLASH",
  "PATH_NOT_ABSOLUTE",
  "PATH_CONFUSABLE",
  "PATH_NOT_NORMALIZED",
  "PATH_OUTSIDE_ROOT",
  "SENSITIVE_PATH",
  "SYMLINK_ESCAPE",
  "SYMLINK_UNRESOLVED",
  "RESOLVED_PATH_INVALID",
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
  | { kind: "fs.read" | "fs.write" | "fs.delete"; path: string; resolvedPath?: string; isSymlink?: boolean }
  | { kind: "net.connect"; host: string; port: number }
  | { kind: "shell.exec"; command: string };

export interface SandboxDecision {
  decision: "allow" | "deny" | "escape-approval-required";
  reason: SandboxReason;
  normalizedPath?: string;
  needsRealpath?: true;
}

const MAX_PATH = 4096;
const MAX_NAME = 255;
const MAX_HOST = 253;
const MAX_ALLOWLIST = 256;
// eslint-disable-next-line no-control-regex
const CONTROL = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]");
const SLASH_LOOK = new RegExp("[\\u2044\\u2215\\u29f8\\u2571\\u1735]");
const SYSTEM_PREFIXES = ["/etc", "/proc", "/sys", "/dev", "/root", "/boot", "/private/etc", "/var", "/usr", "/bin", "/sbin", "/lib", "/system", "/library"];
const SENSITIVE_ROOTS = ["/etc", "/proc", "/sys", "/dev", "/root", "/boot", "/private/etc"];

const deny = (reason: SandboxReason): SandboxDecision => ({ decision: "deny", reason });
const escape = (reason: SandboxReason, normalizedPath?: string): SandboxDecision =>
  normalizedPath === undefined ? { decision: "escape-approval-required", reason } : { decision: "escape-approval-required", reason, normalizedPath };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isPort = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 65535;

interface SafePolicy { root: string; allowWrite: boolean; allowlist: Array<{ host: string; port: number }> }

function readPolicy(policy: unknown): SafePolicy | null {
  if (!isObj(policy)) return null;
  const root = policy.workspaceRoot;
  if (typeof root !== "string" || !root.startsWith("/") || root === "/" || root.length > MAX_PATH || CONTROL.test(root) || root.includes("\\")) return null;
  const segs = root.slice(1).split("/");
  if (segs.some((s) => s === "" || s === "." || s === ".." || s.length > MAX_NAME || confusable(s))) return null;
  const lowerRoot = root.toLowerCase();
  if (SENSITIVE_ROOTS.some((p) => lowerRoot === p || lowerRoot.startsWith(p + "/")) || segs.some((s) => s.toLowerCase() === ".ssh")) return null;
  if (typeof policy.allowWrite !== "boolean" || policy.shell !== false) return null;
  const list = policy.networkAllowlist === undefined ? [] : policy.networkAllowlist;
  if (!Array.isArray(list) || list.length > MAX_ALLOWLIST) return null;
  const allowlist: Array<{ host: string; port: number }> = [];
  for (const e of list) {
    if (!isObj(e) || typeof e.host !== "string" || !isPort(e.port)) return null;
    if (e.host.length === 0 || e.host.length > MAX_HOST || e.host.includes("*") || /[\s\u0000-\u001f\u007f]/.test(e.host)) return null;
    allowlist.push({ host: e.host.toLowerCase(), port: e.port });
  }
  return { root, allowWrite: policy.allowWrite, allowlist };
}

/** True when a segment can be mistaken for "." / ".." or contain a separator after Unicode folding. */
function confusable(seg: string): boolean {
  if (seg === "." || seg === "..") return false; // literal dot segments are classified separately
  if (SLASH_LOOK.test(seg)) return true;
  const n = seg.normalize("NFKC");
  return n === "." || n === ".." || n.includes("/") || n.includes("\\");
}

type PathCheck =
  | { ok: true; path: string; segments: string[] }
  | { ok: false; result: SandboxDecision };

/** Syntactic check; `rootFn` is used to classify non-normalized paths that lexically leave the root. */
function checkPath(raw: unknown, root: string, allowDotLexicalEscape: boolean): PathCheck {
  if (typeof raw !== "string") return { ok: false, result: deny("REQUEST_INVALID") };
  if (raw.length > MAX_PATH) return { ok: false, result: deny("PATH_TOO_LONG") };
  if (CONTROL.test(raw)) return { ok: false, result: deny("PATH_CONTROL_CHAR") };
  if (raw.includes("\\")) return { ok: false, result: deny("PATH_BACKSLASH") };
  if (!raw.startsWith("/")) return { ok: false, result: deny("PATH_NOT_ABSOLUTE") };
  if (raw === "/") return { ok: false, result: escape("PATH_OUTSIDE_ROOT") };
  const segments = raw.slice(1).split("/");
  if (segments.some((s) => s.length > MAX_NAME)) return { ok: false, result: deny("PATH_TOO_LONG") };
  if (segments.some(confusable)) return { ok: false, result: deny("PATH_CONFUSABLE") };
  if (segments.some((s) => s === "" || s === "." || s === "..")) {
    // Never normalize on the caller's behalf; only classify where it would land.
    const stack: string[] = [];
    for (const s of segments) {
      if (s === "" || s === ".") continue;
      if (s === "..") stack.pop();
      else stack.push(s);
    }
    const lexical = "/" + stack.join("/");
    return { ok: false, result: inRoot(lexical, root) ? deny("PATH_NOT_NORMALIZED") : escape(classifyOutside(lexical)) };
  }
  return { ok: true, path: raw, segments };
}

const inRoot = (p: string, root: string): boolean => p === root || p.startsWith(root + "/");

function classifyOutside(p: string): SandboxReason {
  const lower = p.toLowerCase();
  if (SYSTEM_PREFIXES.some((s) => lower === s || lower.startsWith(s + "/")) || lower.split("/").includes(".ssh")) return "SENSITIVE_PATH";
  return "PATH_OUTSIDE_ROOT";
}

function sensitiveInside(rel: string[], kind: string): boolean {
  const lower = rel.map((s) => s.toLowerCase());
  if (lower.includes(".ssh")) return true;
  if (kind === "fs.read") return false;
  for (let i = 0; i < lower.length - 1; i++) if (lower[i] === ".git" && lower[i + 1] === "hooks") return true;
  return lower.length > 0 && lower[lower.length - 1].startsWith(".env");
}

function evalFs(p: SafePolicy, req: Record<string, unknown>, kind: "fs.read" | "fs.write" | "fs.delete"): SandboxDecision {
  const c = checkPath(req.path, p.root, true);
  if (!c.ok) return c.result;
  const path = c.path;
  if (!inRoot(path, p.root)) return escape(classifyOutside(path), path);
  if (sensitiveInside(path.slice(p.root.length + 1).split("/").filter((s) => s !== ""), kind)) return escape("SENSITIVE_PATH", path);

  const rp = req.resolvedPath;
  const sym = req.isSymlink;
  if ((rp !== undefined && typeof rp !== "string") || (sym !== undefined && typeof sym !== "boolean")) return deny("REQUEST_INVALID");
  let needsRealpath = true;
  if (typeof rp === "string") {
    const r = checkPath(rp, p.root, true);
    if (!r.ok) return r.result.decision === "escape-approval-required" ? escape("SYMLINK_ESCAPE", path) : deny("RESOLVED_PATH_INVALID");
    if (!inRoot(r.path, p.root)) return escape("SYMLINK_ESCAPE", path);
    if (sensitiveInside(r.path.slice(p.root.length + 1).split("/").filter((s) => s !== ""), kind)) return escape("SENSITIVE_PATH", path);
    needsRealpath = false;
  } else if (sym === true) {
    return deny("SYMLINK_UNRESOLVED");
  }
  if (kind !== "fs.read" && !p.allowWrite) return deny("WRITE_DISABLED");
  const out: SandboxDecision = { decision: "allow", reason: "WORKSPACE_ALLOWED", normalizedPath: path };
  if (needsRealpath) out.needsRealpath = true;
  return out;
}

const IPV4ISH = /^[0-9.]+$/;
function hostSpecial(h: string): boolean {
  if (h.includes(":") || h.startsWith("[")) return true; // IPv6 literal
  if (IPV4ISH.test(h) || /^0x[0-9a-f.]*$/i.test(h)) return true; // IPv4 literal (decimal/hex forms)
  const labels = h.split(".");
  if (labels.every((l) => /^(0x[0-9a-f]+|[0-9]+)$/i.test(l))) return true;
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".localdomain")) return true;
  return h === "metadata" || h === "instance-data";
}

function evalNet(p: SafePolicy, req: Record<string, unknown>): SandboxDecision {
  const host = req.host;
  if (typeof host !== "string" || !isPort(req.port)) return deny("REQUEST_INVALID");
  if (p.allowlist.length === 0) return deny("NETWORK_CLOSED");
  if (host.length === 0 || host.length > MAX_HOST || /[\s\u0000-\u001f\u007f*/\\@?#%]/.test(host)) return deny("HOST_INVALID");
  // Non-ASCII or punycode (IDN) hosts and IP-literal/local/metadata hosts always need escape approval.
  // eslint-disable-next-line no-control-regex
  if (/[^\u0000-\u007f]/.test(host) || host.toLowerCase().split(".").some((l) => l.startsWith("xn--"))) return escape("HOST_SPECIAL");
  const h = host.toLowerCase();
  if (hostSpecial(h)) return escape("HOST_SPECIAL");
  if (h.endsWith(".") || h.startsWith(".") || h.includes("..") || !/^[a-z0-9.-]+$/.test(h)) return deny("HOST_INVALID");
  return p.allowlist.some((e) => e.host === h && e.port === req.port) ? { decision: "allow", reason: "NETWORK_ALLOWLISTED" } : deny("NOT_IN_ALLOWLIST");
}

export function evaluateSandboxAccess(policy: unknown, request: unknown): SandboxDecision {
  try {
    const p = readPolicy(policy);
    if (!p) return deny("POLICY_INVALID");
    if (!isObj(request) || typeof request.kind !== "string") return deny("REQUEST_INVALID");
    switch (request.kind) {
      case "fs.read":
      case "fs.write":
      case "fs.delete":
        return evalFs(p, request, request.kind);
      case "net.connect":
        return evalNet(p, request);
      case "shell.exec":
        return deny("SHELL_DISABLED");
      default:
        return deny("REQUEST_INVALID");
    }
  } catch {
    return deny("INTERNAL_ERROR");
  }
}
