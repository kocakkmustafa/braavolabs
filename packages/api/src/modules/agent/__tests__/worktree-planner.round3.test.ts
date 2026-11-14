import { describe, it, expect } from "vitest";
import { planWorktree } from "../worktree-planner";

const root = "/var/work/run-1";
const create = (path: string) => ({ path, op: "create" as const, content: "x" });
const run = (path: string) => planWorktree({ root, patches: [create(path)] });
const sens = (path: string) => {
  const p = run(path);
  return p.ok ? p.files[0].sensitive : `ERR:${p.code}`;
};
const err = (path: string) => {
  const p = run(path);
  return p.ok ? "OK" : p.code;
};

describe("round 3: wider sensitive tree", () => {
  it("flags whole config trees and CI/build files", () => {
    for (const f of [
      ".github/actions/x/action.yml", ".github/CODEOWNERS", ".github/workflows/ci.yml",
      ".vscode/settings.json", ".devcontainer/devcontainer.json", ".circleci/config.yml",
      ".yarn/releases/x.cjs", ".gitlab-ci.yml", "Jenkinsfile", "azure-pipelines.yml",
      ".travis.yml", "Dockerfile", "docker-compose.yml", "docker-compose.prod.yaml", "sub/Dockerfile",
    ]) {
      expect(sens(f)).toBe(true);
    }
  });
  it("does not flag ordinary files", () => {
    for (const f of [".gitignore", "README.md", "a~1b.txt", "release~notes.md", "src/github/x.ts"]) {
      expect(sens(f)).toBe(false);
    }
  });
});

describe("round 3: 8.3 short names", () => {
  it("rejects segments ending in ~N", () => {
    for (const f of ["GITHUB~1/workflows/x", "VSCODE~1/tasks.json", "HUSKY~1/pre-commit", "a~1", "sub/GIT~2/config"]) {
      expect(err(f)).toBe("PATH_RESERVED");
    }
  });
  it("accepts names where ~ is not at the end", () => {
    expect(err("a~1b.txt")).toBe("OK");
    expect(err("release~notes.md")).toBe("OK");
  });
});
