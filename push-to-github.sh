#!/bin/bash
# AI Company OS — Push all fixes to GitHub
# Run this from the project root: bash push-to-github.sh

set -e

echo "🔧 Fixing git worktree state..."

# Remove stale index lock
rm -f .git/index.lock

# Remove stale worktree references
rm -rf .git/worktrees/*

# Remove worktreeConfig extension from git config
git config --unset extensions.worktreeConfig 2>/dev/null || true

echo "✅ Git state cleaned"

echo ""
echo "📋 Changed files:"
git status --short

echo ""
echo "📦 Staging all changes..."
git add -A

echo ""
echo "💾 Creating commit..."
git commit -m "$(cat <<'EOF'
fix: comprehensive bug fixes, security hardening, and production readiness

Session 1-4: Fixed 7 bugs including collaboration heartbeat 404, Material Icons
rendering, sidebar overlapping public pages, settings sign out button overlap,
onboarding checklist z-index, scroll-behavior warning, and silent error handling.
Created 9 missing compiled JS modules for dist/.

Session 5: Fixed 13 more bugs — dark/light theme toggle, form validations
(companies/new, A/B tests, onboarding), toast feedback (settings save, webhook
install), billing spacing, marketplace layout, onboarding channel wrap + sticky
button, drafts dropdown label, and Material Icons FOUT preloading.

Security hardening:
- Added rate limiting to /auth/refresh endpoint
- Removed unsafe-eval from CSP, narrowed connect-src
- Added HSTS + X-XSS-Protection + base-uri + form-action to frontend headers
- Added CORS maxAge (24h preflight caching)
- Added JWT_SECRET length warning for production
- Updated README with security section and production checklist

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"

echo ""
echo "🚀 Pushing to GitHub..."
git push origin main

echo ""
echo "✅ All done! Changes pushed to GitHub successfully."
