import { describe, it, expect } from "vitest";
import { planWorktree, MAX_PATCHES } from "../worktree-planner";

const root = "/var/work/run-1";
const c = (n: number) => String.fromCharCode(n);
const create = (path: string, content = "x") => ({ path, op: "create" as const, content });
const code = (p: ReturnType<typeof planWorktree>) => (p.ok ? "OK" : p.code);
const sub = (subPath: string) => code(planWorktree({ root, subPath }));
const patch = (...paths: string[]) => code(planWorktree({ root, patches: paths.map((x) => create(x)) }));

describe("planWorktree hardening", () => {
  it("rejects file/dir conflicts case-insensitively", () => {
    expect(patch("a", "a/b")).toBe("PATH_CONFLICT");
    expect(patch("a/b", "A")).toBe("PATH_CONFLICT");
    expect(
      code(planWorktree({ root, patches: [{ path: "a", op: "modify", content: "x" }, create("a/b")] })),
    ).toBe("PATH_CONFLICT");
    expect(patch("a/b", "a/c", "ab")).toBe("OK");
  });

  it("rejects lone surrogates but accepts valid pairs", () => {
    expect(sub("a" + c(0xd800) + "b")).toBe("PATH_UNICODE");
    expect(sub("a" + c(0xdc00) + "b")).toBe("PATH_UNICODE");
    expect(sub("a" + c(0xd800))).toBe("PATH_UNICODE");
    expect(sub("a" + c(0xd83d) + c(0xde00) + "b")).toBe("OK");
    expect(code(planWorktree({ root: "/x" + c(0xd800) }))).toBe("ROOT_INVALID");
  });

  it("rejects .git variants (case, trailing dot, 8.3 short name, ADS)", () => {
    expect(sub(".GIT")).toBe("PATH_RESERVED");
    expect(sub("a/.Git/config")).toBe("PATH_RESERVED");
    expect(sub(".git.")).not.toBe("OK");
    expect(sub("GIT~1/config")).toBe("PATH_RESERVED");
    expect(sub("git~12")).toBe("PATH_RESERVED");
    expect(sub(".git::$INDEX_ALLOCATION")).toBe("PATH_RESERVED");
    expect(sub("x/a:b")).toBe("PATH_RESERVED");
    expect(sub("file.txt:stream")).toBe("PATH_RESERVED");
  });

  it("rejects Windows device names, with extensions too", () => {
    for (const n of ["CON", "prn", "aux.txt", "NUL", "com1", "COM9.log", "LPT3"]) {
      expect(sub(`d/${n}`)).toBe("PATH_RESERVED");
    }
    expect(sub("console")).toBe("OK");
  });

  it("rejects a/b/../../.. and .gitmodules", () => {
    expect(sub("a/b/../../..")).toBe("PATH_TRAVERSAL");
    expect(patch(".gitmodules")).toBe("PATH_RESERVED");
    expect(patch("x/.GitModules")).toBe("PATH_RESERVED");
  });

  it("flags sensitive files without blocking them", () => {
    const paths = [
      ".gitattributes", ".husky/pre-commit", ".githooks/x", ".github/workflows/ci.yml",
      "package.json", "pkg/package.json", ".npmrc", ".envrc", ".vscode/tasks.json", "Makefile",
    ];
    const p = planWorktree({ root, patches: paths.map((x) => create(x)) });
    expect(p.ok).toBe(true);
    if (p.ok) {
      expect(p.files).toHaveLength(paths.length);
      for (const f of p.files) {
        expect(f.sensitive).toBe(true);
        expect(typeof f.reason).toBe("string");
      }
    }
    const q = planWorktree({ root, patches: [create("src/index.ts"), create(".vscode/settings.json")] });
    expect(q.ok && q.files.every((f) => f.sensitive === false && f.reason === undefined)).toBe(true);
  });

  it("measures segment length in UTF-8 bytes", () => {
    expect(sub("é".repeat(127))).toBe("OK");
    expect(sub("é".repeat(128))).toBe("PATH_TOO_LONG");
  });

  it("measures content in bytes (600k two-byte chars exceed 1 MiB)", () => {
    const p = planWorktree({ root, patches: [create("big.txt", "é".repeat(600_000))] });
    expect(code(p)).toBe("PATCH_INVALID");
  });

  it("rejects more than the patch limit", () => {
    const patches = Array.from({ length: MAX_PATCHES + 1 }, (_, i) => create(`f${i}.txt`));
    expect(code(planWorktree({ root, patches }))).toBe("PATCH_TOO_MANY");
    expect(code(planWorktree({ root, patches: patches.slice(0, MAX_PATCHES) }))).toBe("OK");
  });

  it("rejects total content over 8 MiB", () => {
    const chunk = "a".repeat(1024 * 1024);
    const nine = Array.from({ length: 9 }, (_, i) => create(`f${i}.txt`, chunk));
    expect(code(planWorktree({ root, patches: nine }))).toBe("PATCH_TOO_LARGE");
    expect(code(planWorktree({ root, patches: nine.slice(0, 8) }))).toBe("OK");
  });

  it("rejects a root containing .git", () => {
    expect(code(planWorktree({ root: "/var/.git/work" }))).toBe("ROOT_INVALID");
    expect(code(planWorktree({ root: "/var/.GIT" }))).toBe("ROOT_INVALID");
  });

  it("documents that percent-encoding is NOT decoded (executor must not decode)", () => {
    const p = planWorktree({ root, patches: [create("..%2f..%2fetc")] });
    expect(p.ok && p.files[0].absPath).toBe(`${root}/..%2f..%2fetc`);
  });

  it("keeps hostile-but-legal shell characters inert in absPath", () => {
    const p = planWorktree({ root, patches: [create("-rf"), create("a;b"), create("$(x)")] });
    expect(p.ok && p.files.map((f) => f.path)).toEqual(["$(x)", "-rf", "a;b"]);
  });
});
