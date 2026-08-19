#!/usr/bin/env bash
#
# Release artifact provenance (BR-P0-005 / roadmap §8): SBOM + SHA-256.
#
# Produces, into dist-release/:
#   sbom.cdx.json    CycloneDX 1.6 SBOM of the whole workspace
#   SHA256SUMS       checksums for every artifact, verifiable with `shasum -c`
#
# SBOM tooling note: @cyclonedx/cyclonedx-npm does NOT work here — it shells out
# to `npm ls`, which fails on a pnpm workspace (verified: exit 254,
# "npm-ls exited with errors"). cdxgen with `-t pnpm` reads the pnpm lockfile
# directly and is what this uses.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${RELEASE_OUT:-$ROOT/dist-release}"
cd "$ROOT"

rm -rf "$OUT"; mkdir -p "$OUT"

echo "── SBOM (CycloneDX, pnpm-aware) ──"
npx --yes @cyclonedx/cdxgen@11 -t pnpm -o "$OUT/sbom.cdx.json" --no-recurse . >/dev/null 2>&1
node -e '
  const b = require(process.argv[1]);
  if (b.bomFormat !== "CycloneDX") { console.error("not a CycloneDX document"); process.exit(1); }
  const n = (b.components || []).length;
  if (n < 50) { console.error(`only ${n} components — the SBOM is probably empty/wrong`); process.exit(1); }
  console.log(`   ${b.bomFormat} ${b.specVersion}, ${n} components`);
' "$OUT/sbom.cdx.json"

echo "── artifacts ──"
# Ship the built server bundle and the SBOM itself. Checksumming the SBOM
# matters: an SBOM nobody can verify is decoration.
if [ -d packages/api/dist ]; then
  tar -czf "$OUT/api-dist.tar.gz" -C packages/api dist
  echo "   api-dist.tar.gz"
fi
if [ -d packages/ui/.next/standalone ]; then
  tar -czf "$OUT/ui-standalone.tar.gz" -C packages/ui/.next standalone
  echo "   ui-standalone.tar.gz"
fi

echo "── SHA256SUMS ──"
cd "$OUT"
: > SHA256SUMS
for f in *; do
  [ "$f" = "SHA256SUMS" ] && continue
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$f" >> SHA256SUMS
  else shasum -a 256 "$f" >> SHA256SUMS; fi
done
cat SHA256SUMS

echo "── self-verify ──"
# Generating checksums proves nothing; verifying them does.
if command -v sha256sum >/dev/null 2>&1; then sha256sum -c SHA256SUMS
else shasum -a 256 -c SHA256SUMS; fi
echo "release artifacts ready in $OUT"
