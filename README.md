# AI Company OS

**Build and run autonomous AI companies in minutes.**

AI Company OS is a full-stack platform that lets you create, manage, and scale AI-powered companies from a single dashboard. Describe your business idea in plain text, and the system configures agents, pipelines, tools, and governance automatically.

---

## Features

| Feature | Description |
|---------|-------------|
| **Freeform Company Builder** | Describe your company idea in plain text — AI configures everything |
| **9 Primitives System** | Acquisition, Sales, Delivery, Content, Operations, Finance, Analytics, Memory, Governance |
| **Autonomous Agent Loop** | Claude-powered agents with tool use, retry, and budget controls |
| **29 Built-in Tools** | CRM, email, social media, content generation, analytics, and more |
| **Pipeline Engine** | Multi-step workflows with scheduled triggers (cron) |
| **Memory Engine** | Episodic + semantic + graph memory with lifecycle management |
| **Governance Engine** | Cost anomaly, loop detection, spam protection, brand safety |
| **Spend Approval** | Human-in-the-loop for financial actions |
| **Full Audit Log** | Every action, tool call, and decision is logged with reasoning |
| **CRM Integration** | HubSpot-first with contacts, deals, and outreach automation |
| **Usage-Based Billing** | Stripe integration with Free/Pro/Enterprise tiers |
| **Referral & Growth** | PQL scoring, blueprint sharing, referral rewards |
| **Modern Dashboard** | Next.js 15 UI with real-time metrics and Kanban boards |
| **Dual LLM Mode** | `local` (your Claude CLI) or `api` (Anthropic API key) |
| **Self-Hosted** | Docker Compose — runs anywhere |

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                        Next.js Dashboard                      │
│                    (port 3000 — packages/ui)                  │
└────────────────────────────┬─────────────────────────────────┘
                             │ REST API
┌────────────────────────────▼─────────────────────────────────┐
│                     Express API Server                        │
│                   (port 8080 — packages/api)                  │
│                                                               │
│  ┌──────────┐ ┌───────────┐ ┌────────────┐ ┌──────────────┐ │
│  │ Company  │ │ Pipeline  │ │ Governance │ │   Billing    │ │
│  │ Builder  │ │  Runner   │ │   Engine   │ │  (Stripe)    │ │
│  └──────────┘ └───────────┘ └────────────┘ └──────────────┘ │
│  ┌──────────┐ ┌───────────┐ ┌────────────┐ ┌──────────────┐ │
│  │  Agent   │ │  Memory   │ │  Outreach  │ │   Growth     │ │
│  │   Loop   │ │  Engine   │ │  Runner    │ │   Engine     │ │
│  └──────────┘ └───────────┘ └────────────┘ └──────────────┘ │
└──────┬─────────────┬────────────────┬────────────────────────┘
       │             │                │
  ┌────▼────┐  ┌─────▼─────┐  ┌──────▼──────┐
  │PostgreSQL│  │   Redis   │  │ Claude CLI  │
  │+pgvector │  │  +BullMQ  │  │  or API     │
  └─────────┘  └───────────┘  └─────────────┘
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | Next.js 15, React 19, Tailwind CSS 4, Zustand |
| **Backend** | Node.js, Express, TypeScript |
| **Database** | PostgreSQL 16 + pgvector |
| **Cache/Queue** | Redis 7 + BullMQ |
| **ORM** | Prisma |
| **LLM** | Claude (Anthropic) — API or local CLI |
| **CRM** | HubSpot |
| **Billing** | Stripe |
| **Email** | SendGrid |
| **Observability** | OpenTelemetry + Pino |
| **Validation** | Zod |
| **Monorepo** | pnpm workspaces |
| **Containers** | Docker Compose |
| **CI/CD** | GitHub Actions |

---

## Project Structure

```
ai-company-os/
├── packages/
│   ├── api/                    # Express API server
│   │   └── src/
│   │       ├── config/         # Environment + validation
│   │       ├── lib/            # DB, logger, queue, telemetry
│   │       ├── middleware/     # Auth (JWT), error handler, validation
│   │       └── modules/
│   │           ├── agent/      # Claude agent loop, tool registry (29 tools), tool executor
│   │           ├── approval/   # Spend approval queue
│   │           ├── auth/       # Register, login, Google OAuth
│   │           ├── billing/    # Stripe metering + webhooks
│   │           ├── company/    # Company CRUD + AI builder
│   │           ├── crm/        # Contacts, deals
│   │           ├── dashboard/  # Health, usage, finance, activity
│   │           ├── draft/      # Content drafts + approval
│   │           ├── governance/ # Risk detection engine (5 stop types)
│   │           ├── growth/     # PQL scoring, blueprints, referrals
│   │           ├── memory/     # Semantic search + consolidation cron
│   │           ├── onboarding/ # Hero company setup
│   │           ├── outreach/   # Email sequences + runner
│   │           ├── pipeline/   # Pipeline CRUD + BullMQ runner
│   │           ├── run/        # Run management (pause/stop/rollback)
│   │           └── webhook/    # Incoming webhook handler
│   │
│   ├── ui/                     # Next.js 15 dashboard
│   │   └── app/
│   │       ├── page.tsx        # Dashboard — metrics, companies, activity feed
│   │       ├── login/          # Auth — email/password + Google OAuth
│   │       ├── companies/      # Company list + detail (agents, pipelines, runs, CRM)
│   │       ├── approvals/      # Approval queue
│   │       ├── drafts/         # Content draft management
│   │       ├── analytics/      # Run analytics + cost breakdown
│   │       ├── risks/          # Risk events + activity log
│   │       ├── settings/       # Plan, billing, integrations, governance
│   │       └── onboarding/     # Getting started wizard
│   │
│   ├── db/                     # Prisma schema + migrations (22 tables)
│   ├── core/                   # Shared types, constants, utilities
│   ├── memory/                 # Memory engine (episodic, semantic, graph)
│   └── integrations/           # External adapters (Stripe, HubSpot, SendGrid, social)
│
├── HOLDING_CORE/               # Policies, templates, eval suite
├── ENV/                        # Docker Compose + Dockerfile
├── .github/workflows/          # CI/CD pipelines
└── CLAUDE.md                   # AI assistant context file
```

---

## Quick Start

### Prerequisites

- **Node.js** 20+
- **pnpm** 9+
- **Docker** (for PostgreSQL + Redis)
- **Claude Code CLI** (optional — for local LLM mode)

### 1. Clone & Install

```bash
git clone https://github.com/kocakkmustafa/The-Creator.git
cd The-Creator
pnpm install
```

### 2. Environment Setup

```bash
cp .env.example .env
# Edit .env with your API keys (see Configuration section below)
```

### 3. Start Infrastructure

```bash
docker compose -f ENV/compose.yaml up -d
```

This starts:
- **PostgreSQL 16** with pgvector extension (port 5432)
- **Redis 7** (port 6379)

### 4. Database Setup

```bash
# Generate Prisma client
cd packages/db && npx prisma generate

# Run migrations
npx prisma migrate deploy

# Seed initial data (optional)
npx prisma db seed
```

### 5. Start the Platform

```bash
# Terminal 1 — API Server
cd packages/api
npx tsx src/index.ts
# → Running on http://localhost:8080

# Terminal 2 — Dashboard
cd packages/ui
npx next dev
# → Running on http://localhost:3000
```

### 6. Create Your First Company

1. Open http://localhost:3000
2. Register or login
3. Click **"New Company"**
4. Describe your business idea (e.g., _"A social media agency for small businesses that creates TikTok and LinkedIn content weekly"_)
5. AI configures agents, pipelines, and tools automatically
6. Confirm and start running

---

## Configuration

### LLM Provider

The system supports two LLM modes:

| Mode | `LLM_PROVIDER` | Description |
|------|-----------------|-------------|
| **Local** | `local` | Uses your Claude Code CLI (`claude` command). No API key needed. Uses your existing Claude subscription. |
| **API** | `api` | Uses Anthropic API directly. Requires `ANTHROPIC_API_KEY`. For production/published deployments. |

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `REDIS_URL` | Yes | Redis connection string |
| `JWT_SECRET` | Yes | Secret for JWT signing (min 8 chars) |
| `LLM_PROVIDER` | No | `local` or `api` (default: `api`) |
| `ANTHROPIC_API_KEY` | If `api` | Anthropic API key |
| `GOOGLE_CLIENT_ID` | No | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | No | Google OAuth secret |
| `GOOGLE_REDIRECT_URI` | No | OAuth callback URL |
| `STRIPE_SECRET_KEY` | No | Stripe billing |
| `STRIPE_WEBHOOK_SECRET` | No | Stripe webhook verification |
| `SENDGRID_API_KEY` | No | Email delivery |
| `HUBSPOT_ACCESS_TOKEN` | No | CRM integration |

See [.env.example](.env.example) for all variables.

---

## API Reference

### Auth
| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/v1/auth/register` | Register new user + tenant |
| `POST` | `/api/v1/auth/login` | Login with email/password |
| `GET` | `/api/v1/auth/google` | Get Google OAuth URL |
| `GET` | `/api/v1/auth/google/callback` | Google OAuth callback |

### Companies
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/v1/companies` | List companies |
| `POST` | `/api/v1/companies` | Create company manually |
| `POST` | `/api/v1/companies/build` | AI company builder (freeform text) |
| `POST` | `/api/v1/companies/build/:id/answer` | Answer clarification questions |
| `POST` | `/api/v1/companies/build/:id/confirm` | Confirm and create |
| `GET` | `/api/v1/companies/:id` | Company detail |
| `DELETE` | `/api/v1/companies/:id` | Archive company |
| `GET` | `/api/v1/companies/:id/agents` | List agents |
| `GET` | `/api/v1/companies/:id/activity` | Activity timeline |

### Pipelines & Runs
| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/v1/pipelines/:id/run` | Trigger pipeline run |
| `GET` | `/api/v1/runs/:id` | Run detail with steps |
| `POST` | `/api/v1/runs/:id/stop` | Stop a running pipeline |
| `POST` | `/api/v1/runs/:id/pause` | Pause a running pipeline |
| `POST` | `/api/v1/runs/:id/resume` | Resume paused pipeline |
| `POST` | `/api/v1/run-steps/:id/rollback` | Rollback a step |
| `POST` | `/api/v1/run-steps/:id/rerun` | Re-run a failed step |

### Dashboard & Analytics
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/v1/dashboard/health` | System health overview |
| `GET` | `/api/v1/dashboard/usage` | Run usage stats |
| `GET` | `/api/v1/dashboard/finance` | Cost breakdown |
| `GET` | `/api/v1/dashboard/activity` | Activity log |
| `GET` | `/api/v1/dashboard/runs` | Run history |

### More Endpoints
| Area | Endpoints |
|------|-----------|
| **Approvals** | `GET /approvals`, `POST /approvals/:id/decide` |
| **Drafts** | `GET /drafts`, `POST /drafts`, `POST /drafts/:id/approve` |
| **Memory** | `GET /memory/search`, `POST /memory` |
| **Billing** | `GET /billing/usage`, `GET /billing/subscription`, `POST /billing/checkout` |
| **CRM** | `GET /crm/companies/:id/contacts`, `GET /crm/companies/:id/deals` |
| **Governance** | `GET /governance/risk-summary` |
| **Growth** | `GET /growth/pql`, `GET /growth/referral`, `POST /growth/blueprint/publish` |
| **Onboarding** | `GET /onboarding/status`, `POST /onboarding/hero-company` |

---

## Tool Registry (29 Tools)

The agent system includes 29 pre-registered tools:

| Category | Tools |
|----------|-------|
| **CRM** | `crm_create_contact`, `crm_create_deal`, `crm_search_contacts`, `crm_update_contact` |
| **Content** | `generate_post`, `create_draft`, `content_generate`, `content_generate_image_prompt` |
| **Social** | `social_create_post`, `social_get_analytics` |
| **Email** | `send_email` |
| **Outreach** | `enrich_contact`, `proposal_generate` |
| **Memory** | `search_memory`, `save_memory`, `create_memory_edge` |
| **Analytics** | `get_company_metrics`, `web_search`, `knowledge_base_search` |
| **System** | `log_activity`, `wait` |

---

## Governance & Safety

| Stop Type | Description |
|-----------|-------------|
| `cost_anomaly_stop` | Run cost exceeds 20% of budget |
| `loop_stop` | 5+ consecutive step failures |
| `spam_stop` | 3+ unanswered outreach to same target |
| `brand_violation_stop` | Content matches blocked patterns |
| `hard_stop` | Manual governance override |

**Approval Policy:** Only spend actions require human approval. All other operations run autonomously.

**Audit Trail:** Every tool call, decision, and state change is logged with timestamps, actors, and reasoning.

---

## Database Schema (22 Tables)

```
tenants, users, companies, agents, pipelines, runs, run_steps,
tool_calls, approvals, memory_items, memory_embeddings, memory_edges,
contacts, deals, outreach_sequences, outreach_enrollments,
usage_meters, eval_results, activity_log, drafts, referrals, blueprints
```

All queries are tenant-isolated. See [packages/db/prisma/schema.prisma](packages/db/prisma/schema.prisma) for full schema.

---

## Development Roadmap

- [x] Phase 0: Project skeleton + Docker + DB schema
- [x] Phase 1: Orchestrator API + Company Builder + Pipeline Runner
- [x] Phase 2: Memory Engine (episodic + semantic + graph)
- [x] Phase 3: HubSpot CRM + Outreach Automation
- [x] Phase 4: Dashboard UI (Next.js)
- [x] Phase 5: Stripe Billing + Usage Metering
- [x] Phase 6: Governance + Risk Detection + Eval Suite
- [x] Phase 7: OpenTelemetry + Observability
- [x] Phase 8: Free Plan Onboarding (Hero Company)
- [x] Phase 9: Referral + Growth Engine
- [x] Phase 10: Self-Hosted + CI/CD
- [x] Phase 11: Auth + Context Builder + Tool Executor
- [x] Phase 12: PQL Scoring + Blueprint Sharing
- [x] Phase 13: Google OAuth + Local CLI Mode + UI Redesign

---

## License

Private — All rights reserved.

---

Built with Claude by [@kocakkmustafa](https://github.com/kocakkmustafa)
