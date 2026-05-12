# CLAUDE.md — Braavolabs

Product context for Claude Code and other coding agents working in this
repo. Keep this file short and load-bearing: it's read into every agent
session, so out-of-date claims here cost more than they save.

## What Braavolabs is

A BYOK multi-agent platform that turns a plain-English business idea
into a staffed autonomous AI company. Users describe their business →
Claude runs a 2-3 turn clarification loop → the system composes a set
of agents across nine primitives (acquisition, sales, delivery,
content, operations, finance, analytics, memory, governance) and gives
them a runnable pipeline.

Every action is logged, every step records its reasoning, every spend
is gated by an explicit approval, and five risk stops (hard, loop,
cost-anomaly, spam, brand-violation) protect the user from runaway
behaviour. Cloud + self-hosted hybrid; pipelines export as
machine-bound encrypted bundles for offline / air-gapped use.

## Stack

- **Monorepo**: pnpm workspaces + Turbo
- **API**: Node.js + TypeScript + Express + Prisma 5
- **UI**: Next.js 15 (App Router) + Tailwind CSS + Material Symbols
- **DB**: Postgres 16 + pgvector (HNSW)
- **Cache / queue**: Redis 7 + BullMQ
- **LLM**: 12-provider BYOK router (Anthropic, OpenAI, Google,
  Mistral, Groq, OpenRouter, DeepSeek, Kimi, Qwen, Ollama, LM Studio,
  Custom). Trial pool routes free-tier users through Groq.
- **Auth**: JWT + rotated refresh tokens (Redis allowlist), Google +
  GitHub OAuth with CSRF state
- **Billing**: Stripe (subscription + usage meters) + Apple /
  Google IAP via the `/billing/iap` bridge
- **i18n**: next-intl in 6 locales (en, tr, es, de, fr, ar)
- **Crypto**: AES-256-GCM (scrypt-derived per-row key), HKDF-SHA256
  for license tokens, HS256 JWTs pinned at verify time
- **Observability**: Pino + OpenTelemetry + Sentry
- **CI / CD**: GitHub Actions → Lightsail (Frankfurt) + Cloudflare CDN

## Common commands

```bash
pnpm install                       # bootstrap workspaces
pnpm dev                           # turbo dev — api + ui + workers
pnpm build                         # turbo build
pnpm lint                          # lint
pnpm -r --if-present test          # run tests across workspaces
pnpm db:migrate                    # prisma migrate
pnpm db:seed                       # prisma seed
pnpm db:generate                   # regen prisma client
pnpm docker:up / docker:down       # local Postgres + Redis
```

## Repo layout

```
braavolabs/
├── packages/
│   ├── api/                       # Express API
│   ├── ui/                        # Next.js dashboard + marketing
│   ├── db/                        # Prisma schema + migrations
│   ├── core/                      # Shared types + utilities
│   ├── memory/                    # Episodic + semantic + graph memory
│   └── integrations/              # External adapters (HubSpot, Stripe, …)
├── ENV/                           # Dockerfiles + compose + nginx
├── HOLDING_CORE/policies/         # Operational policy docs
├── docs/                          # Runbooks + design brief
├── .github/workflows/             # CI + deploy pipelines
└── scripts/install.sh             # Self-hosted installer
```

## Database

20 core tables: `tenants`, `users`, `companies`, `agents`, `pipelines`,
`runs`, `run_steps`, `tool_calls`, `approvals`, `memory_items`,
`memory_embeddings`, `memory_edges`, `contacts`, `deals`,
`outreach_sequences`, `outreach_enrollments`, `usage_meters`,
`eval_results`, `activity_log`, `drafts` — plus billing
(`mobile_subscriptions`, Stripe webhook idempotency, referrals).

## API surface (top routes)

- `POST /api/v1/auth/{register,login,refresh,logout,forgot-password,reset-password}`
- `GET  /api/v1/auth/{google,github}/callback` (CSRF-stateful)
- `CRUD /api/v1/companies` (+ `pause/resume`)
- `POST /api/v1/pipelines/:id/run`, `GET /api/v1/runs/:id` (SSE-streamable), `/run-steps/:id/{rollback,rerun}`
- `/api/v1/approvals` — spend-approval queue
- `/api/v1/memory/search` — semantic + graph
- `/api/v1/drafts`, `/api/v1/dashboard/*`
- `/api/v1/billing/usage`, `/api/v1/billing/iap/{verify,entitlement,apple/notify,google/notify}`
- `/api/v1/growth/{pql,blueprint}` — PQL + blueprint sharing
- `/hooks/:company_slug/:event` — external webhook fan-in (HMAC,
  required timestamp, 5-min replay window)

## Non-negotiable rules

1. **Every tool call is logged** to `tool_calls`.
2. **Every step has a reasoning field** — never empty.
3. **Money-touching actions require an approval row**.
4. **Single-example generalisations are forbidden** — a memory needs
   2+ successful occurrences across companies before it's promoted
   from `candidate` → `approved`.
5. **Memory lifecycle**: candidate → approved → deprecated. Never
   write `approved` directly.
6. **Spam guard**: ≥3 unanswered sends to the same target stops the
   sequence.
7. **Loop guard**: ≥5 consecutive failures auto-stops the pipeline.
8. **Cost anomaly**: any run >20% over budget halts mid-execution.
9. **`activity_log` everywhere** — every CRUD, send, and decision.
10. **Tenant isolation**: every Prisma `where` clause includes
    `tenantId` (or traverses to it).

## Code organisation

- New modules live under `packages/api/src/modules/<feature>/` or
  `packages/ui/app/<route>/`.
- Shared types in `packages/core/src/types/`.
- External adapters in `packages/integrations/src/`.
- Operational policy in `HOLDING_CORE/policies/`.
- Environment variables go in both `.env.example` (template) and
  `packages/api/src/config/env.ts` (Zod validator).
- Docker services in `ENV/compose.yaml` + `ENV/compose.prod.yaml`.
