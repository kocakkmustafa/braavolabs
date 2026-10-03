# CLAUDE.md — Braavolabs

Ortak şirket/ürün/servis/durum bağlamı için önce [YULAlab ortak girişini](../../../AGENTS.md) oku. Teknik yöntemi model seçer; bu dosya işlem yetkisi üretmez. Yerel ürün ve güvenlik bilgileri aşağıdadır.

Braavo/Braavolabs API ve yerel modelleri telefon, desktop ve CLI üzerinden orkestre eden AI çalışma platformunu hedefler. Mevcut company/pipeline modülleri bu kaynakta yer alır; eski "otonom şirket" anlatımı tüm güncel ürün hedefini tanımlamaz.

Every action is logged, every step records its reasoning, every spend
is gated by an explicit approval, and five risk stops (hard, loop,
cost-anomaly, spam, brand-violation) protect the user from runaway
behaviour. Cloud + self-hosted hybrid; pipelines export as
machine-bound encrypted bundles for offline / air-gapped use.

## Mevcut kaynak mimarisi (tasarım reçetesi değildir)

- **Monorepo**: pnpm workspaces + Turbo
- **API**: Node.js + TypeScript + Express + Prisma 5
- **UI**: Next.js 15 (App Router) + Tailwind CSS + Material Symbols
- **DB**: Postgres 16 + pgvector (HNSW)
- **Cache / queue**: Redis 7 + BullMQ
- **LLM**: 14-provider BYOK router (Anthropic, OpenAI, Google,
  Mistral, Groq, OpenRouter, DeepSeek, Kimi, Qwen, Cerebras, Zhipu GLM,
  Ollama, LM Studio, Custom). Trial pool routes free-tier users through
  Groq.
- **Auth**: JWT + rotated refresh tokens (Redis allowlist), Google +
  GitHub OAuth with CSRF state
- **Billing**: Stripe (subscription + usage meters) + Apple /
  Google IAP via the `/billing/iap` bridge
- **i18n**: next-intl in 6 locales (en, tr, es, de, fr, ar)
- **Crypto**: AES-256-GCM (scrypt-derived per-row key), HKDF-SHA256
  for license tokens, HS256 JWTs pinned at verify time
- **Observability**: Pino + OpenTelemetry + Sentry
- **CI / CD**: GitHub Actions → Lightsail (Frankfurt) + Cloudflare CDN


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
├── docs/                          # Runbooks + design brief
├── .github/workflows/             # CI + deploy pipelines
└── scripts/install.sh             # Self-hosted installer
```

## Database

47 models (was "20 core" pre-v2; the v2 expansion added voice, web
research, A/B testing, marketplace, SSO, external automation, devices,
etc.). The tenant-isolation core: `tenants`, `users`, `companies`,
`agents`, `pipelines`, `runs`, `run_steps`, `tool_calls`, `approvals`,
`memory_items`, `memory_embeddings`, `memory_edges`, `contacts`, `deals`,
`outreach_sequences`, `outreach_enrollments`, `usage_meters`,
`eval_results`, `activity_log`, `drafts` — plus billing
(`mobile_subscriptions`, Stripe webhook idempotency, referrals).

Row-Level Security: `tenant_rls` (8 tables) + `tenant_rls_extend`
(remaining tenant tables) add defense-in-depth RLS policies. They are
FAIL-OPEN and only enforce when the app runs as a non-superuser DB role
AND `app.tenant_id` is set transaction-locally on the query connection —
see the migration headers. The primary isolation guarantee is the
application-layer `where tenantId` clause (rule #10).

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

## Mevcut kod yerleşimi

- Existing modules live under `packages/api/src/modules/<feature>/` or
  `packages/ui/app/<route>/`.
- Shared types in `packages/core/src/types/`.
- External adapters in `packages/integrations/src/`.
- Environment variables go in both `.env.example` (template) and
  `packages/api/src/config/env.ts` (Zod validator).
- Docker services in `ENV/compose.yaml` + `ENV/compose.prod.yaml`.
