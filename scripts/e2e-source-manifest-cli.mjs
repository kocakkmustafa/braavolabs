import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beginBuild, hash, readPinnedJson, sealBuild } from "./e2e-source-manifest.mjs";

function writeOutside(root, path, value) {
  const target = resolve(path);
  const location = relative(root, target);
  assert.ok(location === ".." || location.startsWith("../"), "Write evidence outside the checkout");
  const bytes = JSON.stringify(value, null, 2) + "\n";
  writeFileSync(target, bytes, { flag: "wx" });
  console.log(JSON.stringify({ path: target, sha256: hash(bytes) }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const [mode, path, pin, output] = process.argv.slice(2);
  if (mode === "before" && path && !pin) writeOutside(root, path, beginBuild(root));
  else if (mode === "seal" && path && pin && output) writeOutside(root, output, sealBuild(root, readPinnedJson(path, pin), pin));
  else throw new Error("Usage: e2e-source-manifest-cli.mjs before OUTPUT | seal BEFORE BEFORE_SHA256 OUTPUT");
}
