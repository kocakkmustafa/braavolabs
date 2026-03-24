#!/usr/bin/env bash
set -euo pipefail

# ──────────────────────────────────────────────────────────
# AI Company OS — Self-Hosted Install Script
# ──────────────────────────────────────────────────────────
#
# Usage:
#   curl -sSL https://raw.githubusercontent.com/<repo>/main/scripts/install.sh | bash
#   OR
#   ./scripts/install.sh
#
# Prerequisites:
#   - Docker + Docker Compose v2
#   - Git
# ──────────────────────────────────────────────────────────

INSTALL_DIR="${AICOS_INSTALL_DIR:-$HOME/ai-company-os}"

echo "╔═══════════════════════════════════════════════╗"
echo "║        AI Company OS — Self-Hosted Setup      ║"
echo "╚═══════════════════════════════════════════════╝"
echo ""

# Check prerequisites
command -v docker >/dev/null 2>&1 || { echo "Error: Docker is required but not installed."; exit 1; }
command -v git >/dev/null 2>&1 || { echo "Error: Git is required but not installed."; exit 1; }

# Check Docker Compose
if docker compose version >/dev/null 2>&1; then
  COMPOSE_CMD="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_CMD="docker-compose"
else
  echo "Error: Docker Compose is required but not installed."
  exit 1
fi

echo "1/5  Checking prerequisites..."
echo "     Docker: $(docker --version | head -1)"
echo "     Compose: $($COMPOSE_CMD version | head -1)"
echo ""

# Clone or update
if [ -d "$INSTALL_DIR" ]; then
  echo "2/5  Updating existing installation..."
  cd "$INSTALL_DIR"
  git pull --ff-only 2>/dev/null || echo "     (skipped git pull — not a git repo)"
else
  echo "2/5  Creating installation directory..."
  mkdir -p "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi

# Generate .env if not exists
if [ ! -f ".env" ]; then
  echo "3/5  Generating environment configuration..."

  POSTGRES_PASSWORD=$(openssl rand -hex 16 2>/dev/null || head -c 32 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 32)
  REDIS_PASSWORD=$(openssl rand -hex 16 2>/dev/null || head -c 32 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 32)
  JWT_SECRET=$(openssl rand -hex 32 2>/dev/null || head -c 64 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 64)

  cat > .env <<ENVEOF
# AI Company OS — Production Environment
# Generated on $(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Database
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
DATABASE_URL=postgresql://aicos:$POSTGRES_PASSWORD@postgres:5432/aicos_dev?schema=public

# Redis
REDIS_PASSWORD=$REDIS_PASSWORD
REDIS_URL=redis://:$REDIS_PASSWORD@redis:6379

# Auth
JWT_SECRET=$JWT_SECRET

# API
API_PORT=8080
APP_URL=http://localhost:3000

# UI
UI_PORT=3000
NEXT_PUBLIC_API_URL=http://localhost:8080/api/v1

# Claude / Anthropic (required for AI agents)
ANTHROPIC_API_KEY=

# Stripe (optional — for billing)
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=

# HubSpot (optional — for CRM sync)
HUBSPOT_ACCESS_TOKEN=

# SendGrid (optional — for email)
SENDGRID_API_KEY=

# OpenTelemetry (optional — for observability)
OTEL_EXPORTER_OTLP_ENDPOINT=
ENVEOF

  echo "     .env created with random credentials"
  echo ""
  echo "     IMPORTANT: Add your ANTHROPIC_API_KEY to .env for AI agents to work"
else
  echo "3/5  Using existing .env configuration"
fi

# Copy compose files if needed
if [ ! -f "compose.yaml" ]; then
  if [ -f "ENV/compose.yaml" ]; then
    cp ENV/compose.yaml compose.yaml
    cp ENV/compose.prod.yaml compose.prod.yaml
  fi
fi

echo "4/5  Starting services..."
$COMPOSE_CMD -f compose.yaml -f compose.prod.yaml up -d

echo ""
echo "5/5  Waiting for services to be healthy..."
sleep 5

# Check health
for i in {1..30}; do
  if curl -sf http://localhost:8080/health >/dev/null 2>&1; then
    echo ""
    echo "╔═══════════════════════════════════════════════╗"
    echo "║          AI Company OS is running!            ║"
    echo "╠═══════════════════════════════════════════════╣"
    echo "║  Dashboard:  http://localhost:3000            ║"
    echo "║  API:        http://localhost:8080/api/v1     ║"
    echo "║  Health:     http://localhost:8080/health     ║"
    echo "╠═══════════════════════════════════════════════╣"
    echo "║  Next steps:                                  ║"
    echo "║  1. Add ANTHROPIC_API_KEY to .env             ║"
    echo "║  2. Run: docker compose restart api           ║"
    echo "║  3. Open http://localhost:3000                ║"
    echo "╚═══════════════════════════════════════════════╝"
    exit 0
  fi
  sleep 2
done

echo ""
echo "Warning: API health check failed after 60s."
echo "Check logs with: $COMPOSE_CMD logs api"
echo "Services may still be starting up."
