import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getReleaseInfo, readPackageVersion, resolveReleaseCommit } from "../release-info";

const SHA = "ca36025e1f2d3c4b5a69788796a5b4c3d2e1f0a9";

describe("release-info", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("accepts a 40-char lowercase hex commit", () => {
    expect(resolveReleaseCommit(SHA)).toBe(SHA);
  });

  it.each([
    ["undefined", undefined],
    ["empty", ""],
    ["the Dockerfile default", "unknown"],
    ["short sha", SHA.slice(0, 7)],
    ["uppercase", SHA.toUpperCase()],
    ["41 chars", `${SHA}a`],
    ["trailing newline", `${SHA}\n`],
    ["non-hex", "g".repeat(40)],
    ["injection attempt", "<script>alert(1)</script>"],
  ])("returns unknown for %s", (_label, raw) => {
    expect(resolveReleaseCommit(raw)).toBe("unknown");
  });

  it("getReleaseInfo reads RELEASE_COMMIT from env and the package version", () => {
    vi.stubEnv("RELEASE_COMMIT", SHA);
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "..", "package.json"), "utf8"));
    expect(getReleaseInfo()).toEqual({ commit: SHA, version: pkg.version });
    vi.stubEnv("RELEASE_COMMIT", "nope");
    expect(getReleaseInfo().commit).toBe("unknown");
    expect(typeof getReleaseInfo().version).toBe("string");
  });

  it("readPackageVersion falls back to unknown on missing/invalid manifests", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-info-"));
    try {
      expect(readPackageVersion(path.join(dir, "missing.json"))).toBe("unknown");
      const bad = path.join(dir, "bad.json");
      fs.writeFileSync(bad, "{not json");
      expect(readPackageVersion(bad)).toBe("unknown");
      const noVersion = path.join(dir, "nov.json");
      fs.writeFileSync(noVersion, JSON.stringify({ name: "x" }));
      expect(readPackageVersion(noVersion)).toBe("unknown");
      const ok = path.join(dir, "ok.json");
      fs.writeFileSync(ok, JSON.stringify({ version: "1.2.3" }));
      expect(readPackageVersion(ok)).toBe("1.2.3");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
