# Local candidate build evidence

GitHub CI keeps the existing tracked, clean-HEAD legal-navigation evidence guard.
An uncommitted local acceptance candidate can instead bind the entire checkout,
lockfile, all locale messages, public API URL, surface hosts, fresh Next BUILD_ID,
and compiled server/browser output to an external manifest with an exact SHA256
pin. This labels the result `uncommitted-candidate`; the base revision/tree are
metadata, not a claim that the tested source is that commit.

Freeze source changes before taking the input snapshot. Use the same explicit
configuration for the snapshot, fresh build, seal and Playwright process:

```sh
export NEXT_PUBLIC_API_URL=https://api.operator.example/api/v1
export SELF_HOSTED_SURFACE_HOSTS=operator.example
node scripts/e2e-source-manifest-cli.mjs before /absolute/evidence/input.json
pnpm --filter @ai-company-os/ui build
node scripts/e2e-source-manifest-cli.mjs seal /absolute/evidence/input.json INPUT_SHA256 /absolute/evidence/build.json
E2E_SOURCE_MANIFEST=/absolute/evidence/build.json \
E2E_SOURCE_MANIFEST_SHA256=PRINTED_BUILD_SHA256 pnpm exec playwright test
```

The helper prints the exact file SHA256 at each write. Output paths must be
outside the checkout and cannot already exist. Source changes during the build,
a reused BUILD_ID, missing or changed artifacts, changed runtime configuration,
an absent compiled API URL, a missing manifest/pin, and symlink manifests fail
closed. Each legal test checks the same identity at its beginning and end. This
mode is rejected in GitHub Actions and supports only the existing `next start`
harness. There is no bypass flag. Keep the input, sealed manifest and logs with
the acceptance artifact; rebuild and reseal after any source change.

Run the evidence contract tests with:

```sh
node --test scripts/e2e-source-manifest.test.mjs
```
