#!/usr/bin/env bash
#
# Post-merge workflow watchdog (BR-P0-005).
#
# Answers one question honestly: did the workflows we EXPECT for a commit
# actually run, and did their jobs actually EXECUTE?
#
# Why the second half matters. On 2026-08-19 a merge to main produced a
# "Build & Deploy" run and a "CI" run — both existed, both were reachable by
# the API, and a naive check for "was a run created for this SHA?" would have
# reported success. But the GitHub Actions budget was exhausted, so the jobs
# were never started: every job came back `conclusion: failure` with an EMPTY
# steps array, and the deploy never touched production. The fix shipped, main
# said "merged", and nothing was deployed for hours.
#
# So this checks three distinct states, because they need different responses:
#
#   NO_RUN       the trigger never fired            → workflow/branch filter wrong
#   NOT_STARTED  run exists, zero steps executed    → account/billing/runner problem
#   FAILED       jobs ran and failed                → a real code failure
#
# Runs anywhere gh is authenticated: a laptop, a cron, another CI.
#
# LIMITATION, deliberately not papered over: when GitHub Actions is entirely
# blocked, a watchdog that itself runs IN Actions cannot report it — it would be
# blocked too. That is exactly the outage this exists for, so run it OUTSIDE
# Actions (locally or from a scheduler) for it to be worth anything.
set -uo pipefail

REPO="${WATCHDOG_REPO:-kocakkmustafa/braavolabs}"
SHA="${1:-}"
shift || true
EXPECTED=("$@")
[ ${#EXPECTED[@]} -eq 0 ] && EXPECTED=("CI" "Build & Deploy")

if [ -z "$SHA" ]; then
  echo "usage: $0 <sha> [expected workflow name ...]" >&2
  exit 2
fi

# The runs API filters head_sha by EXACT match, so a short SHA silently returns
# nothing and the check reports NO_RUN — the most misleading answer available,
# because it sends you to look at workflow triggers when the real problem may be
# billing. Resolve to the full SHA first. (Caught by testing the tool against a
# commit whose run demonstrably existed.)
if [ ${#SHA} -lt 40 ]; then
  FULL=$(git rev-parse "$SHA" 2>/dev/null || true)
  if [ -n "$FULL" ] && [ ${#FULL} -eq 40 ]; then
    SHA="$FULL"
  else
    echo "warning: '$SHA' is not a full 40-char SHA and could not be resolved locally;" >&2
    echo "         a NO_RUN result below may be a lookup artifact rather than reality." >&2
  fi
fi

echo "watchdog: repo=$REPO sha=${SHA:0:7} expecting: ${EXPECTED[*]}"
RUNS=$(gh api "repos/$REPO/actions/runs?head_sha=$SHA&per_page=50" 2>/dev/null) || {
  echo "RESULT: API_ERROR — could not query GitHub" >&2; exit 3; }

problems=0
for want in "${EXPECTED[@]}"; do
  id=$(echo "$RUNS" | jq -r --arg n "$want" '[.workflow_runs[] | select(.name==$n)] | sort_by(.created_at) | last | .id // empty')
  if [ -z "$id" ]; then
    echo "  ✗ $want: NO_RUN — the trigger never fired for this commit"
    problems=$((problems+1)); continue
  fi
  jobs=$(gh api "repos/$REPO/actions/runs/$id/jobs" 2>/dev/null)
  total=$(echo "$jobs" | jq '[.jobs[]] | length')
  # A job that never started reports zero steps. This is the signal a naive
  # "did a run exist" check misses entirely.
  started=$(echo "$jobs" | jq '[.jobs[] | select((.steps|length) > 0)] | length')
  concl=$(echo "$RUNS" | jq -r --arg n "$want" '[.workflow_runs[] | select(.name==$n)] | sort_by(.created_at) | last | .conclusion // "pending"')

  if [ "$started" -eq 0 ] && [ "$total" -gt 0 ]; then
    echo "  ✗ $want: NOT_STARTED — run $id exists but 0/$total jobs executed a single step."
    echo "      Account/billing/runner problem, NOT a code failure. Fix the account, then re-run."
    problems=$((problems+1))
  elif [ "$started" -lt "$total" ] && [ "$concl" != "success" ]; then
    # Observed for real on 2026-08-19: the budget was exhausted PART WAY through
    # a run, so the first job completed all its steps and every later job came
    # back failed with zero steps. Reading that as a code failure sends you to
    # read logs that do not exist.
    echo "  ✗ $want: CUT_OFF — only $started/$total jobs executed any step (conclusion: $concl)."
    echo "      A run that began and was then starved — check the account before the code."
    problems=$((problems+1))
  elif [ "$concl" != "success" ]; then
    echo "  ✗ $want: $concl — $started/$total jobs ran. A real failure; read the logs."
    problems=$((problems+1))
  else
    echo "  ✓ $want: success ($started/$total jobs ran)"
  fi
done

if [ "$problems" -gt 0 ]; then
  echo "RESULT: $problems expected workflow(s) did not complete successfully."
  exit 1
fi
echo "RESULT: all expected workflows ran and succeeded."
