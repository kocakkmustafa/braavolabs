# Braavolabs — Braavolabs

**Your AI company. Built in 10 minutes. Runs on autopilot.**

Describe your business in plain English. Braavolabs builds a fully-staffed autonomous company — content, sales, ops — that runs while you sleep. Every decision is logged, every spend is approved by you, every run is audited end-to-end.

Built for **creators and solo founders** who want to scale without hiring. Claude-native, self-hostable, exportable as a Claude Code skill bundle.

![License](https://img.shields.io/badge/license-MIT-blue)
![Node](https://img.shields.io/badge/node-%3E%3D20-green)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)
![Phase](https://img.shields.io/badge/phase-launch--ready%20(code)-brightgreen)
![Tests](https://img.shields.io/badge/tests-27%20passing-brightgreen)

---

## Quick Start

```bash
# 1. Clone and install
git clone https://github.com/kocakkmustafa/The-Creator.git
cd The-Creator
pnpm install

# 2. Set up environment
cp .env.example .env
# Edit .env with your credentials (see Configuration below)

# 3. Start database and services
docker compose -f ENV/compose.yaml up -d

# 4. Run migrations
pnpm db:migrate
pnpm db:generate

# 5. Start development
pnpm dev
```

The app runs at:
- **Frontend**: http://localhost:3000
- **API**: http://localhost:8080

---

## Features

| Feature | Description |
|---------|-------------|
| **Freeform Company Builder** | Describe your company in plain text — AI configures everything via clarification chat |
| **9 Primitives System** | Acquisition, Sales, Delivery, Content, Operations, Finance, Analytics, Memory, Governance |
| **Autonomous Agent Loop** | Claude-powered agents with tool use, retry, and budget controls |
| **29 Built-in Tools** | CRM, email, social media, content generation, analytics, and more |
| **Pipeline Engine** | Multi-step workflows with scheduled triggers (cron) and manual runs |
| **Real-time Run Tracking** | Live progress bars, auto-polling, step-by-step timeline |
| **Memory Engine** | Episodic + semantic + graph memory with lifecycle management |
| **Governance Engine** | Cost anomaly, loop detection, spam protection, brand safety |
| **Spend Approval** | Human-in-the-loop for financial actions |
| **Blueprint Marketplace** | Clone proven AI company templates in one click |
| **Billing & Usage** | Stripe-powered 4-tier plans (Free / Creator / Pro / Business / Enterprise) with yearly 20% discount |
| **Referral System** | Share codes, earn bonus runs for both parties |
| **Google OAuth** | One-click sign in with Google |
| **Command Palette** | `Cmd+K` quick navigation with keyboard shortcuts |
| **Integration Library** | 120+ connectors across 20 categories (CRM, social, email, payment, etc.) |
| **A/B Testing** | Compare agent configurations with variant metrics and winner selection |
| **Agent Version Control** | Snapshot, diff, and rollback agent configurations |
| **Natural Language Agent Editing** | Edit agents with plain English commands (16+ rule patterns) |
| **Webhook Marketplace** | 32 pre-built webhook templates (Shopify, Stripe, GitHub, etc.) |
| **Real-time Collaboration** | See who's online and what they're working on via SSE presence |
| **Mobile Responsive** | Full responsive design with collapsible sidebar |
| **Export to Claude Code** | Export companies as CLAUDE.md, skills, hooks, and settings bundles |
| **SSE Run Streaming** | Real-time Server-Sent Events for live pipeline run status |
| **Scheduled Pipelines** | Cron-based automatic pipeline execution via node-cron |
| **Security Hardening** | OWASP Top 10 covered — parameterized SQL, tenant isolation, blueprint sanitization, Stripe webhook idempotency, rate limits on expensive endpoints, HMAC webhooks, CSP, HSTS |
| **Graceful Shutdown** | SIGTERM/SIGINT handlers with Redis/Prisma cleanup |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Monorepo** | pnpm workspaces + Turborepo |
| **Frontend** | Next.js 15 (App Router) + Tailwind CSS + Material Icons |
| **Backend** | Express + TypeScript |
| **Database** | PostgreSQL 16 + Prisma ORM |
| **Cache/Queue** | Redis 7 + BullMQ |
| **AI** | Claude (Anthropic) — tool use / function calling |
| **Auth** | JWT + Google OAuth |
| **Billing** | Stripe (subscriptions + usage metering) |
| **CRM** | HubSpot integration |
| **Email** | SendGrid |
| **Container** | Docker Compose |

---

## Project Structure

```
├── packages/
│   ├── ui/          # Next.js 15 dashboard (30+ routes)
│   ├── api/         # Express API server (19 modules)
│   ├── db/          # Prisma schema + migrations (20 tables)
│   ├── core/        # Shared types and utilities
│   ├── memory/      # Memory engine (episodic + semantic + graph)
│   └── integrations/# External service adapters
├── HOLDING_CORE/    # Policies, templates, evals
├── ENV/             # Docker Compose + Dockerfile
├── .env.example     # Environment template
└── CLAUDE.md        # AI context file
```

---

## Configuration

### Required Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `DATABASE_URL` | PostgreSQL connection string | Yes |
| `REDIS_URL` | Redis connection string | Yes |
| `JWT_SECRET` | Secret for JWT signing (min 32 chars, generate with `openssl rand -hex 32`) | Yes |
| `ENCRYPTION_KEY` | AES-256-GCM encryption key (min 32 chars, generate with `openssl rand -hex 32`) | Yes |
| `APP_URL` | Frontend URL (default: `http://localhost:3000`) | Yes |

### Optional — AI

| Variable | Description |
|----------|-------------|
| `LLM_PROVIDER` | `api` (Anthropic API) or `local` (Claude Code CLI) |
| `ANTHROPIC_API_KEY` | Anthropic API key (required if `LLM_PROVIDER=api`) |
| `CLAUDE_MODEL` | Model to use (default: `claude-sonnet-4-5-20250929`) |

### Optional — Auth

| Variable | Description |
|----------|-------------|
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `GOOGLE_REDIRECT_URI` | OAuth callback URL |

### Optional — Billing (4-tier plan structure)

| Variable | Description |
|----------|-------------|
| `STRIPE_SECRET_KEY` | Stripe secret key |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret (HMAC-SHA256 verified) |
| `STRIPE_CREATOR_PRICE_ID` | Creator $19/mo price |
| `STRIPE_CREATOR_YEARLY_PRICE_ID` | Creator $182/yr (20% off) price |
| `STRIPE_PRO_PRICE_ID` | Pro $39/mo price |
| `STRIPE_PRO_YEARLY_PRICE_ID` | Pro $374/yr (20% off) price |
| `STRIPE_BUSINESS_PRICE_ID` | Business $99/mo price |
| `STRIPE_BUSINESS_YEARLY_PRICE_ID` | Business $950/yr (20% off) price |
| `STRIPE_ENTERPRISE_PRICE_ID` | Enterprise custom price |

### Optional — Integrations

| Variable | Description |
|----------|-------------|
| `HUBSPOT_ACCESS_TOKEN` | HubSpot CRM access token |
| `SENDGRID_API_KEY` | SendGrid email API key |
| `TIKTOK_CLIENT_KEY` | TikTok API client key |
| `LINKEDIN_CLIENT_ID` | LinkedIn API client ID |

### Production-Required — Observability + Backup

| Variable | Description | When |
|----------|-------------|------|
| `SENTRY_DSN` | Sentry project DSN — every uncaught exception lands here. SDK no-ops when unset. | Production REQUIRED |
| `SENTRY_RELEASE` | Tag releases for per-deploy error rates | Optional |
| `SENTRY_TRACES_SAMPLE_RATE` | Trace sample rate `0..1` (default `0.05`) | Optional |
| `BACKUP_S3_BUCKET` | Off-site backup destination — bucket name only, no `s3://` prefix | Production REQUIRED |
| `BACKUP_S3_PREFIX` | Folder inside bucket (default `aicos-prod/`) | Optional |
| `BACKUP_S3_REGION` | AWS region for the bucket (default `us-east-1`) | Optional |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | Credentials for off-site sync | Production REQUIRED |

---

## Commands

```bash
pnpm install          # Install all dependencies
pnpm dev              # Start all services (frontend + API)
pnpm build            # Build all packages
pnpm lint             # Lint all packages
pnpm test             # Run tests
pnpm db:migrate       # Run Prisma migrations
pnpm db:generate      # Generate Prisma client
pnpm db:seed          # Seed database
pnpm docker:up        # Start Docker services
pnpm docker:down      # Stop Docker services
```

---

## Pricing Tiers

| Plan | Price | Companies | Runs/mo | Key Features |
|------|-------|-----------|---------|--------------|
| **Free** | $0 forever | 1 | 10 | Hero TikTok+LinkedIn template, full audit log, community support |
| **Creator** | $19/mo | 5 (parallel) | 100 | All channels, custom pipelines, memory engine, email support |
| **Pro** ⭐ | $39/mo | 20 | 500 | HubSpot CRM, outreach automation, advanced analytics, priority support |
| **Business** | $99/mo | 100 | 2,000 | 3 team seats, governance, audit export, white-label prep, dedicated support |
| **Enterprise** | Custom | Unlimited | Unlimited | SSO + SAML, SLA, private deployment, dedicated CSM |

- **Yearly billing saves 20%** (Creator $182/yr, Pro $374/yr, Business $950/yr)
- **No free trial** on paid plans — the Free plan already gives real AI output
- All plans hit hard quota limits enforced server-side (HTTP 402 on overrun)

## Setting Up Stripe

### Option A: Stripe Türkiye (recommended for Turkish businesses)

1. Go to [stripe.com/tr](https://stripe.com/tr) and register with your Turkish company
2. Provide tax number (vergi numarası) and trade registry (ticaret sicil no)
3. Link your company's TRY IBAN
4. Wait 1–3 business days for approval
5. Create products in Stripe Dashboard:
   - **Creator**: $19/mo monthly + $182/yr yearly
   - **Pro**: $39/mo monthly + $374/yr yearly
   - **Business**: $99/mo monthly + $950/yr yearly
   - **Enterprise**: custom price (connect to sales)
6. Configure webhook endpoint → `https://api.braavolabs.com/hooks/stripe`
7. Add events: `checkout.session.completed`, `customer.subscription.*`, `invoice.payment_*`, `charge.refunded`
8. Copy the 6 price IDs + webhook secret + secret key into your `.env`

### Option B: Stripe Atlas ($500, 2–3 weeks)

For non-Turkish operators: creates a US Delaware LLC + Mercury bank + Stripe account. See [stripe.com/atlas](https://stripe.com/atlas). Same product setup as above after the LLC is provisioned.

### Option C: Paddle as Merchant of Record (5% commission)

If you want Paddle to handle VAT/tax globally, switch the billing adapter to Paddle. Requires 1-2 days of code work to replace Stripe webhook handling. See [paddle.com](https://paddle.com).

### Idempotency + retry safety

The webhook handler at `/hooks/stripe` uses Redis SETNX on `event.id` for 7-day deduplication — safe against Stripe retries. On handler errors the claim is released so Stripe can retry. Handles: `checkout.session.completed`, `customer.subscription.{updated,deleted,trial_will_end}`, `invoice.payment_{failed,action_required}`, `charge.refunded` (auto-downgrade to Free on full refund).

---

## Deployment

### Option 1: Vercel + Railway (Recommended)

1. **Frontend** → Deploy `packages/ui` to [Vercel](https://vercel.com)
   - Root Directory: `packages/ui`
   - Build Command: `pnpm build`
   - Set `NEXT_PUBLIC_API_URL` to your API URL

2. **Backend** → Deploy `packages/api` to [Railway](https://railway.app)
   - Add PostgreSQL and Redis services
   - Set all environment variables

3. **Domain** → Point your domain to Vercel, API subdomain to Railway

### Option 2: Docker (Self-Hosted)

```bash
docker compose -f ENV/compose.yaml up -d --build
```

### Option 3: VPS (DigitalOcean/Hetzner)

1. Provision a VPS with 2GB+ RAM
2. Install Docker and Docker Compose
3. Clone the repo, configure `.env`
4. Run `docker compose up -d`
5. Set up Nginx reverse proxy with SSL (Let's Encrypt)

---

## Domain & DNS Setup

1. Purchase a domain (e.g., from [Namecheap](https://namecheap.com) or [Cloudflare](https://cloudflare.com))
2. Point DNS records:
   - `A` record → your server IP (or Vercel's IP)
   - `CNAME` for `api.yourdomain.com` → your API server
3. Enable HTTPS with Let's Encrypt or Cloudflare SSL
4. Update `.env`:
   ```env
   APP_URL=https://yourdomain.com
   NEXT_PUBLIC_API_URL=https://api.yourdomain.com/api/v1
   GOOGLE_REDIRECT_URI=https://api.yourdomain.com/api/v1/auth/google/callback
   ```

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/auth/register` | Register new user |
| POST | `/auth/login` | Login |
| GET | `/auth/google` | Google OAuth URL |
| GET/POST | `/companies` | CRUD companies |
| POST | `/companies/build` | Start AI company builder |
| POST | `/pipelines/:id/run` | Trigger pipeline run |
| GET | `/runs/:id` | Get run details |
| GET/POST | `/approvals` | Manage approvals |
| POST | `/memory/search` | Semantic memory search |
| GET | `/dashboard/*` | Health, usage, finance stats |
| POST | `/billing/checkout` | Create Stripe checkout |
| POST | `/billing/webhook` | Stripe webhook handler |
| GET | `/growth/blueprints` | List blueprints |
| POST | `/growth/blueprint/:slug/clone` | Clone blueprint |
| GET | `/export/:companyId/claude-md` | Export CLAUDE.md |
| GET | `/export/:companyId/skills` | Export agent skills |
| GET | `/export/:companyId/hooks` | Export pipeline hooks |
| GET | `/export/:companyId/bundle` | Full export bundle |
| GET | `/runs/:id/stream` | SSE run status stream |

---

## Security

Braavolabs includes comprehensive security hardening for production:

- **Authentication**: JWT access + refresh tokens with bcrypt (cost 12) password hashing
- **Rate Limiting**: Redis-backed rate limits on auth, register, refresh, and API endpoints
- **Account Lockout**: Automatic lockout after repeated failed login attempts
- **CSRF Protection**: OAuth state tokens with one-time use and TTL
- **Headers**: Helmet.js + HSTS + CSP + X-Frame-Options + Permissions-Policy
- **Input Validation**: Zod schemas on all API inputs
- **Webhook Security**: HMAC-SHA256 signature verification
- **Credential Encryption**: AES-256-GCM for stored integration credentials
- **Tenant Isolation**: Every DB query is scoped by tenant ID
- **BYPASS_BILLING Guard**: Throws on startup if enabled in production
- **Graceful Shutdown**: SIGTERM/SIGINT handlers cleanly close Redis, Prisma, and workers

### Production Checklist

Before deploying to production, ensure:

1. `JWT_SECRET` and `ENCRYPTION_KEY` are unique, random 64+ character secrets (`openssl rand -hex 32`)
2. `NODE_ENV=production` is set
3. `BYPASS_BILLING=false` (enforced — server refuses to start otherwise)
4. PostgreSQL and Redis have strong passwords
5. HTTPS is enabled (HSTS is pre-configured)
6. `APP_URL` and `NEXT_PUBLIC_API_URL` point to your production domains
7. All 6 Stripe price IDs are configured (Creator/Pro/Business × monthly+yearly)
8. Google OAuth redirect URI matches your production domain
9. Prisma migrations applied: `pnpm exec prisma migrate deploy`
10. Anthropic API key is live + has sufficient credit

## Launch Checklist (manual steps for Mustafa)

Code is launch-ready. The remaining work is everything that needs a credit card,
a legal signature, or a product decision — none of which the codebase can do
for you. Ordered roughly by what unblocks what:

### Infrastructure (1–2 hours, $30/mo)

- [ ] **Domain**: register `braavolabs.com` at Cloudflare Registrar (~$10/yr) or transfer if owned elsewhere
- [ ] **DNS**: in Cloudflare, add `A` for `braavolabs.com` → VPS IP, `CNAME` for `app.braavolabs.com` → Vercel, `CNAME` for `api.braavolabs.com` → VPS, enable proxy (orange cloud) for SSL + DDoS
- [ ] **Wildcard**: `*.braavolabs.com` → VPS for future subdomains (docs, status)
- [ ] **VPS**: provision Hetzner CPX31 (€13/mo) or DigitalOcean 8GB droplet, install Docker
- [ ] **S3 backup bucket**: AWS S3 or compatible (Backblaze B2, Cloudflare R2). Create bucket + IAM user with `PutObject` permission scoped to that bucket. Keep `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`.

### Accounts + secrets (2–4 hours, $0–500 setup)

- [ ] **Anthropic**: create API key at console.anthropic.com, top up $100–200
- [ ] **Stripe**: apply to Stripe Türkiye with Turkish company (1–3 day approval). On approval, create the 6 products listed in the *Setting Up Stripe* section above and paste price IDs into env. (Or Stripe Atlas — see same section.)
- [ ] **Sentry**: create a free project at sentry.io, copy DSN into `SENTRY_DSN`
- [ ] **SendGrid**: create account + API key + domain auth (SPF/DKIM for `braavolabs.com`)
- [ ] **Google OAuth**: Cloud Console → OAuth Consent (External) + Credentials → set redirect URI to `https://api.braavolabs.com/api/v1/auth/google/callback`
- [ ] **Strong secrets**: `openssl rand -hex 32` × 2 → `JWT_SECRET` + `ENCRYPTION_KEY` (production startup REFUSES to boot if `ENCRYPTION_KEY` contains a placeholder string)

### Legal (1–2 weeks, $75–1500)

- [ ] **ToS + Privacy**: either pay $75/yr to [Termly](https://termly.io) for templated documents that auto-update, OR retain an attorney for a custom set ($500–1500). Required by Stripe + GDPR + Apple/Google policies. Site has stub `/privacy` + `/terms` pages already wired.
- [ ] **DPA**: data processing addendum for any business-tier customer that requests one (Termly bundles this).

### Deploy (30 min after secrets in hand)

```bash
ssh root@<vps-ip>
git clone https://github.com/kocakkmustafa/The-Creator.git
cd The-Creator
cp .env.example .env
$EDITOR .env   # paste every secret from above
docker compose -f ENV/compose.prod.yaml --profile backup up -d --build
docker compose -f ENV/compose.prod.yaml exec api pnpm exec prisma migrate deploy
```

The `--profile backup` flag enables the postgres-backup service that mirrors
nightly dumps to your S3 bucket (DB-NEW-004 / off-site sync). Without that
flag the backup container does not run — local-only retention only.

### Soft launch path (ship even if Stripe is pending)

1. Deploy with `BYPASS_BILLING=true` — all users can sign up and use the Free plan immediately
2. Real AI output works (1 company, 10 runs/month, TikTok + LinkedIn)
3. When Stripe Türkiye approves: create the 6 products, paste price IDs, flip `BYPASS_BILLING=false` → paid tiers go live without a redeploy

### Post-launch growth (ongoing)

- [ ] **Bundled AI credits decision** (ISS-045): give Free plan first 10 runs against the platform's Anthropic key, then require user to BYO key. Code is ready; toggle is a product/pricing call.
- [ ] **Launch verdict gate** (ISS-070): set go/no-go thresholds before paid spend (suggested: activation > 20%, free→paid conversion > 8%, 50+ active users for LAL seed). Free signups can run from day one.
- [ ] **Social accounts + Product Hunt + Hacker News**

---

## What This Repo Already Ships (Launch-Ready Code)

The following landed in the V1 launch-prep sweep (April 2026). Production
deploys will inherit all of this without further code work:

### Hardening landed in this sweep

- [x] **Stripe webhook signature verification** — raw body preserved; mount order verified end-to-end
- [x] **Stripe webhook idempotency** — Redis SETNX with 7-day TTL; duplicates short-circuit, errors release the claim for retry
- [x] **Spend approval gate** — every tool with `requiresApproval: true` writes an `Approval` row before the handler is reached; bare path explicitly rejects spend tools
- [x] **Cross-tenant isolation** — `enforceTenantScopedCompany` rewrites every tool's `companyId` to a canonical tenant-owned ID before the handler runs; throws on cross-tenant attempts
- [x] **Quota TOCTOU close** — `claimQuota()` is a single atomic SQL statement (`INSERT ... ON CONFLICT DO UPDATE WHERE value < limit`); two concurrent claims at value=9, limit=10 cannot both succeed
- [x] **Pipeline wall-clock timeout** — 15-minute hard cap per run + 50-step pathological-payload guard
- [x] **Encryption KDF** — scrypt-derived AES-256-GCM key with versioned `v2:` prefix; legacy raw-slice ciphertext still readable; production refuses to boot with placeholder `ENCRYPTION_KEY`
- [x] **Tool input validation** — Zod schemas on all credential-handling + DB-write tools (`create_draft`, `store_memory`, `recall_memory`, `crm_create_contact`, `crm_create_deal`); `registerZodTool` helper available for the rest
- [x] **Blueprint clone supply-chain hardening** — sanitization caps + tool-name whitelist + `scanForInjection` (8 jailbreak patterns + outbound-URL detection); untrusted publishers land as `DRAFT` (cannot trigger pipelines until manual activation)
- [x] **Cost-abuse caps** — `description.max(2000)` on natural-language pipeline builder + per-tenant rate limits on all expensive endpoints
- [x] **pgvector HNSW index** — `memory_embeddings.embedding USING hnsw (vector_cosine_ops)` migration, applied with `CONCURRENTLY` so live traffic isn't blocked
- [x] **Sentry SDK** — `@sentry/node` initialized before all other imports; capture middleware runs before app's error handler; PII / credentials redacted from request snapshots
- [x] **Off-site backup** — postgres-backup service mirrors every nightly dump to `${BACKUP_S3_BUCKET}` via `aws s3 cp`; activates only when credentials are set (dev/staging keep working without)
- [x] **CI** — `Lint & Type Check` + `Test` (Vitest) + `Build` + `DB Migration Check` jobs all green on every PR; broken `pnpm/action-setup` config fixed

### Test coverage today

`packages/core` — 27 passing (utils + plan constants). `packages/api`, `ui`,
`integrations`, `memory` are wired for Vitest via the same setup but have no
tests yet. `pnpm -r --if-present test` runs whatever is defined; CI does not
fail when a package has no test script.

## V1 Launch Hardening (completed 2026-04-20)

- [x] SQL injection fix in memory semantic search (Prisma parameterized queries)
- [x] Stripe webhook idempotency via Redis SETNX + 4 new event handlers
- [x] Spend approval gate: pipeline runs thread governance context through agent tools
- [x] Cross-tenant memory isolation: all tool inputs with `companyId` validated against caller's tenant
- [x] Blueprint sanitization: tool-name whitelist + systemPrompt cap + 15 agent cap
- [x] Rate limiting on Claude-API-expensive endpoints (pipelines/run, memory/search, companies/build)
- [x] Company count quota enforcement (plan limits enforced server-side)
- [x] 4-tier plan structure with 20% yearly discount
- [x] Landing copy reframed from Zapier category to "autonomous AI company"
- [x] Logged-out dashboard shows honest example preview, not fake platform metrics
- [x] Invalid Claude model IDs removed, `env.CLAUDE_MODEL` used everywhere

---

## License

MIT

---

Built with Claude by [Braavolabs](https://github.com/kocakkmustafa/The-Creator)
