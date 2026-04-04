# AI Company OS

**Build and run autonomous AI companies from plain text.**

AI Company OS is a full-stack platform where you describe your business idea and AI builds agents, pipelines, and workflows — running 24/7 with full audit logs and human approval gates.

![License](https://img.shields.io/badge/license-MIT-blue)
![Node](https://img.shields.io/badge/node-%3E%3D20-green)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)

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
| **Billing & Usage** | Stripe-powered subscriptions with usage metering |
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
| **Security Hardening** | Rate limiting, account lockout, HMAC webhooks, CSP, HSTS |
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
| `CLAUDE_MODEL` | Model to use (default: `claude-sonnet-4-20250514`) |

### Optional — Auth

| Variable | Description |
|----------|-------------|
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `GOOGLE_REDIRECT_URI` | OAuth callback URL |

### Optional — Billing

| Variable | Description |
|----------|-------------|
| `STRIPE_SECRET_KEY` | Stripe secret key |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret |
| `STRIPE_PRO_PRICE_ID` | Stripe price ID for Pro plan |
| `STRIPE_ENTERPRISE_PRICE_ID` | Stripe price ID for Enterprise plan |

### Optional — Integrations

| Variable | Description |
|----------|-------------|
| `HUBSPOT_ACCESS_TOKEN` | HubSpot CRM access token |
| `SENDGRID_API_KEY` | SendGrid email API key |
| `TIKTOK_CLIENT_KEY` | TikTok API client key |
| `LINKEDIN_CLIENT_ID` | LinkedIn API client ID |

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

## Setting Up Stripe for Real Payments

1. Create a [Stripe account](https://dashboard.stripe.com/register)
2. Get your API keys from the Stripe Dashboard
3. Create two products with recurring prices:
   - **Pro Plan**: $49/month
   - **Enterprise Plan**: Custom pricing
4. Set up a webhook endpoint pointing to `https://yourdomain.com/api/v1/billing/webhook`
5. Configure webhook events: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_succeeded`
6. Add the keys to your `.env`:
   ```env
   STRIPE_SECRET_KEY=sk_live_...
   STRIPE_WEBHOOK_SECRET=whsec_...
   STRIPE_PRO_PRICE_ID=price_...
   STRIPE_ENTERPRISE_PRICE_ID=price_...
   ```

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

AI Company OS includes comprehensive security hardening for production:

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

1. `JWT_SECRET` and `ENCRYPTION_KEY` are unique, random 64+ character secrets
2. `NODE_ENV=production` is set
3. `BYPASS_BILLING=false` (enforced — server refuses to start otherwise)
4. PostgreSQL and Redis have strong passwords
5. HTTPS is enabled (HSTS is pre-configured)
6. `APP_URL` and `NEXT_PUBLIC_API_URL` point to your production domains
7. Stripe webhook secret is configured for payment processing
8. Google OAuth redirect URI matches your production domain

---

## License

MIT

---

Built with Claude by [AI Company OS](https://github.com/kocakkmustafa/The-Creator)
