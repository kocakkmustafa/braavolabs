import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts/deploy-platform.sh");
const RELEASE = "1".repeat(40);
const PREVIOUS_RELEASE = "0".repeat(40);
const ROLLBACK_RELEASE = "2".repeat(40);
const AUTHORITATIVE_PREVIOUS_RELEASE = "fd2b3c3ad7795f20a1cf93d3506c72cbf3a5424b";
const REAL_MIGRATION_CANDIDATE = "1a8e966c8739d05a917d90941c19ce18398f714e";
const API = "ghcr.io/kocakkmustafa/braavolabs/api@sha256:" + "a".repeat(64);
const UI = "ghcr.io/kocakkmustafa/braavolabs/ui@sha256:" + "b".repeat(64);
const PREVIOUS_API = "ghcr.io/kocakkmustafa/braavolabs/api@sha256:" + "c".repeat(64);
const PREVIOUS_UI = "ghcr.io/kocakkmustafa/braavolabs/ui@sha256:" + "d".repeat(64);
const KEY_A = "AAAAC3NzaC1lZDI1NTE5AAAAIEtleUFTeXN0aGV0aWNLZXlB"; // gitleaks:allow — synthetic public key fixture
const KEY_B = "AAAAC3NzaC1lZDI1NTE5AAAAIEtleUJTeXN0aGV0aWNLZXlC"; // gitleaks:allow — synthetic public key fixture
const FINGERPRINT_A = "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const FINGERPRINT_B = "SHA256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const REVIEWED_ENUM_MIGRATION =
  "packages/db/prisma/migrations/20260820000000_subscription_plan_enum_values/migration.sql";
const REVIEWED_PROJECTION_MIGRATION =
  "packages/db/prisma/migrations/20260821_subscription_only_plans/migration.sql";
const REVIEWED_IAP_DELIVERY_MIGRATION =
  "packages/db/prisma/migrations/20260825233000_iap_delivery_dlq/migration.sql";
const REVIEWED_GOOGLE_ALIAS_MIGRATION =
  "packages/db/prisma/migrations/20260828_google_purchase_alias_ownership/migration.sql";
const REVIEWED_SUBSCRIPTION_DIFF =
  `A\t${REVIEWED_ENUM_MIGRATION}\n` +
  `A\t${REVIEWED_PROJECTION_MIGRATION}\n` +
  `A\t${REVIEWED_IAP_DELIVERY_MIGRATION}\n` +
  `A\t${REVIEWED_GOOGLE_ALIAS_MIGRATION}\n`;

function executable(path, body) {
  writeFileSync(path, `#!/bin/sh\nset -eu\n${body}\n`, { mode: 0o700 });
}
function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
function writeKnownHosts(h, lines, mode = 0o600) {
  writeFileSync(h.knownHosts, lines.join("\n") + "\n", { mode });
  chmodSync(h.knownHosts, mode);
}
function writeStatFixture(h, body) {
  executable(join(h.bin, "stat"), body);
}
function buildIncoming(h, migrationSql = "ALTER TABLE subscription ADD COLUMN settlement_version INTEGER;\n") {
  const incoming = join(h.appRoot, "incoming", `${RELEASE}.${process.pid}`);
  mkdirSync(join(incoming, "ENV"), { recursive: true });
  cpSync(join(ROOT, "packages/db/prisma/migrations"),
    join(incoming, "packages/db/prisma/migrations"), { recursive: true });
  mkdirSync(join(incoming, "packages/db/prisma/migrations/20991231000000_fixture"), { recursive: true });
  cpSync(join(ROOT, "ENV/compose.prod.yaml"), join(incoming, "ENV/compose.prod.yaml"));
  const deltaPath = "packages/db/prisma/migrations/20991231000000_fixture/migration.sql";
  writeFileSync(join(incoming, deltaPath), migrationSql);
  writeFileSync(join(incoming, "migration-delta.name-status"), `A\t${deltaPath}\n`);
  writeFileSync(join(incoming, "migration-delta.sha256"),
    `${sha256File(join(incoming, deltaPath))}  ${deltaPath}\n`);
  writeFileSync(join(incoming, "migration-delta.meta"), [
    `previousRelease=${PREVIOUS_RELEASE}`,
    `candidateRelease=${RELEASE}`,
    `api=${API}`,
    `ui=${UI}`,
    `discoverySha256=${sha256File(join(incoming, "migration-delta.name-status"))}`,
    `deltaSha256=${sha256File(join(incoming, "migration-delta.sha256"))}`,
    "",
  ].join("\n"));
  const files = [];
  const walk = (directory, prefix = "") => {
    for (const name of readdirSync(directory).sort()) {
      const absolute = join(directory, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      try { files.push(...walk(absolute, relative)); } catch { files.push(relative); }
    }
    return [];
  };
  walk(incoming);
  const manifestFiles = [...new Set(files)].filter((path) => path !== "release-inputs.sha256").sort();
  writeFileSync(join(incoming, "release-inputs.sha256"),
    manifestFiles.map((path) => `${sha256File(join(incoming, path))}  ${path}`).join("\n") + "\n");
  h.incoming = incoming;
  return incoming;
}
function remoteEnvironment(h, overrides = {}) {
  return {
    ...process.env,
    PATH: `${h.bin}:/usr/bin:/bin`,
    DEPLOY_HERMETIC_TEST: "1",
    FAKE_CALL_LOG: h.log,
    FAKE_STATE_ROOT: h.state,
    FAKE_GIT_SOURCE_ROOT: ROOT,
    FAKE_APP_ROOT: h.appRoot,
    PREVIOUS_RELEASE_COMMIT: PREVIOUS_RELEASE,
    RELEASE_COMMIT: RELEASE,
    API_IMAGE_REF: API,
    UI_IMAGE_REF: UI,
    PREVIOUS_API_REF: PREVIOUS_API,
    PREVIOUS_UI_REF: PREVIOUS_UI,
    HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", NO_PROXY: "*", no_proxy: "*",
    ...overrides,
  };
}
// Historical deployment acceptance must stage the exact reviewed migration
// snapshot, not every migration later added to the current source checkout.
function useReviewedMigrationSnapshot(h) {
  const snapshot = join(h.root, "reviewed-source");
  const listed = spawnSync("git", ["-C", ROOT, "ls-tree", "-r", "--name-only", REAL_MIGRATION_CANDIDATE,
    "packages/db/prisma/migrations"], { encoding: "utf8" });
  assert.equal(listed.status, 0, listed.stderr);
  const paths = listed.stdout.trim().split("\n").filter((path) => path.endsWith("/migration.sql"));
  assert.equal(paths.length, 48);
  for (const path of paths) {
    const blob = spawnSync("git", ["-C", ROOT, "show", `${REAL_MIGRATION_CANDIDATE}:${path}`]);
    assert.equal(blob.status, 0, blob.stderr.toString());
    mkdirSync(dirname(join(snapshot, path)), { recursive: true });
    writeFileSync(join(snapshot, path), blob.stdout);
  }
  mkdirSync(join(snapshot, "ENV"), { recursive: true });
  cpSync(join(ROOT, "ENV/compose.prod.yaml"), join(snapshot, "ENV/compose.prod.yaml"));
  h.sourceRoot = snapshot;
}

function runDeploy(h, overrides = {}) {
  const result = spawnSync("bash", [SCRIPT], {
    cwd: h.sourceRoot ?? ROOT,
    encoding: "utf8",
    env: {
      ...remoteEnvironment(h, overrides),
      DEPLOY_HOST: "deploy.example.test",
      DEPLOY_PORT: "22",
      DEPLOY_USER: "deploy",
      SSH_IDENTITY_FILE: h.key,
      SSH_KNOWN_HOSTS_FILE: h.knownHosts,
      SSH_HOST_KEY_SHA256: FINGERPRINT_A,
      RELEASE_COMMIT: RELEASE,
      API_IMAGE_REF: API,
      UI_IMAGE_REF: UI,
      REMOTE_APP_ROOT: "/opt/braavolabs",
      FAKE_APP_ROOT: h.appRoot,
      ...overrides,
    },
  });
  return { ...result, calls: readFileSync(h.log, "utf8") };
}
function runRemote(h, overrides = {}) {
  const incoming = buildIncoming(h, overrides.MIGRATION_SQL);
  const result = spawnSync("bash", [SCRIPT, "--remote", RELEASE, API, UI, h.appRoot, incoming], {
    cwd: ROOT, encoding: "utf8", env: remoteEnvironment(h, overrides),
  });
  return {
    ...result,
    calls: readFileSync(h.log, "utf8"),
    network: readFileSync(join(h.state, "network-attempts.jsonl"), "utf8")
      .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)),
  };
}
function readCurrentRecord(h) {
  return JSON.parse(readFileSync(join(h.appRoot, "releases", RELEASE, "release.json"), "utf8"));
}
function readTransitions(h) {
  const directory = join(h.appRoot, "releases", RELEASE, "transitions");
  if (!existsSync(directory)) return [];
  return readdirSync(directory).sort().map((name) =>
    JSON.parse(readFileSync(join(directory, name), "utf8")));
}
function readCurrentTransition(h) {
  if (!existsSync(join(h.appRoot, "releases", RELEASE, "release.json"))) return null;
  const record = readCurrentRecord(h);
  return `${record.state}:${record.result}`;
}
function assertNoExternalNetwork(h) {
  const attempts = readFileSync(join(h.state, "network-attempts.jsonl"), "utf8")
    .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(attempts.every((entry) => entry.policy === "fixture"), true, JSON.stringify(attempts));
  assert.equal(attempts.every((entry) => entry.socketOpened === false), true, JSON.stringify(attempts));
}
function seedSuccessfulJournal(h, { updatePreviousGood = true } = {}) {
  const incoming = buildIncoming(h);
  const manifestHash = sha256File(join(incoming, "release-inputs.sha256"));
  const deltaHash = sha256File(join(incoming, "migration-delta.sha256"));
  const releaseRoot = join(h.appRoot, "releases", RELEASE);
  mkdirSync(join(releaseRoot, "transitions"), { recursive: true });
  writeFileSync(join(releaseRoot, "compose.digest-override.yaml"), "services: {}\n");
  cpSync(join(h.appRoot, "releases/previous-good.json"),
    join(releaseRoot, "previous-good.before.json"));
  writeFileSync(join(releaseRoot, "release.json"), JSON.stringify({
    release: RELEASE,
    tuple: `${RELEASE}|${API}|${UI}|${manifestHash}|${deltaHash}`,
    api: API,
    ui: UI,
    previousApi: PREVIOUS_API,
    previousUi: PREVIOUS_UI,
    state: "COMMIT_RELEASE",
    result: "success",
  }) + "\n");
  writeFileSync(join(h.state, "active-compose-release"), RELEASE);
  if (updatePreviousGood) {
    writeFileSync(join(h.appRoot, "releases/previous-good.json"), JSON.stringify({
      release: RELEASE, previousRelease: PREVIOUS_RELEASE,
      tuple: `${RELEASE}|${API}|${UI}|${manifestHash}|${deltaHash}`,
      api: API, ui: UI, migrationDeltaSha256: deltaHash,
      result: "success",
    }) + "\n");
  }
}
function seedCommitRestartState(h, {
  state = "COMMIT_RELEASE",
  result = "pending",
  durable = "old",
} = {}) {
  const incoming = buildIncoming(h);
  const manifestHash = sha256File(join(incoming, "release-inputs.sha256"));
  const deltaHash = sha256File(join(incoming, "migration-delta.sha256"));
  const tuple = `${RELEASE}|${API}|${UI}|${manifestHash}|${deltaHash}`;
  const releaseRoot = join(h.appRoot, "releases", RELEASE);
  mkdirSync(join(releaseRoot, "transitions"), { recursive: true });
  writeFileSync(join(releaseRoot, "compose.digest-override.yaml"), "services: {}\n");
  cpSync(join(h.appRoot, "releases/previous-good.json"),
    join(releaseRoot, "previous-good.before.json"));
  writeFileSync(join(releaseRoot, "release.json"), JSON.stringify({
    release: RELEASE, tuple, api: API, ui: UI,
    previousApi: PREVIOUS_API, previousUi: PREVIOUS_UI,
    state, result,
  }) + "\n");
  const durablePath = join(h.appRoot, "releases/previous-good.json");
  if (durable === "candidate") {
    writeFileSync(durablePath, JSON.stringify({
      release: RELEASE, previousRelease: PREVIOUS_RELEASE, tuple,
      api: API, ui: UI, migrationDeltaSha256: deltaHash, result: "success",
    }) + "\n");
  } else if (durable === "missing") {
    rmSync(durablePath);
  } else if (durable === "mismatch") {
    writeFileSync(durablePath, JSON.stringify({
      release: RELEASE, previousRelease: PREVIOUS_RELEASE, tuple: "wrong-tuple",
      api: API, ui: UI, migrationDeltaSha256: deltaHash, result: "success",
    }) + "\n");
  }
  writeFileSync(join(h.state, "active-api"), API);
  writeFileSync(join(h.state, "active-ui"), UI);
  writeFileSync(join(h.state, "active-compose-release"), RELEASE);
  return tuple;
}
function primitive(h, name, body) {
  executable(join(h.bin, name), `printf '%s\\n' "${name} $*" >> "$FAKE_CALL_LOG"\n${body}`);
}

function seedComposeIdentity(h, {
  release = PREVIOUS_RELEASE,
  state = "COMMIT_RELEASE",
  result = "success",
  api = PREVIOUS_API,
  ui = PREVIOUS_UI,
  previousApi = PREVIOUS_API,
  previousUi = PREVIOUS_UI,
} = {}) {
  const releaseRoot = join(h.appRoot, "releases", release);
  mkdirSync(join(releaseRoot, "input/ENV"), { recursive: true });
  writeFileSync(join(releaseRoot, "input/ENV/compose.prod.yaml"), "services: {}\n");
  writeFileSync(join(releaseRoot, "compose.digest-override.yaml"), "services: {}\n");
  writeFileSync(join(releaseRoot, "release.json"), JSON.stringify({
    release, state, result, api, ui, previousApi, previousUi,
  }) + "\n");
  writeFileSync(join(h.state, "active-compose-release"), release);
  return releaseRoot;
}

function makeHarness() {
  const root = mkdtempSync(join(tmpdir(), "braavo-deploy-test-"));
  const h = {
    root,
    bin: join(root, "bin"),
    state: join(root, "state"),
    appRoot: join(root, "opt/braavolabs"),
    log: join(root, "calls.log"),
    key: join(root, "identity"),
    knownHosts: join(root, "known_hosts"),
  };
  mkdirSync(h.bin, { recursive: true });
  mkdirSync(h.state, { recursive: true });
  mkdirSync(join(h.appRoot, "app"), { recursive: true });
  mkdirSync(join(h.appRoot, "incoming"), { recursive: true });
  mkdirSync(join(h.appRoot, "releases"), { recursive: true });
  writeFileSync(h.log, "");
  writeFileSync(join(h.state, "network-attempts.jsonl"), "");
  writeFileSync(join(h.state, "active-api"), PREVIOUS_API);
  writeFileSync(join(h.state, "active-ui"), PREVIOUS_UI);
  writeFileSync(join(h.state, "migrate-count"), "0");
  writeFileSync(join(h.state, "cutover-count"), "0");
  writeFileSync(join(h.appRoot, "app/.env"), "MIGRATE_DATABASE_URL=postgresql://hermetic\n");
  writeFileSync(join(h.appRoot, "releases/previous-good.json"), JSON.stringify({
    release: PREVIOUS_RELEASE, previousRelease: PREVIOUS_RELEASE,
    tuple: "previous-tuple", api: PREVIOUS_API, ui: PREVIOUS_UI,
    migrationDeltaSha256: "e".repeat(64), result: "success",
  }) + "\n");
  seedComposeIdentity(h);
  writeFileSync(h.key, "synthetic-key\n", { mode: 0o600 });
  writeKnownHosts(h, [`deploy.example.test ssh-ed25519 ${KEY_A}`]);

  primitive(h, "flock", `[ "${'${FAIL_PRIMITIVE:-}'}" = flock ] && exit 1; exit 0`);
  // Readiness uses the real bounded loop with injectable command primitives;
  // only explicit signal-test pauses sleep in wall-clock time.
  primitive(h, "sleep", `[ "$1" = 30 ] && exec /bin/sleep "$@"; exit 0`);
  primitive(h, "timeout", `test "$1" = --signal=KILL; shift 2; exec "$@"`);
  primitive(h, "date", `printf '%s\\n' 2026-08-29T00:00:00Z`);
  primitive(h, "sync", `
[ "${'${PAUSE_AT:-}'}" = journal-finalize ] && case "${'${DEPLOY_WRITE_PHASE:-}'}" in commit-release-*) sleep 30 ;; esac
[ -n "${'${FAIL_WRITE_PHASE:-}'}" ] && [ "${'${FAIL_WRITE_PHASE:-}'}" = "${'${DEPLOY_WRITE_PHASE:-}'}" ] && exit 1
exit 0`);
  primitive(h, "sha256sum", `
if [ "${'${1:-}'}" = -c ]; then shift; exec /usr/bin/shasum -a 256 -c "$@"; fi
exec /usr/bin/shasum -a 256 "$@"`);
  for (const [tool, real] of [["cp", "/bin/cp"], ["mv", "/bin/mv"], ["rm", "/bin/rm"]]) {
    primitive(h, tool, `
[ -n "${'${FAIL_WRITE_PHASE:-}'}" ] && [ "${'${FAIL_WRITE_PHASE:-}'}" = "${'${DEPLOY_WRITE_PHASE:-}'}" ] && exit 1
${real} "$@"
if [ "${tool}" = cp ] && [ -n "${'${FAKE_STAGE_MUTATION_MODE:-}'}" ]; then
  target=''; for arg in "$@"; do target="$arg"; done
  case " $* " in
    *' packages/db/prisma/migrations '*)
      enum="$target/20260820000000_subscription_plan_enum_values/migration.sql"
      projection="$target/20260821_subscription_only_plans/migration.sql"
      case "$FAKE_STAGE_MUTATION_MODE" in
        hash) printf '%s\n' '-- tampered bytes' >> "$enum" ;;
        enum-label) /usr/bin/perl -0pi -e "s/'INDIVIDUAL'/'PERSONAL'/" "$enum" ;;
        mapping) /usr/bin/perl -0pi -e "s/WHEN 'CREATOR' THEN 'INDIVIDUAL'/WHEN 'CREATOR' THEN 'TEAM'/" "$projection" ;;
        default) /usr/bin/perl -0pi -e "s/SET DEFAULT 'MANUAL_REVIEW'/SET DEFAULT 'INDIVIDUAL'/" "$projection" ;;
        extra-statement) printf '%s\n' 'CREATE TABLE IF NOT EXISTS reviewed_looking_extra (id TEXT);' >> "$projection" ;;
        iap-delivery-hash) printf '%s\n' '-- tampered IAP delivery bytes' >> "$target/20260825233000_iap_delivery_dlq/migration.sql" ;;
        google-alias-hash) printf '%s\n' '-- tampered Google alias bytes' >> "$target/20260828_google_purchase_alias_ownership/migration.sql" ;;
        third-migration)
          /bin/mkdir -p "$target/20260820000001_unreviewed"
          printf '%s\n' 'ALTER TABLE tenants ADD COLUMN unreviewed TEXT;' > "$target/20260820000001_unreviewed/migration.sql" ;;
        unmanifested)
          other=$(find "$target" -type f -name migration.sql \
            ! -path "*/20260820000000_subscription_plan_enum_values/*" \
            ! -path "*/20260821_subscription_only_plans/*" | head -1)
          test -n "$other"; printf '%s\n' '-- unmanifested tamper' >> "$other" ;;
        *) exit 98 ;;
      esac ;;
  esac
fi
exit 0`);
  }
  primitive(h, "curl", `
url=''; for arg in "$@"; do case "$arg" in http://*|https://*) url="$arg" ;; esac; done
case "$url" in
  https://api.braavolabs.com/health|https://braavolabs.com/|https://www.braavolabs.com/|https://app.braavolabs.com/login)
    printf '{"primitive":"curl","url":"%s","policy":"fixture","socketOpened":false}\n' "$url" >> "$FAKE_STATE_ROOT/network-attempts.jsonl" ;;
  *)
    printf '{"primitive":"curl","url":"%s","policy":"denied","socketOpened":false}\n' "$url" >> "$FAKE_STATE_ROOT/network-attempts.jsonl"
    exit 97 ;;
esac
api=$(cat "$FAKE_STATE_ROOT/active-api")
[ "${'${PAUSE_AT:-}'}" = target-health ] && [ "$api" = "$API_IMAGE_REF" ] && sleep 30
if [ "$api" = "$API_IMAGE_REF" ] && [ "${'${FAIL_TARGET_HEALTH:-0}'}" = 1 ]; then exit 22; fi
if [ "$api" = "$PREVIOUS_API_REF" ] && [ "${'${FAIL_ROLLBACK_HEALTH:-0}'}" = 1 ]; then exit 22; fi
phase=ROLLBACK; [ "$api" = "$API_IMAGE_REF" ] && phase=TARGET
case "$url" in
  https://api.braavolabs.com/health) endpoint=API ;;
  https://app.braavolabs.com/login) endpoint=APP ;;
  *) endpoint=WWW ;;
esac
case "$phase:$endpoint" in
  TARGET:API) status="${'${FAKE_TARGET_HTTP_API:-200}'}" ;;
  TARGET:APP) status="${'${FAKE_TARGET_HTTP_APP:-200}'}" ;;
  TARGET:WWW) status="${'${FAKE_TARGET_HTTP_WWW:-200}'}" ;;
  ROLLBACK:API) status="${'${FAKE_ROLLBACK_HTTP_API:-200}'}" ;;
  ROLLBACK:APP) status="${'${FAKE_ROLLBACK_HTTP_APP:-200}'}" ;;
  ROLLBACK:WWW) status="${'${FAKE_ROLLBACK_HTTP_WWW:-200}'}" ;;
esac
[ "$status" = error ] && { printf 200; exit 7; }
case " $* " in *' --write-out '*) printf '%s' "$status" ;; esac
case "$status" in 4*|5*) exit 22 ;; esac
exit 0`);
  primitive(h, "docker", `
api=$(cat "$FAKE_STATE_ROOT/active-api"); ui=$(cat "$FAKE_STATE_ROOT/active-ui")
container=''; for arg in "$@"; do container="$arg"; done
identity_value() {
  expected="$1"; mismatch_name="$2"
  if [ "${'${FAKE_COMPOSE_IDENTITY_MISMATCH_CONTAINER:-}'}" = "$container" ]; then
    eval "value=\${$mismatch_name:-mismatch}"
    printf '%s\n' "$value"
  else
    printf '%s\n' "$expected"
  fi
}
case "$*" in
  *'com.docker.compose.project.config_files'*)
    rid=$(cat "$FAKE_STATE_ROOT/active-compose-release"); root="$FAKE_APP_ROOT/releases/$rid"
    if [ "$container" = aicos-postgres ] || [ "$container" = aicos-redis ]; then
      value="$FAKE_APP_ROOT/app/ENV/compose.prod.yaml"
    else
      case "${'${FAKE_COMPOSE_IDENTITY_MUTATION:-}'}" in
        canonical-mix) value="$FAKE_APP_ROOT/app/ENV/compose.prod.yaml,$root/compose.digest-override.yaml" ;;
        extra-config) value="$root/input/ENV/compose.prod.yaml,$root/compose.digest-override.yaml,/tmp/extra.yaml" ;;
        traversal) value="$FAKE_APP_ROOT/releases/$rid/../$rid/input/ENV/compose.prod.yaml,$root/compose.digest-override.yaml" ;;
        mismatched-release)
          if [ "$container" = aicos-ui ]; then other='3333333333333333333333333333333333333333'; value="$FAKE_APP_ROOT/releases/$other/input/ENV/compose.prod.yaml,$FAKE_APP_ROOT/releases/$other/compose.digest-override.yaml"
          else value="$root/input/ENV/compose.prod.yaml,$root/compose.digest-override.yaml"; fi ;;
        *) value="$root/input/ENV/compose.prod.yaml,$root/compose.digest-override.yaml" ;;
      esac
    fi
    identity_value "$value" FAKE_COMPOSE_CONFIG; exit 0 ;;
  *'com.docker.compose.project.working_dir'*)
    rid=$(cat "$FAKE_STATE_ROOT/active-compose-release")
    if [ "$container" = aicos-postgres ] || [ "$container" = aicos-redis ]; then value="$FAKE_APP_ROOT/app/ENV"
    else value="$FAKE_APP_ROOT/releases/$rid/input/ENV"; fi
    [ "${'${FAKE_COMPOSE_IDENTITY_MUTATION:-}'}" = work-mismatch ] && value="$FAKE_APP_ROOT/releases/$rid/input"
    identity_value "$value" FAKE_COMPOSE_WORKING_DIR; exit 0 ;;
  *'com.docker.compose.project'*)
    value=env; [ "${'${FAKE_COMPOSE_IDENTITY_MUTATION:-}'}" = project-mismatch ] && value=wrong
    identity_value "$value" FAKE_COMPOSE_PROJECT; exit 0 ;;
  *'com.docker.compose.service'*)
    case "$container" in aicos-api) service=api ;; aicos-ui) service=ui ;; aicos-postgres) service=postgres ;; aicos-redis) service=redis ;; *) service=unknown ;; esac
    [ "${'${FAKE_COMPOSE_IDENTITY_MUTATION:-}'}" = service-mismatch ] && service=wrong
    identity_value "$service" FAKE_COMPOSE_SERVICE; exit 0 ;;
  *'NetworkSettings.Networks'*)
    value=present; [ "${'${FAKE_COMPOSE_IDENTITY_MUTATION:-}'}" = network-mismatch ] && value=''
    identity_value "$value" FAKE_COMPOSE_NETWORK; exit 0 ;;
  *'pull '*) [ "${'${PAUSE_AT:-}'}" = pull ] && sleep 30; [ "${'${FAIL_PRIMITIVE:-}'}" = pull ] && exit 1; exit 0 ;;
  *'image inspect'*"$API_IMAGE_REF"*) printf '%s\\n' "$API_IMAGE_REF"; exit 0 ;;
  *'image inspect'*"$UI_IMAGE_REF"*) printf '%s\\n' "$UI_IMAGE_REF"; exit 0 ;;
  *'image inspect'*"$PREVIOUS_API_REF"*) [ "${'${PREVIOUS_IMAGES_MISSING:-0}'}" = 1 ] && exit 1; printf '%s\\n' "$PREVIOUS_API_REF"; exit 0 ;;
  *'image inspect'*"$PREVIOUS_UI_REF"*) [ "${'${PREVIOUS_IMAGES_MISSING:-0}'}" = 1 ] && exit 1; printf '%s\\n' "$PREVIOUS_UI_REF"; exit 0 ;;
  *'inspect --format {{.Image}}'*aicos-api*) printf '%s\\n' api-active; exit 0 ;;
  *'inspect --format {{.Image}}'*aicos-ui*) printf '%s\\n' ui-active; exit 0 ;;
  *'image inspect'*api-active*) printf '%s\\n' "$api"; exit 0 ;;
  *'image inspect'*ui-active*) printf '%s\\n' "$ui"; exit 0 ;;
  *'inspect --format {{.Id}}'*aicos-api*) printf api-container; exit 0 ;;
  *'inspect --format {{.Id}}'*aicos-ui*) printf ui-container; exit 0 ;;
  *'State.Health'*aicos-*)
    phase=ROLLBACK; [ "$api" = "$API_IMAGE_REF" ] && phase=TARGET
    service=UI; [ "$container" = aicos-api ] && service=API
    case "$phase:$service" in
      TARGET:API) health="${'${FAKE_TARGET_API_HEALTH:-healthy}'}" ;;
      TARGET:UI) health="${'${FAKE_TARGET_UI_HEALTH:-healthy}'}" ;;
      ROLLBACK:API) health="${'${FAKE_ROLLBACK_API_HEALTH:-healthy}'}" ;;
      ROLLBACK:UI) health="${'${FAKE_ROLLBACK_UI_HEALTH:-healthy}'}" ;;
    esac
    counter="$FAKE_STATE_ROOT/$phase-$service-health-count"
    count=0; [ ! -f "$counter" ] || count=$(cat "$counter")
    count=$((count + 1)); printf '%s' "$count" > "$counter"
    if [ "$container" = aicos-ui ] && [ "${'${FAKE_REQUIRE_TRUSTED_UI_PROBE:-0}'}" = 1 ]; then
      [ "$(cat "$FAKE_STATE_ROOT/applied-ui-probe")" = trusted ] || health=unhealthy
    fi
    case "$health" in
      starting-once) [ "$count" = 1 ] && health=starting || health=healthy ;;
      starting-20) [ "$count" -le 20 ] && health=starting || health=healthy ;;
      empty) exit 0 ;;
      error) printf true:healthy; exit 1 ;;
      timeout) exit 124 ;;
      stopped) printf false:healthy; exit 0 ;;
    esac
    printf 'true:%s' "$health"; exit 0 ;;
  *'inspect --format {{.State.Running}}'*)
    phase=ROLLBACK; [ "$api" = "$API_IMAGE_REF" ] && phase=TARGET
    if [ "$phase" = TARGET ]; then running="${'${FAKE_TARGET_BACKUP_RUNNING:-true}'}"
    else running="${'${FAKE_ROLLBACK_BACKUP_RUNNING:-true}'}"; fi
    [ "$running" = error ] && { printf true; exit 1; }
    [ "$running" = empty ] || printf '%s' "$running"
    exit 0 ;;
  *'compose'*'run --rm --no-deps api'*)
    count=$(( $(cat "$FAKE_STATE_ROOT/migrate-count") + 1 )); printf '%s' "$count" > "$FAKE_STATE_ROOT/migrate-count"
    [ "${'${FAIL_MIGRATION_LEDGER:-0}'}" = 1 ] && exit 1
    [ "${'${FAIL_PRIMITIVE:-}'}" = migrate ] && exit 1
    exit 0 ;;
  *'compose'*'up -d --no-deps api ui'*)
    override=''; compose_file=''; previous=''
    for arg in "$@"; do
      if [ "$previous" = -f ]; then
        [ -n "$compose_file" ] || compose_file="$arg"
        override="$arg"; previous=''
      else previous="$arg"; fi
    done
    test -n "$override" && test -f "$override"
    if grep -q -- '--header=Host:www.braavolabs.com' "$compose_file"; then probe=trusted; else probe=untrusted; fi
    printf '%s' "$probe" > "$FAKE_STATE_ROOT/applied-ui-probe"
    next_api=$(awk '$1=="image:" && index($2,"/api@sha256:") {print $2}' "$override")
    next_ui=$(awk '$1=="image:" && index($2,"/ui@sha256:") {print $2}' "$override")
    test -n "$next_api" && test -n "$next_ui"
    count=$(( $(cat "$FAKE_STATE_ROOT/cutover-count") + 1 )); printf '%s' "$count" > "$FAKE_STATE_ROOT/cutover-count"
    if [ "${'${FAIL_INITIAL_CUTOVER:-0}'}" = 1 ] && [ "$count" = 1 ]; then exit 1; fi
    if [ "${'${FAIL_PARTIAL_CUTOVER:-0}'}" = 1 ] && [ "$count" = 1 ]; then
      printf '%s' "$next_api" > "$FAKE_STATE_ROOT/active-api"; exit 1
    fi
    if [ "${'${FAIL_PARTIAL_UI_CUTOVER:-0}'}" = 1 ] && [ "$count" = 1 ]; then
      printf '%s' "$next_ui" > "$FAKE_STATE_ROOT/active-ui"; exit 1
    fi
    [ "${'${FAKE_DIGEST_MISMATCH:-}'}" = api ] && next_api="$PREVIOUS_API_REF"
    printf '%s' "$next_api" > "$FAKE_STATE_ROOT/active-api"
    printf '%s' "$next_ui" > "$FAKE_STATE_ROOT/active-ui"
    basename "$(dirname "$override")" > "$FAKE_STATE_ROOT/active-compose-release"
    exit 0 ;;
  *'compose'*'postgres-backup'*) [ "${'${PAUSE_AT:-}'}" = backup ] && sleep 30; [ "${'${FAIL_PRIMITIVE:-}'}" = backup ] && exit 1; exit 0 ;;
  *) exit 0 ;;
esac`);
  primitive(h, "ssh-keygen", `
if [ "${'${FAKE_SSH_KEYGEN_OUTPUT+x}'}" = x ]; then
  printf '%b' "$FAKE_SSH_KEYGEN_OUTPUT"
  exit "${'${FAKE_SSH_KEYGEN_EXIT:-0}'}"
fi
data=$(awk '{print $2}' | tail -1)
case "$data" in ${KEY_A}) fp='${FINGERPRINT_A}' ;; ${KEY_B}) fp='${FINGERPRINT_B}' ;; *) exit 1 ;; esac
printf '256 %s no comment (ED25519)\\n' "$fp"`);
  primitive(h, "git", `
case "${'${1:-}'}" in
  cat-file) exit 0 ;;
  diff)
    [ "${'${USE_REAL_GIT_DIFF:-0}'}" = 1 ] && exec /usr/bin/git -C "$FAKE_GIT_SOURCE_ROOT" "$@"
    printf '%b' "${'${FAKE_GIT_DIFF:-}'}"
    [ "${'${FAKE_GIT_DIFF_IO_FAILURE:-0}'}" = 1 ] && exit 74
    exit "${'${FAKE_GIT_DIFF_EXIT:-0}'}" ;;
  *) exec /usr/bin/git "$@" ;;
esac`);
  primitive(h, "ssh", `
case " $* " in
  *' deploy@deploy.example.test '*)
    printf '{"primitive":"ssh","destination":"deploy@deploy.example.test","policy":"fixture","socketOpened":false}\\n' >> "$FAKE_STATE_ROOT/network-attempts.jsonl" ;;
  *)
    printf '{"primitive":"ssh","destination":"denied","policy":"denied","socketOpened":false}\\n' >> "$FAKE_STATE_ROOT/network-attempts.jsonl"; exit 97 ;;
esac
printf '%s\\n' ssh >> "$FAKE_STATE_ROOT/transport"
case "$*" in
  *' true') exit 0 ;;
  *'sudo cat /opt/braavolabs/releases/previous-good.json'*)
    exec /bin/cat "$FAKE_APP_ROOT/releases/previous-good.json" ;;
  *'sudo install -d'*) /bin/mkdir -p "$FAKE_APP_ROOT/incoming"; exit 0 ;;
  *'sudo bash -s -- --remote'*)
    script="$FAKE_STATE_ROOT/remote-script"; /bin/cat > "$script"; chmod 700 "$script"
    while [ "$#" -gt 0 ] && [ "$1" != --remote ]; do shift; done
    release="$2"; api="$3"; ui="$4"; remote_incoming="$6"
    mapped="$FAKE_APP_ROOT/incoming/$(basename "$remote_incoming")"
    exec /bin/bash "$script" --remote "$release" "$api" "$ui" "$FAKE_APP_ROOT" "$mapped" ;;
  *) exit 66 ;;
esac`);
  primitive(h, "rsync", `
case " $* " in
  *' deploy@deploy.example.test:/opt/braavolabs/incoming/'*)
    printf '{"primitive":"rsync","destination":"deploy@deploy.example.test","policy":"fixture","socketOpened":false}\\n' >> "$FAKE_STATE_ROOT/network-attempts.jsonl" ;;
  *)
    printf '{"primitive":"rsync","destination":"denied","policy":"denied","socketOpened":false}\\n' >> "$FAKE_STATE_ROOT/network-attempts.jsonl"; exit 97 ;;
esac
printf '%s\\n' rsync >> "$FAKE_STATE_ROOT/transport"
source=''; destination=''
for arg in "$@"; do case "$arg" in *:/opt/braavolabs/incoming/*) destination="$arg" ;; */) source="$arg" ;; esac; done
test -n "$source" && test -n "$destination"
target="$FAKE_APP_ROOT/incoming/$(basename "${'${destination#*:}'}")"
/bin/mkdir -p "$target"; /bin/cp -R "$source"/. "$target"/`);
  return h;
}

function withHarness(fn) {
  const h = makeHarness();
  return Promise.resolve()
    .then(() => fn(h))
    .finally(() => rmSync(h.root, { recursive: true, force: true }));
}

function runHealth(h, overrides = {}, command = "verify_health") {
  const source = readFileSync(SCRIPT, "utf8");
  const entrypoint = source.lastIndexOf('\nif test "${1:-}" = --remote;');
  assert.ok(entrypoint > 0, "isolate function definitions, never run a deployment entrypoint");
  writeFileSync(join(h.state, "active-api"), API);
  writeFileSync(join(h.state, "active-ui"), UI);
  const result = spawnSync("bash", ["-c", `${source.slice(0, entrypoint)}\n${command}`], {
    cwd: ROOT, encoding: "utf8", env: remoteEnvironment(h, overrides), timeout: 10_000,
  });
  return { ...result, calls: readFileSync(h.log, "utf8") };
}

test("UI compose health probe retains loopback with a trusted public Host", () => {
  const compose = readFileSync(join(ROOT, "ENV/compose.prod.yaml"), "utf8");
  const ui = compose.slice(compose.indexOf("\n  ui:"), compose.indexOf("\n  otel-collector:"));
  assert.match(ui, /test: \["CMD", "wget", "-q", "--spider", "--header=Host:www\.braavolabs\.com", "http:\/\/127\.0\.0\.1:3000\/"\]/);
  assert.match(ui, /NODE_ENV: production/);
});

test("health readiness requires healthy API/UI and exact HTTPS 200 on all three surfaces", () => withHarness((h) => {
  const result = runHealth(h);
  assert.equal(result.status, 0, result.stderr);
  assert.equal((result.calls.match(/^timeout --signal=KILL 5 docker inspect/gm) ?? []).length, 3);
  for (const endpoint of ["https://api.braavolabs.com/health", "https://www.braavolabs.com/", "https://app.braavolabs.com/login"]) {
    const call = result.calls.split("\n").find((line) => line.startsWith("curl ") && line.endsWith(endpoint));
    assert.ok(call, endpoint);
    assert.match(call, /--proto =https/);
    assert.match(call, /--max-redirs 0/);
    assert.match(call, /--max-time 15/);
    assert.match(call, /--output \/dev\/null --write-out %\{http_code\}/);
    assert.doesNotMatch(call, /--location|--insecure| -L\b| -k\b/);
  }
  assert.doesNotMatch(result.calls, /https:\/\/braavolabs\.com\/|^sleep /m);
  assertNoExternalNetwork(h);
}));

for (const service of ["API", "UI"]) {
  for (const state of ["unhealthy", "missing", "empty", "stopped", "error", "timeout", "unknown"]) {
    test(`health readiness rejects ${service} ${state} despite a running process`, () => withHarness((h) => {
      const result = runHealth(h, { [`FAKE_TARGET_${service}_HEALTH`]: state });
      assert.equal(result.status, 1, result.stderr);
      assert.doesNotMatch(result.calls, /^curl |^sleep /m);
      assertNoExternalNetwork(h);
    }));
  }
  test(`health readiness polls ${service} starting then healthy without a blind startup sleep`, () => withHarness((h) => {
    const result = runHealth(h, { [`FAKE_TARGET_${service}_HEALTH`]: "starting-once" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal((result.calls.match(/^sleep 2$/gm) ?? []).length, 1);
    assert.equal(readFileSync(join(h.state, `TARGET-${service}-health-count`), "utf8"), "2");
    assert.ok(result.calls.indexOf("sleep 2") < result.calls.indexOf("curl "));
  }));
}

test("health readiness times out permanently starting containers after 30 bounded attempts", () => withHarness((h) => {
  const result = runHealth(h, { FAKE_TARGET_UI_HEALTH: "starting" });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(readFileSync(join(h.state, "TARGET-UI-health-count"), "utf8"), "30");
  assert.equal((result.calls.match(/^sleep 2$/gm) ?? []).length, 29);
  assert.doesNotMatch(result.calls, /^curl /m);
}));

test("health readiness accepts startup after twenty polling intervals (nominal 40 seconds)", () => withHarness((h) => {
  const result = runHealth(h, { FAKE_TARGET_API_HEALTH: "starting-20" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal((result.calls.match(/^sleep 2$/gm) ?? []).length, 20);
  assert.equal(readFileSync(join(h.state, "TARGET-API-health-count"), "utf8"), "21");
  assertNoExternalNetwork(h);
}));

test("health readiness deadline caps each command by the remaining fixed budget", () => withHarness((h) => {
  for (const [command, status, output] of [
    ['health_command_budget "$((SECONDS + 90))" 5', 0, "5"],
    ['health_command_budget "$((SECONDS + 2))" 15', 0, "2"],
    ['health_command_budget "$((SECONDS - 1))" 5', 1, ""],
  ]) {
    const result = runHealth(h, {}, command);
    assert.equal(result.status, status, result.stderr);
    assert.equal(result.stdout.trim(), output);
  }
  const exhausted = runHealth(h, {}, "health_command_budget() { return 1; }; verify_health");
  assert.equal(exhausted.status, 1, exhausted.stderr);
  assert.doesNotMatch(exhausted.calls, /^docker |^curl |^sleep /m);
}));

for (const running of ["false", "empty", "error"]) {
  test(`health readiness rejects backup running=${running}`, () => withHarness((h) => {
    const result = runHealth(h, { FAKE_TARGET_BACKUP_RUNNING: running });
    assert.equal(result.status, 1, result.stderr);
    assert.doesNotMatch(result.calls, /^curl /m);
  }));
}

for (const endpoint of ["API", "WWW", "APP"]) {
  for (const status of ["308", "500", "204", "error"]) {
    test(`health readiness rejects ${endpoint} HTTP ${status}`, () => withHarness((h) => {
      const result = runHealth(h, { [`FAKE_TARGET_HTTP_${endpoint}`]: status });
      assert.equal(result.status, 1, result.stderr);
      assertNoExternalNetwork(h);
    }));
  }
}

test("health rollback uses candidate compose trusted probe with previous image digests", () => withHarness((h) => {
  const result = runRemote(h, { FAKE_REQUIRE_TRUSTED_UI_PROBE: "1", FAKE_TARGET_HTTP_APP: "500" });
  assert.equal(result.status, 70, result.stderr);
  assert.equal(readFileSync(join(h.state, "active-api"), "utf8"), PREVIOUS_API);
  assert.equal(readFileSync(join(h.state, "active-ui"), "utf8"), PREVIOUS_UI);
  assert.equal(readFileSync(join(h.state, "applied-ui-probe"), "utf8"), "trusted");
  const expectedCompose = join(h.appRoot, "releases", RELEASE, "input/ENV/compose.prod.yaml");
  const cutovers = result.calls.split("\n").filter((line) => line.startsWith("docker compose ") && line.includes("up -d --no-deps api ui"));
  assert.equal(cutovers.length, 2);
  assert.ok(cutovers.every((line) => line.includes(`-f ${expectedCompose} -f `)));
  assert.equal(readCurrentTransition(h), "ROLLBACK_APPLICATION:restored");
  assertNoExternalNetwork(h);
}));

for (const [state, expected] of [["starting-once", 70], ["unhealthy", 71], ["missing", 71], ["starting", 71]]) {
  test(`health rollback ${state} is verified by the same readiness helper`, () => withHarness((h) => {
    const result = runRemote(h, { FAIL_TARGET_HEALTH: "1", FAKE_ROLLBACK_UI_HEALTH: state });
    assert.equal(result.status, expected, result.stderr);
    assert.equal(readCurrentTransition(h), `ROLLBACK_APPLICATION:${expected === 70 ? "restored" : "failed"}`);
    assertNoExternalNetwork(h);
  }));
}

test("cutover persists candidate digests and success journal", () => withHarness((h) => {
  const result = runRemote(h);
  assert.equal(result.status, 0);
  assert.match(result.calls, /docker compose -p env /);
  assert.doesNotMatch(result.calls, /docker compose -p braavolabs /);
  assert.equal(readFileSync(join(h.state, "active-api"), "utf8"), API);
  assert.equal(readFileSync(join(h.state, "active-ui"), "utf8"), UI);
  assert.equal(readCurrentRecord(h).result, "success");
  assertNoExternalNetwork(h);
}));

for (const [name, container, env] of [
  ["project", "aicos-api", { FAKE_COMPOSE_PROJECT: "braavolabs" }],
  ["service", "aicos-ui", { FAKE_COMPOSE_SERVICE: "api" }],
  ["config path", "aicos-postgres", { FAKE_COMPOSE_CONFIG: "/tmp/compose.prod.yaml" }],
  ["working directory", "aicos-redis", { FAKE_COMPOSE_WORKING_DIR: "/tmp" }],
  ["network", "aicos-api", { FAKE_COMPOSE_NETWORK: "" }],
]) test(`compose identity denies ${name} mismatch before migration and cutover`, () => withHarness((h) => {
  const result = runRemote(h, {
    FAKE_COMPOSE_IDENTITY_MISMATCH_CONTAINER: container,
    ...env,
  });
  assert.equal(result.status, 66, result.stderr);
  assert.equal(readFileSync(join(h.state, "migrate-count"), "utf8"), "0");
  assert.equal(readFileSync(join(h.state, "cutover-count"), "utf8"), "0");
  assert.doesNotMatch(result.calls, /docker compose .* run --rm --no-deps api|docker compose .* up -d/m);
  assertNoExternalNetwork(h);
}));

test("release-scoped identity accepts a proven restored rollback journal", () =>
  withHarness((h) => {
    seedComposeIdentity(h, {
      release: ROLLBACK_RELEASE,
      state: "ROLLBACK_APPLICATION",
      result: "restored",
      api: API,
      ui: UI,
    });
    const result = runRemote(h);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(h.state, "migrate-count"), "utf8"), "1");
    assert.equal(readFileSync(join(h.state, "cutover-count"), "utf8"), "1");
  }));

for (const mutation of [
  "canonical-mix",
  "extra-config",
  "traversal",
  "mismatched-release",
  "work-mismatch",
  "project-mismatch",
  "service-mismatch",
  "network-mismatch",
]) test(`compose identity denies ${mutation} before migration or cutover`, () =>
  withHarness((h) => {
    const result = runRemote(h, { FAKE_COMPOSE_IDENTITY_MUTATION: mutation });
    assert.equal(result.status, 66, result.stderr);
    assert.equal(readFileSync(join(h.state, "migrate-count"), "utf8"), "0");
    assert.equal(readFileSync(join(h.state, "cutover-count"), "utf8"), "0");
    assert.doesNotMatch(result.calls, /migrate deploy|up -d --no-deps api ui|curl /);
  }));

for (const [name, mutate] of [
  ["absent journal", (h, root) => rmSync(join(root, "release.json"))],
  ["mismatched journal release", (h, root) => {
    const path = join(root, "release.json");
    const journal = JSON.parse(readFileSync(path, "utf8"));
    journal.release = ROLLBACK_RELEASE;
    writeFileSync(path, JSON.stringify(journal) + "\n");
  }],
  ["untrusted journal state", (h, root) => {
    const path = join(root, "release.json");
    const journal = JSON.parse(readFileSync(path, "utf8"));
    journal.state = "CUTOVER";
    writeFileSync(path, JSON.stringify(journal) + "\n");
  }],
  ["mismatched journal digest", (h, root) => {
    const path = join(root, "release.json");
    const journal = JSON.parse(readFileSync(path, "utf8"));
    journal.api = API;
    writeFileSync(path, JSON.stringify(journal) + "\n");
  }],
  ["symlinked override escape", (h, root) => {
    const escape = join(h.root, "escape.override.yaml");
    writeFileSync(escape, "services: {}\n");
    rmSync(join(root, "compose.digest-override.yaml"));
    symlinkSync(escape, join(root, "compose.digest-override.yaml"));
  }],
  ["symlinked compose-file escape", (h, root) => {
    const escape = join(h.root, "escape.compose.yaml");
    writeFileSync(escape, "services: {}\n");
    rmSync(join(root, "input/ENV/compose.prod.yaml"));
    symlinkSync(escape, join(root, "input/ENV/compose.prod.yaml"));
  }],
]) test(`compose identity denies ${name} before migration or cutover`, () =>
  withHarness((h) => {
    const root = join(h.appRoot, "releases", PREVIOUS_RELEASE);
    mutate(h, root);
    const result = runRemote(h);
    assert.equal(result.status, 66, result.stderr);
    assert.equal(readFileSync(join(h.state, "migrate-count"), "utf8"), "0");
    assert.equal(readFileSync(join(h.state, "cutover-count"), "utf8"), "0");
    assert.doesNotMatch(result.calls, /migrate deploy|up -d --no-deps api ui|curl /);
  }));

test("candidate identity denies an active API outside its journal digest pair", () =>
  withHarness((h) => {
    seedCommitRestartState(h, { state: "CUTOVER", result: "pending" });
    writeFileSync(join(h.state, "active-api"),
      `ghcr.io/kocakkmustafa/braavolabs/api@sha256:${"f".repeat(64)}`);
    const result = runRemote(h);
    assert.equal(result.status, 66, result.stderr);
    assert.equal(readFileSync(join(h.state, "migrate-count"), "utf8"), "0");
    assert.equal(readFileSync(join(h.state, "cutover-count"), "utf8"), "0");
    assert.doesNotMatch(result.calls, /migrate deploy|up -d --no-deps api ui|curl /);
  }));

test("candidate identity denies an impossible durable transition result", () =>
  withHarness((h) => {
    seedCommitRestartState(h, { state: "CUTOVER", result: "success" });
    const result = runRemote(h);
    assert.equal(result.status, 66, result.stderr);
    assert.equal(readFileSync(join(h.state, "migrate-count"), "utf8"), "0");
    assert.equal(readFileSync(join(h.state, "cutover-count"), "utf8"), "0");
    assert.doesNotMatch(result.calls, /migrate deploy|up -d --no-deps api ui|curl /);
  }));

for (const [name, env, status] of [
  ["target health", { FAIL_TARGET_HEALTH: "1" }, 70],
  ["rollback health", { FAIL_TARGET_HEALTH: "1", FAIL_ROLLBACK_HEALTH: "1" }, 71],
  ["digest mismatch", { FAKE_DIGEST_MISMATCH: "api" }, 70],
]) test(`${name} derives rollback from real state`, () => withHarness((h) => {
  const result = runRemote(h, env);
  assert.equal(result.status, status);
  if (status === 70) {
    assert.equal(readFileSync(join(h.state, "active-api"), "utf8"), PREVIOUS_API);
    assert.equal(readFileSync(join(h.state, "active-ui"), "utf8"), PREVIOUS_UI);
  }
  assertNoExternalNetwork(h);
}));

test("default-deny network primitive records and rejects an unapproved destination", () =>
  withHarness((h) => {
    const result = spawnSync(join(h.bin, "curl"), ["https://provider.example.invalid/"], {
      encoding: "utf8", env: remoteEnvironment(h),
    });
    assert.equal(result.status, 97);
    const entry = JSON.parse(readFileSync(join(h.state, "network-attempts.jsonl"), "utf8").trim());
    assert.deepEqual(entry, {
      primitive: "curl", url: "https://provider.example.invalid/",
      policy: "denied", socketOpened: false,
    });
  }));

for (const [name, env, expectedStatus] of [
  ["initial cutover failure", { FAIL_INITIAL_CUTOVER: "1" }, 69],
  ["partial API cutover failure", { FAIL_PARTIAL_CUTOVER: "1" }, 69],
  ["partial UI cutover failure", { FAIL_PARTIAL_UI_CUTOVER: "1" }, 69],
  ["complete cutover then target-health failure", { FAIL_TARGET_HEALTH: "1" }, 70],
]) test(`${name} restores from the generated previous-digest override`, () =>
  withHarness((h) => {
    const result = runRemote(h, env);
    assert.equal(result.status, expectedStatus);
    assert.equal(readFileSync(join(h.state, "active-api"), "utf8"), PREVIOUS_API);
    assert.equal(readFileSync(join(h.state, "active-ui"), "utf8"), PREVIOUS_UI);
    assert.equal(readTransitions(h).some((entry) =>
      entry.state === "ROLLBACK_APPLICATION" && entry.result === "restored"), true);
    assertNoExternalNetwork(h);
  }));

for (const [state, seed] of [
  ["previous/previous", [PREVIOUS_API, PREVIOUS_UI]],
  ["candidate/previous", [API, PREVIOUS_UI]],
  ["previous/candidate", [PREVIOUS_API, UI]],
  ["candidate/candidate", [API, UI]],
]) test(`rollback override restores both digests from state ${state}`, () =>
  withHarness((h) => {
    writeFileSync(join(h.state, "active-api"), seed[0]);
    writeFileSync(join(h.state, "active-ui"), seed[1]);
    const override = join(h.root, "rollback.override.yaml");
    writeFileSync(override, `services:\n  api:\n    image: ${PREVIOUS_API}\n  ui:\n    image: ${PREVIOUS_UI}\n`);
    const result = spawnSync(join(h.bin, "docker"), [
      "compose", "-f", override, "up", "-d", "--no-deps", "api", "ui",
    ], { encoding: "utf8", env: remoteEnvironment(h) });
    assert.equal(result.status, 0);
    assert.equal(readFileSync(join(h.state, "active-api"), "utf8"), PREVIOUS_API);
    assert.equal(readFileSync(join(h.state, "active-ui"), "utf8"), PREVIOUS_UI);
  }));

for (const [state, seed] of [
  ["candidate API / previous UI", [API, PREVIOUS_UI]],
  ["previous API / candidate UI", [PREVIOUS_API, UI]],
  ["candidate API / candidate UI without success", [API, UI]],
]) test(`real remote restart restores durable previous-good from ${state}`, () =>
  withHarness((h) => {
    seedCommitRestartState(h, { state: "CUTOVER", result: "pending" });
    writeFileSync(join(h.state, "active-api"), seed[0]);
    writeFileSync(join(h.state, "active-ui"), seed[1]);
    const result = runRemote(h);
    assert.equal(result.status, 66);
    assert.equal(readFileSync(join(h.state, "active-api"), "utf8"), PREVIOUS_API);
    assert.equal(readFileSync(join(h.state, "active-ui"), "utf8"), PREVIOUS_UI);
  }));

test("real remote restart reports 71 when durable recovery health fails", () =>
  withHarness((h) => {
    seedCommitRestartState(h, { state: "CUTOVER", result: "pending" });
    writeFileSync(join(h.state, "active-api"), API);
    writeFileSync(join(h.state, "active-ui"), PREVIOUS_UI);
    const result = runRemote(h, { FAIL_ROLLBACK_HEALTH: "1" });
    assert.equal(result.status, 71);
  }));

test("resumed release rejects tampered staged bytes before migration health or rollback", () =>
  withHarness((h) => {
    assert.equal(runRemote(h).status, 0);
    const staged = join(h.appRoot, "releases", RELEASE, "input", "ENV", "compose.prod.yaml");
    writeFileSync(staged, "services:\n  api:\n    image: tampered\n");
    const before = readFileSync(h.log, "utf8").split("\n").length;
    const result = runRemote(h);
    assert.equal(result.status, 67);
    assert.doesNotMatch(result.calls.split("\n").slice(before).join("\n"),
      /migrate|curl|up -d|ROLLBACK_APPLICATION/);
  }));

for (const [name, gitDiff] of [
  ["deleted migration", "D\\tpackages/db/prisma/migrations/20200101000000_old/migration.sql\\n"],
  ["renamed migration", "R100\\tpackages/db/prisma/migrations/old/migration.sql\\tpackages/db/prisma/migrations/new/migration.sql\\n"],
]) test(`${name} fails locally before ssh staging`, () => withHarness((h) => {
  const result = runDeploy(h, { FAKE_GIT_DIFF: gitDiff });
  assert.equal(result.status, 68);
  assert.doesNotMatch(result.calls, /sudo install -d|rsync|--remote/);
}));

test("unmanifested staged migration fails exact membership before migration", () =>
  withHarness((h) => {
    const incoming = buildIncoming(h);
    writeFileSync(join(incoming, "packages/db/prisma/migrations/unmanifested.sql"), "SELECT 1;\n");
    const result = spawnSync("bash", [SCRIPT, "--remote", RELEASE, API, UI, h.appRoot, incoming], {
      cwd: ROOT, encoding: "utf8", env: remoteEnvironment(h),
    });
    assert.equal(result.status, 67);
    assert.doesNotMatch(readFileSync(h.log, "utf8"), /migrate|up -d/);
  }));

test("idempotent tuple proves candidate digests migration no-op and health", () => withHarness((h) => {
  seedSuccessfulJournal(h);
  writeFileSync(join(h.state, "active-api"), API);
  writeFileSync(join(h.state, "active-ui"), UI);
  const result = runRemote(h);
  assert.equal(result.status, 0);
  assert.equal(readFileSync(join(h.state, "migrate-count"), "utf8"), "1");
  assert.doesNotMatch(result.calls, /up -d --no-deps api ui/);
}));

test("backup-shaped unmanifested release input is still rejected on retry", () => withHarness((h) => {
  assert.equal(runRemote(h).status, 0);
  const backups = join(h.appRoot, "releases", RELEASE, "input", "ENV", "backups");
  mkdirSync(backups);
  writeFileSync(join(backups, "aicos_prod_probe.sql.gz"), "unmanifested fixture");
  const before = readFileSync(h.log, "utf8").split("\n").length;
  const result = runRemote(h);
  assert.equal(result.status, 67);
  assert.doesNotMatch(result.calls.split("\n").slice(before).join("\n"), /migrate|curl|up -d|ROLLBACK_APPLICATION/);
}));

test("mutable backup state outside input does not invalidate exact-tuple retry", () => withHarness((h) => {
  seedSuccessfulJournal(h);
  writeFileSync(join(h.state, "active-api"), API);
  writeFileSync(join(h.state, "active-ui"), UI);
  const outsideInput = join(h.state, "postgres_backup_data");
  mkdirSync(outsideInput);
  writeFileSync(join(outsideInput, "aicos_prod_fixture.sql.gz"), "external volume fixture");
  const result = runRemote(h);
  assert.equal(result.status, 0);
  assert.equal(readFileSync(join(outsideInput, "aicos_prod_fixture.sql.gz"), "utf8"), "external volume fixture");
  assert.doesNotMatch(result.calls, /up -d --no-deps api ui/);
}));

for (const [name, field, value] of [
  ["missing release", "release", undefined],
  ["mismatched release", "release", "f".repeat(40)],
  ["missing API digest", "api", undefined],
  ["mismatched API digest", "api", `ghcr.io/kocakkmustafa/braavolabs/api@sha256:${"f".repeat(64)}`],
  ["missing UI digest", "ui", undefined],
  ["mismatched UI digest", "ui", `ghcr.io/kocakkmustafa/braavolabs/ui@sha256:${"f".repeat(64)}`],
]) test(`idempotent success denies ${name} before downstream effects`, () => withHarness((h) => {
  seedSuccessfulJournal(h);
  writeFileSync(join(h.state, "active-api"), API);
  writeFileSync(join(h.state, "active-ui"), UI);
  const journalPath = join(h.appRoot, "releases", RELEASE, "release.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  if (value === undefined) delete journal[field]; else journal[field] = value;
  writeFileSync(journalPath, JSON.stringify(journal) + "\n");
  const durablePath = join(h.appRoot, "releases", "previous-good.json");
  const durableBefore = readFileSync(durablePath, "utf8");

  const result = runRemote(h);

  assert.equal(result.status, 66);
  assert.equal(readFileSync(join(h.state, "migrate-count"), "utf8"), "0");
  assert.equal(readFileSync(join(h.state, "cutover-count"), "utf8"), "0");
  assert.doesNotMatch(result.calls, /migrate deploy|curl |commit-release-success|COMMIT_RELEASE success/);
  assert.equal(readFileSync(durablePath, "utf8"), durableBefore);
  assert.equal(readFileSync(journalPath, "utf8"), JSON.stringify(journal) + "\n");
}));

for (const [name, resultState, field, value] of [
  ["pending missing release", "pending", "release", undefined],
  ["pending mismatched release", "pending", "release", "f".repeat(40)],
  ["pending missing API digest", "pending", "api", undefined],
  ["pending mismatched API digest", "pending", "api", `ghcr.io/kocakkmustafa/braavolabs/api@sha256:${"f".repeat(64)}`],
  ["pending missing UI digest", "pending", "ui", undefined],
  ["pending mismatched UI digest", "pending", "ui", `ghcr.io/kocakkmustafa/braavolabs/ui@sha256:${"f".repeat(64)}`],
]) test(`${name} resume is denied before migration health durable rewrite or success`, () =>
  withHarness((h) => {
    seedCommitRestartState(h, { result: resultState, durable: "candidate" });
    const journalPath = join(h.appRoot, "releases", RELEASE, "release.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8"));
    if (value === undefined) delete journal[field]; else journal[field] = value;
    writeFileSync(journalPath, JSON.stringify(journal) + "\n");
    const durablePath = join(h.appRoot, "releases", "previous-good.json");
    const durableBefore = readFileSync(durablePath, "utf8");

    const result = runRemote(h);

    assert.equal(result.status, 66);
    assert.equal(readFileSync(join(h.state, "migrate-count"), "utf8"), "0");
    assert.equal(readFileSync(join(h.state, "cutover-count"), "utf8"), "0");
    assert.doesNotMatch(result.calls, /migrate deploy|curl |commit-release-success|COMMIT_RELEASE success/);
    assert.equal(readFileSync(durablePath, "utf8"), durableBefore);
    assert.equal(readFileSync(journalPath, "utf8"), JSON.stringify(journal) + "\n");
  }));

for (const [name, resultState, durableState] of [
  ["crash before durable previous-good write", "pending", "old"],
  ["crash after durable write before success journal", "pending", "candidate"],
  ["legacy success with stale durable tuple", "success", "old"],
  ["legacy success with missing durable tuple", "success", "missing"],
  ["legacy success with mismatched durable tuple", "success", "mismatch"],
]) test(`${name} deterministically completes the verified commit`, () => withHarness((h) => {
  const tuple = seedCommitRestartState(h, { result: resultState, durable: durableState });
  const resumed = runRemote(h);
  assert.equal(resumed.status, 0);
  const durable = JSON.parse(readFileSync(join(h.appRoot, "releases/previous-good.json"), "utf8"));
  assert.deepEqual(
    { release: durable.release, tuple: durable.tuple, api: durable.api, ui: durable.ui, result: durable.result },
    { release: RELEASE, tuple, api: API, ui: UI, result: "success" },
  );
  assert.equal(readCurrentTransition(h), "COMMIT_RELEASE:success");
}));

test("durable write failure restores sealed old tuple and never journals success", () => withHarness((h) => {
  const result = runRemote(h, { FAIL_WRITE_PHASE: "commit-release-success:copy" });
  assert.equal(result.status, 72);
  const durable = JSON.parse(readFileSync(join(h.appRoot, "releases/previous-good.json"), "utf8"));
  assert.equal(durable.release, PREVIOUS_RELEASE);
  assert.notEqual(readCurrentTransition(h), "COMMIT_RELEASE:success");
}));

test("success-journal failure after durable write restores old tuple and exits 72", () =>
  withHarness((h) => {
    seedCommitRestartState(h, { result: "pending", durable: "candidate" });
    const result = runRemote(h, { FAIL_WRITE_PHASE: "transition-COMMIT_RELEASE-record:copy" });
    assert.equal(result.status, 72);
    const durable = JSON.parse(readFileSync(join(h.appRoot, "releases/previous-good.json"), "utf8"));
    assert.equal(durable.release, PREVIOUS_RELEASE);
  }));

for (const [name, mutate, env, status, updatePreviousGood = true] of [
  ["stale success previous digests", (h) => {}, {}, 67, false],
  ["mixed active digests", (h) => writeFileSync(join(h.state, "active-api"), API), {}, 66, false],
  ["migration ledger failure", (h) => { writeFileSync(join(h.state, "active-api"), API); writeFileSync(join(h.state, "active-ui"), UI); }, { FAIL_MIGRATION_LEDGER: "1" }, 68],
]) test(`idempotent ${name} fails closed`, () => withHarness((h) => {
  seedSuccessfulJournal(h, { updatePreviousGood }); mutate(h);
  assert.equal(runRemote(h, env).status, status);
}));

for (const [name, env] of [
  ["git diff exits 91", { FAKE_GIT_DIFF_EXIT: "91" }],
  ["git diff reports output I/O failure", { FAKE_GIT_DIFF_IO_FAILURE: "1" }],
]) test(`${name} is exit 68 before every transport and release side effect`, () =>
  withHarness((h) => {
    const result = runDeploy(h, env);
    assert.equal(result.status, 68);
    assert.doesNotMatch(result.calls,
      /^ssh |^rsync |migrate deploy|up -d|curl |COMMIT_RELEASE|previous-good committed/m);
    assert.equal(readFileSync(join(h.state, "migrate-count"), "utf8"), "0");
    assert.equal(readFileSync(join(h.state, "cutover-count"), "utf8"), "0");
    assert.equal(existsSync(join(h.state, "transport")), false);
  }));
async function signalAt(h, pauseAt, extra = {}) {
  const incoming = buildIncoming(h);
  const child = spawn("bash", [SCRIPT, "--remote", RELEASE, API, UI, h.appRoot, incoming], {
    cwd: ROOT,
    detached: true,
    env: remoteEnvironment(h, { PAUSE_AT: pauseAt, ...extra }),
  });
  const marker = pauseAt === "pull" ? "docker pull" :
    pauseAt === "backup" ? "postgres-backup" :
    pauseAt === "target-health" ? "curl " : "sync ";
  let reached = false;
  for (let attempt = 0; attempt < 3000; attempt += 1) {
    if (readFileSync(h.log, "utf8").includes(marker)) {
      reached = true;
      break;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  assert.equal(reached, true, `timed out waiting for ${pauseAt} marker ${marker}`);
  process.kill(-child.pid, "SIGTERM");
  const [status] = await once(child, "exit");
  return status;
}

test("SIGTERM before cutover preserves 66 and task-only cleanup", () => withHarness(async (h) => {
  writeFileSync(join(h.appRoot, "unrelated.keep"), "keep\n");
  assert.equal(await signalAt(h, "pull"), 66);
  assert.equal(existsSync(join(h.appRoot, "unrelated.keep")), true);
}));
for (const phase of ["backup", "target-health", "journal-finalize"]) {
  test(`SIGTERM at ${phase} performs verified rollback and preserves 66`, () =>
    withHarness(async (h) => {
      assert.equal(await signalAt(h, phase), 66);
      assert.equal(readFileSync(join(h.state, "active-api"), "utf8"), PREVIOUS_API);
      assert.equal(readFileSync(join(h.state, "active-ui"), "utf8"), PREVIOUS_UI);
    }));
}
test("SIGTERM rollback-health failure exits 71", () => withHarness(async (h) => {
  assert.equal(await signalAt(h, "target-health", { FAIL_ROLLBACK_HEALTH: "1" }), 71);
}));
test("restart after interrupted cutover recovers and completes from sealed staged bytes", () =>
  withHarness(async (h) => {
    assert.equal(await signalAt(h, "backup"), 66);
    assert.equal(readFileSync(join(h.state, "active-api"), "utf8"), PREVIOUS_API);
    assert.equal(readFileSync(join(h.state, "active-ui"), "utf8"), PREVIOUS_UI);
    const resumed = runRemote(h);
    assert.equal(resumed.status, 0);
    assert.equal(readCurrentRecord(h).result, "success");
  }));

const deniedHosts = [
  ["wildcard", ["*.example.test ssh-ed25519 " + KEY_A], FINGERPRINT_A, 0o600],
  ["hashed", ["|1|salt|hash ssh-ed25519 " + KEY_A], FINGERPRINT_A, 0o600],
  ["unexpected", ["other.example.test ssh-ed25519 " + KEY_A], FINGERPRINT_A, 0o600],
  ["marker", ["@revoked deploy.example.test ssh-ed25519 " + KEY_A], FINGERPRINT_A, 0o600],
  ["malformed", ["deploy.example.test ssh-ed25519"], FINGERPRINT_A, 0o600],
  ["wrong type", ["deploy.example.test ssh-rsa " + KEY_A], FINGERPRINT_A, 0o600],
  ["duplicate", ["deploy.example.test ssh-ed25519 " + KEY_A, "deploy.example.test ssh-ed25519 " + KEY_A], FINGERPRINT_A, 0o600],
  ["mode", ["deploy.example.test ssh-ed25519 " + KEY_A], FINGERPRINT_A, 0o644],
  ["fingerprint", ["deploy.example.test ssh-ed25519 " + KEY_A], FINGERPRINT_B, 0o600],
  ["duplicate expected fingerprint", ["deploy.example.test ssh-ed25519 " + KEY_A], `${FINGERPRINT_A},${FINGERPRINT_A}`, 0o600],
  ["partial rotation", ["deploy.example.test ssh-ed25519 " + KEY_A], `${FINGERPRINT_A},${FINGERPRINT_B}`, 0o600],
  ["more than two rotation keys", [
    "deploy.example.test ssh-ed25519 " + KEY_A,
    "deploy.example.test ssh-ed25519 " + KEY_B,
    "deploy.example.test ssh-ed25519 " + KEY_A + "A",
  ], `${FINGERPRINT_A},${FINGERPRINT_B},SHA256:CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC`, 0o600],
];
test("GNU stat mode probe is preferred over the incompatible -f form", () => withHarness((h) => {
  writeStatFixture(h, `
if [ "${'${1:-}'}" = -c ]; then printf '%s\n' 600; exit 0; fi
if [ "${'${1:-}'}" = -f ]; then printf '%s\n' unexpected-filesystem-report; exit 0; fi
exit 2`);
  const result = runDeploy(h);
  assert.equal(result.status, 0, result.stderr);
}));
test("BSD stat mode probe is used only after GNU stat is unsupported", () => withHarness((h) => {
  writeStatFixture(h, `
if [ "${'${1:-}'}" = -c ]; then exit 1; fi
if [ "${'${1:-}'}" = -f ]; then printf '%s\n' 600; exit 0; fi
exit 2`);
  const result = runDeploy(h);
  assert.equal(result.status, 0, result.stderr);
}));
test("stat mode probe failure denies before transport", () => withHarness((h) => {
  writeStatFixture(h, "exit 1");
  const result = runDeploy(h);
  assert.equal(result.status, 64);
  assert.match(result.stderr, /identity mode must be 0600/);
  assert.doesNotMatch(result.calls, /^ssh |^rsync /m);
}));
for (const [name, lines, fingerprints, mode] of deniedHosts) {
  test(`known_hosts ${name} denies before transport`, () => withHarness((h) => {
    writeKnownHosts(h, lines, mode);
    const result = runDeploy(h, { SSH_HOST_KEY_SHA256: fingerprints });
    assert.equal(result.status, 65);
    assert.doesNotMatch(result.calls, /^ssh |^rsync /m);
  }));
}
test("known_hosts exact host is accepted", () => withHarness((h) => {
  useReviewedMigrationSnapshot(h);
  const historicalMigrations = readdirSync(join(h.sourceRoot, "packages/db/prisma/migrations"))
    .filter((name) => existsSync(join(h.sourceRoot, "packages/db/prisma/migrations", name, "migration.sql")));
  assert.equal(historicalMigrations.length, 48);
  for (const acceptedMigration of [
    "20260820000000_subscription_plan_enum_values",
    "20260821_subscription_only_plans",
    "20260825233000_iap_delivery_dlq",
    "20260828_google_purchase_alias_ownership",
  ]) {
    assert.ok(historicalMigrations.includes(acceptedMigration), `missing accepted migration: ${acceptedMigration}`);
  }
  const result = runDeploy(h);
  assert.equal(result.status, 0);
  assert.match(result.calls, /StrictHostKeyChecking=yes/);
  assertNoExternalNetwork(h);
}));
test("system ssh-keygen emits a commentless ED25519 record accepted by the parser contract", () => {
  const keyRoot = mkdtempSync(join(tmpdir(), "braavo-commentless-key-"));
  try {
    const keyPath = join(keyRoot, "id_ed25519");
    const generated = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "", "-f", keyPath], {
      encoding: "utf8",
    });
    assert.equal(generated.status, 0);
    const result = spawnSync("ssh-keygen", ["-lf", "-", "-E", "sha256"], {
      encoding: "utf8",
      input: readFileSync(`${keyPath}.pub`, "utf8"),
    });
    assert.equal(result.status, 0);
    assert.match(result.stdout.trim(), /^\d+ SHA256:[A-Za-z0-9+/]+=? no comment \(ED25519\)$/);
  } finally {
    rmSync(keyRoot, { recursive: true, force: true });
  }
});
for (const [name, output] of [
  ["malformed fingerprint output", "256 not-a-fingerprint no comment (ED25519)\\n"],
  ["multiple fingerprint records", `256 ${FINGERPRINT_A} no comment (ED25519)\\n256 ${FINGERPRINT_A} no comment (ED25519)\\n`],
]) {
  test(`known_hosts ${name} denies before transport`, () => withHarness((h) => {
    const result = runDeploy(h, { FAKE_SSH_KEYGEN_OUTPUT: output });
    assert.equal(result.status, 65);
    assert.doesNotMatch(result.calls, /^ssh |^rsync /m);
  }));
}
test("known_hosts exact two-key rotation is accepted", () => withHarness((h) => {
  writeKnownHosts(h, [
    `deploy.example.test ssh-ed25519 ${KEY_A}`,
    `deploy.example.test ssh-ed25519 ${KEY_B}`,
  ]);
  const result = runDeploy(h, { SSH_HOST_KEY_SHA256: `${FINGERPRINT_A},${FINGERPRINT_B}` });
  assert.equal(result.status, 0);
  assert.match(result.calls, /StrictHostKeyChecking=yes/);
  assertNoExternalNetwork(h);
}));
test("known_hosts bracketed non-default port is accepted", () => withHarness((h) => {
  writeKnownHosts(h, [`[deploy.example.test]:2222 ssh-ed25519 ${KEY_A}`]);
  const result = runDeploy(h, { DEPLOY_PORT: "2222" });
  assert.equal(result.status, 0);
  assert.match(result.calls, /StrictHostKeyChecking=yes/);
  assertNoExternalNetwork(h);
}));

test("real main-to-candidate four-path migration discovery reaches the mocked Prisma sink", () =>
  withHarness((h) => {
    useReviewedMigrationSnapshot(h);
    seedComposeIdentity(h, { release: AUTHORITATIVE_PREVIOUS_RELEASE });
    writeFileSync(join(h.appRoot, "releases/previous-good.json"), JSON.stringify({
      release: AUTHORITATIVE_PREVIOUS_RELEASE,
      previousRelease: AUTHORITATIVE_PREVIOUS_RELEASE,
      tuple: "previous-tuple", api: PREVIOUS_API, ui: PREVIOUS_UI,
      migrationDeltaSha256: "e".repeat(64), result: "success",
    }) + "\n");
    const result = runDeploy(h, {
      PREVIOUS_RELEASE_COMMIT: AUTHORITATIVE_PREVIOUS_RELEASE,
      RELEASE_COMMIT: REAL_MIGRATION_CANDIDATE,
      USE_REAL_GIT_DIFF: "1",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr.includes("FAKE_GIT_DIFF"), false);
    assert.match(result.calls, /^ssh /m);
    assert.match(result.calls, /^rsync /m);
    assert.match(result.calls, /docker compose .* run --rm --no-deps api/);
    assert.equal(readFileSync(join(h.state, "migrate-count"), "utf8"), "1");
  }));

for (const [name, mutation, gitDiff = REVIEWED_SUBSCRIPTION_DIFF] of [
  ["byte hash", "hash"],
  ["enum label", "enum-label"],
  ["legacy mapping", "mapping"],
  ["default", "default"],
  ["extra reviewed-looking statement", "extra-statement"],
  ["IAP delivery byte hash", "iap-delivery-hash"],
  ["Google alias byte hash", "google-alias-hash"],
  ["third migration", "third-migration",
    `${REVIEWED_SUBSCRIPTION_DIFF}A\tpackages/db/prisma/migrations/20260820000001_unreviewed/migration.sql\n`],
  ["unmanifested historical migration", "unmanifested"],
]) test(`reviewed subscription bundle denies ${name} mutation before transport`, () =>
  withHarness((h) => {
    const result = runDeploy(h, {
      FAKE_GIT_DIFF: gitDiff,
      FAKE_STAGE_MUTATION_MODE: mutation,
    });
    assert.equal(result.status, 68);
    assert.doesNotMatch(result.calls, /^ssh |^rsync |migrate deploy|up -d|curl /m);
    assert.equal(readFileSync(join(h.state, "migrate-count"), "utf8"), "0");
    assert.equal(existsSync(join(h.state, "transport")), false);
  }));

test("reviewed subscription bundle denies a changed path before transport", () =>
  withHarness((h) => {
    const result = runDeploy(h, {
      FAKE_GIT_DIFF:
        `A\tpackages/db/prisma/migrations/20260820000000_changed_path/migration.sql\n` +
        `A\t${REVIEWED_PROJECTION_MIGRATION}\n` +
        `A\t${REVIEWED_IAP_DELIVERY_MIGRATION}\n` +
        `A\t${REVIEWED_GOOGLE_ALIAS_MIGRATION}\n`,
    });
    assert.equal(result.status, 68);
    assert.doesNotMatch(result.calls, /^ssh |^rsync |migrate deploy|up -d|curl /m);
  }));

for (const [name, gitDiff] of [
  ["modified status", REVIEWED_SUBSCRIPTION_DIFF.replace(`A\t${REVIEWED_PROJECTION_MIGRATION}`, `M\t${REVIEWED_PROJECTION_MIGRATION}`)],
  ["omitted path", REVIEWED_SUBSCRIPTION_DIFF.replace(`A\t${REVIEWED_IAP_DELIVERY_MIGRATION}\n`, "")],
  ["reordered paths",
    `A\t${REVIEWED_PROJECTION_MIGRATION}\n` +
    `A\t${REVIEWED_ENUM_MIGRATION}\n` +
    `A\t${REVIEWED_IAP_DELIVERY_MIGRATION}\n` +
    `A\t${REVIEWED_GOOGLE_ALIAS_MIGRATION}\n`],
  ["duplicate path", REVIEWED_SUBSCRIPTION_DIFF + `A\t${REVIEWED_ENUM_MIGRATION}\n`],
  ["rename-copy status", `R100\t${REVIEWED_ENUM_MIGRATION}\t${REVIEWED_PROJECTION_MIGRATION}\n`],
]) test(`reviewed subscription bundle denies ${name} before transport`, () =>
  withHarness((h) => {
    const result = runDeploy(h, {
      PREVIOUS_RELEASE_COMMIT: AUTHORITATIVE_PREVIOUS_RELEASE,
      FAKE_GIT_DIFF: gitDiff,
    });
    assert.equal(result.status, 68);
    assert.doesNotMatch(result.calls, /^ssh |^rsync |migrate deploy|up -d|curl /m);
    assert.equal(readFileSync(join(h.state, "migrate-count"), "utf8"), "0");
  }));

test("non-authoritative previous-good base lease is rejected before SSH", () =>
  withHarness((h) => {
    const result = runDeploy(h, {
      PREVIOUS_RELEASE_COMMIT: "f".repeat(40),
      FAKE_GIT_DIFF: REVIEWED_SUBSCRIPTION_DIFF,
    });
    assert.equal(result.status, 68);
    assert.doesNotMatch(result.calls, /^ssh |^rsync |migrate deploy|up -d|curl /m);
  }));

test("remote previous-good drift is rejected before transfer and migration", () =>
  withHarness((h) => {
    useReviewedMigrationSnapshot(h);
    const result = runDeploy(h, {
      PREVIOUS_RELEASE_COMMIT: AUTHORITATIVE_PREVIOUS_RELEASE,
      FAKE_GIT_DIFF: REVIEWED_SUBSCRIPTION_DIFF,
    });
    assert.equal(result.status, 68);
    assert.match(result.calls, /^ssh /m);
    assert.doesNotMatch(result.calls, /^rsync |migrate deploy|up -d|curl /m);
    assert.equal(readFileSync(join(h.state, "migrate-count"), "utf8"), "0");
  }));

const migrationCases = [
  ["nullable add", "ALTER TABLE subscription ADD COLUMN settlement_version INTEGER;", 0],
  ["safe index", "CREATE INDEX IF NOT EXISTS subscription_tenant_idx ON subscription(tenant_id);", 0],
  ["comments multiline casing", "/* expand */\nalter table subscription\n add column settlement_note TEXT; -- nullable", 0],
  ["rename", "ALTER TABLE subscription RENAME COLUMN plan TO plan_tier;", 68],
  ["type narrowing", "ALTER TABLE subscription ALTER COLUMN quota TYPE SMALLINT;", 68],
  ["not null", "ALTER TABLE subscription ADD COLUMN owner TEXT NOT NULL;", 68],
  ["drop index", "DROP INDEX subscription_tenant_idx;", 68],
  ["constraint", "ALTER TABLE subscription ADD CONSTRAINT tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenant(id);", 68],
  ["unknown", "DO $$ BEGIN RAISE NOTICE 'manual'; END $$;", 68],
  ["unterminated comment", "/* broken", 68],
];
for (const [name, sql, status] of migrationCases) test(`migration policy ${name}`, () => withHarness((h) => {
  const result = runRemote(h, { MIGRATION_SQL: sql });
  assert.equal(result.status, status);
  if (status === 68) assert.doesNotMatch(result.calls, /migrate deploy|up -d --no-deps/);
}));

const COREPACK_ARCHIVE_SHA256 = "d389715b4d2966e8c84103387f83d2ea698d797bf678f56b6895f179be7db6a5";
const COREPACK_EMBEDDED_SHA512 = "b2dc20e2fc72b3e18848459b37359a32064663e5627a51e4c74b2c29dd8e8e0491483c3abb40789cfd578bf362fb6ba8261b05f0387d76792ed6e23ea3b1b6a0";
const COREPACK_ORIGIN = "https://registry.npmjs.org/pnpm/-/pnpm-9.15.4.tgz";
const LOCKFILE_SHA256 = "7c9e73f60bc2bfed4abf091eab49c03d897dc1801afa1c679d242e275a48c4c1";

function assertOfflineCorepackContract(source, label) {
  assert.match(source, /^# syntax=docker\/dockerfile:1\.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e$/m, `${label}: frontend digest`);
  assert.match(source, /^FROM scratch AS corepack_archive$/m, `${label}: empty named-context fallback`);
  assert.match(source, /^FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS corepack_(?:online|offline)$/m, `${label}: pinned Node base`);
  assert.match(source, /RUN --network=none --mount=type=bind,from=corepack_archive,source=\/,target=\/run\/corepack-archive,ro/, `${label}: read-only networkless bind`);
  assert.match(source, /find \/run\/corepack-archive -mindepth 1 -maxdepth 1/, `${label}: exact membership`);
  assert.match(source, /test "\$count" -eq 2/, `${label}: two-file context`);
  assert.match(source, /test -f "\$archive" && test ! -L "\$archive"/, `${label}: archive is regular non-link`);
  assert.match(source, /test -f "\$manifest" && test ! -L "\$manifest"/, `${label}: manifest is regular non-link`);
  assert.match(source, /3882495/, `${label}: archive size`);
  assert.match(source, new RegExp(COREPACK_ARCHIVE_SHA256), `${label}: archive SHA-256`);
  assert.match(source, new RegExp(COREPACK_EMBEDDED_SHA512), `${label}: embedded SHA-512`);
  assert.match(source, new RegExp(COREPACK_ORIGIN.replaceAll(".", "\\.")), `${label}: npm origin`);
  assert.match(source, /corepack install -g --cache-only "\$archive"/, `${label}: cache-only install`);
  assert.match(source, /test "\$\(pnpm --version\)" = 9\.15\.4/, `${label}: activated version`);
  assert.match(source, /rm -rf \/root\/\.cache\/node\/corepack/, `${label}: Corepack cache removed before snapshot`);
  assert.match(source, new RegExp(`id=braavo-pnpm-9\\.15\\.4-${LOCKFILE_SHA256}`), `${label}: lockfile-bound pnpm cache`);
  assert.match(source, /pnpm fetch --frozen-lockfile/, `${label}: acquisition fills the complete offline store`);
  assert.match(source, /pnpm install --offline --frozen-lockfile/, `${label}: offline install branch`);
  assert.match(source, /pnpm install --frozen-lockfile/, `${label}: context-absent network install branch`);
  assert.doesNotMatch(source, /(?:COPY|ADD).*corepack-pnpm|(?:ARG|ENV).*COREPACK_ARCHIVE|type=secret,id=corepack_archive|--build-arg[^\n]*corepack/i, `${label}: archive transport must remain ephemeral`);
}

test("API and UI Dockerfiles enforce the exact offline Corepack contract", () => {
  const api = readFileSync(join(ROOT, "ENV/Dockerfile.api"), "utf8");
  assertOfflineCorepackContract(api, "api");
  assert.match(
    api,
    /id=braavo-prisma-6\.19\.2-linux-musl-arm64,target=\/root\/\.cache\/prisma,sharing=locked[\s\\]*\n\s*pnpm --filter @ai-company-os\/db exec prisma generate/,
    "api: acquisition-bound Prisma engine cache",
  );
  assert.match(
    api,
    /find "\/app\/node_modules\/\.pnpm\/thread-stream@3\.1\.0\/node_modules\/thread-stream\/test" -type f -name '\*\.zip' -delete/,
    "api: all unsupported upstream test archives are absent before the install layer commits",
  );
  assertOfflineCorepackContract(readFileSync(join(ROOT, "ENV/Dockerfile.ui"), "utf8"), "ui");
});

test("offline Corepack security-property mutations are rejected", () => {
  const source = readFileSync(join(ROOT, "ENV/Dockerfile.ui"), "utf8");
  const mutations = [
    source.replace("FROM scratch AS corepack_archive", "FROM scratch AS missing_context"),
    source.replace("--network=none ", ""),
    source.replace(",ro", ",rw"),
    source.replaceAll(COREPACK_ARCHIVE_SHA256, "0".repeat(64)),
    source.replace(COREPACK_ORIGIN, "https://example.invalid/pnpm.tgz"),
    source.replace("rm -rf /root/.cache/node/corepack", ":"),
    source.replace(`braavo-pnpm-9.15.4-${LOCKFILE_SHA256}`, "braavo-pnpm-unbound"),
    source.replace("pnpm fetch --frozen-lockfile", ":"),
  ];
  for (const [index, mutation] of mutations.entries()) {
    assert.throws(
      () => assertOfflineCorepackContract(mutation, `mutation-${index}`),
      `security-property mutation ${index} must be rejected`,
    );
  }
});

// Keep the current Google draft out of the historical deploy allowlist.
test("current Google lineage migration still requires manual review before transport", () => withHarness((h) => {
  assert.ok(existsSync(join(ROOT, "packages/db/prisma/migrations/20261003000000_google_verified_lineage/migration.sql")));
  const result = runDeploy(h, {
    PREVIOUS_RELEASE_COMMIT: AUTHORITATIVE_PREVIOUS_RELEASE,
    FAKE_GIT_DIFF: REVIEWED_SUBSCRIPTION_DIFF,
  });
  assert.equal(result.status, 68);
  assert.match(result.stderr, /migration requires manual review/);
  assert.doesNotMatch(result.calls, /^ssh |^rsync |migrate deploy|up -d|curl /m);
  assert.equal(readFileSync(join(h.state, "migrate-count"), "utf8"), "0");
  assertNoExternalNetwork(h);
}));
