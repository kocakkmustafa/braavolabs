<div align="center">

<img src="packages/ui/public/braavolabs-logo.png" alt="Braavolabs" width="120" />

# Braavolabs

**Your AI agents & automations workspace.**

Build, run, and steer AI agent workflows in plain English — or connect the n8n / Make / Zapier automations you already run — and control them all from one workspace. BYOK, on-device optional. Every decision is logged, every spend is approved, every run is audited end-to-end. (The flagship onboarding template still spins up a fully-staffed **AI company** in ~10 minutes.)

🌍 **Production:** [braavolabs.com](https://braavolabs.com)

![Node](https://img.shields.io/badge/node-%3E%3D20-3c873a)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6)
![Next.js](https://img.shields.io/badge/Next.js-15-000)
![Postgres](https://img.shields.io/badge/Postgres-16-336791)
![Tests](https://img.shields.io/badge/tests-133%20passing-brightgreen)
![i18n](https://img.shields.io/badge/i18n-6%20locales-00d1ff)

</div>

---

## What it does

Users sign up, describe their idea (or pick a starter — Content Studio, Outreach Strategist, Market Research, Brand Voice Builder), and Braavolabs composes a multi-agent AI team with a runnable pipeline. The platform is **BYOK** — users plug in their own Claude / OpenAI / Gemini / Groq / Ollama / 8 more provider keys, or take 3 free trial runs on a platform-provided Groq pool.

Every pipeline run produces:
- A reasoned, step-by-step audit trail (every tool call, every decision, every cost cent)
- Spend-approval gates for any action that touches money
- Risk stops (cost anomaly, loop detection, brand-violation, spam)
- Optional encrypted, machine-bound exports for offline / air-gapped use

---

## New in v2

The platform generalised from "an AI company" into an **agent & automation workspace** — the v1 capabilities stay; v2 adds:

- **Mid-run steering (HITL moat)** — inject guidance into a live agent on its next turn (`POST /runs/:id/steer`), or have an agent **ask the operator a question** (`ask_user`) and resume on the answer. Resume is idempotent: already-completed steps are skipped, not re-run.
- **Connect & monitor external automations** — link an existing **n8n / Make / Zapier / generic-REST** instance; a poller mirrors its executions into one dashboard alongside native runs (`/connections`).
- **Visual builder** — `/pipelines/[id]` has a List + interactive **React-Flow DAG canvas** and a **parallel-aware step editor** (group steps into concurrent stages).
- **Real-time** — run views stream over SSE (Redis pub/sub) instead of polling.
- **Full i18n** — every UI surface localized across **6 locales** (en/tr/es/de/fr/ar).
- **CLI** — dep-free `braavo` (`login / runs / run / steer / connections`).
- **Mobile** — pocket control (run detail, steer, answer `ask_user`, push deep-links) + an offline / on-device (Gemma) mode toggle.
- **Plans** — tiers re-scoped to automation dimensions (workspaces, connected automations, seats, on-device); prices unchanged.

---

## Quick start (local dev)

```bash
# 1. Clone
git clone https://github.com/kocakkmustafa/braavolabs.git
cd braavolabs

# 2. Dependencies + Prisma client
pnpm install
pnpm --filter @ai-company-os/db generate

# 3. Local services (Postgres + Redis)
docker compose -f ENV/compose.yaml up -d

# 4. Env
cp .env.example .env
# Generate the two required secrets:
#   ENCRYPTION_KEY=$(openssl rand -hex 32)
#   JWT_SECRET=$(openssl rand -hex 32)
# Then edit .env with both.

# 5. Migrate + start dev
pnpm db:migrate
pnpm dev
```

App is at `http://localhost:3000`, API at `http://localhost:8080`.

---

## Tech stack

| Layer | Choice |
|---|---|
| **Backend** | Node.js + TypeScript + Express + Prisma |
| **Frontend** | Next.js 15 (App Router) + Tailwind + Material Symbols |
| **Database** | Postgres 16 + pgvector (HNSW index) |
| **Cache / queue** | Redis 7 + BullMQ |
| **LLM** | Anthropic / OpenAI / Google / Mistral / Groq / OpenRouter / DeepSeek / Kimi / Qwen / Ollama / LM Studio / custom (12 providers, BYOK) |
| **Auth** | JWT + refresh tokens, Google + GitHub OAuth |
| **Billing** | Stripe (subscription + usage-based) |
| **Crypto** | AES-256-GCM (scrypt-derived), HKDF-SHA256, JWT HS256 |
| **i18n** | next-intl (en, tr, es, de, fr, ar) |
| **Monorepo** | pnpm workspaces + Turbo |
| **Container** | Docker Compose |
| **CI / CD** | GitHub Actions → Lightsail (Frankfurt) + Cloudflare CDN |

---

## Repo layout

```
braavolabs/
├── packages/
│   ├── api/                # Express API (auth, pipelines, agents, billing, license, ...)
│   ├── ui/                 # Next.js dashboard + marketing pages
│   ├── db/                 # Prisma schema + migrations
│   ├── core/               # Shared types + utilities
│   ├── memory/             # Episodic + semantic + graph memory engine
│   └── integrations/       # External service adapters
├── ENV/                    # Dockerfiles + compose.yaml + nginx config
├── docs/                   # Runbooks, design briefs, marketing, research
├── .github/workflows/      # CI + Build & Deploy pipelines
└── scripts/                # Self-hosted install script
```

---

## Documentation

| Topic | File |
|---|---|
| Custom domain split (api / app subdomains) | [docs/custom-domain-setup.md](docs/custom-domain-setup.md) |
| Pipeline export DRM (machine-bound encryption) | [docs/pipeline-drm.md](docs/pipeline-drm.md) |
| Deployment runbook (GitHub Actions → Lightsail) | [docs/deployment-github-actions.md](docs/deployment-github-actions.md) |

Plus product context for Claude / coding agents in [`CLAUDE.md`](CLAUDE.md).

---

## Self-hosting

Operators who want to run their own instance:

```bash
curl -sSL https://raw.githubusercontent.com/kocakkmustafa/braavolabs/main/scripts/install.sh | bash
```

The installer drops a working `docker compose` stack with all 4 services. You bring your own:
- Cloudflare or Caddy for TLS
- Postgres backup off-site target (S3-compatible)
- LLM provider key (or set `GROQ_API_KEY` to enable trial-free user runs)

See [`docs/deployment-github-actions.md`](docs/deployment-github-actions.md) for the production reference deployment.

---

## Status

Production. **133 tests passing**, typecheck clean across every workspace package, OWASP Top 10 coverage in place: parameterized SQL via Prisma, per-tenant isolation on every query, HMAC-signed Stripe webhooks with replay-bound timestamps, fail-closed rate limits (auth + IAP + register + refresh, even when Redis is unreachable), strict CSP + HSTS + frame-ancestors, AES-256-GCM at-rest credential encryption (scrypt-derived per-row key, placeholder-detection at boot), cross-tenant IAP hijack defence, SSRF guard on tenant-controlled outbound URLs (blocks AWS / GCP / Azure metadata endpoints, loopback, RFC1918 ranges from every BYOK provider and integration code path), and refresh tokens that re-read user + tenant from the database on every rotation so role / workspace changes propagate within one round-trip.

---

## License

Source-available, all-rights-reserved during early access. For commercial / self-hosting licensing reach out at [founder@braavolabs.com](mailto:founder@braavolabs.com).
