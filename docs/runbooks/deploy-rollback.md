# Deploy and migration rollback runbook (QA-BRA-02)

Scope: how to roll back a Braavolabs release (API + UI images) and its Prisma
migrations, how to read the deploy script exit codes (including drift, 68), and
how to rehearse all of it on staging. Companion to
[`deployment-github-actions.md`](../deployment-github-actions.md) (release gates)
and [`scripts/deploy-platform.sh`](../../scripts/deploy-platform.sh) (the
orchestrator). This runbook changes no code, workflow or migration.

Status of this document (2026-11-14):

- Written from reading `.github/workflows/deploy.yml`, `scripts/deploy-platform.sh`
  and the migration folder at `main` `ec4482e`.
- **Local rehearsal done** (throw-away Postgres, section 8).
- **Staging rehearsal NOT done.** Steps are ready in section 9; the founder
  approves running them. Nothing here was run against production or real staging.
- Time boxes marked `[ ... ]` are intentionally empty until the staging rehearsal.

## 1. How a release is shaped

| Piece | Where | Rollback relevance |
|---|---|---|
| Images | `ghcr.io/kocakkmustafa/braavolabs/{api,ui}@sha256:<digest>` | Deploys are by immutable digest (`API_IMAGE_REF`, `UI_IMAGE_REF`); tags (`vX.Y.Z`, `sha-<8>`, `latest`) are convenience only. Roll back by digest, never by `latest`. |
| Previous-good record | Server: `/opt/braavolabs/releases/previous-good.json` (fields `release`, `previousRelease`, `tuple`, `api`, `ui`, `migrationDeltaSha256`, `result`) | Written only after a candidate is healthy. The script reads it as the rollback target. |
| Previous-good variable | GitHub repo variable `BRAAVOLABS_PREVIOUS_GOOD_COMMIT` (workflow input `PREVIOUS_RELEASE_COMMIT`) | Must equal the server record's `release`, or the record's `previousRelease` when the server already runs the candidate (idempotent re-run). Otherwise exit 68 (drift). |
| Journal | `/opt/braavolabs/releases/<release-sha>/transitions/NNNN-<STATE>.json` | One file per state (`CAPTURE_PREVIOUS`, `STAGE_RELEASE`, `MIGRATE_CANDIDATE`, `CUTOVER`, `ROLLBACK_APPLICATION`, ...). First place to look after a failed deploy. |
| Migrations | `packages/db/prisma/migrations/` (56 as of `ec4482e`), run by `npx prisma migrate deploy` inside the candidate API image **before** cutover | Forward only. Prisma has no down migrations. |

Sequence in `deploy-platform.sh` (remote side): lock (`flock`, exit 75) ->
capture previous-good -> verify migration delta -> migrate candidate (exit 68 on
failure) -> `compose up -d --no-deps api ui` (cutover, 69) -> `verify_health`
(90 s budget; api/ui containers healthy, backup container running, three HTTPS
200 probes) -> write new `previous-good.json`.

**Automatic application rollback.** If cutover, health or the journal fails
after cutover, `rollback_application` rewrites the compose override to the
previous digests, brings api/ui back, re-verifies health, checks the running
digests equal the previous ones, restores the previous-good file, and exits with
the original code (69, 70 or 72). If that rollback itself fails the exit code is
71 and a human must act (section 3).

**The automatic rollback never touches the database.** Migrations run before
cutover and stay applied. That is safe only because every migration admitted by
the script is additive (section 4).

## 2. Exit codes

| Code | Name | Meaning | Action |
|---|---|---|---|
| 64 | input | Missing/invalid input (e.g. previous commit not 40-hex) | Fix the variable/secret; rerun. No server change. |
| 65 | host | SSH host identity mismatch | Stop. Do not bypass; verify the host key out of band. |
| 66 | remote | Remote command/SSH failure, or local cleanup failure | Check Lightsail reachability, rerun. |
| 67 | image | Image pull/identity verification failed | Check GHCR digest exists; rerun build. |
| 68 | migration | **Drift** (previous-good != `BRAAVOLABS_PREVIOUS_GOOD_COMMIT`), migration delta not additive / not in reviewed manifest, previous or candidate commit unavailable, or `prisma migrate deploy` failed | Section 5. Nothing was cut over unless the log says `fail_after_cutover`. |
| 69 | cutover | `compose up` failed; app rolled back | Read journal; rerun after fixing cause. |
| 70 | health rolled back | Candidate unhealthy; app rolled back | Read container logs of the candidate; fix forward. |
| 71 | rollback | Automatic rollback FAILED | Page the founder; manual rollback (section 3). |
| 72 | journal | Journal/previous-good write failed | Treat like 70; app rolled back when possible. |
| 75 | lock | Another deploy holds the lock | Wait; never delete the lock file by hand. |

## 3. Roll back a release (images)

Use when a deployed release is healthy by probes but wrong in behaviour, or
after exit 71. Prefer reverting through the normal pipeline (revert commit on
`main` -> CI green -> tag/dispatch), because the script then re-verifies CI,
digests and the migration delta. Manual SSH rollback is the emergency path.

### 3a. Normal path (preferred, ~one deploy cycle)

1. Identify the previous-good release: `git log` on `main`, or read
   `previous-good.json` on the server (field `release`).
2. `git revert` the offending merge on a branch, PR, CI green, normal merge
   (founder approval for deploy as usual).
3. Dispatch the deploy workflow (Actions -> Build & Deploy -> Run workflow,
   `environment` = `production` or `staging`) or push a new `v*` tag.
4. Confirm the `BRAAVOLABS_PREVIOUS_GOOD_COMMIT` variable still equals the
   server's `release` (section 5) before dispatching, or the run stops at 68.

### 3b. Emergency path (server, previous digests)

Prerequisite: SSH access as the deploy user, the server's compose override
mechanism untouched, and the previous images still present
(`docker image inspect` succeeds; `load_previous_good` requires this).

```bash
ssh <deploy-user>@<host>
sudo cat /opt/braavolabs/releases/previous-good.json        # note api, ui, release
docker image inspect <previous api digest ref> <previous ui digest ref> >/dev/null
# Re-point api/ui to the previous digests using the same override file the
# script writes (see write_override / compose in deploy-platform.sh), then:
#   compose up -d --no-deps api ui
#   compose --profile backup up -d postgres-backup
```

Do not edit `previous-good.json` by hand. If the manual rollback succeeds, the
repo variable `BRAAVOLABS_PREVIOUS_GOOD_COMMIT` and the server record must still
agree; if they do not, section 5.

Image-by-tag fallback (only if the digest record is lost): the `vX.Y.Z` tag of
the last good release identifies it; resolve the digest with
`docker buildx imagetools inspect ghcr.io/kocakkmustafa/braavolabs/api:<tag>` and
use the `@sha256:` form. Never roll back to `:latest`.

## 4. Migration rollback strategy

Rule: **fix forward; do not run down SQL in production.** Prisma has no down
migrations, `migrate deploy` only moves forward, and the deploy script admits
only additive SQL (new tables, nullable/defaulted `ADD COLUMN`, `IF NOT EXISTS`
indexes, plus a few hash-pinned reviewed migrations). Additive changes are
backward compatible: the previous image simply does not read the new
columns/tables, so rolling back the *application* (section 3) is enough. The
extra schema is left in place and is harmless.

Down SQL is a last resort, for staging/local rehearsal or a deliberately
planned production change approved by the founder with a fresh database backup.
Dropping a column destroys data written since the migration (measured in
section 8). If a DB-level undo is truly needed, take a backup first and prefer
a new forward migration that neutralises the change.

Per recent migration:

| Migration | Adds | Roll back app only? | Down SQL (rehearsal only) | Data lost by down SQL | Notes |
|---|---|---|---|---|---|
| `20261108000000_job_lifecycle` | enums `JobState`, `ResultStatus`; 10 new columns on `runs`; table `job_receipts` (RLS policy) ; 2 indexes on `runs`, 2 on `job_receipts` | **Safe.** Old code ignores them. Nothing reads them while `JOB_STATE_DUAL_WRITE` is off. | `DROP TABLE job_receipts; DROP INDEX runs_tenant_id_state_idx, runs_tenant_id_idempotency_key_key; ALTER TABLE runs DROP COLUMN ...; DROP TYPE JobState, ResultStatus;` | All `job_receipts` rows and every `runs.state`, `idempotency_key`, `retry_count`, etc. written since. | Backfill of `tenant_id`/`workspace_id` is idempotent. Turn `JOB_STATE_DUAL_WRITE` off first (check `/api/v1/ops/flags`). Down SQL must run in a transaction; it takes a brief `ACCESS EXCLUSIVE` lock on `runs`. |
| `20261108010000_approval_exact_action` | `approvals.nonce/action_hash/consumed_at/tenant_id`; `runs.job_budget`; unique index `approvals_nonce_key`, index `approvals_run_id_action_hash_idx` | **Safe.** Old code ignores them while `EXACT_ACTION_APPROVAL` is off and no run carries a `job_budget`. | `DROP INDEX approvals_run_id_action_hash_idx, approvals_nonce_key; ALTER TABLE approvals DROP COLUMN ...; ALTER TABLE runs DROP COLUMN job_budget;` | Consumed-nonce history (replay protection), exact-action bindings, `job_budget` values. | **Do NOT run down SQL with `EXACT_ACTION_APPROVAL` on:** dropping `nonce`/`consumed_at` re-opens approval replay. Turn the flag off, keep the columns. Must be rolled back **after** (or together with) the job_lifecycle down SQL only if both are dropped; both touch `runs`. |
| `20261114000000_connector_scope_audience` | `tenant_connectors.scopes` (default `{}`), `audience`, `revoked_at` | **Safe** for availability: empty `scopes` = legacy unrestricted behaviour. | `ALTER TABLE tenant_connectors DROP COLUMN scopes, DROP COLUMN audience, DROP COLUMN revoked_at;` | Scope restrictions, audience binding and **revocation timestamps** (measured: revoked connector loses its revoked mark). | **Security-sensitive: do not drop in production.** After app rollback the old code ignores `revoked_at`, so a connector revoked under the new code behaves as active again. Before rolling the app back past this migration, list `revoked_at IS NOT NULL` connectors and disable/rotate them by hand. Prefer fix-forward. |

Order if more than one down SQL is rehearsed: reverse of application, newest
first (`connector_scope_audience`, then `approval_exact_action`, then
`job_lifecycle`). After a down SQL, `_prisma_migrations` still records the
migration as applied; Prisma will not re-apply it. Rehearsal databases are
discarded afterwards. Never run down SQL on a database that Prisma will keep
using without also deleting the `_prisma_migrations` row, and never do that in
production.

## 5. Drift (exit 68) and other migration-stage failures

Drift means the server's idea of "previous good" differs from the variable the
workflow passed. The script refuses before touching anything
(`previous release drift`).

1. Read the server record (read-only):
   `ssh <deploy-user>@<host> sudo cat /opt/braavolabs/releases/previous-good.json`
   and note `release` and `previousRelease`.
2. Read the repo variable: GitHub -> Settings -> Variables ->
   `BRAAVOLABS_PREVIOUS_GOOD_COMMIT`.
3. Interpret:
   - Server `release` == variable: not drift; look at the other 68 causes
     (below).
   - Server `release` == the commit being deployed, `previousRelease` ==
     variable: idempotent re-run, allowed.
   - Server `release` differs and is the newer, healthy release (a previous
     deploy succeeded but the variable was not updated): update the variable to
     the server's `release` (founder step), then rerun.
   - Server `release` is older/unknown: someone deployed or rolled back by hand.
     Stop; establish which release actually runs
     (`curl https://api.braavolabs.com/health`, `commit` field) before changing
     anything.
4. Other 68 causes: read the log line.
   - `migration delta is not additive/modified SQL`, `migration requires manual
     review`, `migration discovery and manifest differ`: a non-additive
     migration, or an unreviewed one, is in the delta. Do not weaken the check.
     Split the change or add a reviewed manifest entry through a PR.
   - `previous release commit unavailable`: workflow checkout depth (`fetch-depth:
     0` is set) or a force-pushed/garbage-collected commit.
   - `prisma migrate deploy` failure: the migration was rejected by Postgres
     (nothing was cut over; `MIGRATE_CANDIDATE` journal is `failed`). A
     transaction-per-migration Postgres DDL error leaves that migration unapplied;
     fix forward with a corrected migration, and check `_prisma_migrations` for a
     failed row before retrying (`prisma migrate resolve` is a founder decision).

## 6. Verification commands

After any deploy or rollback:

```bash
# 1. Which commit runs. /health returns status, timestamp and release info.
curl -fsS https://api.braavolabs.com/health        # expect {"status":"ok",...,"commit":"<release sha>"}
curl -fsS https://api.braavolabs.com/api/v1/health # same handler (alias)

# 2. Feature flags (platform admin only; needs an admin bearer token, not stored here).
curl -fsS -H "Authorization: Bearer $ADMIN_TOKEN" https://api.braavolabs.com/api/v1/ops/flags
#   expect JOB_STATE_DUAL_WRITE and EXACT_ACTION_APPROVAL with the intended enabled value

# 3. Web
curl -fsS -o /dev/null -w '%{http_code}\n' https://www.braavolabs.com/      # 200
curl -fsS -o /dev/null -w '%{http_code}\n' https://app.braavolabs.com/login # 200

# 4. Server state (read-only)
ssh <deploy-user>@<host> 'sudo cat /opt/braavolabs/releases/previous-good.json; docker ps --format "{{.Names}} {{.Status}}" | grep aicos'
```

The `commit` and `version` fields come from `getReleaseInfo()` in
`packages/api/src/lib/release-info.ts`; the commit is baked in via the
`RELEASE_COMMIT` build arg. For staging substitute the staging hostnames.
`/ops/flags` returns 403 for non-admins; that is expected.

## 7. Founder-owned steps

Production deploys, `BRAAVOLABS_PREVIOUS_GOOD_COMMIT` edits, manual SSH
rollback, `prisma migrate resolve`, and any down SQL on a persistent database
need the founder's approval in his own words. Secrets (`LIGHTSAIL_*`, tokens)
are never pasted into tickets, logs or this repo.

## 8. Local rehearsal (done 2026-11-14)

Environment: macOS, PostgreSQL 18.6 (Homebrew) in a throw-away cluster
(`initdb`, unix socket, port 55432, scratch dir only). Docker CLI present but not
used. `prisma` was not installed in the worktree, so migrations were applied
with `psql -f migration.sql` in lexical order, which executes the same SQL that
`migrate deploy` runs but does not exercise `_prisma_migrations` bookkeeping or
the deploy script. Dataset: 20,000 `runs`, 5,000 `approvals`, 50 `pipelines`
(1 tenant, 1 company).

```bash
initdb -D <dir>/pgdata -U postgres --auth=trust
pg_ctl -D <dir>/pgdata -o "-p 55432 -k <dir> -c listen_addresses=''" -w start
psql -h <dir> -p 55432 -U postgres -c "create database qa_bra02"
for d in <migrations in order>; do psql -h <dir> -p 55432 -U postgres -d qa_bra02 -v ON_ERROR_STOP=1 -q -f $d/migration.sql; done
```

| Step | Result | Time |
|---|---|---|
| Baseline: 53 older migrations from empty DB | all applied | 0.61 s |
| Apply `20261108000000_job_lifecycle` (backfill 20,000 runs) | ok; `runs.tenant_id` set on 20,000/20,000 | 0.18 s |
| Apply `20261108010000_approval_exact_action` (backfill 5,000 approvals) | ok; `approvals.tenant_id` set 5,000/5,000 | 0.09 s |
| Apply `20261114000000_connector_scope_audience` | ok | 0.01 s |
| Down SQL `connector_scope_audience` | columns gone; existing rows kept | 0.01 s |
| Down SQL `approval_exact_action` | ok; 5,000 approvals kept | 0.01 s |
| Down SQL `job_lifecycle` | ok; 20,000 runs kept; `job_receipts` gone | 0.01 s |
| Re-apply the three migrations after down SQL (forward re-apply) | ok | 0.18 + 0.10 + 0.01 s |
| Data-loss probe: connector with `revoked_at` set, then down SQL | row kept, **`revoked_at` value lost** (column dropped) | n/a |

What this shows: the three recent migrations are additive and reversible on a
scratch database with a fresh start; times are for a tiny dataset on a laptop and
say nothing about production lock time. What it does not show: behaviour of the
deploy script, Prisma bookkeeping, production-size locks, the 90 s health
window, or image rollback. Those need the staging rehearsal.

Not measured: image rollback, deploy workflow, `/health`, `/ops/flags` (no
environment). **Local rehearsal of the deploy script was not done: no
staging-like host.**

## 9. Staging rehearsal (to run after founder approval)

Preconditions: staging environment exists and is the target of
`workflow_dispatch` with `environment=staging`; staging has a recent DB backup;
`BRAAVOLABS_PREVIOUS_GOOD_COMMIT` (or its staging equivalent) matches the staging
server record; the operator has SSH access and an admin token. Do **not** run
against production. Record every time in the boxes. A stopwatch value in
seconds is enough; write the actual command output next to it.

| # | Step | Command | Expected | Time |
|---|---|---|---|---|
| S0 | Baseline | `curl -fsS https://<staging-api>/health`; `ssh <staging> sudo cat /opt/braavolabs/releases/previous-good.json` | `status:ok`; record `release` R0 and `api`/`ui` digests | [ ... ] |
| S1 | Drift check | Compare R0 with the repo variable | Equal | [ ... ] |
| S2 | Deploy candidate with the newest migration | Actions -> Build & Deploy -> `environment=staging` on the release commit | Job green; exit 0 | [ ... ] total; of which migrate [ ... ], health [ ... ] |
| S3 | Journal | `ssh <staging> sudo ls /opt/braavolabs/releases/<sha>/transitions/` | `CAPTURE_PREVIOUS`, `STAGE_RELEASE`, `MIGRATE_CANDIDATE`, `CUTOVER` all complete | [ ... ] |
| S4 | Verify new release | section 6 commands | `/health` commit == candidate; `/ops/flags` as intended | [ ... ] |
| S5 | Application rollback (normal path) | Revert PR merged, dispatch deploy again (section 3a) **or** emergency path 3b | `/health` commit == R0 digest set; `previous-good.json` consistent | [ ... ] |
| S6 | Confirm schema left in place | `psql` on staging DB: `\d tenant_connectors` | New columns still present and old release serves traffic | [ ... ] |
| S7 | Forced-failure rollback (optional) | Dispatch a deploy of a commit whose `/health` is known-bad on staging only, or temporarily block the health URL | Exit 70; automatic rollback; running digests == R0; journal `ROLLBACK_APPLICATION restored` | [ ... ] |
| S8 | Drift 68 | Set the staging variable to a wrong 40-hex value, dispatch, then restore it | Exit 68 `previous release drift`; no server change (`previous-good.json` unchanged) | [ ... ] |
| S9 | Down SQL (staging only, backup taken) | Section 4 down SQL for the newest migration in a transaction | Rows kept; dropped columns gone; measured lock/duration [ ... ] | [ ... ] |
| S10 | Forward fix | Redeploy candidate (S2 again) | Exit 0; schema consistent | [ ... ] |

Summary box to fill after the rehearsal:

- Date / operator: `[ ... ]`
- Staging release before / after / after rollback: `[ ... ] / [ ... ] / [ ... ]`
- Total application rollback time (S5): `[ ... ]`
- Automatic rollback time (S7): `[ ... ]`
- Down SQL duration on staging data (S9): `[ ... ]`
- Surprises / corrections to this runbook: `[ ... ]`
