# Deploy and migration rollback runbook (QA-BRA-02)

Scope: how to roll back a Braavolabs release (API + UI images) and its Prisma
migrations, how to read the deploy script exit codes (including drift, 68), and
how to rehearse all of it on staging. Companion to
[`deployment-github-actions.md`](../deployment-github-actions.md) (release gates)
and [`scripts/deploy-platform.sh`](../../scripts/deploy-platform.sh) (the
orchestrator). This runbook changes no code, workflow or migration.

Status of this document (2026-11-14):

- Written from reading `.github/workflows/deploy.yml`, `scripts/deploy-platform.sh`
  and the migration folder at `main` `ec4482e`. Line numbers below refer to that
  script.
- **Local rehearsal done** (throw-away Postgres, section 9) and the script's
  migration classifier was run in isolation (section 5). Evidence files are in
  `scratch/2026-11-14-qa-bra-02/` (not committed): `prova.sh`, `rehearse.sh`,
  `seed.sql`, `down-*.sql`, `connector-loss.sql`, `classify.sh`.
- **Staging rehearsal NOT done.** Steps are in section 10; the founder approves
  running them. Nothing here was run against production or real staging, and the
  deploy script itself was never executed.
- Time boxes marked `[ ... ]` are intentionally empty until the staging rehearsal.

## 0. Blocker found before any rehearsal

The deploy script's migration classifier **rejects**
`20261114000000_connector_scope_audience` (section 5): the morning deploy that
carries it stops with exit 68 (`migration requires manual review`) until a
reviewed exception is added to the script through a PR. This runbook does not
change the script. Also, the reviewed job-lifecycle exception pins a 55-file
migration tree; the folder has 56 (section 5).

## 1. How a release is shaped

| Piece | Where | Rollback relevance |
|---|---|---|
| Images | `ghcr.io/kocakkmustafa/braavolabs/{api,ui}@sha256:<digest>` | Deploys are by immutable digest (`API_IMAGE_REF`, `UI_IMAGE_REF`); tags (`vX.Y.Z`, `sha-<8>`, `latest`) are convenience only. Roll back by digest, never by `latest`. |
| Last-good record | Server: `/opt/braavolabs/releases/previous-good.json` (fields `release`, `previousRelease`, `tuple`, `api`, `ui`, `migrationDeltaSha256`, `result`) | **Describes the release that is currently deployed and healthy**, not the one before it: `write_previous_good` (script ~600-607) writes the candidate's `release`/`api`/`ui` after a healthy cutover. Despite the name it is not the rollback target digest source for an already-successful release. |
| Record of the release before | `/opt/braavolabs/releases/<release-sha>/previous-good.before.json` (script ~672, copied from `previous-good.json` before that release deployed) and the journal fields `previousApi` / `previousUi` (script ~200) | These hold the **previous** release's `release`/`api`/`ui`. Use them to find the digests to roll back to. |
| Previous-good variable | GitHub repo variable `BRAAVOLABS_PREVIOUS_GOOD_COMMIT`, passed to the script as job env `PREVIOUS_RELEASE_COMMIT` (`deploy.yml` ~192; it is not a workflow dispatch input) | Must equal the server record's `release`, or the record's `previousRelease` when the server already runs the candidate (idempotent re-run). Otherwise the local step exits 68 (`previous release drift`, script ~968-972). |
| Journal | `/opt/braavolabs/releases/<release-sha>/transitions/NNNN-<STATE>.json` | One file per state (`CAPTURE_PREVIOUS`, `STAGE_RELEASE`, `MIGRATE_CANDIDATE`, `CUTOVER`, `VERIFY_TARGET`, `COMMIT_RELEASE`, `ROLLBACK_APPLICATION`). First place to look after a failed deploy. |
| Migrations | `packages/db/prisma/migrations/` (56 `migration.sql` as of `ec4482e`), run by `npx prisma migrate deploy` inside the candidate API image **before** cutover | Forward only. Prisma has no down migrations. |

Sequence (remote side, `remote_main`): lock (`flock`, exit 75) -> load
last-good -> verify delta contract and migration eligibility -> migrate
(`prisma migrate deploy`, exit 68 on failure) -> cutover
(`compose up -d --no-deps api ui`, 69) -> `verify_health` (90 s budget:
api/ui containers healthy, backup container running, three HTTPS 200 probes) ->
write the new last-good record.

**What the automatic rollback covers.** If cutover, health or the journal fails
after cutover, `fail_after_cutover` calls `rollback_application` (~265-277): it
rewrites the compose override to the digests recorded as `previous_api`/
`previous_ui`, brings api/ui back, re-verifies health, checks the running digests
equal them, restores the last-good file, and exits with the original code (69, 70
or 72). If the rollback itself fails the exit code is 71.

**What it does not cover: the database.** Migrations run before cutover and stay
applied; `rollback_application` neither reverts schema nor data. Staying safe
relies on the migrations being backward compatible (section 4), and that is
**not** true for everything the new code writes: a connector revoked under the
new code is *not* revoked for the old code (section 4, `connector_scope_audience`).
"Application rolled back" therefore does not mean "behaviour rolled back".

## 2. Exit codes

| Code | Name | Meaning | Action |
|---|---|---|---|
| 64 | input | Missing/invalid input (e.g. previous commit not 40-hex) | Fix the variable/secret; rerun. No server change. |
| 65 | host | Static check of the provided `known_hosts` file against `LIGHTSAIL_HOST_KEY_SHA256` failed (~840-875: format, key type, fingerprint set). It does **not** detect a changed live host key | Stop. Do not bypass; fix the secrets after verifying the key out of band. |
| 66 | remote | SSH/remote failure, local cleanup failure, a **changed live host key** (strict host key checking makes ssh return 255, reported as `remote preflight failed`), **or the remote compose-identity check failed** (e.g. after a manual rollback, section 3c) | Read the local log; for the remote cause read the journal and `docker inspect` labels. The remote 66 is silent and does **not** roll the app back. |
| 67 | image | Image pull/identity verification failed, or this exact release is already recorded as `COMMIT_RELEASE success` | Check GHCR digest; use a new commit/tag for a re-release. |
| 68 | migration | Drift, delta not additive / not reviewed, commit unavailable, **or** `prisma migrate deploy` failed | Section 6. |
| 69 | cutover | `compose up` failed; app rolled back | Read journal; fix cause. |
| 70 | health rolled back | Candidate unhealthy; app rolled back | Read candidate container logs; fix forward. |
| 71 | rollback | Automatic rollback FAILED **or a pre-cutover safety check failed**: last-good record unreadable/invalid (`load_previous_good` needs `result: success`, 40-hex release, digest refs, images present locally), restore of the record failed, running digest not a valid digest ref (~688-719) | Page the founder; manual rollback (section 3b). Not always an outage: it can fire before anything was changed. |
| 72 | journal | Journal/last-good write failed | **Before cutover** (state transitions up to `CUTOVER pending`) there is no rollback: the script just exits 72 and nothing was cut over. **After cutover** the failure goes through `fail_after_cutover` and the app is rolled back (72, or 71 if that fails). Check which state the journal stopped at. |
| 75 | lock | Another deploy holds the lock | Wait; never delete the lock file by hand. |

Log quirks: the *local* step prints `deploy-platform: <message>` for 64-68
failures (including `migration requires manual review` and `previous release
drift`). The *remote* step is silent on an eligibility rejection (~758-762): it
writes the journal state `MIGRATE_CANDIDATE rejected` and exits 68 with no
message, so read `transitions/` on the server. `fail_after_cutover` is a shell
function name, not a log line; do not grep logs for it.

## 3. Roll back a release (images)

Prefer reverting through the normal pipeline (revert commit on `main` -> CI green
-> normal merge -> dispatch/tag), because the script then re-verifies CI,
digests and the migration delta. Manual SSH rollback is the emergency path.
Production deploys need the founder's approval in his own words.

### 3a. Normal path

1. Identify the release to return to: `git log` on `main`, or the server files in
   section 1 (record of the release before).
2. `git revert` the offending merge on a branch, PR, CI green, normal merge.
3. Dispatch Build & Deploy (`environment` = `production`, or `staging`, but see
   section 10 preconditions) or push a `v*` tag.
4. Before dispatching, confirm `BRAAVOLABS_PREVIOUS_GOOD_COMMIT` equals the
   server's last-good `release` (section 6), or the run stops at 68.
5. A revert that contains an older additive migration set is fine; a revert never
   removes migrations, so the database keeps the extra schema.

### 3b. Emergency path (server)

Digest source, in order of preference (read-only):

```bash
ssh <deploy-user>@<host>
sudo cat /opt/braavolabs/releases/previous-good.json                       # current release R1: api/ui are R1's digests
sudo cat /opt/braavolabs/releases/<R1-sha>/previous-good.before.json       # previous release R0: release/api/ui are the rollback target
sudo grep -h -o '"previousApi":"[^"]*","previousUi":"[^"]*"' /opt/braavolabs/releases/<R1-sha>/transitions/*.json | head -1   # same, from the journal
docker image inspect <R0 api digest ref> <R0 ui digest ref> >/dev/null     # both images must still exist locally
ls /opt/braavolabs/releases/<R0-sha>/input/ENV/compose.prod.yaml /opt/braavolabs/releases/<R0-sha>/compose.digest-override.yaml
```

Bring api/ui back **through R0's own release directory**: its compose file and
its own digest override already exist from R0's deploy, name R0's digests, and
make the containers carry R0's compose labels (which `verify_compose_identity`
checks later, section 3c). The script's `compose` is a bash function (~89-92); the
equivalent full commands, with R0's paths, are:

```bash
R0=/opt/braavolabs/releases/<R0-sha>
docker compose -p env --env-file /opt/braavolabs/app/.env \
  -f $R0/input/ENV/compose.prod.yaml -f $R0/compose.digest-override.yaml \
  up -d --no-deps api ui
docker compose -p env --env-file /opt/braavolabs/app/.env \
  -f $R0/input/ENV/compose.prod.yaml -f $R0/compose.digest-override.yaml \
  --profile backup up -d postgres-backup
```

A plain `docker compose up` without `-p env` and both `-f` files opens the wrong
project and can recreate or orphan containers. On production, `up` recreates the
running api/ui: a live change that needs the founder's approval. If R0's release
directory is gone, there is no clean way back through the script's identity
rules; stop and ask the founder.

Image-by-tag fallback (only if every record is lost): resolve the last good
`vX.Y.Z` tag with `docker buildx imagetools inspect
ghcr.io/kocakkmustafa/braavolabs/api:<tag>` and use the `@sha256:` form, never
`:latest`. This is **not portable into the script's world**: containers started
from a hand-made override carry labels the script does not recognise, so the next
deploy stops at exit 66 until the host is reconciled (3c). Use it only to restore
service, then reconcile.

### 3c. After a manual rollback: the next deploy stops with exit 66, silently

`remote_main` runs `verify_compose_identity` (~99-188, called ~720) before it
reaches the cutover/rollback logic. After a manual rollback to R0 while the
record still describes R1:

- the containers carry R0 (or hand-made) compose labels and R0 digests, but the
  record and R1's journal say R1 is running; `verify_compose_identity` fails and
  the script exits **66 right there**. The remote step prints nothing; the host
  is **left running R0**. `rollback_application` (~738-749) is not reached (it
  only runs after the identity check passes). The same failure occurs if the
  containers were recreated with hand-made override paths (labels must equal
  `<release>/input/ENV/compose.prod.yaml,<release>/compose.digest-override.yaml`).
- Copying R0's record over `previous-good.json` alone does **not** fix it while
  the containers are still labelled for R1 or for hand-made files: the "clean
  previous release" case (~178-186) needs the labels to point at the recorded
  release's directory, that release's journal to be `COMMIT_RELEASE success`, and
  the running digests to equal that journal. It fails with R1-labelled
  containers.

Ways out (founder decision; neither is routine):

1. Undo the manual rollback: recreate api/ui from **R1's** directory (the 3b
   commands with `R0=` pointing at R1's release path) so labels and digests agree
   with the record, then deploy normally with a revert commit (3a).
2. Make everything agree on R0: recreate api/ui from **R0's** directory (the 3b
   commands: R0 labels and digests), then install R0's record, then set
   `BRAAVOLABS_PREVIOUS_GOOD_COMMIT` to R0's `release`. Install the record with
   the script's own safeguards, not a bare `cp`: hold the deploy lock
   (`/opt/braavolabs/deploy.lock`, taken by `remote_main` ~681), write atomically
   (temp file in the same directory, sync, rename, as `atomic_file` ~54-61 does),
   and make sure no deploy is running or queued (Actions idle):

   ```bash
   sudo flock -n /opt/braavolabs/deploy.lock -c '
     cp -p /opt/braavolabs/releases/previous-good.json /opt/braavolabs/releases/previous-good.json.pre-rollback &&
     cp -p /opt/braavolabs/releases/<R1-sha>/previous-good.before.json /opt/braavolabs/releases/previous-good.json.tmp &&
     sync /opt/braavolabs/releases/previous-good.json.tmp &&
     mv -f /opt/braavolabs/releases/previous-good.json.tmp /opt/braavolabs/releases/previous-good.json &&
     sync /opt/braavolabs/releases'
   ```

   `flock -n` exits non-zero if a deploy holds the lock; do not wait for it or
   remove the lock file. Never write a new JSON by hand: `load_previous_good`
   rejects anything not shaped exactly like a script-written record.

Neither way-out has been exercised; both come from reading the code. S5b
rehearses way-out 2 before anyone relies on it on production.

Re-releasing the same commit R1 later fails with exit 67 if its journal already
says `COMMIT_RELEASE success`; use a new commit.

## 4. Migration rollback strategy

Rule: **fix forward; do not run down SQL in production.** Prisma has no down
migrations and `migrate deploy` only moves forward. Additive changes are
backward compatible for *reading*: the previous image does not read the new
columns/tables, so rolling back the application leaves harmless extra schema.

Down SQL is for staging/local rehearsal, or a founder-approved planned
production change with a fresh database backup. Dropping a column destroys data
written since the migration (measured in section 9).

Per recent migration. The down SQL below is **not in the repository** (no files
were added to `migrations/`); these blocks reproduce what was rehearsed. Run
each in one transaction, newest migration first.

| Migration | Adds | App-only rollback | Data lost by down SQL | Notes |
|---|---|---|---|---|
| `20261108000000_job_lifecycle` | enums `JobState`, `ResultStatus`; 10 columns on `runs`; table `job_receipts` (RLS policy); indexes | Safe for availability. Old code ignores them; nothing reads them while `JOB_STATE_DUAL_WRITE` is off. | All `job_receipts` rows; `runs.state`, `idempotency_key`, `retry_count`, `tenant_id`, ... written since | Turn `JOB_STATE_DUAL_WRITE` off first (`/api/v1/ops/flags`). Backfill is idempotent. Brief `ACCESS EXCLUSIVE` lock on `runs`. |
| `20261108010000_approval_exact_action` | `approvals.nonce/action_hash/consumed_at/tenant_id`; `runs.job_budget`; unique index `approvals_nonce_key`; index `approvals_run_id_action_hash_idx` | Safe for availability while `EXACT_ACTION_APPROVAL` is off and no run carries a `job_budget`. | Consumed-nonce history, action bindings, `job_budget` | **Never drop with `EXACT_ACTION_APPROVAL` on:** removing `nonce`/`consumed_at` re-opens approval replay. Turn the flag off, keep the columns. |
| `20261114000000_connector_scope_audience` | `tenant_connectors.scopes` (default `{}`), `audience`, `revoked_at` | **Not safe for security behaviour.** Old code ignores `revoked_at`/`scopes`/`audience`, so a connector revoked under the new code is treated as **active** again, and scope/audience limits stop applying. | Scope restrictions, audience binding, revocation timestamps (measured) | Automatic rollback (section 1) does not address this. Before rolling the app back past this migration, list `revoked_at IS NOT NULL` connectors and disable/rotate their credentials by hand. Do not drop the columns in production; prefer fix-forward. |

```sql
-- down 3: 20261114000000_connector_scope_audience
BEGIN;
ALTER TABLE "tenant_connectors" DROP COLUMN "scopes", DROP COLUMN "audience", DROP COLUMN "revoked_at";
COMMIT;

-- down 2: 20261108010000_approval_exact_action
BEGIN;
DROP INDEX "approvals_run_id_action_hash_idx";
DROP INDEX "approvals_nonce_key";
ALTER TABLE "approvals" DROP COLUMN "action_hash", DROP COLUMN "consumed_at", DROP COLUMN "nonce", DROP COLUMN "tenant_id";
ALTER TABLE "runs" DROP COLUMN "job_budget";
COMMIT;

-- down 1: 20261108000000_job_lifecycle
BEGIN;
DROP TABLE "job_receipts";
DROP INDEX "runs_tenant_id_state_idx";
DROP INDEX "runs_tenant_id_idempotency_key_key";
ALTER TABLE "runs" DROP COLUMN "deadline", DROP COLUMN "evidence_ref", DROP COLUMN "heartbeat_at", DROP COLUMN "idempotency_key", DROP COLUMN "plan_version", DROP COLUMN "result_status", DROP COLUMN "retry_count", DROP COLUMN "state", DROP COLUMN "tenant_id", DROP COLUMN "workspace_id";
DROP TYPE "JobState";
DROP TYPE "ResultStatus";
COMMIT;
```

Bookkeeping: after down SQL, `_prisma_migrations` still lists the migration as
applied and Prisma will not re-apply it. To re-run it on a **rehearsal** database,
delete its row (section 10, S9). Never do this in production; there, fix forward
with a new migration.

## 5. Will the deploy script accept the recent migrations? (measured)

The classifier (`migration_is_eligible`, ~478-545) was run in isolation, local
only, with a harness that sources the script's functions without executing it
and rebuilds the staged inputs exactly as `stage_release_inputs` does (no server,
no deploy). Harness: `scratch/2026-11-14-qa-bra-02/classify.sh`.

| Case (previous -> candidate) | Delta | Result | Exit |
|---|---|---|---|
| `d29e432` -> `main` (connector only) | `connector_scope_audience` | **REJECT** | local `die 68 migration requires manual review` |
| `ea61abc^` -> `main` (all three) | job_lifecycle, approval_exact_action, connector | **REJECT** | 68 |
| `6846ab7^` -> `main` (connector only) | connector | **REJECT** | 68 |
| `ea61abc^` -> `d29e432` (the two job migrations, 55-file tree) | job_lifecycle, approval_exact_action | **ACCEPT** | 0 |
| connector case with the double quotes stripped from the SQL (diagnostic only) | connector | ACCEPT | 0 |

Cause: the generic additive rule matches identifiers with `[A-Z_][A-Z0-9_]*`
(~532-537); Prisma writes `ALTER TABLE "tenant_connectors" ADD COLUMN ...` with
quoted identifiers, which that pattern does not match. Nothing else in the
connector SQL trips it (it has no `NOT NULL`, `UNIQUE`, `REFERENCES`, ...).
Consequence for the morning deploy: **it stops with exit 68 and a reviewed
exception for the connector migration has to be added to the script** (PR, founder
review); this runbook does not change the script.

Job-lifecycle exception: `reviewed_job_ux_delta` (~425-457) requires the delta
to be **exactly** the two job files and the whole migration tree (`migration.sql`
files, sorted) to hash to `REVIEWED_JOBUX_MIGRATION_TREE_SHA256`, which was pinned
for 55 files. At `main` the folder has **56** `migration.sql` files (tree hash
`b875ef09...`, pin `7120cc9c...`), so the exception cannot match at `main`: if
the job migrations are still undeployed, the pair is rejected too (the connector
file also breaks the exact two-file delta). If production already runs the two job
migrations, only the connector delta remains and it is rejected as above.

## 6. Drift (exit 68) and other migration-stage failures

Drift: the server's last-good `release` differs from the value the workflow
passed (`previous release drift`, local step, nothing touched).

1. Read the server record (read-only): `ssh <deploy-user>@<host> sudo cat
   /opt/braavolabs/releases/previous-good.json`; note `release`, `previousRelease`.
2. Read the repo variable `BRAAVOLABS_PREVIOUS_GOOD_COMMIT`.
3. Interpret:
   - Server `release` == variable: not drift; check the other causes below.
   - Server `release` == the commit being deployed and `previousRelease` ==
     variable: idempotent re-run, allowed.
   - Server `release` is a newer healthy release (deploy succeeded but the
     variable was not updated): update the variable (founder step), rerun.
   - Server `release` is older/unknown (hand deploy or rollback): stop; find the
     running release (`curl https://api.braavolabs.com/health`, `commit`) before
     changing anything; see 3c.
4. Other 68 causes:
   - `migration delta is not additive/modified SQL`, `migration requires manual
     review`, `migration discovery and manifest differ` (local, printed): the delta
     is not admitted (section 5). Do not weaken the check; add a reviewed entry
     through a PR.
   - Remote eligibility rejection: **silent**; only the journal
     `MIGRATE_CANDIDATE rejected`.
   - `previous release commit unavailable`: checkout depth (`fetch-depth: 0` is
     set) or a force-pushed/garbage-collected commit.
   - `prisma migrate deploy` failed: Postgres rejected the migration; nothing was
     cut over (`MIGRATE_CANDIDATE failed`). Check `_prisma_migrations` for a failed
     row before retrying; `prisma migrate resolve` is a founder decision (not
     exercised here).

## 7. Verification commands

```bash
# 1. Which commit runs. /health returns status, timestamp, commit, version.
curl -fsS https://api.braavolabs.com/health        # expect {"status":"ok",...,"commit":"<release sha>","version":"..."}
curl -fsS https://api.braavolabs.com/api/v1/health # same handler

# 2. Feature flags (platform admin only; admin bearer token, not stored here).
curl -fsS -H "Authorization: Bearer $ADMIN_TOKEN" https://api.braavolabs.com/api/v1/ops/flags
#   JOB_STATE_DUAL_WRITE and EXACT_ACTION_APPROVAL; non-admins get 403 (expected)

# 3. Web
curl -fsS -o /dev/null -w '%{http_code}\n' https://www.braavolabs.com/      # 200
curl -fsS -o /dev/null -w '%{http_code}\n' https://app.braavolabs.com/login # 200

# 4. Server state (read-only)
ssh <deploy-user>@<host> 'sudo cat /opt/braavolabs/releases/previous-good.json; docker ps --format "{{.Names}} {{.Status}}" | grep aicos'
```

`commit`/`version` come from `getReleaseInfo()` in
`packages/api/src/lib/release-info.ts` (commit baked in via the `RELEASE_COMMIT`
build arg). These URLs are production; for a separate staging host substitute its
hostnames, but see section 8.

## 8. Staging is not proven isolated (precondition for section 10)

- `deploy.yml` only switches the GitHub *environment* (and so the secrets) for
  `staging`; the script itself targets `/opt/braavolabs` and calls the host it
  is given.
- `verify_health` (~253-255) probes **production** URLs
  (`api/www/app.braavolabs.com`) regardless of the target. A staging run
  therefore judges success or failure on production endpoints. Per
  `docs/deployment-github-actions.md` (~21-23) the `staging` choice must not be
  assumed isolated: prove separate environment credentials and host identity
  before treating a run as non-production. If staging resolves to the production
  host, a "staging" rehearsal is a production deploy and must not be run.
- **A staging green (or red) is valid evidence only if a separate staging host
  with its own credentials is proven.** Even then, the three HTTPS probes
  (`api/www/app.braavolabs.com`) check production, not the staging host; only the
  container health checks (api/ui healthy, backup running) are about the staging
  host. A staging "healthy" therefore means "staging containers healthy AND
  production answers 200", and a production outage fails a staging run. Record
  this limit next to every staging result.
- Consequence for failure rehearsals: you cannot simulate an unhealthy release by
  blocking a "staging health URL", because there is none. Use S7 below.

## 9. Local rehearsal (done 2026-11-14)

Environment: macOS, PostgreSQL 18.6 (Homebrew), throw-away cluster (`initdb`,
unix socket, port 55432, scratch dir only). Docker CLI present, not used.
`prisma` was not installed in the worktree, so migrations were applied with
`psql -f migration.sql` in lexical order (same SQL `migrate deploy` runs, but
without `_prisma_migrations` bookkeeping or the deploy script). Dataset: 20,000
`runs`, 5,000 `approvals`, 50 `pipelines`, 1 tenant, 1 company. Evidence:
`scratch/2026-11-14-qa-bra-02/{prova.sh,rehearse.sh,seed.sql,down-*.sql,connector-loss.sql}`
and the console output of those scripts (not committed).

| Step | Result | Time |
|---|---|---|
| Baseline: 53 older migrations from empty DB | all applied | 0.61 s |
| `20261108000000_job_lifecycle` (backfill 20,000 runs) | ok; `runs.tenant_id` set 20,000/20,000 | 0.18 s |
| `20261108010000_approval_exact_action` (backfill 5,000) | ok; `approvals.tenant_id` 5,000/5,000 | 0.09 s |
| `20261114000000_connector_scope_audience` | ok | 0.01 s |
| Down SQL, connector | columns gone | 0.01 s |
| Down SQL, approval | ok; 5,000 approvals kept | 0.01 s |
| Down SQL, job_lifecycle | ok; 20,000 runs kept; `job_receipts` gone | 0.01 s |
| Re-apply the three after down SQL | ok (here the `psql` path has no bookkeeping row) | 0.18 + 0.10 + 0.01 s |
| Data-loss probe: connector with `revoked_at` set, then down SQL | row kept, **`revoked_at` value lost** | n/a |

The seeded `tenant_connectors` rows failed on a foreign key in the first seed
pass; the connector row was recreated explicitly in `connector-loss.sql`, so the
connector rows in the main table above were empty. The data-loss probe is the
only connector data measurement.

Shows: the three migrations are additive and re-appliable on a scratch database;
times are tiny-dataset, laptop figures and say nothing about production lock
time. Does not show: the deploy script, Prisma bookkeeping, production-size
locks, the 90 s health window, image rollback, `/health`, `/ops/flags`.
**Local rehearsal of the deploy script was not done: no staging-like host.**

## 10. Staging rehearsal (after founder approval)

Preconditions (all must hold, otherwise do not start): section 8 satisfied
(separate staging host and credentials proven, host key verified); recent staging
DB backup; `BRAAVOLABS_PREVIOUS_GOOD_COMMIT` equals the staging server record;
section 5 blocker resolved (the connector migration would otherwise stop the
deploy at 68, which is itself a useful S-step: record it); operator has SSH and
an admin token. Record every time; paste real output next to it.

| # | Step | Command | Expected | Time |
|---|---|---|---|---|
| S0 | Baseline | `curl -fsS https://<staging-api>/health`; `ssh <staging> sudo cat /opt/braavolabs/releases/previous-good.json` | `status:ok`; record release R0 and its api/ui digests | [ ... ] |
| S1 | Drift check | compare R0 with the repo variable | equal | [ ... ] |
| S2 | Deploy candidate with the newest migration | Actions -> Build & Deploy -> `environment=staging` on the release commit | green; exit 0 (or 68 if section 5 blocker unresolved: record it and stop). Valid as staging evidence only with a proven separate host; probes hit production (section 8) | [ ... ] total; migrate [ ... ]; health [ ... ] |
| S3 | Journal | `ssh <staging> sudo ls /opt/braavolabs/releases/<sha>/transitions/` | `CAPTURE_PREVIOUS`, `STAGE_RELEASE`, `MIGRATE_CANDIDATE`, `CUTOVER`, `VERIFY_TARGET`, `COMMIT_RELEASE` all complete | [ ... ] |
| S4 | Verify new release | section 7 commands (staging hostnames) | `commit` == candidate; flags as intended | [ ... ] |
| S5 | Application rollback, normal path | revert PR merged, dispatch again (3a) | `commit` == R0; last-good record consistent | [ ... ] |
| S5b | Application rollback, emergency path | 3b with digests from `previous-good.before.json`, via R0's release directory | `commit` == R0. Then, **before** reconciling, dispatch a deploy and record the expected result: remote exit 66, silent, host stays on R0, no auto-restore (3c). Then apply way-out 2 (locked, atomic record install, variable set to R0) and dispatch again: preflight should now pass. Record anything that differs from 3c | [ ... ] |
| S6 | Schema left in place | `psql` staging: `\d tenant_connectors` | new columns present; old release serves traffic | [ ... ] |
| S7 | Forced failure (do NOT block URLs: health probes prod, section 8) | dispatch a candidate whose api container healthcheck fails (throw-away branch, staging only) | exit 70; running digests == R0; journal `ROLLBACK_APPLICATION restored`. Staging-only validity as in section 8 (the 3 HTTPS probes are production) | [ ... ] |
| S8 | Drift 68 | set the staging variable to a wrong 40-hex value, dispatch, then restore | exit 68 `previous release drift`; last-good record unchanged | [ ... ] |
| S9 | Down SQL on staging (backup taken) | the section 4 down SQL, newest first, each in a transaction; **then**, to allow re-application: `DELETE FROM _prisma_migrations WHERE migration_name IN ('20261114000000_connector_scope_audience','20261108010000_approval_exact_action','20261108000000_job_lifecycle');` for the migrations that were dropped | rows kept; columns gone; lock/duration measured | [ ... ] |
| S10 | Forward fix | redeploy candidate (S2) | exit 0; `migrate deploy` re-applies; schema consistent | [ ... ] |

Summary box:

- Date / operator: `[ ... ]`
- Staging release before / after / after rollback: `[ ... ] / [ ... ] / [ ... ]`
- Application rollback time (S5, S5b): `[ ... ]`
- Automatic rollback time (S7): `[ ... ]`
- Down SQL duration on staging data (S9): `[ ... ]`
- Surprises / corrections to this runbook: `[ ... ]`
