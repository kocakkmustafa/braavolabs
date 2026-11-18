/** Pure sandbox policy (BRA-P2-02b). No I/O; every case is deterministic and must never throw. */
import { describe, expect, it } from "vitest";
import { evaluateSandboxAccess as ev, type SandboxPolicy } from "../sandbox-policy";

const base: SandboxPolicy = { workspaceRoot: "/work", allowWrite: true, networkAllowlist: [], shell: false };
const net = (allow: Array<{ host: string; port: number }>): SandboxPolicy => ({ ...base, networkAllowlist: allow });
const read = (path: string, extra: object = {}) => ev(base, { kind: "fs.read", path, ...extra });
const write = (path: string, pol: SandboxPolicy = base) => ev(pol, { kind: "fs.write", path });

describe("filesystem under the workspace root", () => {
  it("allows normalized in-root paths and asks for realpath when no hint is given", () => {
    expect(read("/work/a/b.txt")).toEqual({ decision: "allow", reason: "WORKSPACE_ALLOWED", normalizedPath: "/work/a/b.txt", needsRealpath: true });
    expect(read("/work")).toMatchObject({ decision: "allow" });
  });
  it("write/delete need allowWrite; reads do not", () => {
    const ro = { ...base, allowWrite: false };
    expect(write("/work/a", ro)).toEqual({ decision: "deny", reason: "WRITE_DISABLED" });
    expect(ev(ro, { kind: "fs.delete", path: "/work/a" })).toEqual({ decision: "deny", reason: "WRITE_DISABLED" });
    expect(ev(ro, { kind: "fs.read", path: "/work/a" }).decision).toBe("allow");
    expect(write("/work/a").decision).toBe("allow");
  });
  it("prefix trap: sibling with the root as string prefix is never allowed", () => {
    expect(read("/work-evil/x")).toMatchObject({ decision: "escape-approval-required", reason: "PATH_OUTSIDE_ROOT" });
    expect(read("/workspace")).toMatchObject({ decision: "escape-approval-required" });
  });
  it("outside root always requires escape approval, never allow", () => {
    for (const p of ["/", "/tmp/x", "/home/u/x", "/WORK/a", "/Work"]) {
      expect(read(p).decision).toBe("escape-approval-required");
      expect(write(p).decision).toBe("escape-approval-required");
    }
  });
  it("system and sensitive locations are flagged SENSITIVE_PATH", () => {
    for (const p of ["/etc/passwd", "/proc/1/environ", "/root/x", "/home/u/.ssh/id_rsa", "/work/.ssh/config", "/ETC/passwd"]) {
      expect(read(p)).toMatchObject({ decision: "escape-approval-required", reason: "SENSITIVE_PATH" });
    }
  });
  it(".git/hooks and .env* are escape-only for write/delete, readable otherwise", () => {
    expect(write("/work/.git/hooks/pre-commit")).toMatchObject({ decision: "escape-approval-required", reason: "SENSITIVE_PATH" });
    expect(write("/work/app/.env.local")).toMatchObject({ decision: "escape-approval-required", reason: "SENSITIVE_PATH" });
    expect(ev(base, { kind: "fs.delete", path: "/work/.ENV" })).toMatchObject({ decision: "escape-approval-required" });
    expect(read("/work/.git/hooks/pre-commit").decision).toBe("allow");
    expect(write("/work/.gitignore").decision).toBe("allow");
    expect(write("/work/environment.ts").decision).toBe("allow");
  });
});

describe("path syntax", () => {
  it("dot segments inside the root are denied, not normalized", () => {
    for (const p of ["/work/a/../b", "/work/./a", "/work//a", "/work/a/", "/work/a/./"]) {
      expect(read(p)).toEqual({ decision: "deny", reason: "PATH_NOT_NORMALIZED" });
    }
  });
  it("traversal that leaves the root asks for escape approval", () => {
    expect(read("/work/../etc/passwd")).toMatchObject({ decision: "escape-approval-required", reason: "SENSITIVE_PATH" });
    expect(read("/work/a/../../x")).toMatchObject({ decision: "escape-approval-required", reason: "PATH_OUTSIDE_ROOT" });
    expect(read("/work/..")).toMatchObject({ decision: "escape-approval-required" });
    expect(read("/work/../work-evil/x").decision).toBe("escape-approval-required");
  });
  it("encoded traversal is a raw name (no decode) and stays in root", () => {
    expect(read("/work/..%2f")).toMatchObject({ decision: "allow", normalizedPath: "/work/..%2f" });
    expect(read("/work/%2e%2e/x").decision).toBe("allow");
    expect(read("/work%2f..%2fetc").decision).toBe("escape-approval-required");
  });
  it("Unicode dot/slash lookalikes are denied", () => {
    for (const p of ["/work/‥/x", "/work/．．/x", "/work/a∕b", "/work/a／b", "/work/⁄"]) {
      expect(read(p)).toEqual({ decision: "deny", reason: "PATH_CONFUSABLE" });
    }
    expect(read("/work/café.txt").decision).toBe("allow");
  });
  it("NUL, control characters, backslash, relative and non-string paths are denied", () => {
    expect(read("/work/a\u0000b")).toEqual({ decision: "deny", reason: "PATH_CONTROL_CHAR" });
    expect(read("/work/a\nb").reason).toBe("PATH_CONTROL_CHAR");
    expect(read("/work/a\\b")).toEqual({ decision: "deny", reason: "PATH_BACKSLASH" });
    expect(read("work/a")).toEqual({ decision: "deny", reason: "PATH_NOT_ABSOLUTE" });
    expect(read("")).toEqual({ decision: "deny", reason: "PATH_NOT_ABSOLUTE" });
    expect(ev(base, { kind: "fs.read", path: 5 })).toEqual({ decision: "deny", reason: "REQUEST_INVALID" });
    expect(ev(base, { kind: "fs.read" })).toEqual({ decision: "deny", reason: "REQUEST_INVALID" });
  });
  it("very long paths and names are denied", () => {
    expect(read("/work/" + "a".repeat(5000))).toEqual({ decision: "deny", reason: "PATH_TOO_LONG" });
    expect(read("/work/" + "a".repeat(256))).toEqual({ decision: "deny", reason: "PATH_TOO_LONG" });
    expect(read("/work/" + "a".repeat(255)).decision).toBe("allow");
  });
});

describe("symlink hints", () => {
  it("resolvedPath inside the root is allowed without needsRealpath", () => {
    expect(read("/work/link", { resolvedPath: "/work/real", isSymlink: true })).toEqual({ decision: "allow", reason: "WORKSPACE_ALLOWED", normalizedPath: "/work/link" });
  });
  it("resolvedPath outside the root is a symlink escape", () => {
    expect(read("/work/link", { resolvedPath: "/etc/shadow", isSymlink: true })).toMatchObject({ decision: "escape-approval-required", reason: "SYMLINK_ESCAPE" });
    expect(read("/work/link", { resolvedPath: "/work-evil/x" })).toMatchObject({ reason: "SYMLINK_ESCAPE" });
    expect(read("/work/link", { resolvedPath: "/work/../tmp" })).toMatchObject({ reason: "SYMLINK_ESCAPE" });
  });
  it("resolvedPath into a protected place is still protected", () => {
    expect(write("/work/innocent").decision).toBe("allow");
    expect(ev(base, { kind: "fs.write", path: "/work/innocent", resolvedPath: "/work/.git/hooks/post-merge" })).toMatchObject({ decision: "escape-approval-required", reason: "SENSITIVE_PATH" });
  });
  it("symlink flagged without resolution is denied; malformed hints are denied", () => {
    expect(read("/work/link", { isSymlink: true })).toEqual({ decision: "deny", reason: "SYMLINK_UNRESOLVED" });
    expect(read("/work/link", { resolvedPath: "rel/x" })).toEqual({ decision: "deny", reason: "RESOLVED_PATH_INVALID" });
    expect(read("/work/link", { resolvedPath: "/work/a/./b" })).toEqual({ decision: "deny", reason: "RESOLVED_PATH_INVALID" });
    expect(read("/work/link", { resolvedPath: 7 })).toEqual({ decision: "deny", reason: "REQUEST_INVALID" });
    expect(read("/work/link", { isSymlink: "yes" })).toEqual({ decision: "deny", reason: "REQUEST_INVALID" });
  });
});

describe("network", () => {
  const c = (pol: SandboxPolicy, host: unknown, port: unknown = 443) => ev(pol, { kind: "net.connect", host, port });
  it("is closed when the allowlist is empty, for every host", () => {
    for (const h of ["example.com", "127.0.0.1", "localhost", "::1", "ünï.com"]) expect(c(base, h)).toEqual({ decision: "deny", reason: "NETWORK_CLOSED" });
  });
  it("exact host+port match, case-insensitive, no wildcard", () => {
    const pol = net([{ host: "API.Example.com", port: 443 }]);
    expect(c(pol, "api.example.com")).toEqual({ decision: "allow", reason: "NETWORK_ALLOWLISTED" });
    expect(c(pol, "API.EXAMPLE.COM")).toMatchObject({ decision: "allow" });
    expect(c(pol, "api.example.com", 80)).toEqual({ decision: "deny", reason: "NOT_IN_ALLOWLIST" });
    expect(c(pol, "evil.example.com")).toEqual({ decision: "deny", reason: "NOT_IN_ALLOWLIST" });
    expect(c(pol, "example.com")).toMatchObject({ decision: "deny" });
    expect(c(pol, "api.example.com.")).toEqual({ decision: "deny", reason: "HOST_INVALID" });
    expect(c(pol, "*.example.com")).toEqual({ decision: "deny", reason: "HOST_INVALID" });
    expect(c(pol, "api.example.com@evil.com")).toEqual({ decision: "deny", reason: "HOST_INVALID" });
    expect(c(pol, "api.example.com:443")).toMatchObject({ decision: "escape-approval-required" });
  });
  it("a wildcard in the policy allowlist invalidates the policy", () => {
    expect(c(net([{ host: "*.example.com", port: 443 }]), "a.example.com")).toEqual({ decision: "deny", reason: "POLICY_INVALID" });
  });
  it("IP literals, localhost, metadata and IDN need escape approval even if allowlisted", () => {
    const hosts = ["127.0.0.1", "10.0.0.5", "169.254.169.254", "192.168.1.1", "0.0.0.0", "::1", "[::1]", "2001:db8::1", "localhost", "LOCALHOST", "foo.localhost", "metadata.google.internal", "2130706433", "0x7f000001", "bücher.de", "xn--bcher-kva.de"];
    const pol = net(hosts.map((host) => ({ host, port: 443 })));
    for (const h of hosts) expect(c(pol, h)).toEqual({ decision: "escape-approval-required", reason: "HOST_SPECIAL" });
  });
  it("invalid host/port inputs are denied", () => {
    const pol = net([{ host: "example.com", port: 443 }]);
    expect(c(pol, "")).toEqual({ decision: "deny", reason: "HOST_INVALID" });
    expect(c(pol, "a b.com")).toEqual({ decision: "deny", reason: "HOST_INVALID" });
    expect(c(pol, 5)).toEqual({ decision: "deny", reason: "REQUEST_INVALID" });
    for (const port of [0, 65536, -1, 1.5, "443", NaN, null]) expect(c(pol, "example.com", port)).toEqual({ decision: "deny", reason: "REQUEST_INVALID" });
  });
});

describe("shell", () => {
  it("is always denied", () => {
    expect(ev(base, { kind: "shell.exec", command: "ls" })).toEqual({ decision: "deny", reason: "SHELL_DISABLED" });
    expect(ev(base, { kind: "shell.exec", command: 5 })).toEqual({ decision: "deny", reason: "SHELL_DISABLED" });
    expect(ev(net([{ host: "example.com", port: 1 }]), { kind: "shell.exec" })).toMatchObject({ decision: "deny" });
  });
});

describe("robustness", () => {
  it("malformed policies deny and never throw", () => {
    const req = { kind: "fs.read", path: "/work/a" };
    const bad: unknown[] = [undefined, null, 5, "x", [], {}, { ...base, workspaceRoot: "" }, { ...base, workspaceRoot: "work" }, { ...base, workspaceRoot: "/" },
      { ...base, workspaceRoot: "/work/" }, { ...base, workspaceRoot: "/work/../x" }, { ...base, workspaceRoot: "/work//x" }, { ...base, workspaceRoot: "/etc" },
      { ...base, workspaceRoot: "/etc/app" }, { ...base, workspaceRoot: "/a\u0000b" }, { ...base, allowWrite: "yes" }, { ...base, shell: true }, { ...base, shell: undefined },
      { ...base, networkAllowlist: "x" }, { ...base, networkAllowlist: [null] }, { ...base, networkAllowlist: [{ host: "a", port: 0 }] },
      { ...base, networkAllowlist: [{ host: "", port: 1 }] }, { ...base, workspaceRoot: 1 }];
    for (const p of bad) expect(ev(p, req)).toEqual({ decision: "deny", reason: "POLICY_INVALID" });
  });
  it("networkAllowlist defaults to closed when omitted", () => {
    const { networkAllowlist: _omit, ...rest } = base;
    expect(ev(rest, { kind: "net.connect", host: "example.com", port: 443 })).toEqual({ decision: "deny", reason: "NETWORK_CLOSED" });
  });
  it("malformed requests deny and never throw", () => {
    for (const r of [undefined, null, 1, "fs.read", [], {}, { kind: 1 }, { kind: "fs.exec", path: "/work/a" }, { kind: "net.connect" }]) {
      expect(ev(base, r)).toEqual({ decision: "deny", reason: "REQUEST_INVALID" });
    }
  });
  it("hostile objects (throwing getters, proxies) yield deny", () => {
    const evil = { kind: "fs.read", get path(): string { throw new Error("boom"); } };
    expect(ev(base, evil)).toEqual({ decision: "deny", reason: "INTERNAL_ERROR" });
    const px = new Proxy({}, { get() { throw new Error("boom"); }, getPrototypeOf() { throw new Error("boom"); } });
    expect(ev(px, { kind: "fs.read", path: "/work/a" })).toEqual({ decision: "deny", reason: "INTERNAL_ERROR" });
  });
  it("is deterministic and does not mutate its input", () => {
    const pol = net([{ host: "Example.com", port: 443 }]);
    const snap = JSON.stringify(pol);
    const a = ev(pol, { kind: "net.connect", host: "example.com", port: 443 });
    expect(ev(pol, { kind: "net.connect", host: "example.com", port: 443 })).toEqual(a);
    expect(JSON.stringify(pol)).toBe(snap);
  });
});
