import { describe, it, expect } from "vitest";
import { planWorktree } from "../worktree-planner";

const root = "/var/work/run-1";
const sens = (path: string) => {
  const p = planWorktree({ root, patches: [{ path, op: "create", content: "x" }] });
  return p.ok ? p.files[0].sensitive : `ERR:${p.code}`;
};

describe("sensitive basename patterns", () => {
  it("flags build/CI/container file families", () => {
    for (const f of [
      "Dockerfile.prod", "app.dockerfile", "Containerfile", "compose.yaml",
      "docker-compose.override.yml", "azure-pipelines.yaml", ".gitlab-ci.yaml",
      "Jenkinsfile.groovy", "sub/dir/Makefile.inc", "rules.mk", "Dockerfile", "Makefile",
      "docker-compose-prod.yml", "compose-dev.yaml", "docker-compose.yml",
    ]) {
      expect(sens(f)).toBe(true);
    }
  });
  it("does not flag unrelated names", () => {
    for (const f of ["README.md", "dockerfile-notes.md", "composer.json", "compose-notes.md", "makefile-notes.md"]) {
      expect(sens(f)).toBe(false);
    }
  });
});
