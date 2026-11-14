import { describe, it, expect } from "vitest";
import { planWorktree, validateRelativePath } from "../worktree-planner";

const root = "/var/work/run-1";
const create = (path: string) => ({ path, op: "create" as const, content: "x" });
const failCode = (p: ReturnType<typeof planWorktree>) => (p.ok ? "OK" : p.code);
const sub = (subPath: string) => failCode(planWorktree({ root, subPath }));

describe("planWorktree", () => {
  it("valid simple path stays under root", () => {
    const p = planWorktree({ root, subPath: "repo", patches: [create("a.txt")] });
    expect(p).toMatchObject({ ok: true, workDir: `${root}/repo` });
    if (p.ok) expect(p.files[0].absPath).toBe(`${root}/repo/a.txt`);
  });
  it("valid nested path", () => {
    const p = planWorktree({ root, subPath: "a/b/c", patches: [create("src/deep/x.ts")] });
    expect(p.ok && p.files[0].absPath).toBe(`${root}/a/b/c/src/deep/x.ts`);
  });
  it("omitted subPath uses root", () => {
    const p = planWorktree({ root });
    expect(p).toEqual({ ok: true, root, workDir: root, files: [] });
  });
  it("rejects '..' segment", () => expect(sub("a/../b")).toBe("PATH_TRAVERSAL"));
  it("rejects a/../../b and bare ..", () => {
    expect(sub("a/../../b")).toBe("PATH_TRAVERSAL");
    expect(sub("..")).toBe("PATH_TRAVERSAL");
    expect(failCode(planWorktree({ root, patches: [create("../x")] }))).toBe("PATH_TRAVERSAL");
  });
  it("rejects absolute path", () => expect(sub("/etc/passwd")).toBe("PATH_ABSOLUTE"));
  it("rejects NUL / newline / CR / tab", () => {
    for (const c of ["\u0000", "\n", "\r", "\t", "\u001b", "\u007f"]) {
      expect(sub(`a${c}b`)).toBe("PATH_CONTROL_CHAR");
    }
  });
  it("rejects backslash and UNC", () => {
    expect(sub("a\\b")).toBe("PATH_BACKSLASH");
    expect(sub("\\\\server\\share")).toBe("PATH_DRIVE_OR_UNC");
  });
  it("rejects Windows drive and // prefix", () => {
    expect(sub("C:/x")).toBe("PATH_DRIVE_OR_UNC");
    expect(sub("c:x")).toBe("PATH_DRIVE_OR_UNC");
    expect(sub("//host/x")).toBe("PATH_DRIVE_OR_UNC");
  });
  it("rejects empty, double slash, trailing slash", () => {
    expect(sub("")).toBe("PATH_EMPTY");
    expect(sub("a//b")).toBe("PATH_EMPTY_SEGMENT");
    expect(sub("a/")).toBe("PATH_EMPTY_SEGMENT");
  });
  it("rejects leading/trailing whitespace and trailing dot", () => {
    expect(sub(" a")).toBe("PATH_WHITESPACE");
    expect(sub("a ")).toBe("PATH_WHITESPACE");
    expect(sub("a/b./c")).toBe("PATH_WHITESPACE");
  });
  it("rejects overly long path and segment", () => {
    expect(sub("a/".repeat(300) + "b")).toBe("PATH_TOO_LONG");
    expect(sub("a".repeat(256))).toBe("PATH_TOO_LONG");
  });
  it("rejects unicode tricks (dot leader, fullwidth dot/slash, zero-width, bidi, NFD)", () => {
    expect(sub("a/\u2024\u2024/b")).toBe("PATH_UNICODE");
    expect(sub("\uFF0E\uFF0E/b")).toBe("PATH_UNICODE");
    expect(sub("a\uFF0Fb")).toBe("PATH_UNICODE");
    expect(sub("a\u2215b")).toBe("PATH_UNICODE");
    expect(sub("a\u200Bb")).toBe("PATH_UNICODE");
    expect(sub("a\u202Eb")).toBe("PATH_UNICODE");
    expect(sub("e\u0301")).toBe("PATH_UNICODE"); // NFD
    expect(sub("\uFB01le")).toBe("PATH_UNICODE"); // ligature, not NFKC-stable
  });
  it("rejects '.' segments (symlink-like) and .git", () => {
    expect(sub("a/./b")).toBe("PATH_DOT_SEGMENT");
    expect(sub(".")).toBe("PATH_DOT_SEGMENT");
    expect(sub("a/.GIT/hooks")).toBe("PATH_RESERVED");
  });
  it("accepts dotfiles and legit unicode", () => {
    expect(validateRelativePath(".env.example").ok).toBe(true);
    expect(validateRelativePath("src/çalışma/dosya.ts").ok).toBe(true);
  });
  it("rejects bad root", () => {
    for (const r of ["", "rel/x", "/a/../b", "/a//b", "/a/./b", "//x", "/a\\b", "/a\u0000"]) {
      expect(failCode(planWorktree({ root: r }))).toBe("ROOT_INVALID");
    }
  });
  it("validates patches: bad op, missing content, duplicates (case-insensitive)", () => {
    expect(failCode(planWorktree({ root, patches: [{ path: "a", op: "chmod" as never }] }))).toBe("PATCH_INVALID");
    expect(failCode(planWorktree({ root, patches: [{ path: "a", op: "create" }] }))).toBe("PATCH_INVALID");
    expect(failCode(planWorktree({ root, patches: [create("A.ts"), create("a.ts")] }))).toBe("PATCH_DUPLICATE");
  });
  it("is deterministic and sorted regardless of input order", () => {
    const a = planWorktree({ root, subPath: "w", patches: [create("z.ts"), { path: "m.ts", op: "delete" }, create("a.ts")] });
    const b = planWorktree({ root, subPath: "w", patches: [create("a.ts"), create("z.ts"), { path: "m.ts", op: "delete" }] });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.ok && a.files.map((f) => f.path)).toEqual(["a.ts", "m.ts", "z.ts"]);
    expect(a.ok && a.files[1]).toMatchObject({ op: "delete", bytes: 0 });
  });
  it("every accepted absPath stays under workDir", () => {
    const p = planWorktree({ root, subPath: "w", patches: [create("a/b.ts"), create(".hidden")] });
    expect(p.ok && p.files.every((f) => f.absPath.startsWith(`${root}/w/`))).toBe(true);
  });
});
