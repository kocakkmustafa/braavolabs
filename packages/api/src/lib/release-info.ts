import fs from "node:fs";
import path from "node:path";

// Public, unauthenticated release identity for /health. Deliberately tiny:
// only the build commit and the package version. Never add flag state,
// environment names or anything else that leaks rollout information.

const COMMIT_SHA_RE = /^[0-9a-f]{40}$/;

/**
 * Returns the 40-char lowercase hex commit baked into the image via the
 * RELEASE_COMMIT build-arg, or "unknown" when absent/malformed. The raw env
 * value is never reflected.
 */
export function resolveReleaseCommit(raw: string | undefined = process.env.RELEASE_COMMIT): string {
  return typeof raw === "string" && COMMIT_SHA_RE.test(raw) ? raw : "unknown";
}

/**
 * Reads `version` from packages/api/package.json. This module sits at
 * `<pkg>/src/lib` (ts/vitest) and `<pkg>/dist/lib` (compiled), so the
 * manifest is `../../package.json` in both layouts; the runtime image copies
 * packages/api/package.json next to dist.
 */
export function readPackageVersion(manifestPath: string = path.join(__dirname, "..", "..", "package.json")): string {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const version = (parsed as { version?: unknown } | null)?.version;
    return typeof version === "string" && version.length > 0 && version.length <= 64 ? version : "unknown";
  } catch {
    return "unknown";
  }
}

let cachedVersion: string | undefined;

export function getReleaseInfo(): { commit: string; version: string } {
  cachedVersion ??= readPackageVersion();
  return { commit: resolveReleaseCommit(), version: cachedVersion };
}
