/** Pure sandbox policy (BRA-P2-02b). No I/O; every case is deterministic and must never throw. */
import { describe, expect, it } from "vitest";
import { evaluateSandboxAccess as ev, type SandboxPolicy } from "../sandbox-policy";

const base: SandboxPolicy = { workspaceRoot: "/srv/work", allowWrite: true, networkAllowlist: [], shell: false };
const net = (allow: Array<{ host: string; port: number }>): SandboxPolicy => ({ ...base, networkAllowlist: allow });
const read = (path: string, extra: object = {}) => ev(base, { kind: "fs.read", path, ...extra });
const write = (path: string, pol: SandboxPolicy = base) => ev(pol, { kind: "fs.write", path });

describe("filesystem under the workspace root", () => {
  it("allows normalized in-root paths and asks for realpath when no hint is given", () => {
    expect(read("/srv/work/a/b.txt")).toEqual({ decision: "allow", reason: "WORKSPACE_ALLOWED", normalizedPath: "/srv/work/a/b.txt", needsRealpath: true });
    expect(read("/srv/work")).toMatchObject({ decision: "allow" });
  });
  it("write/delete need allowWrite; reads do not", () => {
    const ro = { ...base, allowWrite: false };
    expect(write("/srv/work/a", ro)).toEqual({ decision: "deny", reason: "WRITE_DISABLED" });
    expect(ev(ro, { kind: "fs.delete", path: "/srv/work/a" })).toEqual({ decision: "deny", reason: "WRITE_DISABLED" });
    expect(ev(ro, { kind: "fs.read", path: "/srv/work/a" }).decision).toBe("allow");
    expect(write("/srv/work/a").decision).toBe("allow");
  });
  it("prefix trap: sibling with the root as string prefix is never allowed", () => {
    expect(read("/srv/work-evil/x")).toMatchObject({ decision: "escape-approval-required", reason: "PATH_OUTSIDE_ROOT" });
    expect(read("/srv/workspace")).toMatchObject({ decision: "escape-approval-required" });
  });
  it("outside root always requires escape approval, never allow", () => {
    for (const p of ["/", "/tmp/x", "/home/u/x", "/srv/WORK/a", "/srv/Work"]) {
      expect(read(p).decision).toBe("escape-approval-required");
      expect(write(p).decision).toBe("escape-approval-required");
    }
  });
  it("system and sensitive locations are flagged SENSITIVE_PATH", () => {
    for (const p of ["/etc/passwd", "/proc/1/environ", "/root/x", "/home/u/.ssh/id_rsa", "/srv/work/.ssh/config", "/ETC/passwd"]) {
      expect(read(p)).toMatchObject({ decision: "escape-approval-required", reason: "SENSITIVE_PATH" });
    }
  });
  it(".git/hooks and .env* are escape-only for write/delete, readable otherwise", () => {
    expect(write("/srv/work/.git/hooks/pre-commit")).toMatchObject({ decision: "escape-approval-required", reason: "SENSITIVE_PATH" });
    expect(write("/srv/work/app/.env.local")).toMatchObject({ decision: "escape-approval-required", reason: "SENSITIVE_PATH" });
    expect(ev(base, { kind: "fs.delete", path: "/srv/work/.ENV" })).toMatchObject({ decision: "escape-approval-required" });
    expect(read("/srv/work/.git/hooks/pre-commit").decision).toBe("allow");
    expect(write("/srv/work/.gitignore").decision).toBe("allow");
    expect(write("/srv/work/environment.ts").decision).toBe("allow");
  });
});

describe("path syntax", () => {
  it("dot segments inside the root are denied, not normalized", () => {
    for (const p of ["/srv/work/a/../b", "/srv/work/./a", "/srv/work//a", "/srv/work/a/", "/srv/work/a/./"]) {
      expect(read(p)).toEqual({ decision: "deny", reason: "PATH_NOT_NORMALIZED" });
    }
  });
  it("traversal that leaves the root asks for escape approval", () => {
    expect(read("/srv/work/../../etc/passwd")).toMatchObject({ decision: "escape-approval-required", reason: "SENSITIVE_PATH" });
    expect(read("/srv/work/a/../../x")).toMatchObject({ decision: "escape-approval-required", reason: "PATH_OUTSIDE_ROOT" });
    expect(read("/srv/work/..")).toMatchObject({ decision: "escape-approval-required" });
    expect(read("/srv/work/../work-evil/x").decision).toBe("escape-approval-required");
  });
  it("encoded traversal is a raw name (no decode) and stays in root", () => {
    expect(read("/srv/work/..%2f")).toMatchObject({ decision: "allow", normalizedPath: "/srv/work/..%2f" });
    expect(read("/srv/work/%2e%2e/x").decision).toBe("allow");
    expect(read("/srv/work%2f..%2fetc").decision).toBe("escape-approval-required");
  });
  it("Unicode dot/slash lookalikes are denied", () => {
    for (const p of ["/srv/work/‥/x", "/srv/work/．．/x", "/srv/work/a∕b", "/srv/work/a／b", "/srv/work/⁄"]) {
      expect(read(p)).toEqual({ decision: "deny", reason: "PATH_CONFUSABLE" });
    }
    expect(read("/srv/work/café.txt").decision).toBe("allow");
  });
  it("NUL, control characters, backslash, relative and non-string paths are denied", () => {
    expect(read("/srv/work/a\u0000b")).toEqual({ decision: "deny", reason: "PATH_CONTROL_CHAR" });
    expect(read("/srv/work/a\nb").reason).toBe("PATH_CONTROL_CHAR");
    expect(read("/srv/work/a\\b")).toEqual({ decision: "deny", reason: "PATH_BACKSLASH" });
    expect(read("work/a")).toEqual({ decision: "deny", reason: "PATH_NOT_ABSOLUTE" });
    expect(read("")).toEqual({ decision: "deny", reason: "PATH_NOT_ABSOLUTE" });
    expect(ev(base, { kind: "fs.read", path: 5 })).toEqual({ decision: "deny", reason: "REQUEST_INVALID" });
    expect(ev(base, { kind: "fs.read" })).toEqual({ decision: "deny", reason: "REQUEST_INVALID" });
  });
  it("very long paths and names are denied", () => {
    expect(read("/srv/work/" + "a".repeat(5000))).toEqual({ decision: "deny", reason: "PATH_TOO_LONG" });
    expect(read("/srv/work/" + "a".repeat(256))).toEqual({ decision: "deny", reason: "PATH_TOO_LONG" });
    expect(read("/srv/work/" + "a".repeat(255)).decision).toBe("allow");
  });
});

describe("symlink hints", () => {
  it("resolvedPath inside the root is allowed without needsRealpath", () => {
    expect(read("/srv/work/link", { resolvedPath: "/srv/work/real", isSymlink: true, realpathVerified: true })).toEqual({ decision: "allow", reason: "WORKSPACE_ALLOWED", normalizedPath: "/srv/work/link" });
    // Without realpathVerified:true the hint does not close needsRealpath.
    expect(read("/srv/work/link", { resolvedPath: "/srv/work/real", isSymlink: true })).toMatchObject({ decision: "allow", needsRealpath: true });
    expect(read("/srv/work/link", { resolvedPath: "/srv/work/real", realpathVerified: false })).toMatchObject({ needsRealpath: true });
    expect(read("/srv/work/link", { realpathVerified: true })).toMatchObject({ needsRealpath: true });
  });
  it("resolvedPath outside the root is a symlink escape", () => {
    expect(read("/srv/work/link", { resolvedPath: "/etc/shadow", isSymlink: true })).toMatchObject({ decision: "escape-approval-required", reason: "SYMLINK_ESCAPE" });
    expect(read("/srv/work/link", { resolvedPath: "/srv/work-evil/x" })).toMatchObject({ reason: "SYMLINK_ESCAPE" });
    expect(read("/srv/work/link", { resolvedPath: "/srv/work/../tmp" })).toMatchObject({ reason: "SYMLINK_ESCAPE" });
  });
  it("resolvedPath into a protected place is still protected", () => {
    expect(write("/srv/work/innocent").decision).toBe("allow");
    expect(ev(base, { kind: "fs.write", path: "/srv/work/innocent", resolvedPath: "/srv/work/.git/hooks/post-merge" })).toMatchObject({ decision: "escape-approval-required", reason: "SENSITIVE_PATH" });
  });
  it("symlink flagged without resolution is denied; malformed hints are denied", () => {
    expect(read("/srv/work/link", { isSymlink: true })).toMatchObject({ decision: "allow", needsRealpath: true });
    expect(read("/srv/work/link", { realpathVerified: "yes" })).toEqual({ decision: "deny", reason: "REQUEST_INVALID" });
    expect(read("/srv/work/link", { resolvedPath: "rel/x" })).toEqual({ decision: "deny", reason: "RESOLVED_PATH_INVALID" });
    expect(read("/srv/work/link", { resolvedPath: "/srv/work/a/./b" })).toEqual({ decision: "deny", reason: "RESOLVED_PATH_INVALID" });
    expect(read("/srv/work/link", { resolvedPath: 7 })).toEqual({ decision: "deny", reason: "REQUEST_INVALID" });
    expect(read("/srv/work/link", { isSymlink: "yes" })).toEqual({ decision: "deny", reason: "REQUEST_INVALID" });
  });
});

describe("network", () => {
  const c = (pol: SandboxPolicy, host: unknown, port: unknown = 443) => ev(pol, { kind: "net.connect", host, port });
  it("is closed when the allowlist is empty, for every host", () => {
    for (const h of ["example.com", "127.0.0.1", "localhost", "::1", "ünï.com"]) expect(c(base, h)).toEqual({ decision: "deny", reason: "NETWORK_CLOSED" });
  });
  it("exact host+port match, case-insensitive, no wildcard", () => {
    const pol = net([{ host: "API.Example.com", port: 443 }]);
    expect(c(pol, "api.example.com")).toEqual({ decision: "allow", reason: "NETWORK_ALLOWLISTED", needsResolvedIpCheck: true });
    expect(c(pol, "API.EXAMPLE.COM")).toMatchObject({ decision: "allow" });
    expect(c(pol, "api.example.com", 80)).toEqual({ decision: "escape-approval-required", reason: "NOT_IN_ALLOWLIST" });
    expect(c(pol, "evil.example.com")).toEqual({ decision: "escape-approval-required", reason: "NOT_IN_ALLOWLIST" });
    expect(c(pol, "example.com")).toMatchObject({ decision: "escape-approval-required", reason: "NOT_IN_ALLOWLIST" });
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
    const req = { kind: "fs.read", path: "/srv/work/a" };
    const bad: unknown[] = [undefined, null, 5, "x", [], {}, { ...base, workspaceRoot: "" }, { ...base, workspaceRoot: "work" }, { ...base, workspaceRoot: "/" },
      { ...base, workspaceRoot: "/srv/work/" }, { ...base, workspaceRoot: "/srv/work/../x" }, { ...base, workspaceRoot: "/srv/work//x" }, { ...base, workspaceRoot: "/etc" },
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
    for (const r of [undefined, null, 1, "fs.read", [], {}, { kind: 1 }, { kind: "fs.exec", path: "/srv/work/a" }, { kind: "net.connect" }]) {
      expect(ev(base, r)).toEqual({ decision: "deny", reason: "REQUEST_INVALID" });
    }
  });
  it("hostile objects (throwing getters, proxies) yield deny", () => {
    const evil = { kind: "fs.read", get path(): string { throw new Error("boom"); } };
    expect(ev(base, evil)).toEqual({ decision: "deny", reason: "INTERNAL_ERROR" });
    const px = new Proxy({}, { get() { throw new Error("boom"); }, getPrototypeOf() { throw new Error("boom"); } });
    expect(ev(px, { kind: "fs.read", path: "/srv/work/a" })).toEqual({ decision: "deny", reason: "INTERNAL_ERROR" });
  });
  it("is deterministic and does not mutate its input", () => {
    const pol = net([{ host: "Example.com", port: 443 }]);
    const snap = JSON.stringify(pol);
    const a = ev(pol, { kind: "net.connect", host: "example.com", port: 443 });
    expect(ev(pol, { kind: "net.connect", host: "example.com", port: 443 })).toEqual(a);
    expect(JSON.stringify(pol)).toBe(snap);
  });
});

describe("review fixes (git/secret protection, folding, root rules)", () => {
  const w = (path: string, pol: SandboxPolicy = base) => ev(pol, { kind: "fs.write", path });
  const d = (path: string, pol: SandboxPolicy = base) => ev(pol, { kind: "fs.delete", path });
  const SENS = { decision: "escape-approval-required", reason: "SENSITIVE_PATH" };

  it("any .git component is escape-only for write/delete", () => {
    for (const p of ["/srv/work/.git/config", "/srv/work/.git/hooks/pre-commit", "/srv/work/.git/modules/x/hooks/y", "/srv/work/.git/info/exclude", "/srv/work/sub/.git/HEAD", "/srv/work/.git"]) {
      expect(w(p)).toMatchObject(SENS);
      expect(d(p)).toMatchObject(SENS);
    }
    for (const p of ["/srv/work/.gitmodules", "/srv/work/.gitattributes", "/srv/work/.husky/pre-commit", "/srv/work/a/.husky/x"]) expect(w(p)).toMatchObject(SENS);
    expect(w("/srv/work/.gitignore").decision).toBe("allow");
    expect(w("/srv/work/.github/ci.yml").decision).toBe("allow");
    expect(read("/srv/work/.git/HEAD").decision).toBe("allow");
    expect(read("/srv/work/.git/hooks/x").decision).toBe("allow");
  });
  it("secrets are not readable without escape approval", () => {
    for (const p of ["/srv/work/.git/config", "/srv/work/.git-credentials", "/srv/work/.netrc", "/srv/work/.npmrc", "/srv/work/.aws/credentials", "/srv/work/.gnupg/x",
      "/srv/work/.kube/config", "/srv/work/.ssh/id", "/srv/work/id_rsa", "/srv/work/id_rsa.pub", "/srv/work/keys/id_ed25519", "/srv/work/.env", "/srv/work/a/.env.production"]) {
      expect(read(p)).toMatchObject(SENS);
    }
    expect(read("/srv/work/environment.ts").decision).toBe("allow");
    expect(read("/srv/work/src/id_dsa_notes.txt").decision).toBe("allow");
  });
  it("Unicode/FS folding: long s, trailing dot/space, case, Kelvin sign", () => {
    expect(w("/srv/work/.git/hookſ")).toMatchObject(SENS);
    expect(read("/srv/work/.ſsh/x")).toMatchObject(SENS);
    expect(w("/srv/work/.git./x")).toMatchObject(SENS);
    expect(w("/srv/work/.GIT/x")).toMatchObject(SENS);
    expect(w("/srv/work/.git /x")).toMatchObject(SENS);
    expect(read("/srv/work/.Kube/x")).toMatchObject(SENS); // Kelvin sign folds to k
    expect(read("/srv/work/.kube/x")).toMatchObject(SENS);
    expect(read("/srv/work/.KUBE/x")).toMatchObject(SENS);
  });
  it("invisible / default-ignorable characters are denied", () => {
    for (const p of ["/srv/work/.git​/config", "/srv/work/a‍b", "/srv/work/a‮b", "/srv/work/a﻿b", "/srv/work/a­b", "/srv/work/⁠x"]) {
      expect(read(p)).toEqual({ decision: "deny", reason: "PATH_INVISIBLE" });
    }
  });
  it("allowWrite:false denies write/delete on every path before anything else", () => {
    const ro = { ...base, allowWrite: false };
    for (const p of ["/srv/work/a", "/srv/work/.git/config", "/etc/passwd", "/", "/srv/work/../x", "rel", 5, "/srv/work/.env"]) {
      expect(ev(ro, { kind: "fs.write", path: p })).toEqual({ decision: "deny", reason: "WRITE_DISABLED" });
      expect(ev(ro, { kind: "fs.delete", path: p })).toEqual({ decision: "deny", reason: "WRITE_DISABLED" });
    }
  });
  it("deleting the workspace root or an ancestor is denied", () => {
    for (const p of ["/srv/work", "/srv", "/", "/srv/work/", "/srv/work/.", "/srv/work/a/..", "/srv/work/../work"]) {
      expect(d(p)).toEqual({ decision: "deny", reason: "ROOT_DELETE" });
    }
    expect(d("/srv/work/a").decision).toBe("allow");
    expect(d("/srv/work-evil").decision).toBe("escape-approval-required");
    expect(read("/srv/work").decision).toBe("allow");
    expect(ev(base, { kind: "fs.delete", path: "/srv/work/link", resolvedPath: "/srv/work", realpathVerified: true })).toEqual({ decision: "deny", reason: "ROOT_DELETE" });
  });
  it("workspaceRoot validation: depth < 2 and system locations are invalid", () => {
    for (const r of ["/", "/Users", "/home", "/usr", "/var", "/tmp", "/etc", "/root", "/srv", "/etc/x", "/proc/1", "/root/ws", "/home/u/.ssh", "/Users/"]) {
      expect(ev({ ...base, workspaceRoot: r }, { kind: "fs.read", path: "/srv/work/a" })).toEqual({ decision: "deny", reason: "POLICY_INVALID" });
    }
    expect(ev({ ...base, workspaceRoot: "/Users/u/ws" }, { kind: "fs.read", path: "/Users/u/ws/a" }).decision).toBe("allow");
    expect(ev({ ...base, workspaceRoot: "/tmp/ws" }, { kind: "fs.read", path: "/tmp/ws/a" }).decision).toBe("allow");
  });
  it("network: non-listed host with a populated allowlist needs escape approval; allow carries needsResolvedIpCheck", () => {
    const pol = net([{ host: "example.com", port: 443 }]);
    expect(ev(pol, { kind: "net.connect", host: "other.org", port: 443 })).toEqual({ decision: "escape-approval-required", reason: "NOT_IN_ALLOWLIST" });
    expect(ev(pol, { kind: "net.connect", host: "example.com", port: 443 })).toMatchObject({ decision: "allow", needsResolvedIpCheck: true });
    expect(ev(base, { kind: "net.connect", host: "other.org", port: 443 })).toEqual({ decision: "deny", reason: "NETWORK_CLOSED" });
  });
  it("more special hosts: trailing-dot localhost, upper-case hex IPv4, v4-mapped IPv6", () => {
    const hosts = ["localhost.", "0X7F.1", "[::ffff:127.0.0.1]", "::ffff:7f00:1", "LocalHost.", "127.1"];
    const pol = net(hosts.map((host) => ({ host, port: 80 })));
    for (const host of hosts) expect(ev(pol, { kind: "net.connect", host, port: 80 })).toEqual({ decision: "escape-approval-required", reason: "HOST_SPECIAL" });
  });
  it("allowlist size cap (257) and sparse arrays invalidate the policy", () => {
    const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ host: "h" + i + ".com", port: 443 }));
    const req = { kind: "net.connect", host: "h0.com", port: 443 };
    expect(ev(net(mk(256)), req).decision).toBe("allow");
    expect(ev(net(mk(257)), req)).toEqual({ decision: "deny", reason: "POLICY_INVALID" });
    const sparse = mk(3);
    delete (sparse as unknown[])[1];
    expect(ev(net(sparse), req)).toEqual({ decision: "deny", reason: "POLICY_INVALID" });
    expect(ev(net(new Array(2)), req)).toEqual({ decision: "deny", reason: "POLICY_INVALID" });
  });
  it("reads each input field once (stateful getters cannot flip a decision)", () => {
    let reads = 0;
    const req = { kind: "fs.read", get path(): string { reads++; return reads === 1 ? "/srv/work/a" : "/etc/passwd"; } };
    expect(ev(base, req)).toMatchObject({ decision: "allow", normalizedPath: "/srv/work/a" });
    expect(reads).toBe(1);
    let kindReads = 0;
    const r2 = { get kind(): string { kindReads++; return kindReads === 1 ? "fs.read" : "shell.exec"; }, path: "/srv/work/a" };
    expect(ev(base, r2).decision).toBe("allow");
    expect(kindReads).toBe(1);
    let pr = 0;
    const pol = { get workspaceRoot(): string { pr++; return pr === 1 ? "/srv/work" : "/"; }, allowWrite: true, networkAllowlist: [], shell: false };
    expect(ev(pol, { kind: "fs.read", path: "/srv/work/a" }).decision).toBe("allow");
    expect(pr).toBe(1);
  });
});
