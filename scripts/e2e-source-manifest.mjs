import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const fingerprint = (value) => hash(JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));
const git = (root, ...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 5000, maxBuffer: 1048576 }).trim();
const read = (root, path) => readFileSync(join(root, path));
const buildId = (root) => existsSync(join(root, "packages/ui/.next/BUILD_ID"))
  ? read(root, "packages/ui/.next/BUILD_ID").toString().trim() : null;

export function environment(root, env = process.env) {
  assert.ok(env.NEXT_PUBLIC_API_URL, "Explicit compiled public API URL is required");
  assert.equal(new URL(env.NEXT_PUBLIC_API_URL).protocol, "https:", "Evidence API origin must use HTTPS");
  assert.ok(env.SELF_HOSTED_SURFACE_HOSTS, "Explicit self-hosted surface hosts are required");
  assert.ok(!env.E2E_UI_STANDALONE, "Local evidence currently binds the next-start harness");
  return {
    publicApiUrl: env.NEXT_PUBLIC_API_URL,
    selfHostedSurfaceHosts: env.SELF_HOSTED_SURFACE_HOSTS,
    uiServeMode: "next-start",
    locales: readdirSync(join(root, "packages/ui/messages")).filter((p) => p.endsWith(".json")).map((p) => p.slice(0, -5)).sort(),
  };
}

export function sourceSnapshot(root, env = process.env) {
  const paths = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, maxBuffer: 1048576 })
    .toString().split("\0").filter(Boolean);
  const sources = {};
  for (const path of [...new Set(paths)].sort()) {
    if (!existsSync(join(root, path))) { sources[path] = null; continue; }
    assert.ok(lstatSync(join(root, path)).isFile(), `Evidence requires a regular source file: ${path}`);
    sources[path] = hash(read(root, path));
  }
  return { baseRevision: git(root, "rev-parse", "HEAD"), baseTree: git(root, "rev-parse", "HEAD^{tree}"),
    sources, sourceFingerprint: fingerprint(sources), environment: environment(root, env) };
}

function compiledSnapshot(root, config) {
  const outputs = {};
  const apiOriginFiles = [];
  const collect = (path) => {
    for (const name of readdirSync(join(root, path)).sort()) {
      const entry = `${path}/${name}`;
      const stat = lstatSync(join(root, entry));
      if (stat.isDirectory()) collect(entry);
      else {
        assert.ok(stat.isFile(), `Evidence requires a regular compiled file: ${entry}`);
        const bytes = read(root, entry);
        outputs[entry] = hash(bytes);
        if (entry.startsWith("packages/ui/.next/static/") && entry.endsWith(".js") && bytes.includes(config.publicApiUrl)) apiOriginFiles.push(entry);
      }
    }
  };
  collect("packages/ui/.next/static");
  collect("packages/ui/.next/server");
  for (const path of ["BUILD_ID", "build-manifest.json", "routes-manifest.json", "prerender-manifest.json"]) {
    const name = `packages/ui/.next/${path}`;
    outputs[name] = hash(read(root, name));
  }
  assert.ok(apiOriginFiles.length, "Compiled browser chunks do not contain the declared public API URL");
  return { buildId: buildId(root), outputs, outputsFingerprint: fingerprint(outputs), apiOriginFiles };
}

export function beginBuild(root, env = process.env) {
  return { schema: 1, kind: "local-build-inputs", ...sourceSnapshot(root, env), previousBuildId: buildId(root) };
}

export function sealBuild(root, before, beforeSha256, env = process.env) {
  assert.equal(before.schema, 1);
  assert.equal(before.kind, "local-build-inputs");
  const after = sourceSnapshot(root, env);
  for (const field of ["baseRevision", "baseTree", "sources", "sourceFingerprint", "environment"]) {
    assert.deepEqual(after[field], before[field], `Source/config drift during build: ${field}`);
  }
  const compiled = compiledSnapshot(root, after.environment);
  assert.ok(compiled.buildId && compiled.buildId !== before.previousBuildId, "A fresh build ID is required after the input snapshot");
  return { schema: 1, kind: "uncommitted-candidate-build", ...after, ...compiled,
    beforeSnapshotSha256: beforeSha256, sourceBeforeFingerprint: before.sourceFingerprint,
    sourceAfterFingerprint: after.sourceFingerprint, previousBuildId: before.previousBuildId };
}

export function validateEvidence(manifest, observed, requiredPaths) {
  assert.equal(manifest.schema, 1);
  assert.equal(manifest.kind, "uncommitted-candidate-build");
  assert.match(manifest.baseRevision, /^[a-f0-9]{40}$/);
  assert.match(manifest.baseTree, /^[a-f0-9]{40}$/);
  assert.match(manifest.beforeSnapshotSha256, /^[a-f0-9]{64}$/);
  assert.equal(manifest.sourceBeforeFingerprint, manifest.sourceAfterFingerprint, "Source changed during build");
  assert.equal(manifest.sourceFingerprint, fingerprint(manifest.sources), "Invalid source fingerprint");
  assert.equal(manifest.sourceBeforeFingerprint, manifest.sourceFingerprint, "Build is bound to different source bytes");
  assert.ok(manifest.buildId && manifest.buildId !== manifest.previousBuildId, "Stale build identity");
  for (const path of requiredPaths) assert.match(manifest.sources[path] ?? "", /^[a-f0-9]{64}$/, `Missing required source: ${path}`);
  for (const field of ["baseRevision", "baseTree", "sources", "sourceFingerprint", "environment", "buildId", "outputs", "outputsFingerprint", "apiOriginFiles"]) {
    assert.deepEqual(observed[field], manifest[field], `Current evidence drift: ${field}`);
  }
  assert.equal(manifest.outputsFingerprint, fingerprint(manifest.outputs), "Invalid compiled fingerprint");
  assert.ok(manifest.apiOriginFiles.length, "Missing compiled public API origin evidence");
  for (const path of manifest.apiOriginFiles) assert.ok(manifest.outputs[path], "API origin chunk is not bound to the artifact");
}

export function readPinnedJson(path, expectedSha256) {
  assert.match(expectedSha256 ?? "", /^[a-f0-9]{64}$/, "An exact SHA256 pin is required");
  assert.ok(lstatSync(path).isFile(), "Manifest must be a regular non-symlink file");
  const bytes = readFileSync(path);
  assert.equal(hash(bytes), expectedSha256, "Manifest SHA256 mismatch");
  return JSON.parse(bytes);
}

export function localIdentity(root, requiredPaths, env = process.env) {
  if (!env.E2E_SOURCE_MANIFEST && !env.E2E_SOURCE_MANIFEST_SHA256) return null;
  assert.notEqual(env.GITHUB_ACTIONS, "true", "GitHub CI must retain the clean-HEAD evidence guard");
  assert.ok(env.E2E_SOURCE_MANIFEST, "Manifest path and SHA256 must both be provided");
  const manifest = readPinnedJson(env.E2E_SOURCE_MANIFEST, env.E2E_SOURCE_MANIFEST_SHA256);
  const snapshot = sourceSnapshot(root, env);
  const observed = { ...snapshot, ...compiledSnapshot(root, snapshot.environment) };
  validateEvidence(manifest, observed, requiredPaths);
  return { sourceKind: "uncommitted-candidate", baseRevision: manifest.baseRevision, baseTree: manifest.baseTree,
    candidateSourceFingerprint: manifest.sourceFingerprint, manifestSha256: env.E2E_SOURCE_MANIFEST_SHA256,
    buildId: manifest.buildId, sources: Object.fromEntries(requiredPaths.map((path) => [path, manifest.sources[path]])) };
}

