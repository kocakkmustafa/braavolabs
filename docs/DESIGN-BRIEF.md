# Braavolabs — Complete Design Brief for claude.ai/design

> **Bu doküman**: claude.ai/design'e (veya başka bir tasarım sistemine) tek parça verebileceğin, arka uçtaki tüm veriyi içeren eksiksiz tasarım brief'i. Minimalist + professional + dark-first + data-dense-but-breathable. Her ekran, her component, her state, her edge-case burada.

> **Paste this entire file** into Claude Design and ask: *"Design the complete UI system for Braavolabs using this spec. Deliver pixel-perfect React components with Tailwind v4 and shadcn/ui."*

---

## 1. Project Identity

**Product name**: Braavolabs
**Domain**: braavolabs.com
**Tagline**: *"Your AI company. Built in 10 minutes. Runs on autopilot."*
**Sub-tagline**: *"Describe your business in plain English. Braavolabs builds a fully-staffed autonomous team — content, sales, ops — that runs while you sleep. Every decision is logged."*
**Positioning**: "Autonomous AI company-in-a-box" (NOT Zapier, NOT automation builder — it's a full business operating system where 9 AI agents run an entire company autonomously)
**Primary audience**: Creators, solopreneurs, agency owners, AI-curious founders in US / EU / Turkey / India

### What the product actually does

1. User describes a business in plain English ("I want a faceless YouTube channel about AI tools, 3 videos/week")
2. AI (Claude) runs a **clarification loop** — asks 2-3 strategic follow-up questions max
3. System auto-configures a **Company** with 3-9 specialized **Agents** (one per Primitive)
4. Agents execute **Pipelines** (ordered workflows) autonomously
5. Every action is logged, every spend requires human **Approval**, every step has **Reasoning**
6. Outputs land as **Drafts** — human reviews + publishes to TikTok/LinkedIn/email/etc.

---

## 2. Design Principles (in priority order)

1. **Clarity over cleverness** — User should always know: what am I looking at, what can I do, what's the AI doing right now
2. **Data-dense but breathable** — Dashboards hold metrics + lists + charts but never feel crowded. Generous whitespace, tight typography
3. **Dark-first, light-optional** — Primary theme is dark (#0a0d14 bg). Light mode supported but secondary
4. **Professional, not playful** — This is an enterprise-grade tool that feels like a daily driver (Linear / Superhuman / Vercel energy). NOT a toy, NOT gamified
5. **Fast feedback loops** — Optimistic UI everywhere. Skeleton screens, not spinners. Animated state transitions (150-300ms)
6. **Terminology gradient** — New users see plain English ("Workflow", "AI Specialist"), power users toggle to technical terms ("Pipeline", "Agent")
7. **Trust signals always present** — Security indicators, audit badges, "every decision logged" messaging persistent but subtle
8. **Mobile: read + approve, don't build** — Desktop is for authoring. Mobile for monitoring runs + approving spends + reviewing drafts

---

## 3. Brand System

### 3.1 Colors (Tailwind v4 CSS variables)

Dark mode (default):

```css
/* Backgrounds */
--color-background:               #0a0d14;  /* page bg */
--color-surface:                  #0f1219;  /* card bg */
--color-surface-container-lowest: #070a10;  /* deepest layer */
--color-surface-container-low:    #131720;  /* subtle panels */
--color-surface-container:        #1a1e28;  /* standard card */
--color-surface-container-high:   #222732;  /* elevated card */
--color-surface-container-highest:#2c313c;  /* modal / popover */

/* Primary (cyan/teal — tech, precise) */
--color-primary:                  #a4e6ff;  /* icons, links */
--color-primary-container:        #00d1ff;  /* CTAs, focus rings */
--color-primary-fixed-dim:        #4cd6ff;

/* Secondary (purple — AI, creative) */
--color-secondary:                #e0b6ff;
--color-secondary-container:      #6d11ad;

/* Signature brand gradient */
--gradient-brand: linear-gradient(135deg, #00d1ff 0%, #6d11ad 100%);

/* Text */
--color-on-surface:               #e1e2eb;  /* primary text */
--color-on-surface-variant:       #bbc9cf;  /* secondary text */
--color-outline:                  #859399;  /* muted text */
--color-outline-variant:          #3c494e;  /* faint text (min 3:1 contrast) */

/* Semantic */
--color-success: #34d399;  /* emerald-400 */
--color-warning: #fbbf24;  /* amber-400 */
--color-error:   #f87171;  /* red-400 */
--color-info:    #a4e6ff;  /* same as primary */

/* Run status specific */
--color-status-pending:   #859399;  /* gray */
--color-status-running:   #00d1ff;  /* cyan, animated pulse */
--color-status-waiting:   #fbbf24;  /* amber */
--color-status-completed: #34d399;  /* emerald */
--color-status-failed:    #f87171;  /* red */
--color-status-paused:    #c084fc;  /* violet */
```

Light mode: same semantic mapping, swap bg/surface lightness. See `packages/ui/app/globals.css` for full light overrides.

**Contrast rules**:
- Primary text on background: ≥ 7:1 (AAA)
- Secondary text on background: ≥ 4.5:1 (AA)
- NEVER use `--color-outline-variant` (#3c494e) on `--color-background` (#0a0d14) for body text — only for dividers/decorative

### 3.2 Typography

```css
--font-headline: "Space Grotesk", sans-serif;  /* H1, H2, hero, section titles */
--font-body:     "Inter", sans-serif;          /* body, UI, forms */
--font-mono:     "JetBrains Mono", monospace;  /* code, IDs, tokens */

/* Scale (rem) */
--text-display-2xl: 4.5rem;  /* 72px - hero H1 only */
--text-display-xl:  3.75rem; /* 60px - hero H1 smaller */
--text-display-lg:  3rem;    /* 48px - section H1 */
--text-display-md:  2.25rem; /* 36px - section H2 */
--text-display-sm:  1.875rem;/* 30px */
--text-xl:          1.25rem; /* 20px - card headings */
--text-lg:          1.125rem;/* 18px */
--text-base:        1rem;    /* 16px - body */
--text-sm:          0.875rem;/* 14px - UI labels */
--text-xs:          0.75rem; /* 12px - helper text */
--text-2xs:         0.6875rem;/* 11px - badges */

/* Weights — only use these */
400 (regular), 500 (medium), 600 (semibold), 700 (bold), 800 (extrabold)

/* Line heights */
Headlines: 1.1 (tight, confident)
Body: 1.6 (generous, readable)
UI: 1.4 (compact)

/* Letter spacing */
Display headlines: -0.04em (tight, modern)
All caps labels: 0.12–0.16em (wide)
Body: 0 (default)
```

### 3.3 Spacing (Tailwind scale)

Use Tailwind defaults: 0, 0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 32.

**Rule of 8**: Card padding `p-5` (20px) standard, `p-6` (24px) elevated. Section gaps `gap-8` or `gap-12`. Page max width `max-w-7xl` (1280px).

### 3.4 Radius

```
rounded-sm:  4px  - inline tags, small badges
rounded-md:  8px  - inputs, small cards
rounded-lg:  12px - buttons, medium cards
rounded-xl:  16px - large cards, modals
rounded-2xl: 24px - hero cards, pricing tiers
rounded-full:     - avatars, status dots, pill buttons
```

### 3.5 Shadow / Elevation

Dark mode uses **glow** instead of drop-shadow (sources of light):

```css
/* Subtle (cards) */
--shadow-subtle: 0 1px 2px rgba(0,0,0,0.3);

/* Medium (dropdowns) */
--shadow-medium: 0 4px 12px rgba(0,0,0,0.3);

/* High (modals) */
--shadow-high: 0 16px 48px rgba(0,0,0,0.5);

/* Primary glow (focus, CTA) */
--glow-primary: 0 0 40px rgba(0,209,255,0.15);

/* Brand gradient glow (hero) */
--glow-brand: 0 0 60px rgba(109,17,173,0.2);
```

### 3.6 Iconography

**Library**: Material Symbols Outlined (weight 400, fill 0, opsz 24)
Always inline SVG or the font — no bitmap icons.

**Standard icons**:
- Home/Dashboard: `dashboard`
- Companies: `business`
- Pipelines: `account_tree`
- Runs: `bolt`
- Approvals: `task_alt`
- Drafts: `edit_note`
- Memory: `psychology`
- Analytics: `insights`
- Settings: `settings`
- Integrations: `integration_instructions`
- Marketplace: `storefront`
- Billing: `payments`
- Docs: `help`
- Logout: `logout`
- Company Builder: `auto_awesome`
- AI Agent: `smart_toy`
- Tool Call: `build`
- Cost: `account_balance_wallet`

**Icon sizes**: 14/16/18/20/24px (match text size context).

### 3.7 Motion

- Ease: `cubic-bezier(0.16, 1, 0.3, 1)` (ease-out, natural)
- Durations: 150ms (hover), 250ms (state change), 400ms (page transition), 800ms (hero entrance)
- Never animate property `all` — always list explicit properties
- Reduced motion: respect `prefers-reduced-motion`, disable parallax/floats

---

## 4. Tech Stack Constraints

**Framework**: Next.js 15.5 (App Router, Server Components + Client Components)
**Language**: TypeScript 5.7 strict
**Styling**: Tailwind v4 (CSS-first via `@theme`), PostCSS
**Components**: shadcn/ui patterns (copy-paste, not npm dep) — NOT Radix UI shadcn, rather style-matched custom components
**Icons**: Material Symbols Outlined
**Fonts**: Space Grotesk + Inter + JetBrains Mono (via `next/font` self-hosted)
**State**: Zustand for client state, React Query for server state
**Forms**: react-hook-form + Zod validation
**Charts**: Recharts (dark-themed) for analytics; lightweight custom SVG for simple trends
**Date**: `date-fns` (tree-shakable)
**Animation**: Framer Motion ONLY for complex interactive animations (canvas hero on landing). CSS transitions for 95% of UI.
**No**: Material UI, Chakra, Ant Design, Bootstrap, Emotion/Styled-Components

---

## 5. User Personas (design with these in mind)

### P1: Alex — US Developer Side-Hustler (primary power user)
- 26, SF/Austin, Anthropic fan, Claude Code user
- Wants: CLI-like speed, keyboard shortcuts, raw data visibility, export to git
- Quirks: Types over clicks, tests with curl, lives in terminal + VS Code
- Design implications: Command palette (Cmd+K) works everywhere, dense table views, show raw IDs/tokens on hover, keyboard-first navigation

### P2: Marcus — US Faceless Content Creator (highest volume)
- 32, LA, YouTube + TikTok, 50K+ followers, automation-fluent
- Wants: Launch fast, see results, no jargon
- Quirks: Uses iPad often, mobile-aware, visual learner
- Design implications: Hero flows are image/video heavy, "show me" beats "explain", celebratory success states

### P3: Sarah — UK iPad-First Micro-Founder (mobile critical)
- 34, London, solo course creator, converts on newsletter+TikTok
- Wants: Set-and-forget, email notifications, weekly wins summary
- Quirks: 90% iPad Safari, touch-first, hates long scrolls
- Design implications: 44×44px minimum tap targets, swipe gestures OK, email + push notifications for pipeline events, pause button everywhere

### P4: Kenji — JP Agency Owner (enterprise buyer)
- 42, Tokyo, runs 8-person digital agency
- Wants: Team seats, white-label, SOC 2, invoice PDFs, role separation
- Quirks: Approves nothing without audit log, cross-checks invoices against Slack
- Design implications: Clear admin/member role distinction, exportable audit logs, billing invoices downloadable, "Compliance" tab visible in settings

### P5: Priya — IN Non-Technical Founder (aspirational)
- 28, Bangalore, bootstrapped SaaS founder
- Wants: No AI jargon, bundled credits, "does it work?" not "how does it work?"
- Quirks: English-second-language, sensitive to $, wary of scams
- Design implications: Simplified terminology toggle ON by default, prominent "Free forever" messaging, PPP awareness, pricing in local context

---

## 6. Data Model Reference (all 20+ tables — design reflects these)

### 6.1 Multi-Tenant Core

```ts
Tenant {
  id, name, slug, plan: FREE|CREATOR|PRO|BUSINESS|ENTERPRISE,
  stripeCustomerId, stripeSubscriptionId, createdAt, updatedAt
}

User {
  id, tenantId, email, name, avatarUrl, role: OWNER|ADMIN|MEMBER,
  passwordHash, googleId, resetTokenHash, createdAt, updatedAt
}

UserAIConfig {  // per-tenant AI provider settings
  provider: ANTHROPIC|OPENAI|GOOGLE|MISTRAL|GROQ|OPENROUTER,
  model: string,
  encryptedApiKey: string
}
```

### 6.2 Companies & Agents (the product)

```ts
Company {
  id, tenantId, name, slug, description,
  primitives: Primitive[],  // ACQUISITION, SALES, DELIVERY, CONTENT, OPERATIONS, FINANCE, ANALYTICS, MEMORY, GOVERNANCE
  status: DRAFT|ACTIVE|PAUSED|ARCHIVED,
  config: Json,
  agents: Agent[],
  pipelines: Pipeline[],
  memoryItems, contacts, deals, outreachSequences, evalResults, drafts, integrations, abTests
}

Agent {
  id, companyId, name, role, systemPrompt, tools: Json (string[]),
  model, maxTokens, versions: AgentVersion[]
}

AgentVersion {
  agentId, version: int, label, snapshot: Json, changeSummary, createdAt
  // git-like history per agent
}
```

### 6.3 Pipelines & Runs (the execution engine)

```ts
Pipeline {
  id, companyId, name, description,
  trigger: MANUAL|SCHEDULED|WEBHOOK|EVENT,
  schedule: string (cron),  // only if trigger=SCHEDULED
  steps: Json (array of { name, agentRole, order, config }),
  config: Json,
  enabled: boolean,
  runs: Run[]
}

Run {
  id, pipelineId,
  status: PENDING|RUNNING|PAUSED|WAITING_APPROVAL|COMPLETED|FAILED|CANCELLED,
  trigger, input: Json, output: Json, error,
  costUsd: decimal, budgetUsd: decimal,
  startedAt, completedAt, createdAt,
  steps: RunStep[], approvals: Approval[]
}

RunStep {
  id, runId, agentId, stepIndex, name,
  status: PENDING|RUNNING|COMPLETED|FAILED|ROLLED_BACK,
  reasoning: string (MANDATORY — why did AI decide this),
  input, output, error, costUsd,
  toolCalls: ToolCall[]
}

ToolCall {
  id, runStepId, toolName, input, output,
  status, durationMs, error
}
```

### 6.4 Approvals (human-in-loop)

```ts
Approval {
  id, runId,
  type: SPEND,
  status: PENDING|APPROVED|REJECTED|EXPIRED,
  description, amountUsd: decimal, metadata: Json,
  decidedBy: userId, decidedAt, expiresAt
}
```

### 6.5 Memory (episodic + semantic + graph)

```ts
MemoryItem {
  id, companyId,
  type: EPISODIC|SEMANTIC|PROCEDURAL,
  status: CANDIDATE|APPROVED|DEPRECATED,
  content: string, metadata, source,
  confidence: float (0-1), useCount: int, lastUsedAt, promotedAt,
  embedding: MemoryEmbedding (pgvector 1536-dim)
}

MemoryEdge {
  fromId, toId,
  relation: "supports" | "contradicts" | "derives_from" | custom,
  weight: float
}
```

### 6.6 CRM + Outreach

```ts
Contact {
  id, companyId, email, name, phone, linkedinUrl,
  hubspotId, tags: string[], properties: Json,
  lastContactAt
}

Deal {
  id, companyId, contactId, hubspotId,
  title, stage, amountUsd, currency, closedAt, properties
}

OutreachSequence {
  id, companyId, name, channel: EMAIL|LINKEDIN|TWITTER|TIKTOK,
  steps: Json (array of { delay, message, condition }),
  enabled
}

OutreachEnrollment {
  sequenceId, contactId, currentStep, status: ACTIVE|PAUSED|COMPLETED|UNSUBSCRIBED|BOUNCED,
  lastSentAt, repliedAt, unsubscribedAt, failCount
}
```

### 6.7 Billing, Usage, Audit

```ts
UsageMeter {
  tenantId, metric: "runs"|"tool_calls"|"tokens"|"bonus_runs",
  value: int, periodStart, periodEnd, stripeMeterId
}

ActivityLog {
  tenantId, actor: userId|"system"|agentId,
  action: string, resource, resourceId, details: Json, ip, createdAt
  // 100% audit trail — every action logged
}

EvalResult {
  companyId, suite, testName,
  passed: bool, score: float, details, runId
}
```

### 6.8 Drafts & Content

```ts
Draft {
  id, companyId,
  type: SOCIAL_POST|EMAIL|BLOG_POST|AD_COPY|VIDEO_SCRIPT,
  title, content: Json (flexible structure),
  status: PENDING|APPROVED|PUBLISHED|REJECTED|ARCHIVED,
  channel: string, scheduledAt, publishedAt, metadata
}
```

### 6.9 Growth (referral + blueprints)

```ts
Referral {
  referrerTenantId, referralCode: string (unique),
  referredTenantId, status: PENDING|CONVERTED|EXPIRED,
  rewardType: "extra_runs"|"plan_upgrade", rewardApplied, convertedAt
}

// Blueprints stored in ActivityLog with action="blueprint.published"
```

### 6.10 Integrations (30 providers supported)

```ts
Integration {
  id, companyId,
  provider: TIKTOK|INSTAGRAM|LINKEDIN|YOUTUBE|TWITTER|OPENAI|RUNWAY|
            ELEVENLABS|MIDJOURNEY|FLUX|PIKA|HUBSPOT|STRIPE|SENDGRID|
            SLACK|DISCORD|WHATSAPP|GOOGLE_CALENDAR|GOOGLE_DOCS|GOOGLE_SHEETS|
            NOTION|AIRTABLE|SHOPIFY|WORDPRESS|FACEBOOK|MAILCHIMP|
            INTERCOM|ZENDESK|CALENDLY|GITHUB|TRELLO,
  status: PENDING|ACTIVE|ERROR|EXPIRED,
  credentials: AES-256-GCM encrypted, label, lastTestedAt, metadata
}
```

### 6.11 A/B Testing

```ts
AbTest {
  id, tenantId, companyId, agentId,
  name, description,
  status: DRAFT|RUNNING|PAUSED|COMPLETED,
  winnerVariantId, startedAt, endedAt,
  variants: AbTestVariant[]
}

AbTestVariant {
  testId, name, config: Json (agent override — systemPrompt, temp, etc.),
  weight: int (% traffic),
  metrics: AbTestMetric[]
}

AbTestMetric {
  variantId, runId, metric: string, value: float, metadata
}
```

---

## 7. API Endpoint Reference (50+ endpoints)

### 7.1 Auth
- `POST /api/v1/auth/register` — email + password + name + tenantName
- `POST /api/v1/auth/login` — email + password → JWT
- `POST /api/v1/auth/refresh` — refresh token → new JWT
- `POST /api/v1/auth/logout`
- `GET  /api/v1/auth/google` — OAuth URL
- `GET  /api/v1/auth/google/callback`
- `POST /api/v1/auth/forgot-password`
- `POST /api/v1/auth/reset-password`

### 7.2 Companies
- `GET  /api/v1/companies` — list for tenant
- `POST /api/v1/companies` — direct create (enforces plan limit)
- `GET  /api/v1/companies/:id`
- `PATCH /api/v1/companies/:id`
- `POST /api/v1/companies/:id/pause`
- `POST /api/v1/companies/:id/resume`
- `POST /api/v1/companies/:id/archive`
- `DELETE /api/v1/companies/:id`
- `POST /api/v1/companies/build` — freeform AI builder (starts clarification session)
- `POST /api/v1/companies/build/:sessionId/answer` — continue clarification
- `POST /api/v1/companies/build/:sessionId/confirm` — finalize into Company
- `GET  /api/v1/companies/build/:sessionId`

### 7.3 Agents
- `GET  /api/v1/agents?companyId=X`
- `POST /api/v1/agents`
- `PATCH /api/v1/agents/:id`
- `DELETE /api/v1/agents/:id`
- `POST /api/v1/agents/:id/edit-natural-language` — plain-English agent edit
- `GET  /api/v1/agents/:id/versions` — version history
- `POST /api/v1/agents/:id/versions/:v/rollback`

### 7.4 Pipelines & Runs
- `GET  /api/v1/pipelines?companyId=X`
- `POST /api/v1/pipelines`
- `PATCH /api/v1/pipelines/:id`
- `DELETE /api/v1/pipelines/:id`
- `POST /api/v1/pipelines/from-natural-language` — AI-generate pipeline from text (rate-limited 10/min)
- `POST /api/v1/pipelines/:id/run` — trigger run (rate-limited 30/min)
- `GET  /api/v1/runs/:id` — run details + steps + tool calls
- `GET  /api/v1/runs?companyId=X&status=...`
- `POST /api/v1/runs/:id/stop`
- `POST /api/v1/runs/:id/pause`
- `POST /api/v1/runs/:id/resume`
- `POST /api/v1/run-steps/:id/rollback`
- `POST /api/v1/run-steps/:id/rerun`
- `GET  /api/v1/runs/:id/stream` — SSE real-time events

### 7.5 Approvals
- `GET  /api/v1/approvals?status=PENDING`
- `POST /api/v1/approvals/:id/approve`
- `POST /api/v1/approvals/:id/reject`

### 7.6 Memory
- `POST /api/v1/memory/search` — semantic + text search (rate-limited 30/min)
- `GET  /api/v1/memory?companyId=X&type=...&status=...`
- `POST /api/v1/memory` — manual memory create
- `PATCH /api/v1/memory/:id/promote` — CANDIDATE → APPROVED
- `PATCH /api/v1/memory/:id/deprecate`
- `GET  /api/v1/memory/:id/related` — graph neighbors
- `POST /api/v1/memory/edges`
- `POST /api/v1/memory/consolidate` — batch promote/deprecate (rate-limited 5/min)

### 7.7 Drafts
- `GET  /api/v1/drafts?companyId=X&status=PENDING`
- `POST /api/v1/drafts/:id/approve`
- `POST /api/v1/drafts/:id/reject`
- `POST /api/v1/drafts/:id/publish`
- `POST /api/v1/drafts/:id/schedule`

### 7.8 CRM (Contacts, Deals)
- `GET  /api/v1/crm/contacts?companyId=X`
- `POST /api/v1/crm/contacts`
- `PATCH /api/v1/crm/contacts/:id`
- `GET  /api/v1/crm/deals?companyId=X&stage=...`
- `POST /api/v1/crm/deals`
- `PATCH /api/v1/crm/deals/:id`

### 7.9 Outreach
- `GET  /api/v1/outreach/sequences?companyId=X`
- `POST /api/v1/outreach/sequences`
- `POST /api/v1/outreach/sequences/:id/enroll` — bulk-enroll contacts
- `GET  /api/v1/outreach/enrollments?status=ACTIVE`
- `POST /api/v1/outreach/enrollments/:id/pause`
- `POST /api/v1/outreach/enrollments/:id/unsubscribe`

### 7.10 Dashboard & Analytics
- `GET  /api/v1/dashboard/health` — activeCompanies, activeRuns, pendingApprovals
- `GET  /api/v1/dashboard/usage` — totalRuns, completedRuns, failedRuns, successRate
- `GET  /api/v1/dashboard/finance` — totalCostUsd, runCount, avgCostPerRun
- `GET  /api/v1/dashboard/activity` — recent activityLog

### 7.11 Billing
- `GET  /api/v1/billing/usage` — current-period meters + plan + live counts
- `POST /api/v1/billing/checkout` — Stripe checkout session URL
- `POST /api/v1/billing/portal` — Stripe customer portal URL
- `GET  /api/v1/billing/subscription` — current subscription details
- `POST /hooks/stripe` — Stripe webhook (HMAC-verified, idempotent via Redis)

### 7.12 Growth
- `GET  /api/v1/growth/pql` — product-qualified-lead score
- `POST /api/v1/growth/blueprint/publish`
- `GET  /api/v1/growth/blueprints` — public marketplace
- `GET  /api/v1/growth/blueprints/catalog/:slug` — 42+ curated templates
- `POST /api/v1/growth/blueprints/:slug/clone` — clone to new Company
- `GET  /api/v1/growth/referral` — my code + stats
- `POST /api/v1/growth/referral/redeem`

### 7.13 Integrations
- `GET  /api/v1/integrations?companyId=X`
- `POST /api/v1/integrations/:companyId` — save credentials (encrypted)
- `POST /api/v1/integrations/:companyId/test` — test connection
- `DELETE /api/v1/integrations/:companyId/:provider`

### 7.14 Settings
- `GET  /api/v1/settings/ai-config`
- `PATCH /api/v1/settings/ai-config`
- `GET  /api/v1/settings/profile`
- `PATCH /api/v1/settings/profile`
- `GET  /api/v1/settings/notifications`
- `PATCH /api/v1/settings/notifications`

### 7.15 Webhooks
- `GET  /api/v1/webhooks/templates` — 32 pre-built (Shopify, Stripe, GitHub, etc.)
- `POST /api/v1/webhooks/install/:templateId`
- `DELETE /api/v1/webhooks/:pipelineId`
- `POST /hooks/:companySlug/:event` — public webhook receiver (HMAC)

### 7.16 Export
- `GET  /api/v1/export/:companyId/claude-md`
- `GET  /api/v1/export/:companyId/skills`
- `GET  /api/v1/export/:companyId/hooks`
- `GET  /api/v1/export/:companyId/bundle` — zip file

### 7.17 Collaboration (SSE presence)
- `GET  /api/v1/collaboration/rooms/:roomId`
- `GET  /api/v1/collaboration/rooms/:roomId/events` — SSE stream
- `POST /api/v1/collaboration/rooms/:roomId/join`
- `POST /api/v1/collaboration/rooms/:roomId/leave`

### 7.18 A/B Tests
- `GET  /api/v1/ab-tests`
- `POST /api/v1/ab-tests`
- `POST /api/v1/ab-tests/:id/start`
- `POST /api/v1/ab-tests/:id/pause`
- `POST /api/v1/ab-tests/:id/declare-winner/:variantId`

### 7.19 Governance
- `GET  /api/v1/governance/risks` — active risk_stops
- `GET  /api/v1/governance/evals?companyId=X`
- `POST /api/v1/governance/evals/run`

### 7.20 Onboarding
- `GET  /api/v1/onboarding/checklist` — progress per task
- `POST /api/v1/onboarding/complete/:taskId`
- `POST /api/v1/onboarding/skip`

---

## 8. Screen Inventory (28 pages to design)

### 8.1 Public / Marketing (pre-auth)
1. **`/`** — Landing page (hero + value props + features + pricing preview + CTA)
2. **`/pricing`** — 4-tier pricing (Free/Creator/Pro/Business) + monthly/yearly toggle + Enterprise + FAQ
3. **`/features`** — Feature showcase, 9 Primitives explained
4. **`/docs`** — Documentation hub (getting started, concepts, guides, API ref)
5. **`/privacy`** — Privacy Policy
6. **`/terms`** — Terms of Service

### 8.2 Auth
7. **`/login`** — Email+password + Google OAuth + "Reset password" link
8. **`/reset-password`** — Token-based password reset
9. **`/auth/callback`** — OAuth return handler (spinner)

### 8.3 Onboarding
10. **`/onboarding`** — 5-step segmentation wizard (Welcome → Segment → Template → Confirm → Go)
    - NOTE: In the revised design, this page becomes the SINGLE canonical entry. Old `/companies/new` freeform flow becomes an "Advanced" path accessible from Step 2.

### 8.4 Core Product (authenticated, sidebar navigation)
11. **`/dashboard`** — Command Center: health metrics, live activity feed, recent companies, pending approvals snapshot
12. **`/companies`** — All companies list (grid/list toggle, filter by status, search)
13. **`/companies/new`** — Freeform AI Company Builder (clarification chat + live spec preview)
14. **`/companies/[id]`** — Company detail (overview + agents tab + pipelines tab + runs tab + memory tab + CRM tab + drafts tab + settings tab)
15. **`/companies/[id]/runs/[runId]`** — Run detail: SSE live stream of steps + tool calls + costs + reasoning
16. **`/companies/[id]/export`** — Export as Claude Code skill/bundle

### 8.5 Operational (sidebar items)
17. **`/pipelines`** — All pipelines across all companies (global view, filter by company)
18. **`/approvals`** — Pending approvals queue (review + approve/reject)
19. **`/drafts`** — Draft review queue (social posts, emails, blog posts awaiting human approval)
20. **`/errors`** — Recent errors across runs (triage view)
21. **`/risks`** — Governance risks: loop_stop, cost_anomaly, spam_stop, brand_violation events

### 8.6 Growth & Intelligence
22. **`/marketplace`** — Blueprint marketplace (42+ curated templates to clone)
23. **`/integrations`** — 30 integration providers (install/configure/test each)
24. **`/webhooks`** — Webhook marketplace (32 templates) + installed webhooks
25. **`/analytics`** — Charts: run success rate, cost trends, top pipelines, funnel
26. **`/ab-tests`** — A/B test dashboard (variants, metrics, winner selection)

### 8.7 Account
27. **`/settings`** — Profile + AI provider + notifications + referral + danger zone (delete account)
28. **`/billing`** — Current plan + usage meter + payment method + invoices + upgrade/downgrade

---

## 9. Detailed Page Specifications

### 9.1 Landing Page (`/`)

**Structure (single-column, scroll-reveal)**

1. **Nav** (sticky, 64px tall): Logo (AI gradient square 32px + "Braavolabs") | "Features" | "Pricing" | "Docs" | CTA "Get Started" (gradient button)

2. **Hero** (above fold, ~800px tall, centered content):
   - Badge: `● BUILT FOR CREATORS & SOLO FOUNDERS` (cyan pill, uppercase, tracking-wide, animated pulse dot)
   - H1: 2-line display
     - Line 1: "Your AI company." (white)
     - Line 2: "Built in 10 minutes." (brand gradient text — cyan→purple)
   - Sub (max-width 520px): "Describe your business in plain English. Braavolabs builds a fully-staffed autonomous team — content, sales, ops — that runs while you sleep. Every decision is logged."
   - Hero builder input (max-width 640px, rounded-2xl card with subtle glow):
     - Header: `smart_toy` icon + "AI COMPANY BUILDER" label (uppercase tracking, cyan)
     - Textarea: 3 rows, animated typewriter placeholder cycles through example prompts
     - Footer: `⌘ + Enter` kbd hint (left) + CTA "Hire my AI team — free" (right, gradient button)
   - Chips (4 quick-start templates, centered row, wrapping on mobile):
     - "TikTok Content Studio", "Newsletter Growth", "Lead Follow-up", "Client Reporting"
     - On click: pre-fill textarea with persona-matched prompt
   - Background: Subtle animated canvas showing floating agent nodes (respects reduced-motion)

3. **Trust bar** (below hero, compact):
   - 4 badges in a row: `lock` "SOC 2 in progress" | `bolt` "10K+ runs executed" | `shield` "AES-256 encrypted" | `check_circle` "EU + US data residency"

4. **"How it works" section** (3-step visual):
   - Step 1: "Describe" — user typing animation
   - Step 2: "AI builds" — 9 agent nodes appearing connected
   - Step 3: "Runs itself" — pipeline execution animation with real-time logs

5. **Features grid** (3×3, icon + title + 1-line desc):
   - "9 AI Primitives" | "Full audit log" | "Spend approval" | "Memory engine" | "Export to Claude Code" | "Self-hostable" | "30+ integrations" | "Blueprint marketplace" | "Risk stops"

6. **Pricing preview** (3 cards — Free/Creator/Pro — with "See all plans →" to full `/pricing`)

7. **Testimonial strip** (once real testimonials exist; for launch use "500+ creators on waitlist" type placeholder instead of fake quotes)

8. **Final CTA section**: Centered card, brand-glow background, "Ready to hire your AI team?" → "Get Started Free"

9. **Footer**: 4 columns (Product / Resources / Company / Social) + copyright + small "Made with Claude" mark

---

### 9.2 Pricing Page (`/pricing`)

**Already redesigned in current codebase** — `packages/ui/app/pricing/page.tsx`. Match the current implementation's structure but elevate visual polish:

- 4 cards in a row (Free, Creator $19, Pro $39 w/ "Most Popular" badge, Business $99)
- Enterprise call-out strip below (single wide card, "Talk to Founder" CTA)
- Monthly/Yearly toggle with `−20%` green badge on Yearly
- Feature checklist per tier (icon + text rows)
- 6-item FAQ grid (2×3) at bottom

**Yearly price display rule**: Show per-month equivalent when Yearly is active (e.g. "$31.20 / mo · billed yearly"), NOT total annual.

---

### 9.3 Login / Signup (`/login`)

**Layout**: Split screen on desktop (≥1024px), stacked on mobile.

**Left (or top on mobile)** — brand side (40% width):
- Gradient background (subtle animated mesh)
- Logo top-left
- Center: mini quote or stat carousel ("Claude-native", "Self-hostable", "10-min setup")

**Right (or bottom on mobile)** — form side:
- Card `rounded-2xl p-8 max-w-md`
- Tabs or toggle: "Sign In" / "Create Account"
- Sign-in form:
  - Google OAuth button (full-width, white bg, Google "G" logo, black text) — PRIMARY
  - Horizontal divider with "or"
  - Email input (validated live)
  - Password input with show/hide toggle
  - "Forgot password?" link (right-aligned, small)
  - "Sign in" button (gradient, full-width)
- Create-account form: email + password + name (tenant name auto-generated, shown on blur as "We'll create 'Mustafa's workspace' — you can rename later")
- Footer: "By signing up you agree to Terms + Privacy" (muted text, links)

**States**:
- Loading: spinner in button + disable form
- Error: inline red toast above form ("Invalid credentials" or server message)
- Success: fade form, show "Redirecting..." for 300ms

---

### 9.4 Onboarding Wizard (`/onboarding`)

**Unified 5-step flow** (replaces old /onboarding + /companies/new duality):

**Layout**: Full-page, centered max-width 720px, progress bar at top showing step X of 5.

**Step 1: Welcome (segmentation)** — 30 seconds
- H1: "What brings you here today?"
- 4 large clickable cards (2×2 grid), each ~180px tall, icon + title + 1-line desc:
  - 📹 "Scale my content & social" — TikTok, LinkedIn, YouTube
  - 💼 "Automate my sales / outreach" — Lead gen + email sequences
  - 🛠 "Build something custom" — Freeform description
  - 👀 "Just exploring" — Browse demo mode

**Step 2: Template vs Custom** — 60s
- Shows 3 recommended blueprints based on segmentation + "Build from scratch" secondary option
- Each blueprint card: icon, name, "Clone in 2 min", agent count, run cost estimate

**Step 3: Configure**
- If template chosen: show filled-in form (name, slug, primitives toggles, niche, target audience, channels) — user tweaks
- If custom chosen: redirect to freeform clarification chat (see 9.6)

**Step 4: API Provider**
- Default: "Use bundled credits (first 10 runs free on Free plan)"
- Alternative: "Bring your own API key" expandable section
- If Bring-your-own: Anthropic / OpenAI / Google dropdown + API key input (masked)
- "Test connection" button — green checkmark on success

**Step 5: Launch**
- Summary card: Company name, primitives list, 3 agent previews, 1 pipeline preview
- Big "Launch My AI Company" button (gradient)
- "This creates your company and runs your first pipeline automatically — you'll see output in ~45 seconds."

**Persistent UI**:
- Back button in top-left
- Skip link top-right ("Skip for now — just show me the dashboard")
- Progress dots 1-5 animated

---

### 9.5 Dashboard (`/dashboard`) — LOGGED IN

**Grid layout** (max-width 1280px, responsive):

**Top bar** (48px): Breadcrumb + search + notifications bell + user avatar menu

**Hero row** — 5 KPI cards (responsive grid 2/3/5 cols):
- Active Companies (icon + count + MoM delta)
- Running Pipelines (animated pulse dot when > 0)
- Pending Approvals (amber-tinted if > 0, click → approvals page)
- Runs This Month (vs plan quota — show progress ring 0-100%)
- Cost This Month (USD, cyan if under budget)

Each card: 120px tall, `rounded-xl` `bg-surface-container`, icon top-left colored by semantic, value `text-2xl font-bold`, label `text-xs muted`, trend indicator bottom.

**Main content** — 2 columns (8/4 on lg, stacks on md):

Left column (2/3 width):
- **Companies list** (glass-card)
  - Header: "Your Companies" + filter pills (All/Active/Paused) + "+ New Company" button
  - Rows: gradient-brand avatar (initial letter), name + desc, primitive chips, status dot, last run time
  - Click row → `/companies/[id]`
- **Run Timeline** (last 24h, horizontal swimlane)
  - Shows runs as colored bars by status, clickable

Right column (1/3 width):
- **Live Activity Feed** (auto-updating SSE)
  - Ordered reverse-chronological
  - Each item: agent avatar + action text + timestamp
  - "Content published → TikTok" / "Lead scored → 0.87" / "Invoice reconciled"
- **Pending Approvals** (top 3, with "View all →" link)
  - Amount + reason + Approve/Reject inline buttons

**Empty states** (no companies yet):
- Single large card centered: "Build your first autonomous AI company in 10 minutes"
- 3 template cards + "Describe from scratch" CTA

---

### 9.6 Freeform Company Builder (`/companies/new`)

**Chat-like interface** (max-width 720px centered):

**Top**: Progress indicator "1 of 4 steps" → "Describe" → "Clarify" → "Preview" → "Create"

**Step 1 — Describe** (initial):
- Big textarea card, `rounded-2xl`, min-height 180px
- Header: "Describe your company in plain English"
- Placeholder rotates (typewriter): "A faceless YouTube channel about AI tools, 3 videos/week, targeting developers" / "A B2B SaaS outbound sequence for project managers" / "A TikTok-first meme brand for Gen Z"
- Character count bottom-right
- Submit button bottom-right: "→ Continue" (gradient)

**Step 2 — Clarify** (AI chat):
- Chat bubbles (AI left, user right)
- AI asks strategic questions (max 3 rounds): "What's your typical customer's job title?" / "How often do you want to publish?" / "What's your tone — professional, casual, humorous?"
- User types response → AI continues
- On each AI turn: show `thinking` state (3 animated dots) for ~2 seconds
- "Enough questions" button to skip remaining rounds
- Top-right: "Reset" (starts over)

**Step 3 — Preview** (full spec):
- Left panel: generated spec
  - Company name (editable)
  - Description
  - Primitives (checkbox list — user can toggle)
  - Agents (3-9 cards, each showing role + system prompt preview + tools)
  - Pipelines (cards with step count, first step name)
  - Estimated run cost range
- Right panel (on lg): "Your AI company at a glance" visualization — 9 primitive hexagons with enabled ones glowing
- Footer: "Edit" (back to Step 2) / "Looks good — Create" (gradient)

**Step 4 — Creating**
- Full-page loading with progressive status:
  - "Creating company... ✓"
  - "Spinning up agents (3)... ✓"
  - "Configuring pipelines (2)... ✓"
  - "Running first pipeline..." (animated)
- Redirect to `/companies/[id]/runs/[runId]` when done

---

### 9.7 Company Detail (`/companies/[id]`)

**Top bar**: Breadcrumb (Dashboard / Companies / [Company Name]) + actions dropdown (Pause, Archive, Export, Delete)

**Header card** (full-width):
- Gradient avatar 64px + Name (H1) + slug + description
- Metadata row: `status chip` | `primitive chips` | `created X days ago` | cost to date
- Quick actions: "Run Pipeline" (primary) | "Edit" | "Clone" | "Export"

**Tab navigation** (sticky):
Overview | Agents (3) | Pipelines (2) | Runs (12) | Memory (47) | CRM | Drafts (5) | Settings

**Overview Tab**:
- 2×2 grid:
  - "Last Run" card (status, timestamp, cost, duration — click to drill in)
  - "Next Scheduled Run" card (cron expression in human form: "Daily 9am UTC")
  - "Weekly Metrics" chart (runs/day last 7d, stacked by status)
  - "Recent Drafts" (last 3)

**Agents Tab**:
- Grid of agent cards (3 cols lg, 2 md, 1 sm)
- Each card: 
  - Icon + name (editable inline) + role badge
  - System prompt preview (3 lines, "Edit" button opens modal)
  - Tools count ("12 tools") with expandable list
  - Model + max tokens
  - "Edit" / "Version history (3)" / "Test in isolation"

**Pipelines Tab**:
- Rows with:
  - Pipeline name + trigger type (chip)
  - Schedule (human-readable cron: "Daily 9am")
  - Last run status + when
  - Enabled toggle (switch)
  - "Run Now" / "Edit" / "Runs history"

**Runs Tab**:
- Filterable list (by status chips row)
- Table rows: Started At | Duration | Status | Cost | Steps | Actions
- Click row → run detail page

**Memory Tab**:
- Filter by type (EPISODIC / SEMANTIC / PROCEDURAL) + status (CANDIDATE / APPROVED / DEPRECATED)
- Search bar (semantic search)
- Cards showing memory content + confidence + useCount + "Promote" button (if CANDIDATE)
- Right-side panel (on lg): selected memory's graph neighbors (small node graph)

**CRM Tab**:
- Sub-tabs: Contacts / Deals / Sequences
- Each a table with inline editing, bulk actions, CSV import/export

**Drafts Tab**:
- Card grid of pending drafts
- Each: type icon + title + preview + "Approve" / "Edit" / "Reject" actions

**Settings Tab**:
- Company name / slug / description (editable form)
- Primitives checkboxes
- Config JSON editor (for advanced users)
- Danger zone: Archive / Delete (red, confirmation modal)

---

### 9.8 Run Detail (`/companies/[id]/runs/[runId]`)

**CRITICAL PAGE — SSE real-time streaming**

**Top bar**: Breadcrumb + run ID (monospace, copyable) + status chip (animated if running)

**Header card** (120px):
- 4-col grid:
  - Run name (pipeline name)
  - Status: big chip, animated pulse if RUNNING
  - Duration: ticking if running, final if done
  - Cost: USD with spend meter bar (cost / budget)
- Actions row: "Stop" (red, if running) | "Pause" | "Resume" | "Re-run" | "Rollback step"

**Main column** — **Step Timeline** (vertical stepper):

Each step is a card in a vertical timeline (connector line between):
- Left: step index circle (1, 2, 3...) colored by status
- Right card (w-full):
  - Step name (H3) + status chip
  - Agent name (chip with avatar)
  - Duration + cost
  - **Reasoning block** (mandatory display) — quote-styled, italic, "Why: The agent decided to..."
  - Expandable sections:
    - Input (JSON pretty-printed, syntax-highlighted, collapsible)
    - Output (JSON, same)
    - Tool Calls (nested list — each tool call with name, duration, input/output preview)
- Auto-scroll to latest step when streaming
- Click a step → side panel opens with full details

**Right panel (on lg)** — Live Telemetry:
- Cost meter (live ticker)
- Token usage (input + output)
- Per-agent breakdown
- "View audit log" link

**Footer**:
- If WAITING_APPROVAL: big banner "This run is paused — approval required" + Approve/Reject buttons inline
- If FAILED: error details in expandable card + "Debug in Claude Code" link (exports failed run context)

**SSE handling**:
- Connection indicator (green pulsing dot = connected, gray = disconnected, yellow = reconnecting)
- Fallback to polling every 2s if SSE unavailable
- New step appears with slide-down animation

---

### 9.9 Approvals Page (`/approvals`)

**Queue-style layout** (Gmail inbox feel):

**Top bar**: Count ("3 pending") + filter chips (All / Pending / Approved / Rejected) + bulk actions (select all → approve all)

**List**:
- Each approval card:
  - Left: Company avatar + approval type icon (💰 for SPEND)
  - Middle: Description ("Agent wants to send $50 ad spend for TikTok boost") + metadata (run name, company)
  - Right-top: Amount USD (bold)
  - Right-bottom: "Approve" (green) / "Reject" (red ghost) / "View run details" (link)
  - Expandable: show full metadata JSON
- Keyboard shortcuts: `J/K` navigate, `A` approve, `R` reject

**Empty state**: "All clear! No pending approvals." + "Approvals are required only for spend actions per company policy."

---

### 9.10 Drafts Page (`/drafts`)

**Card grid** (3 cols desktop, 2 tablet, 1 mobile):

**Top bar**: Filter by type (SOCIAL_POST / EMAIL / BLOG_POST / AD_COPY / VIDEO_SCRIPT) + company filter + status tabs

**Draft card**:
- Type icon top-left (emoji or material icon)
- Channel badge (if SOCIAL_POST): TikTok / LinkedIn / Twitter / Instagram
- Title (H4) + content preview (3-line clamp)
- Preview specialization:
  - SOCIAL_POST: rendered as mock social post (with platform chrome)
  - EMAIL: subject + first 2 lines of body
  - BLOG_POST: title + excerpt
- Scheduled time (if set): calendar icon + "Scheduled for 2h"
- Footer: "Approve" / "Edit" / "Reject" / "Schedule"

**Detail modal** (on click):
- Full content rendering
- Inline edit
- Channel-specific preview (e.g. phone mockup for TikTok)
- Metadata + history

---

### 9.11 Integrations Page (`/integrations`)

**Grid of provider cards** (4 cols desktop, 30 providers):

**Top bar**: Search + category filter (Social / AI / CRM / Payment / Productivity / etc.) + "Installed" toggle

**Provider card**:
- Provider logo + name
- Category chip
- Status indicator:
  - Not installed: "Install" button
  - PENDING: amber "Connecting..."
  - ACTIVE: green checkmark + "Test" / "Manage"
  - ERROR: red warning + "Fix"
- On click (not installed): modal with credential form + "Where to find these keys" link
- On click (installed): settings modal with "Disconnect" / "Re-test"

---

### 9.12 Marketplace (`/marketplace`)

**Blueprint catalog** (42+ curated templates):

**Hero**: "Clone a proven AI company in one click" + search bar

**Sub-tabs**: Curated (official) | Community (user-published)

**Blueprint card** (masonry grid):
- Gradient icon + category tag
- Title (H3)
- Description (2 lines clamp)
- Metadata row: 3 agents | 2 pipelines | ~$0.15/run
- "Clone to my account" (gradient button)
- "Preview" (secondary) — opens modal with full spec

**Blueprint detail modal**:
- Title + full description
- Agents tab (cards)
- Pipelines tab (flow diagrams)
- Sample output
- "Clone" CTA
- Shown `clone count: 127` (social proof)

---

### 9.13 Settings Page (`/settings`)

**Tabbed layout** (vertical nav on left desktop, sticky tabs on mobile):
- Profile
- AI Provider
- Notifications
- Team (Pro+)
- Billing (shortcut to `/billing`)
- API Keys
- Referral
- Danger Zone

**Profile**: Name, email (readonly), avatar upload, timezone, language

**AI Provider**:
- Provider dropdown (Anthropic / OpenAI / Google / etc.) with logos
- Model dropdown (filtered by provider)
- API key input (masked, "Test connection" button green on success)
- "Using bundled credits" toggle (Free plan only)
- Cost estimation: "Current plan includes 10 runs/month (~$1 value)"

**Notifications**: Toggles for run_completed / spend_approval / pipeline_errors / weekly_summary. Email + (future) push channels.

**Referral**:
- Referral code (monospace, copyable) with share buttons (Twitter, LinkedIn, email template)
- Stats: "5 referrals made, 2 converted, +60 bonus runs earned"
- Redeem code input (for new users entering a friend's code)

**Danger Zone**: "Delete account" (red outlined button, confirmation modal requiring email typing)

---

### 9.14 Billing Page (`/billing`)

**Layout**:

**Current plan card**:
- Tier name (large, colored)
- Price
- "Upgrade" / "Manage in Stripe Portal" buttons

**Usage meters** (4 cards):
- Runs this month (progress ring + number/quota)
- Companies (count/quota)
- Contacts (if Pro+)
- Team seats (if Business+)

**Invoices table**:
- Date | Amount | Status (Paid/Failed/Pending) | Download PDF

**Payment method**: last-4 digits (if card on file) + "Update in Portal"

**Quota warning** (if used > 80%): amber banner "You've used 8 of 10 runs — upgrade for more"

---

## 10. Component Library Requirements

Build these reusable primitives (shadcn/ui pattern):

### 10.1 Primitives
- `<Button>` — variants: primary (gradient), secondary (surface-container), ghost (transparent), destructive (red). Sizes: sm/md/lg. Loading state (spinner + disabled).
- `<Input>` — text, email, password (w/ show toggle), number. Error state (red ring), disabled, with prefix/suffix icons.
- `<Textarea>` — auto-grow, character counter, min/max chars validation.
- `<Select>` — native-looking but custom (keyboard accessible).
- `<Checkbox>`, `<Radio>`, `<Switch>`, `<Slider>`.
- `<Label>` + `<FormField>` — accessible labels + error message slots.

### 10.2 Layout
- `<Card>` — variants: default (surface-container), elevated (surface-container-high), glass (backdrop-blur).
- `<Stack>` (vertical) / `<HStack>` (horizontal) — spacing prop.
- `<Divider>` — horizontal/vertical, optional label.
- `<Container>` — max-width constraint.
- `<Grid>` — responsive columns.

### 10.3 Feedback
- `<Toast>` — stacked notifications, auto-dismiss, action link. Positions: bottom-right desktop, top mobile.
- `<Modal>` / `<Dialog>` — centered, backdrop blur, focus trap, esc-to-close.
- `<Drawer>` — slide-in from right (desktop) or bottom (mobile).
- `<Tooltip>` — hover + focus.
- `<Popover>` — click-triggered, click-outside closes.
- `<Alert>` — info/success/warning/error variants.
- `<Progress>` — linear + circular (ring).
- `<Spinner>` — sm/md/lg.
- `<Skeleton>` — text, circle, rectangle. Use instead of spinners for content.

### 10.4 Data Display
- `<Badge>` / `<Chip>` — variants: status (with colored dot), plain, outline, primary.
- `<Avatar>` — initial letter fallback, gradient bg per userId hash.
- `<Table>` — sortable columns, row selection, sticky header, empty state.
- `<List>` — virtual scroll for >100 items.
- `<EmptyState>` — icon + title + description + CTA.
- `<Stat>` — label + value + delta + trend arrow.
- `<Sparkline>` — inline trend chart.

### 10.5 Navigation
- `<Sidebar>` — collapsible (expanded 240px, collapsed 56px icons-only), section headers, active indicator.
- `<Breadcrumb>` — hierarchical links, mobile-collapse.
- `<Tabs>` — horizontal pill or underline variants.
- `<Pagination>` — page numbers + prev/next + "X of Y items".
- `<CommandPalette>` — Cmd+K global search (pages, companies, runs, help).

### 10.6 Domain-Specific
- `<StatusChip>` — props: status ∈ RunStatus. Colored dot + label. Pulse animation if RUNNING.
- `<CostBar>` — used / budget bar, color-coded (green <60%, amber 60-90%, red >90%).
- `<RunTimeline>` — vertical stepper for RunSteps with live SSE updates.
- `<ToolCallBubble>` — compact card showing tool name + duration + "▸ expand" for input/output.
- `<ApprovalCard>` — approval queue item with inline Approve/Reject.
- `<DraftPreview>` — platform-specific rendering (TikTok/LinkedIn/email mockups).
- `<CompanyAvatar>` — gradient-brand bg + initial letter.
- `<AgentAvatar>` — unique color per agent role hash.
- `<PipelineFlow>` — horizontal step chips with arrows between.
- `<MemoryGraph>` — small force-directed graph showing memory edges (use `react-force-graph` or custom D3).
- `<PrimitiveIcon>` — 9 icon variants (ACQUISITION/SALES/DELIVERY/CONTENT/OPERATIONS/FINANCE/ANALYTICS/MEMORY/GOVERNANCE).

### 10.7 Forms
- `<ApiKeyInput>` — masked input with show/hide + test-connection button + status indicator.
- `<CronInput>` — friendly preset dropdown ("Daily 9am", "Weekly Mon", "Monthly 1st") + Advanced toggle to expression.
- `<JsonEditor>` — for config fields, syntax-highlighted, schema-validated.
- `<PrimitiveSelector>` — 9 toggle chips with descriptions.
- `<ChannelSelector>` — pill list with platform icons (TikTok, LinkedIn, etc.).

---

## 11. States & Feedback

Every component + page must handle:

### 11.1 Loading
- First load: `<Skeleton>` matching final layout
- Background refetch: subtle spinner in corner, don't block UI
- Button loading: replace label with spinner + disable
- SSE reconnect: status indicator

### 11.2 Empty
- Never show a blank panel
- Always: icon + title + 1-line description + CTA
- Friendly copy ("No runs yet — trigger your first workflow →")

### 11.3 Error
- Inline (form fields): red ring + icon + message below
- Toast (transient): red tinted, actionable ("Retry" button)
- Page-level (server down): dedicated error page with "Try again" + "Contact support" + supportId
- Never show raw stack traces to users

### 11.4 Success
- Micro: toast ("Saved ✓") top-right, 2s
- Macro: confetti + full-screen celebration for first-time events (first company, first run, first paying customer)
- Check icon + fade-in for form submissions

### 11.5 Disabled
- 50% opacity
- `cursor-not-allowed`
- Tooltip on hover explaining why (e.g. "Upgrade to Creator to run more pipelines")

### 11.6 Read-only / Locked
- Gradient lock icon overlay
- "Upgrade to unlock" CTA
- Applied to Pro+ features on Free plan

---

## 12. Responsive Breakpoints

Mobile-first approach:

```
sm:  640px   - large phone / small tablet
md:  768px   - tablet portrait
lg:  1024px  - tablet landscape / small laptop
xl:  1280px  - desktop
2xl: 1536px  - large desktop
```

**Key patterns**:

- **Sidebar**: desktop permanent (240px expanded), mobile hamburger (slide-in drawer)
- **Nav**: top-bar with logo + hamburger on mobile; full horizontal desktop
- **Tables**: horizontal scroll on mobile OR card-based alternative (show key fields)
- **Forms**: single-column <md, 2-column >=md
- **Grids**: 1 col sm / 2 col md / 3-4 col lg
- **Modals**: full-screen on mobile (<sm), centered card on desktop

**Do not**:
- Use hover-only interactions (touch has no hover)
- Require horizontal scroll for primary content
- Set fixed widths on mobile (use % or viewport units)
- Use `<thead>` that wraps on narrow (use responsive cards instead)

**Touch targets**: Minimum 44×44px. Verify with `[role="button"]` + padding calculation.

---

## 13. Accessibility (WCAG 2.2 AA minimum)

- Color contrast: text 4.5:1 minimum (7:1 for body preferred)
- All interactive elements keyboard-reachable, visible focus ring (2px primary color outline)
- Semantic HTML: `<nav>`, `<main>`, `<aside>`, `<article>`, proper heading hierarchy
- ARIA labels on icon-only buttons (`aria-label="Close"`)
- Form labels linked (`<label htmlFor>` or wrapping)
- Error messages announced via `role="alert"` + `aria-live="polite"`
- Modals: focus trap + `aria-modal="true"` + ESC-to-close
- Skip-to-content link at top of every page
- Image alt text (use empty `alt=""` for decorative)
- No autoplay video/audio
- Respect `prefers-reduced-motion` (disable parallax, reduce animation)
- Respect `prefers-color-scheme` (both modes supported)
- Screen reader landmarks tested (axe, Lighthouse ≥ 95)

---

## 14. Animation Guidelines

**Allowed**:
- Hover states on interactive elements (scale 1.02, brightness 110%, border color shift)
- Page enter: fade-in 400ms with 16px translateY
- Card/row reveal: staggered 50ms delay between items
- Status change: 250ms cross-fade
- Toast: slide-in from right, slide-out
- Modal: fade-in + scale 0.95→1
- Skeleton shimmer: 1.5s infinite horizontal gradient
- Status-dot pulse: 2s infinite (only for RUNNING state)
- Brand glow: subtle 4s breathing on hero CTA

**Forbidden**:
- Auto-rotating carousels (require user input)
- Marquee/scroll text
- Parallax on body scroll (ok on decorative sections only)
- Animations > 1s for UI feedback (feels broken)
- CSS `animation: all infinite` (performance killer)

**Framer Motion** — only for the landing hero canvas (agent nodes floating). Everything else CSS transitions.

---

## 15. Copy Voice Guidelines

**Tone**: Helpful · Direct · Humble · Smart (NOT: salesy, corporate, jokey, cringe)

**Rules**:
- Second person ("your AI company", "you can...")
- Active voice ("Run your pipeline" not "Your pipeline can be run")
- Concrete verbs ("Ship", "Launch", "Hire" not "Utilize", "Leverage")
- No marketing-speak: avoid "cutting-edge", "revolutionary", "game-changing", "next-gen", "disrupt"
- Short sentences (< 20 words)
- Plain numbers ("Built in 10 minutes", not "Build in under 600 seconds")
- Honest scope ("SOC 2 in progress", not "SOC 2 Ready" when not certified)

**Button labels** — imperative, specific:
- ❌ "Submit" → ✅ "Run pipeline"
- ❌ "Get Started" → ✅ "Hire my AI team — free"
- ❌ "Continue" → ✅ "Launch my company"
- ❌ "Save" → ✅ "Save agent"

**Errors** — helpful, not blaming:
- ❌ "Invalid input" → ✅ "Please enter a valid email (e.g. you@example.com)"
- ❌ "500 Internal Error" → ✅ "Something went wrong on our side. Retry or contact support with ID `abc123`."
- ❌ "API key failed" → ✅ "Anthropic rejected your API key. Check it in Settings → AI Provider."

**Empty states** — invite next action:
- ❌ "No data" → ✅ "Your first pipeline will appear here — let's build one →"
- ❌ "Nothing found" → ✅ "No runs match these filters. Try clearing them or run a new pipeline."

**Jargon translation toggle** (Settings → Preferences):
| Technical (default for Pro+) | Plain (default for new users) |
|---|---|
| Primitive | Capability |
| Agent | AI Specialist |
| Pipeline | Workflow |
| Run | Execution |
| Run Step | Step |
| Tool Call | Action |
| Approval | Spend review |
| Blueprint | Template |
| Clarification loop | Setup chat |

---

## 16. Dos and Don'ts

### ✅ DO
- Lead every authenticated page with context (breadcrumb + page title + primary action)
- Show costs in USD with 4-decimal precision for precision, rounded for display (`$0.0234` → display `$0.02`)
- Use monospace font for IDs, tokens, JSON, code
- Group related actions in a dropdown (overflow menu with ⋯ icon)
- Confirm destructive actions (delete, archive) with a modal requiring typed confirmation
- Show "last updated X ago" for stale data + refresh button
- Include keyboard shortcuts (show with `kbd` styled elements)
- Save drafts of long forms to localStorage; restore on page load
- Use optimistic UI (show instant success, rollback on server error)
- Persist UI state in URL (filters, tabs, sort order) — shareable links

### ❌ DON'T
- Don't use modals for forms that need > 2 screens of content (use dedicated page)
- Don't mix tabs and sidebar navigation for same concept
- Don't use more than 2 CTAs per view (primary + secondary)
- Don't hide required fields behind accordions
- Don't show toasts for every keystroke save (only explicit actions)
- Don't use color alone to convey state (always pair with icon/text)
- Don't use `alert()` or `confirm()` native dialogs
- Don't render giant JSON blobs without collapsibility
- Don't lock the user into a flow (always provide escape hatch)
- Don't autoplay anything (videos, sounds, carousels)

---

## 17. Delivery Checklist

When delivering designs, provide:

1. **Screen-by-screen layouts** (Figma / images) for all 28 pages
2. **Component library** (reusable React + Tailwind code) — full source, not just previews
3. **Responsive variants** for every page: mobile (375px), tablet (768px), desktop (1440px)
4. **Light + dark mode** versions (dark primary)
5. **Empty + loading + error states** for each page
6. **Interaction specs** — Figma prototype or detailed interaction notes
7. **Micro-copy spreadsheet** (optional bonus) — every button/label in one place
8. **Design tokens** — colors, typography, spacing as CSS variables matching `globals.css`
9. **Figma / source file** delivered + code export for at least the 10 most complex pages

---

## 18. Out of Scope (V2)

Don't design these yet:
- Native mobile apps (iOS/Android)
- White-label / custom CSS variables per tenant
- Team collaboration features beyond presence indicators
- Full i18n (keep English-first for V1)
- Dashboard widgets configurability
- Marketplace seller panel (just consumer for now)
- Admin panel (for us the operators — lower priority)

---

## 19. Questions for the designer (optional)

- Should the clarification loop in `/companies/new` use a voice-like chat UI (WhatsApp style) or a more "terminal" minimalist style?
- For `/companies/[id]/runs/[runId]` live streaming — should failed steps collapse or stay expanded for debugging?
- Marketplace blueprint cards — masonry grid or uniform? (masonry implies variable heights)
- Does Analytics page deserve a time-range picker in global nav, or per-chart?
- Should we use `Heroicons` instead of Material Symbols for more custom/cleaner look?

---

**END OF BRIEF**

This document is versioned at `docs/DESIGN-BRIEF.md`. Keep it in sync with any major UX decisions.
