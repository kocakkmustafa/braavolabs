#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'
readonly EXIT_INPUT=64 EXIT_HOST=65 EXIT_REMOTE=66 EXIT_IMAGE=67 EXIT_MIGRATION=68
readonly EXIT_CUTOVER=69 EXIT_HEALTH_ROLLED_BACK=70 EXIT_ROLLBACK=71
readonly EXIT_JOURNAL=72 EXIT_LOCK=75

die() { local code="$1"; shift; printf 'deploy-platform: %s\n' "$*" >&2; exit "$code"; }
require_value() { test -n "${!1:-}" || die "$EXIT_INPUT" "missing required input: $1"; }
is_digest_ref() { [[ "$1" =~ ^ghcr\.io/kocakkmustafa/braavolabs/(api|ui)@sha256:[0-9a-f]{64}$ ]]; }
safe_rm() { rm -rf -- "$1"; }

atomic_file() {
  local destination="$1" source="$2" phase="${3:-atomic}" temporary
  temporary="${destination}.tmp.$$"
  DEPLOY_WRITE_PHASE="$phase:copy" cp -p -- "$source" "$temporary" || return 1
  DEPLOY_WRITE_PHASE="$phase:file-sync" sync "$temporary" || return 1
  DEPLOY_WRITE_PHASE="$phase:rename" mv -f -- "$temporary" "$destination" || return 1
  DEPLOY_WRITE_PHASE="$phase:dir-sync" sync "$(dirname "$destination")" || return 1
}

resolve_running_ref() {
  local container="$1" repository="$2" image_id refs match count
  image_id="$(docker inspect --format '{{.Image}}' "$container")" || return 1
  refs="$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$image_id")" || return 1
  match="$(printf '%s\n' "$refs" | awk -v p="$repository@sha256:" 'index($0,p)==1')"
  count="$(printf '%s\n' "$match" | sed '/^$/d' | wc -l | tr -d ' ')"
  test "$count" = 1 || return 1
  printf '%s\n' "$match"
}

verify_pulled_ref() {
  local expected="$1" refs
  docker pull "$expected" >/dev/null || return 1
  refs="$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$expected")" || return 1
  test "$(printf '%s\n' "$refs" | grep -Fxc -- "$expected")" = 1
}

write_override() {
  local api="$1" ui="$2" destination="$3" source
  source="${destination}.source.$$"
  umask 077
  printf 'services:\n  api:\n    image: %s\n  ui:\n    image: %s\n' "$api" "$ui" > "$source" || return 1
  atomic_file "$destination" "$source" || { safe_rm "$source"; return 1; }
  safe_rm "$source"
}

compose() {
  docker compose -p braavolabs --env-file "$env_file" \
    -f "$compose_file" -f "$override_file" "$@"
}
now_utc() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }

journal_transition() {
  local state="$1" result="$2" source="$journal_dir/.record.$$" record
  transition_seq=$((transition_seq + 1))
  record="$journal_dir/$(printf '%04d' "$transition_seq")-${state}.json"
  umask 077
  printf '{"schema":1,"sequence":%d,"at":"%s","release":"%s","tuple":"%s","api":"%s","ui":"%s","previousApi":"%s","previousUi":"%s","previousApiContainer":"%s","previousUiContainer":"%s","migration":"%s","cutover":"%s","health":"%s","backup":"%s","rollback":"%s","state":"%s","result":"%s"}\n' \
    "$transition_seq" "$(now_utc)" "$release_commit" "$release_tuple" "$api_ref" "$ui_ref" \
    "$previous_api" "$previous_ui" "$previous_api_container" "$previous_ui_container" \
    "$migration_result" "$cutover_result" "$health_result" "$backup_result" \
    "$rollback_result" "$state" "$result" > "$source" || return 1
  atomic_file "$record" "$source" "transition-$state-record" || { safe_rm "$source"; return 1; }
  atomic_file "$journal" "$record" "transition-$state-current" || { safe_rm "$source"; return 1; }
  safe_rm "$source" || return 1
  test "$(sed -n 's/.*\"state\":\"\([^\"]*\)\".*/\1/p' "$journal")" = "$state"
}

verify_health() {
  test "$(docker inspect --format '{{.State.Running}}' aicos-api)" = true &&
  test "$(docker inspect --format '{{.State.Running}}' aicos-ui)" = true &&
  test "$(docker inspect --format '{{.State.Running}}' aicos-backup)" = true &&
  curl --fail --silent --show-error --max-time 15 https://api.braavolabs.com/health >/dev/null &&
  curl --fail --silent --show-error --max-time 15 https://braavolabs.com/ >/dev/null
}

rollback_application() {
  rollback_result=pending
  journal_transition ROLLBACK_APPLICATION pending || return 1
  write_override "$previous_api" "$previous_ui" "$override_file" || return 1
  compose up -d --no-deps api ui || return 1
  compose --profile backup up -d postgres-backup || return 1
  verify_health || return 1
  test "$(resolve_running_ref aicos-api ghcr.io/kocakkmustafa/braavolabs/api)" = "$previous_api" || return 1
  test "$(resolve_running_ref aicos-ui ghcr.io/kocakkmustafa/braavolabs/ui)" = "$previous_ui" || return 1
  atomic_file "$previous_good" "$previous_good_backup" rollback-previous-good || return 1
  rollback_result=restored
  journal_transition ROLLBACK_APPLICATION restored
}

fail_after_cutover() {
  local primary="$1"
  if rollback_application; then return "$primary"; fi
  rollback_result=failed
  journal_transition ROLLBACK_APPLICATION failed >/dev/null 2>&1 || :
  return "$EXIT_ROLLBACK"
}

after_cutover_transition() {
  journal_transition "$1" "$2" || fail_after_cutover "$EXIT_JOURNAL"
}

cleanup_remote() {
  local primary="$1" cleanup=0
  trap - EXIT HUP INT TERM
  set +e
  safe_rm "${incoming:-}"; cleanup="$?"
  set -e
  if test "$primary" -ne 0; then exit "$primary"; fi
  if test "$cleanup" -ne 0; then exit "$EXIT_REMOTE"; fi
  exit 0
}

migration_is_eligible() {
  local staged="$1" delta_manifest="$2" relative file normalized statement upper
  test -f "$delta_manifest" || return 1
  while IFS= read -r relative; do
    test -n "$relative" || continue
    case "$relative" in packages/db/prisma/migrations/*/migration.sql) ;; *) return 1 ;; esac
    file="$staged/$relative"
    test -f "$file" && test ! -L "$file" || return 1
    normalized="$(awk '
      BEGIN { inblock=0 }
      {
        line=$0
        while (1) {
          if (inblock) {
            if (match(line,/\*\//)) { line=substr(line,RSTART+RLENGTH); inblock=0 } else { line=""; break }
          } else if (match(line,/\/\*/)) {
            before=substr(line,1,RSTART-1); line=substr(line,RSTART+RLENGTH); inblock=1; printf "%s ",before
          } else { sub(/--.*/,"",line); print line; break }
        }
      }
      END { if (inblock) exit 42 }
    ' "$file")" || return 1
    while IFS= read -r statement; do
      statement="$(printf '%s' "$statement" | tr '\n\t' '  ' | tr -s ' ' | sed 's/^ //;s/ $//')"
      test -z "$statement" && continue
      upper="$(printf '%s' "$statement" | tr '[:lower:]' '[:upper:]')"
      if [[ "$upper" =~ ^CREATE[[:space:]]+TABLE[[:space:]]+IF[[:space:]]+NOT[[:space:]]+EXISTS[[:space:]]+[A-Z_][A-Z0-9_]*[[:space:]]*\(.+\)$ ]]; then
        :
      elif [[ "$upper" =~ ^ALTER[[:space:]]+TABLE[[:space:]]+[A-Z_][A-Z0-9_]*[[:space:]]+ADD[[:space:]]+COLUMN[[:space:]]+[A-Z_][A-Z0-9_]*[[:space:]]+.+$ ]]; then
        printf '%s' "$upper" | grep -Eiq \
          '(^|[[:space:]])(NOT[[:space:]]+NULL|REFERENCES|PRIMARY[[:space:]]+KEY|UNIQUE|CHECK)([[:space:]]|$)' && return 1
      elif [[ "$upper" =~ ^CREATE[[:space:]]+INDEX([[:space:]]+CONCURRENTLY)?[[:space:]]+IF[[:space:]]+NOT[[:space:]]+EXISTS[[:space:]]+[A-Z_][A-Z0-9_]*[[:space:]]+ON[[:space:]]+[A-Z_][A-Z0-9_]*[[:space:]]*\(.+\)$ ]]; then
        :
      else
        return 1
      fi
    done < <(printf '%s\n' "$normalized" | awk 'BEGIN{RS=";"}{gsub(/[\r\n]+/," "); print}')
  done < <(awk '{print $2}' "$delta_manifest")
}

verify_manifest_membership() {
  local root="$1" manifest expected actual status
  manifest="$root/release-inputs.sha256"
  test -f "$manifest" && test ! -L "$manifest" || return 1
  (cd "$root" && sha256sum -c release-inputs.sha256) || return 1
  expected="$(mktemp)"; actual="$(mktemp)"
  awk '{print $2}' "$manifest" | LC_ALL=C sort -u > "$expected" || return 1
  (cd "$root" && find . -type f ! -name release-inputs.sha256 -print | sed 's#^./##' | LC_ALL=C sort -u) > "$actual" || return 1
  cmp -s "$expected" "$actual"; status="$?"
  rm -f "$expected" "$actual"
  return "$status"
}

verify_delta_contract() {
  local staged="$1" meta manifest discovery
  meta="$staged/migration-delta.meta"
  manifest="$staged/migration-delta.sha256"
  discovery="$staged/migration-delta.name-status"
  test -f "$meta" && test -f "$manifest" && test -f "$discovery" || return 1
  grep -Fx "previousRelease=$delta_previous_release" "$meta" >/dev/null || return 1
  grep -Fx "candidateRelease=$release_commit" "$meta" >/dev/null || return 1
  grep -Fx "api=$api_ref" "$meta" >/dev/null || return 1
  grep -Fx "ui=$ui_ref" "$meta" >/dev/null || return 1
  grep -Fx "discoverySha256=$(sha256sum "$discovery" | awk '{print $1}')" "$meta" >/dev/null || return 1
  grep -Fx "deltaSha256=$(sha256sum "$manifest" | awk '{print $1}')" "$meta" >/dev/null || return 1
  while IFS= read -r path; do
    case "$path" in packages/db/prisma/migrations/*/migration.sql) ;; *) return 1 ;; esac
  done < <(awk '{print $2}' "$manifest")
  if test -s "$manifest"; then (cd "$staged" && sha256sum -c migration-delta.sha256) || return 1; fi
}

json_field() {
  local field="$1" file="$2"
  sed -n "s/.*\"$field\":\"\([^\"]*\)\".*/\1/p" "$file"
}

load_previous_good() {
  local source="${1:-$previous_good}"
  test -f "$source" && test ! -L "$source" || return 1
  previous_release="$(json_field release "$source")"
  previous_base_release="$(json_field previousRelease "$source")"
  previous_tuple="$(json_field tuple "$source")"
  previous_api="$(json_field api "$source")"
  previous_ui="$(json_field ui "$source")"
  previous_delta_sha="$(json_field migrationDeltaSha256 "$source")"
  test "$(json_field result "$source")" = success || return 1
  [[ "$previous_release" =~ ^[0-9a-f]{40}$ ]] || return 1
  [[ "$previous_base_release" =~ ^[0-9a-f]{40}$ ]] || return 1
  test -n "$previous_tuple" && [[ "$previous_delta_sha" =~ ^[0-9a-f]{64}$ ]] || return 1
  is_digest_ref "$previous_api" && is_digest_ref "$previous_ui" || return 1
  docker image inspect "$previous_api" "$previous_ui" >/dev/null || return 1
}

write_previous_good() {
  local source="$release_root/previous-good.next.$$" delta_sha
  delta_sha="$(sha256sum "$staged_root/migration-delta.sha256" | awk '{print $1}')"
  printf '{"schema":1,"release":"%s","previousRelease":"%s","tuple":"%s","api":"%s","ui":"%s","migrationDeltaSha256":"%s","result":"success"}\n' \
    "$release_commit" "$previous_release" "$release_tuple" "$api_ref" "$ui_ref" "$delta_sha" > "$source" || return 1
  atomic_file "$previous_good" "$source" commit-release-success || { safe_rm "$source"; return 1; }
  safe_rm "$source"
}

verify_candidate_previous_good() {
  local delta_sha
  test -f "$previous_good" && test ! -L "$previous_good" || return 1
  delta_sha="$(sha256sum "$staged_root/migration-delta.sha256" | awk '{print $1}')"
  test "$(json_field release "$previous_good")" = "$release_commit" &&
  test "$(json_field previousRelease "$previous_good")" = "$previous_release" &&
  test "$(json_field tuple "$previous_good")" = "$release_tuple" &&
  test "$(json_field api "$previous_good")" = "$api_ref" &&
  test "$(json_field ui "$previous_good")" = "$ui_ref" &&
  test "$(json_field migrationDeltaSha256 "$previous_good")" = "$delta_sha" &&
  test "$(json_field result "$previous_good")" = success
}

journal_identity_matches_candidate() {
  test "$recorded_release" = "$release_commit" &&
  test "$recorded_tuple" = "$release_tuple" &&
  test "$recorded_api" = "$api_ref" &&
  test "$recorded_ui" = "$ui_ref"
}

restore_previous_good_authority() {
  test -f "$previous_good_backup" && test ! -L "$previous_good_backup" || return 1
  atomic_file "$previous_good" "$previous_good_backup" restart-restore-previous-good || return 1
  load_previous_good "$previous_good"
}

cutover_active=0
signal_status=66

signal_remote() {
  local status="$signal_status"
  trap - HUP INT TERM
  if test "$cutover_active" = 1; then
    fail_after_cutover "$status"
    status="$?"
  fi
  exit "$status"
}

verify_candidate_running() {
  test "$(resolve_running_ref aicos-api ghcr.io/kocakkmustafa/braavolabs/api)" = "$api_ref" &&
  test "$(resolve_running_ref aicos-ui ghcr.io/kocakkmustafa/braavolabs/ui)" = "$ui_ref"
}

run_candidate_migration() {
  compose run --rm --no-deps api sh -eu -c \
    'test -n "${MIGRATE_DATABASE_URL:-}"; export DATABASE_URL="$MIGRATE_DATABASE_URL"; cd /app/packages/db; exec npx prisma migrate deploy'
}

remote_main() {
  release_commit="$1"; api_ref="$2"; ui_ref="$3"; app_root="$4"; incoming="$5"
  test "$app_root" = /opt/braavolabs || test "${DEPLOY_HERMETIC_TEST:-0}" = 1 || exit "$EXIT_INPUT"
  is_digest_ref "$api_ref" && is_digest_ref "$ui_ref" || exit "$EXIT_INPUT"
  case "$incoming" in "$app_root/incoming/$release_commit."[0-9]*) ;; *) exit "$EXIT_INPUT" ;; esac
  release_root="$app_root/releases/$release_commit"
  staged_root="$release_root/input"
  compose_file="$staged_root/ENV/compose.prod.yaml"
  migrations_root="$staged_root/packages/db/prisma/migrations"
  env_file="$app_root/app/.env"
  override_file="$release_root/compose.digest-override.yaml"
  journal_dir="$release_root/transitions"
  journal="$release_root/release.json"
  previous_good="$app_root/releases/previous-good.json"
  previous_good_backup="$release_root/previous-good.before.json"
  transition_seq=0; cutover_active=0; signal_status="$EXIT_REMOTE"
  previous_release=''; previous_base_release=''; delta_previous_release=''
  previous_tuple=''; previous_delta_sha=''
  previous_api=''; previous_ui=''; previous_api_container=''; previous_ui_container=''
  migration_result=not-run; cutover_result=not-run; health_result=not-run
  backup_result=not-run; rollback_result=not-run
  trap 'cleanup_remote "$?"' EXIT
  trap signal_remote HUP INT TERM
  exec 9>"$app_root/deploy.lock"
  flock -n 9 || exit "$EXIT_LOCK"
  test -f "$env_file" || exit "$EXIT_REMOTE"
  install -d -m 0700 "$release_root" "$journal_dir"
  durable_candidate_seen=0
  if test -f "$previous_good" && test "$(json_field release "$previous_good")" = "$release_commit"; then
    durable_candidate_seen=1
    load_previous_good "$previous_good_backup" || exit "$EXIT_ROLLBACK"
  elif ! load_previous_good "$previous_good"; then
    restore_previous_good_authority || exit "$EXIT_ROLLBACK"
  fi
  delta_previous_release="$previous_release"
  if test ! -f "$previous_good_backup"; then
    atomic_file "$previous_good_backup" "$previous_good" capture-previous-good || exit "$EXIT_JOURNAL"
  else
    load_previous_good "$previous_good_backup" || exit "$EXIT_ROLLBACK"
  fi
  test -d "$incoming" && test -f "$incoming/release-inputs.sha256" || exit "$EXIT_REMOTE"
  verify_manifest_membership "$incoming" || exit "$EXIT_IMAGE"
  verify_delta_contract "$incoming" || exit "$EXIT_MIGRATION"

  if test -d "$staged_root"; then
    cmp -s "$incoming/release-inputs.sha256" "$staged_root/release-inputs.sha256" || exit "$EXIT_IMAGE"
    verify_manifest_membership "$staged_root" || exit "$EXIT_IMAGE"
    verify_delta_contract "$staged_root" || exit "$EXIT_MIGRATION"
    safe_rm "$incoming" || exit "$EXIT_REMOTE"
  else
    mv -- "$incoming" "$staged_root" || exit "$EXIT_REMOTE"
    verify_manifest_membership "$staged_root" || exit "$EXIT_IMAGE"
    verify_delta_contract "$staged_root" || exit "$EXIT_MIGRATION"
  fi
  incoming="$app_root/incoming/.consumed-$release_commit-$$"
  release_tuple="$(sha256sum "$staged_root/release-inputs.sha256" "$staged_root/migration-delta.sha256" | awk -v r="$release_commit" -v a="$api_ref" -v u="$ui_ref" 'BEGIN{s=r"|"a"|"u} {s=s"|"$1} END{print s}')"

  active_api="$(resolve_running_ref aicos-api ghcr.io/kocakkmustafa/braavolabs/api)" || exit "$EXIT_REMOTE"
  active_ui="$(resolve_running_ref aicos-ui ghcr.io/kocakkmustafa/braavolabs/ui)" || exit "$EXIT_REMOTE"
  previous_api_container="$(docker inspect --format '{{.Id}}' aicos-api)" || exit "$EXIT_REMOTE"
  previous_ui_container="$(docker inspect --format '{{.Id}}' aicos-ui)" || exit "$EXIT_REMOTE"
  is_digest_ref "$active_api" && is_digest_ref "$active_ui" || exit "$EXIT_ROLLBACK"

  recorded_release=''; recorded_tuple=''; recorded_api=''; recorded_ui=''
  recorded_result=''; recorded_state=''; resume_candidate=0
  if test -f "$journal"; then
    recorded_release="$(json_field release "$journal")"
    recorded_tuple="$(json_field tuple "$journal")"
    recorded_api="$(json_field api "$journal")"
    recorded_ui="$(json_field ui "$journal")"
    recorded_result="$(json_field result "$journal")"
    recorded_state="$(json_field state "$journal")"
    test -z "$recorded_tuple" || test "$recorded_tuple" = "$release_tuple" || exit "$EXIT_IMAGE"
    if test "$recorded_state" = COMMIT_RELEASE &&
       { test "$recorded_result" = pending || test "$recorded_result" = success; }; then
      journal_identity_matches_candidate || exit "$EXIT_IMAGE"
    fi
  fi

  if ! { test "$active_api" = "$previous_api" && test "$active_ui" = "$previous_ui"; }; then
    if test "$active_api" = "$api_ref" && test "$active_ui" = "$ui_ref" && \
       journal_identity_matches_candidate && test "$recorded_state" = COMMIT_RELEASE && \
       { test "$recorded_result" = pending || test "$recorded_result" = success; }; then
      resume_candidate=1
      cutover_active=1
    else
      cutover_active=1
      rollback_application || exit "$EXIT_ROLLBACK"
      cutover_active=0
      exit "$EXIT_REMOTE"
    fi
  fi
  if test "$resume_candidate" = 0 && test "$recorded_state" = COMMIT_RELEASE && \
     test "$recorded_result" = success && journal_identity_matches_candidate; then
    exit "$EXIT_IMAGE"
  fi

  verify_pulled_ref "$api_ref" && verify_pulled_ref "$ui_ref" || exit "$EXIT_IMAGE"
  write_override "$api_ref" "$ui_ref" "$override_file" || exit "$EXIT_JOURNAL"
  migration_is_eligible "$staged_root" "$staged_root/migration-delta.sha256" || {
    migration_result=manual-review-required
    journal_transition MIGRATE_CANDIDATE rejected || exit "$EXIT_JOURNAL"
    exit "$EXIT_MIGRATION"
  }

  if test "$resume_candidate" = 1; then
    verify_candidate_running || { fail_after_cutover "$EXIT_IMAGE"; exit "$?"; }
    migration_result=pending
    run_candidate_migration || { fail_after_cutover "$EXIT_MIGRATION"; exit "$?"; }
    migration_result=no-op
    verify_health || { fail_after_cutover "$EXIT_HEALTH_ROLLED_BACK"; exit "$?"; }
    if test "$recorded_result" = success && verify_candidate_previous_good; then
      cutover_active=0
      exit 0
    fi
    if test "$recorded_result" != pending; then
      after_cutover_transition COMMIT_RELEASE pending || exit "$?"
    fi
    write_previous_good || { fail_after_cutover "$EXIT_JOURNAL"; exit "$?"; }
    verify_candidate_previous_good || { fail_after_cutover "$EXIT_JOURNAL"; exit "$?"; }
    after_cutover_transition COMMIT_RELEASE success || exit "$?"
    cutover_active=0
    exit 0
  fi

  journal_transition CAPTURE_PREVIOUS complete || exit "$EXIT_JOURNAL"
  journal_transition STAGE_RELEASE complete || exit "$EXIT_JOURNAL"
  migration_result=pending
  journal_transition MIGRATE_CANDIDATE pending || exit "$EXIT_JOURNAL"
  run_candidate_migration || {
    migration_result=failed
    journal_transition MIGRATE_CANDIDATE failed || exit "$EXIT_JOURNAL"
    exit "$EXIT_MIGRATION"
  }
  migration_result=complete
  journal_transition MIGRATE_CANDIDATE complete || exit "$EXIT_JOURNAL"
  cutover_result=pending
  journal_transition CUTOVER pending || exit "$EXIT_JOURNAL"
  cutover_active=1
  compose up -d --no-deps api ui || { fail_after_cutover "$EXIT_CUTOVER"; exit "$?"; }
  cutover_result=complete
  after_cutover_transition CUTOVER complete || exit "$?"
  backup_result=pending
  compose --profile backup up -d postgres-backup || { fail_after_cutover "$EXIT_CUTOVER"; exit "$?"; }
  backup_result=running
  after_cutover_transition VERIFY_TARGET pending || exit "$?"
  verify_health || { health_result=failed; fail_after_cutover "$EXIT_HEALTH_ROLLED_BACK"; exit "$?"; }
  verify_candidate_running || { health_result=failed; fail_after_cutover "$EXIT_HEALTH_ROLLED_BACK"; exit "$?"; }
  health_result=healthy
  after_cutover_transition VERIFY_TARGET complete || exit "$?"
  after_cutover_transition COMMIT_RELEASE pending || exit "$?"
  write_previous_good || { fail_after_cutover "$EXIT_JOURNAL"; exit "$?"; }
  verify_candidate_previous_good || { fail_after_cutover "$EXIT_JOURNAL"; exit "$?"; }
  after_cutover_transition COMMIT_RELEASE success || exit "$?"
  cutover_active=0
}

file_mode() { stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1"; }
host_token() { if test "$DEPLOY_PORT" = 22; then printf '%s\n' "$DEPLOY_HOST"; else printf '[%s]:%s\n' "$DEPLOY_HOST" "$DEPLOY_PORT"; fi; }

validate_inputs() {
  local name
  for name in DEPLOY_HOST DEPLOY_USER SSH_IDENTITY_FILE SSH_KNOWN_HOSTS_FILE \
    SSH_HOST_KEY_SHA256 PREVIOUS_RELEASE_COMMIT RELEASE_COMMIT API_IMAGE_REF UI_IMAGE_REF REMOTE_APP_ROOT; do require_value "$name"; done
  DEPLOY_PORT="${DEPLOY_PORT:-22}"
  [[ "$DEPLOY_HOST" =~ ^[A-Za-z0-9.-]+$ ]] || die "$EXIT_INPUT" 'invalid deploy host'
  [[ "$DEPLOY_PORT" =~ ^[0-9]+$ ]] && ((DEPLOY_PORT >= 1 && DEPLOY_PORT <= 65535)) || die "$EXIT_INPUT" 'invalid deploy port'
  [[ "$DEPLOY_USER" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ ]] || die "$EXIT_INPUT" 'invalid deploy user'
  [[ "$PREVIOUS_RELEASE_COMMIT" =~ ^[0-9a-f]{40}$ ]] || die "$EXIT_INPUT" 'invalid previous release commit'
  [[ "$RELEASE_COMMIT" =~ ^[0-9a-f]{40}$ ]] || die "$EXIT_INPUT" 'invalid release commit'
  is_digest_ref "$API_IMAGE_REF" && is_digest_ref "$UI_IMAGE_REF" || die "$EXIT_INPUT" 'invalid image digest'
  test "$REMOTE_APP_ROOT" = /opt/braavolabs || die "$EXIT_INPUT" 'unsafe remote root'
  test -f "$SSH_IDENTITY_FILE" && test ! -L "$SSH_IDENTITY_FILE" || die "$EXIT_INPUT" 'identity must be regular non-symlink'
  test "$(file_mode "$SSH_IDENTITY_FILE")" = 600 || die "$EXIT_INPUT" 'identity mode must be 0600'
  test -f "$SSH_KNOWN_HOSTS_FILE" && test ! -L "$SSH_KNOWN_HOSTS_FILE" || die "$EXIT_HOST" 'known_hosts must be regular non-symlink'
  test "$(file_mode "$SSH_KNOWN_HOSTS_FILE")" = 600 || die "$EXIT_HOST" 'known_hosts mode must be 0600'
}

validate_host_identity() {
  local expected_token hosts key_type key_data extra fingerprint count=0 approved=0
  local seen='|' expected expected_seen='|' old_ifs="$IFS" expected_count=0
  expected_token="$(host_token)"; IFS=','
  for expected in $SSH_HOST_KEY_SHA256; do
    [[ "$expected" =~ ^SHA256:[A-Za-z0-9+/]{43}=?$ ]] || die "$EXIT_HOST" 'invalid expected fingerprint'
    case "$expected_seen" in *"|$expected|"*) die "$EXIT_HOST" 'duplicate expected fingerprint' ;; esac
    expected_seen="${expected_seen}${expected}|"
    expected_count=$((expected_count + 1))
  done
  IFS="$old_ifs"
  test "$expected_count" -ge 1 && test "$expected_count" -le 2 || die "$EXIT_HOST" 'invalid rotation set'
  while IFS=' ' read -r hosts key_type key_data extra || test -n "${hosts:-}"; do
    test -n "${hosts:-}" && test -z "${extra:-}" || die "$EXIT_HOST" 'blank or malformed known_hosts line'
    case "$hosts" in \#*|@*|'|'*|*'*'*|*'?'*|*','*) die "$EXIT_HOST" 'unsupported known_hosts line' ;; esac
    test "$hosts" = "$expected_token" || die "$EXIT_HOST" 'unexpected known_hosts host'
    test "$key_type" = ssh-ed25519 || die "$EXIT_HOST" 'unsupported host key type'
    [[ "$key_data" =~ ^[A-Za-z0-9+/]+={0,2}$ ]] || die "$EXIT_HOST" 'malformed host key data'
    fingerprint="$(printf '%s %s\n' "$key_type" "$key_data" | ssh-keygen -lf - -E sha256 | awk 'NF==4 {print $2}')"
    test -n "$fingerprint" || die "$EXIT_HOST" 'fingerprint unavailable'
    case "$seen" in *"|$fingerprint|"*) die "$EXIT_HOST" 'duplicate host key' ;; esac
    seen="${seen}${fingerprint}|"
    case ",$SSH_HOST_KEY_SHA256," in *",$fingerprint,"*) approved=$((approved + 1)) ;; *) die "$EXIT_HOST" 'fingerprint mismatch' ;; esac
    count=$((count + 1))
  done < "$SSH_KNOWN_HOSTS_FILE"
  test "$count" = "$expected_count" && test "$approved" = "$expected_count" || die "$EXIT_HOST" 'ambiguous rotation set'
}

make_ssh_options() {
  SSH_OPTIONS=(-p "$DEPLOY_PORT" -i "$SSH_IDENTITY_FILE" -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$SSH_KNOWN_HOSTS_FILE" -o BatchMode=yes -o ConnectTimeout=15)
  RSYNC_SSH="ssh -p $DEPLOY_PORT -i $SSH_IDENTITY_FILE -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$SSH_KNOWN_HOSTS_FILE -o BatchMode=yes -o ConnectTimeout=15"
  readonly RSYNC_SSH
}

cleanup_local() {
  local primary="$1" cleanup=0
  trap - EXIT HUP INT TERM; set +e; safe_rm "${LOCAL_STAGE:-}"; cleanup="$?"; set -e
  if test "$primary" -ne 0; then exit "$primary"; fi
  if test "$cleanup" -ne 0; then exit "$EXIT_REMOTE"; fi
}
signal_local() { trap - HUP INT TERM; exit "$EXIT_REMOTE"; }

stage_release_inputs() {
  local status path extra delta_tmp discovery_tmp discovery_sha
  LOCAL_STAGE="$(mktemp -d "${TMPDIR:-/tmp}/braavo-release.XXXXXX")"
  REMOTE_INCOMING="$REMOTE_APP_ROOT/incoming/$RELEASE_COMMIT.$$"
  install -d -m 0700 "$LOCAL_STAGE/ENV" "$LOCAL_STAGE/packages/db/prisma"
  cp -p ENV/compose.prod.yaml "$LOCAL_STAGE/ENV/compose.prod.yaml"
  cp -Rp packages/db/prisma/migrations "$LOCAL_STAGE/packages/db/prisma/migrations"
  git cat-file -e "$PREVIOUS_RELEASE_COMMIT^{commit}" || die "$EXIT_MIGRATION" 'previous release commit unavailable'
  git cat-file -e "$RELEASE_COMMIT^{commit}" || die "$EXIT_MIGRATION" 'candidate release commit unavailable'
  delta_tmp="$LOCAL_STAGE/migration-delta.paths"
  discovery_tmp="$LOCAL_STAGE/migration-delta.name-status"
  : > "$delta_tmp"
  : > "$discovery_tmp"
  if ! git diff --name-status "$PREVIOUS_RELEASE_COMMIT" "$RELEASE_COMMIT" -- \
    packages/db/prisma/migrations > "$discovery_tmp"; then
    die "$EXIT_MIGRATION" 'migration delta discovery failed'
  fi
  test -f "$discovery_tmp" && test ! -L "$discovery_tmp" \
    || die "$EXIT_MIGRATION" 'migration delta discovery is not a regular file'
  discovery_sha="$(sha256sum "$discovery_tmp" | awk '{print $1}')" \
    || die "$EXIT_MIGRATION" 'migration delta discovery seal failed'
  while IFS=$'\t' read -r status path extra; do
    test -z "${extra:-}" || die "$EXIT_MIGRATION" 'migration rename/copy is manual review'
    case "$status:$path" in
      A:packages/db/prisma/migrations/*/migration.sql|M:packages/db/prisma/migrations/*/migration.sql)
        printf '%s\n' "$path" >> "$delta_tmp" ;;
      '') ;;
      *) die "$EXIT_MIGRATION" "migration delta is not additive/modified SQL: $status $path" ;;
    esac
  done < "$discovery_tmp"
  LC_ALL=C sort -u "$delta_tmp" -o "$delta_tmp"
  : > "$LOCAL_STAGE/migration-delta.sha256"
  while IFS= read -r path; do
    test -f "$LOCAL_STAGE/$path" && test ! -L "$LOCAL_STAGE/$path" \
      || die "$EXIT_MIGRATION" "manifested migration missing: $path"
    (cd "$LOCAL_STAGE" && sha256sum "$path") >> "$LOCAL_STAGE/migration-delta.sha256"
  done < "$delta_tmp"
  rm -f "$delta_tmp"
  delta_sha="$(sha256sum "$LOCAL_STAGE/migration-delta.sha256" | awk '{print $1}')"
  printf 'previousRelease=%s\ncandidateRelease=%s\napi=%s\nui=%s\ndiscoverySha256=%s\ndeltaSha256=%s\n' \
    "$PREVIOUS_RELEASE_COMMIT" "$RELEASE_COMMIT" "$API_IMAGE_REF" "$UI_IMAGE_REF" \
    "$discovery_sha" "$delta_sha" \
    > "$LOCAL_STAGE/migration-delta.meta"
  (cd "$LOCAL_STAGE" && {
    printf '%s\0' migration-delta.meta migration-delta.name-status migration-delta.sha256
    find ENV packages -type f -print0
  } | LC_ALL=C sort -z | xargs -0 sha256sum > release-inputs.sha256)
}

transfer_release_inputs() {
  ssh "${SSH_OPTIONS[@]}" "$TARGET" sudo install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 0700 "$REMOTE_INCOMING" || die "$EXIT_REMOTE" 'secure staging failed'
  rsync -a --delete --chmod=Du=rwx,Dgo=,Fu=rw,Fgo= -e "$RSYNC_SSH" -- "$LOCAL_STAGE/" "$TARGET:$REMOTE_INCOMING/" || die "$EXIT_REMOTE" 'strict copy failed'
}

run_remote_release() {
  local incoming="$1" primary=0
  ssh "${SSH_OPTIONS[@]}" "$TARGET" sudo bash -s -- --remote "$RELEASE_COMMIT" "$API_IMAGE_REF" "$UI_IMAGE_REF" "$REMOTE_APP_ROOT" "$incoming" < "$0" || primary="$?"
  if test "$primary" -ne 0; then
    set +e; ssh "${SSH_OPTIONS[@]}" "$TARGET" sudo docker compose -p braavolabs ps >&2; set -e
    return "$primary"
  fi
}

local_main() {
  validate_inputs; validate_host_identity; TARGET="${DEPLOY_USER}@${DEPLOY_HOST}"; make_ssh_options
  trap 'cleanup_local "$?"' EXIT; trap signal_local HUP INT TERM
  stage_release_inputs
  ssh "${SSH_OPTIONS[@]}" "$TARGET" true || die "$EXIT_REMOTE" 'remote preflight failed'
  previous_json="$(ssh "${SSH_OPTIONS[@]}" "$TARGET" sudo cat /opt/braavolabs/releases/previous-good.json)" \
    || die "$EXIT_REMOTE" 'previous-good read failed'
  remote_release="$(printf '%s\n' "$previous_json" | sed -n 's/.*"release":"\([0-9a-f]*\)".*/\1/p')"
  remote_base_release="$(printf '%s\n' "$previous_json" | sed -n 's/.*"previousRelease":"\([0-9a-f]*\)".*/\1/p')"
  [[ "$remote_release" =~ ^[0-9a-f]{40}$ ]] || die "$EXIT_REMOTE" 'invalid previous-good release'
  if test "$remote_release" = "$RELEASE_COMMIT"; then
    test "$remote_base_release" = "$PREVIOUS_RELEASE_COMMIT" || die "$EXIT_MIGRATION" 'previous release drift'
  else
    test "$remote_release" = "$PREVIOUS_RELEASE_COMMIT" || die "$EXIT_MIGRATION" 'previous release drift'
  fi
  transfer_release_inputs
  run_remote_release "$REMOTE_INCOMING"
}

if test "${1:-}" = --remote; then shift; remote_main "$@"; else local_main "$@"; fi
