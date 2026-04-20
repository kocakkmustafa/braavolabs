#!/usr/bin/env bash
# Pre-edit hook — The Creator ajan takımı
# Her ajan kod düzenlemesi (Edit/Write/Create) öncesi çalışır
# Amacı: git snapshot al, rollback her zaman mümkün olsun

set -e

# Git repo olmadığı durumda sessizce geç
if [ ! -d ".git" ]; then
  exit 0
fi

# Uncommitted değişiklik yoksa geç
if [ -z "$(git status --porcelain)" ]; then
  exit 0
fi

# Snapshot al
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
AGENT="${CLAUDE_AGENT_NAME:-unknown}"
COMMIT_MSG="snapshot: pre-edit by $AGENT at $TIMESTAMP"

git add -A
git commit -m "$COMMIT_MSG" --quiet 2>/dev/null || true

# Log (debugging için)
mkdir -p .claude/context/logs
echo "[$(date)] Pre-edit snapshot: $AGENT" >> .claude/context/logs/hooks.log

# Extra: Önemli dosyaların ayrı yedeği (kritik config/migration)
if [ -d ".claude/context/backups" ] || mkdir -p .claude/context/backups; then
  BACKUP_DIR=".claude/context/backups/pre-$TIMESTAMP"
  mkdir -p "$BACKUP_DIR"
  
  # Config dosyaları
  for f in package.json tsconfig.json next.config.js next.config.ts middleware.ts .env.example; do
    [ -f "$f" ] && cp "$f" "$BACKUP_DIR/" 2>/dev/null || true
  done
  
  # Migration'lar
  if [ -d "supabase/migrations" ]; then
    cp -r supabase/migrations "$BACKUP_DIR/" 2>/dev/null || true
  fi
fi

exit 0
