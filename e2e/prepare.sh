#!/usr/bin/env bash
# Prepare the E2E environment. Idempotent; safe to re-run.
#
# Next's `output: "standalone"` bundle does NOT include .next/static or public/,
# so the server starts but every asset 404s and pages render unstyled — which
# looks like an app bug rather than a packaging step. Linking them is the fix.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB_NAME="${E2E_DB_NAME:-aicos_e2e}"
DB_USER="${USER:-postgres}"

echo "── database: $DB_NAME (DROPPED and recreated — throwaway only) ──"
psql -d postgres -c "DROP DATABASE IF EXISTS $DB_NAME;" >/dev/null
psql -d postgres -c "CREATE DATABASE $DB_NAME;" >/dev/null
psql -d "$DB_NAME" -c "CREATE EXTENSION IF NOT EXISTS vector;" >/dev/null
DATABASE_URL="postgresql://$DB_USER@localhost:5432/$DB_NAME" \
  pnpm --filter @ai-company-os/db exec prisma db push --skip-generate --accept-data-loss >/dev/null
echo "   schema pushed"

echo "── redis: clear rate-limit counters ──"
# Auth endpoints are rate-limited per IP with a 15-minute window, and every
# test shares 127.0.0.1. Left over from a previous run (or from manual probing)
# these counters make registration return 429 and the suite fails for a reason
# that has nothing to do with the code under test.
redis-cli --scan --pattern 'rl:*' 2>/dev/null | xargs -r redis-cli del >/dev/null 2>&1 || true
echo "   rl:* cleared"

echo "── build ──"
cd "$ROOT"
pnpm build >/dev/null
SA="$ROOT/packages/ui/.next/standalone/packages/ui"
mkdir -p "$SA/.next"
rm -rf "$SA/.next/static" "$SA/public"
cp -R "$ROOT/packages/ui/.next/static" "$SA/.next/static"
[ -d "$ROOT/packages/ui/public" ] && cp -R "$ROOT/packages/ui/public" "$SA/public" || true
echo "   standalone assets linked"
echo "ready — run: pnpm exec playwright test"
