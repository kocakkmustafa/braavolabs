# GitHub Actions deployment runbook

Braavolabs builds API and UI images on GitHub Actions, then deploys a paired set
of immutable GHCR digests through [`deploy-platform.sh`](../scripts/deploy-platform.sh).
Do not build on the Lightsail host: the previous on-host build path exhausted
memory. A source build, green local tests, or a pushed image is not proof of a
healthy production release.

This runbook defines the release gates. Health and CI changes must be reviewed
and verified at the final candidate commit before use; this document does not
assert that CI, DNS/TLS work, migrations, or deployment have completed.

## 1. Authorization and release identity

- Record the full candidate commit SHA and obtain founder approval before any
  commit/push or production-triggering action. Feature-branch/PR approval does
  not authorize a `main` merge, release tag, manual deploy, or DB migration.
- [`deploy.yml`](../.github/workflows/deploy.yml) can deploy on `main` pushes,
  `v*` tag pushes, and manual dispatch. Workflow-only branch changes are excluded;
  that path filter does not protect tag pushes. Dispatch defaults to production.
- Do not assume the `staging` choice is isolated: the script targets
  `/opt/braavolabs`. Prove separate environment credentials and host identity
  before treating a staging run as non-production.
- Check remaining Actions/storage allowance first. Stay free-first; no paid
  runner, host upgrade, new service, package visibility change, or account/secret
  change is implied by permission to prepare a release.

## 2. Required account and host setup

Verify existing configuration through the authorized GitHub/provider account.
If login, MFA, ownership, or a missing setting blocks access, stop at that human
gate. Do not create replacement credentials or bypass account controls.

| GitHub setting | Required meaning |
| --- | --- |
| Secret `LIGHTSAIL_HOST` / `LIGHTSAIL_USER` | Approved existing deployment host and user |
| Secret `LIGHTSAIL_SSH_KEY` | Dedicated approved SSH identity; never print it or put it in logs, chat, or source |
| Secret `LIGHTSAIL_KNOWN_HOSTS` | Independently verified, exact-host ED25519 known-hosts entries |
| Secret `LIGHTSAIL_HOST_KEY_SHA256` | Matching approved SHA256 fingerprint, or the explicitly approved two-key rotation set |
| Variable `BRAAVOLABS_PREVIOUS_GOOD_COMMIT` | Full SHA from the durable previous-good record, not a guessed branch HEAD |
| UI Sentry settings | Existing approved build-time settings used by the workflow, if configured |

The workflow writes SSH material to temporary regular, non-symlink files with
mode `0600` and cleans them up. The script requires exact host-token and
fingerprint agreement and uses `StrictHostKeyChecking=yes`, an explicit
`UserKnownHostsFile`, `IdentitiesOnly=yes`, and `BatchMode=yes`. Do not replace
this with trust-on-first-use `ssh-keyscan`, disabled checking, or a displayed
private key. Host-key changes require independent verification and approval.

Keep GHCR package visibility unchanged. The runner uses its scoped
`GITHUB_TOKEN` to push; private-image pulls require the host's existing approved
read access. An authorization failure is an account/access gate, not a reason
to make the API or UI package public.

Before cutover, verify `/opt/braavolabs/releases/previous-good.json`, its matching
release journal, the live API/UI digests, and the local availability of both
rollback images. The script checks Compose project/service/network/config-path
identity, preserves the canonical stateful services, and serializes remote
releases with a lock. Do not invent a previous-good record or bypass a lock.

## 3. Exact-commit CI gate, then images

The `require-green-ci` job must pass before image push; the deploy job must
repeat the live check before SSH setup and deployment. The checker must query
the repository's `CI` workflow for the exact full release SHA, `push` event, and
`main` branch—not an older green commit, PR run, or generic check badge. Use the
latest applicable run/attempt and require completed success with successful,
useful required jobs and steps. Queued/in-progress work waits only within the
bounded timeout; failed/cancelled/missing evidence, wrong identity, API errors,
and timeout fail closed. A new rerun during image build must not inherit an
older run's success. Do not bypass a failed gate.

Recovery requires **rerunning all jobs in the newest applicable CI run** after
checking the remaining Actions allowance. All ten required jobs must belong to
the same attempt. "Re-run failed jobs" can leave successful jobs in an older
attempt, so a green workflow badge alone will still be rejected. If a newer
retry of an older run makes ordering ambiguous, fully rerun the newest run;
do not choose an older green result or relax the checker.

Each checker invocation has a 25-minute total budget, polls every 15 seconds,
and limits each HTTP/JSON read to 10 seconds. Pagination is capped at ten pages
of 100 entries; incomplete or excessive evidence is rejected. Gate and deploy
jobs have 30-minute limits. If CI finishes after the checker times out, verify
its final evidence and remaining allowance before a separately authorized
deployment retry. A timeout is not permission to continue publication.

The [`CI` workflow](../.github/workflows/ci.yml) must include the release-contract
and motion tests as hard gates alongside its existing checks, including the
health/rollback regressions. Its final watchdog must include those jobs and
must not wait for its own workflow to finish. Review the actual required-job
results at the final SHA; a local test count is not a substitute.

After the first gate passes, Actions builds **both** API and UI and records their
build-produced digests as same-run artifacts. Deployment uses only:

```text
ghcr.io/kocakkmustafa/braavolabs/api@sha256:<64 lowercase hex characters>
ghcr.io/kocakkmustafa/braavolabs/ui@sha256:<64 lowercase hex characters>
```

`latest`, `sha-*`, and `v*` tags may label builds, but are mutable references and
are not deployment or rollback authority. `NEXT_PUBLIC_*` values are compiled
into the UI image; changing the host `.env` does not change that browser bundle.
Confirm the candidate's intended API/APP endpoints and brand assets in the
actual image. A local Next.js build or standalone archive is not Docker proof.

## 4. Migration and cutover

After the second CI gate and production authorization:

1. The workflow passes the candidate SHA, previous-good SHA, and both digests to
   the script over pinned SSH. The script seals Compose and migration inputs,
   validates the exact previous-good → candidate migration delta and hashes,
   and binds that delta to the image pair. Drift or an ineligible delta stops
   the release for review; historical exceptions are not general permission.
2. With separate action-time DB authorization and a verified backup/recovery
   plan, the candidate API image runs `prisma migrate deploy` using
   `MIGRATE_DATABASE_URL` **before** API/UI cutover. The command still runs when
   the discovered delta is empty. Application deployment approval alone is not
   permission to mutate the database.
3. The script recreates API/UI from the digest override without rebuilding on
   the host, ensures the backup service is running, and verifies health and
   running-image identity.
4. Only after verification may it persist previous-good and the durable journal
   state `COMMIT_RELEASE` / `success`. Retain the run URL, full SHA, both digests,
   migration-delta seal, health evidence, and matching journal as the receipt.

## 5. Health and APP DNS/TLS acceptance

Production Compose passes `ALLOWED_ORIGINS` to the API without changing
`APP_URL`. If unset, the extra origin is exactly `https://app.braavolabs.com`.
An explicitly empty value disables extra origins; a comma-separated value
replaces the default. This uses `${ALLOWED_ORIGINS-https://app.braavolabs.com}`
(single `-`, not `:-`) so custom deployments can opt out. `APP_URL` remains
allowed in every case. Use only controlled exact origins, never a wildcard or
suffix pattern. A host `.env` change does not update an already-running
container; verify the effective environment after the separately authorized
candidate cutover. Do not recreate the live API during PR preparation.

Check real credentialed GET and OPTIONS responses using the intended APP
Origin: require its exact `Access-Control-Allow-Origin`, credentials support,
and the required authorization/CSRF request headers. An unrelated Origin must
receive no allow-origin header, even if HTTP status is200/204. A successful
HTTPS login page alone does not prove browser-to-API access. Keep these checks
separate from real-user login, cookie persistence and authenticated agent use;
do not add CORS headers in Nginx to override an API denial.

Require these checks for both the candidate and an application rollback:

- API and UI Docker `.State.Running` must be true and `.State.Health.Status`
  must become `healthy` within the bounded poll. Running alone, missing health
  data, failed inspection, `unhealthy`, or permanently `starting` is not
  acceptance. The backup service must be running.
- The UI loopback probe must use `127.0.0.1:3000` with the trusted
  `Host: www.braavolabs.com` header. Do not weaken production middleware to allow
  localhost or unknown hosts merely to turn the probe green.
- Normal certificate-verified HTTPS must return **exactly 200**, without
  following redirects, for `https://api.braavolabs.com/health`,
  `https://www.braavolabs.com/`, and `https://app.braavolabs.com/login`.
  An apex redirect, HTTP 308, `curl --fail` alone, or `curl -k` is insufficient.
- APP DNS must resolve to the approved existing origin, and its TLS certificate
  and virtual host must cover `app.braavolabs.com`. Verify normal public HTTPS,
  login/cookie/host behavior, and the candidate's `/brand/` asset bodies/hashes.
  Do not broaden the public middleware allowlist to conceal an APP routing gap.

DNS/TLS changes are a separate authorized provider operation: preserve unrelated
records, take exact rollback evidence, validate nginx configuration before any
reload, and respect account/MFA gates. Successful DNS/TLS work does not prove
that the candidate application images have been deployed.

## 6. Failure and rollback

After a cutover failure, the script attempts to restore **both** previous-good
application digests, verifies the same health and digest checks, restores the
previous-good record, and journals `ROLLBACK_APPLICATION` / `restored`. The
rollback uses the staged Compose definition; verify that its corrected health
probe remains compatible with the old images. A restored application is a
failed candidate release, not a successful deployment.

Application rollback does **not** undo database migrations. Schema/data
compatibility and any DB recovery require their own review and authorization.
Do not use `IMAGE_TAG`, `latest`, a branch checkout, or an arbitrary Compose
command as a rollback shortcut.

On CI, identity, registry, migration, health, or journal failure, inspect the
recorded failing phase and redact diagnostics. If rollback is not verified,
treat production state as unknown and escalate. Do not blindly rerun, remove
the deploy lock, rebuild on the host, overwrite release records, or report
success from process status alone.
