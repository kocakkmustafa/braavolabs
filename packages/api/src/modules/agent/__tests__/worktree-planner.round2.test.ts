import { describe, it, expect } from "vitest";
import { planWorktree } from "../worktree-planner";

const root = "/var/work/run-1";
const c = (n: number) => String.fromCodePoint(n);
const create = (path: string) => ({ path, op: "create" as const, content: "x" });
const code = (p: ReturnType<typeof planWorktree>) => (p.ok ? "OK" : p.code);
const sub = (subPath: string) => code(planWorktree({ root, subPath }));
const one = (path: string, subPath?: string) => planWorktree({ root, subPath, patches: [create(path)] });
const sens = (path: string, subPath?: string) => {
  const p = one(path, subPath);
  return p.ok ? p.files[0].sensitive : `ERR:${p.code}`;
};

describe("sensitive classification on root-relative path", () => {
  it("flags files whose sensitive part lives in subPath", () => {
    expect(sens("ci.yml", ".github/workflows")).toBe(true);
    expect(sens("pre-commit", ".husky")).toBe(true);
    expect(sens("tasks.json", ".vscode")).toBe(true);
    expect(sens("launch.json", ".vscode")).toBe(true);
    expect(sens("workflows/ci.yml", ".github")).toBe(true);
    expect(sens("package.json", "pkg")).toBe(true);
  });
  it("flags at any depth", () => {
    expect(sens("pkg/.husky/pre-commit")).toBe(true);
    expect(sens("a/b/.githooks/x")).toBe(true);
    expect(sens("a/.github/workflows/x.yml")).toBe(true);
    expect(sens("a/b/.vscode/tasks.json")).toBe(true);
    expect(sens("a/b/Makefile")).toBe(true);
    expect(sens("a/b/.envrc")).toBe(true);
  });
  it("flags the extended list", () => {
    for (const f of [
      ".yarnrc.yml", ".yarnrc", ".pnpmfile.cjs", "GNUmakefile", ".pre-commit-config.yaml",
      ".claude/settings.json", ".mcp.json", ".cursor/rules/x.mdc", ".codex/config.toml",
    ]) {
      expect(sens(f)).toBe(true);
    }
  });
  it("gives a reason and does not flag ordinary files", () => {
    const p = one("ci.yml", ".github/workflows");
    expect(p.ok && p.files[0].reason).toBe("CI/GitHub config");
    expect(sens(".gitignore")).toBe(false);
    expect(sens("github/workflows/x.yml")).toBe(false);
  });
});

describe("reserved names on root-relative path", () => {
  it("subPath .git is rejected even with innocent file", () => {
    expect(code(one("hooks/x", ".git"))).toBe("PATH_RESERVED");
    expect(sub("a/.GIT")).toBe("PATH_RESERVED");
    expect(code(one(".git/x"))).toBe("PATH_RESERVED");
  });
  it("rejects 8.3 short names for .git and .gitmodules", () => {
    expect(sub("GITMOD~1")).toBe("PATH_RESERVED");
    expect(sub("x/gitmod~12")).toBe("PATH_RESERVED");
    expect(sub("GIT~1")).toBe("PATH_RESERVED");
  });
  it("accepts false-positive look-alikes", () => {
    for (const n of ["my.git.txt", "legit/x", "gitlab/ci.yml", "GITHUB.md", ".gitignore", "console/x"]) {
      expect(sub(n)).toBe("OK");
    }
  });
});

describe("invisible and look-alike code points", () => {
  it("rejects invisible characters", () => {
    for (const cp of [0x2060, 0xfeff, 0x00ad, 0x3164, 0xffa0, 0x180b, 0x180c, 0x180d, 0xe0041, 0xe007f, 0xe0100]) {
      expect(sub("a" + c(cp) + "b")).toBe("PATH_UNICODE");
    }
  });
  it("rejects dot and slash look-alikes", () => {
    for (const cp of [0x29f5, 0x29f8, 0x2571, 0x2572, 0x3002]) {
      expect(sub("a" + c(cp) + "b")).toBe("PATH_UNICODE");
    }
  });
  it("rejects invisible astral characters in the root", () => {
    expect(code(planWorktree({ root: "/x" + c(0xe0041) }))).toBe("ROOT_INVALID");
  });
});
