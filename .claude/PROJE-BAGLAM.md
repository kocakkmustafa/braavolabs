# 🎯 PROJE BAĞLAMI — AJANLAR MUTLAKA OKUR

**Bu dosya her ajan için ZORUNLU okumadır.** Ajan takımı "The Creator" için yazılmış jenerik prompt'lardır; ama **bu proje The Creator DEĞİL**.

---

## 🟢 Proje: Braavolabs (braavolabs.com)

| Alan | Gerçek Değer |
|------|---|
| **Proje adı** | Braavolabs |
| **Domain** | braavolabs.com |
| **Kod adı** | braavolabs |
| **Vaat** | "10 dakikada AI şirketini kur" |
| **Tip** | Freeform AI company creation & execution platform |
| **Ana ürün** | Serbest metinle AI şirketi kurup çalıştırma (clarification loop + 9 Primitive) |
| **Hero company** | Social Media Management + Autonomous Content Studio |
| **Free plan** | 1 şirket, TikTok + LinkedIn, 10 run/ay, gerçek çıktı |
| **Olgunluk** | Faz 18 tamamlandı (production-ready, güvenlik hardened, SSE streaming, export) |
| **Repo root** | `/Users/mustafakaankocak/Documents/YULAlabs-AI/Projects/Web Sites/braavoo.com` |
| **Authoritative CLAUDE.md** | `braavolabs.com/CLAUDE.md` (proje kökünde) |

---

## 🔄 KONSEPT HARİTASI — The Creator → Braavolabs

Ajan prompt'larında aşağıdaki The Creator terimleriyle karşılaştığında **otomatik olarak** Braavolabs karşılığına çevir.

| "The Creator" Prompt'ta | Braavolabs'taki Karşılığı |
|---|---|
| "The Creator" | "Braavolabs" / braavolabs.com |
| "thecreator.app" | "braavolabs.com" |
| Pipeline Builder (drag-drop node editor) | **Company Builder** (freeform clarification loop) + **Pipeline Runner** (yapılandırılmış pipeline template'lerini çalıştırır) |
| AI Agent Builder | Company içindeki **9 Primitive** (acquisition, sales, delivery, content, operations, finance, analytics, memory, governance) — her biri bir "agent" |
| Pipeline | `pipelines` tablosu (template), `runs` tablosu (her çalışma), `run_steps` (adım adım) |
| Pipeline execution | **Run execution** (runs → run_steps → tool_calls zinciri) |
| Node | Pipeline içindeki **step/tool** (Claude tool call) |
| Execution quota | **Run quota** (Free: 10/ay) |
| Template marketplace | **Blueprint sharing** (publish/list/clone API zaten var) |
| API key (OpenAI/Anthropic) | Kullanıcı tarafından girilen **Claude API key** + opsiyonel **HubSpot/Stripe/SendGrid key'ler** |
| Zapier/Make/n8n alternative | **YANLIŞ rakip sınıfı** — Braavolabs bir "automation builder" değil. Gerçek rakipler: Relevance AI (agent side), Lindy (task-agent), Gumloop (AI-native), ama daha çok **"AI SDR / AI agency in a box"** kategorisi. Ayrıca tam bir direkt rakip yok — ürün daha yeni |
| $19 Solo / $39 Pro / $99 Business | **Braavolabs'un gerçek pricing tier'ları HENÜZ kesinleşmedi** — bu projede pricing revizyon aktif konu. Ajanlar pricing hakkında konuşurken "öneri" moduna geç, fait accompli varsayma |
| Solopreneur/creator ICP | Benzer ama daha geniş: **AI-curious founder, agency owner, solopreneur** — "şirket çalıştırır gibi otomatik iş akışı isteyen" |
| Supabase | **Yok**. Stack: **Postgres 16 + pgvector + Prisma**. Self-hosted Docker Compose + opsiyonel cloud |
| Supabase RLS | Postgres'te **tenant_id filter + Prisma middleware** (uygulama katmanı tenant isolation) |
| Supabase Auth | **JWT + OAuth2 Google** (kendi auth sistemi) |
| Vercel serverless 10s timeout | **Yok**. Stack Node.js Express + BullMQ queue. Long-running runs queue üzerinden çalışır |
| BullMQ / Inngest / Trigger.dev | **BullMQ + Redis zaten kurulu ve V1'de kullanılıyor**. V2'de Temporal roadmap'te. Öneride "queue kur" deme — var |
| Stripe subscription | **Stripe + usage-based metering zaten kurulu (Faz 5)** |
| Sentry + PostHog | **OpenTelemetry + Pino structured logging zaten kurulu (Faz 7)** |

---

## 🔑 AI COMPANY OS'UN GERÇEK KRİTİK KURALLARI

Ajan, bulgularını değerlendirirken bu 10 kuralı referans alır. Bunlar CLAUDE.md'den alınmıştır:

1. **Her tool call loglanır** → `tool_calls` tablosu zorunlu
2. **Her step'te reasoning zorunlu** — "neden bu kararı verdin" alanı boş bırakılamaz
3. **Spend approval zorunlu** — para harcayan aksiyonlarda `approvals` tablosu
4. **Tek örnekle genelleme yok** — holding brain'e taşıma için 2+ şirkette tekrar
5. **Memory status lifecycle** — candidate → approved → deprecated (direkt approved yazma)
6. **Spam koruması** — aynı hedefe cevapsız 3+ gönderim engellenir
7. **Loop detection** — 5+ başarısız tekrar → otomatik durdurma
8. **Cost anomaly** — run maliyeti bütçenin %20'sini aşarsa durdur
9. **Activity log her yerde** — her CRUD, her gönderim, her karar `activity_log`'a
10. **Tenant isolation** — her DB sorgusu tenant_id filtrelemeli

---

## 🛑 RISK STOPS (Braavolabs'a özgü)

Her ajan audit yaparken bu stop mekanizmalarının doğru çalıştığını kontrol etmeli:

- `hard_stop` — manuel durdurma
- `loop_stop` — 5+ başarısız tekrar
- `cost_anomaly_stop` — bütçe %20 aşımı
- `spam_stop` — aynı hedefe 3+ cevapsız
- `brand_violation_stop` — brand guideline ihlali

---

## 🏗 GERÇEK TEKNİK STACK (Braavolabs)

```
Monorepo: pnpm workspaces + turbo
Backend: TypeScript + Node.js + Express
Frontend: Next.js 14 App Router + Tailwind + shadcn/ui
DB: Postgres 16 + pgvector + JSONB
ORM: Prisma
Cache/Queue: Redis 7 + BullMQ
Workflow (V1): n8n  /  Workflow (V2): Temporal (roadmap)
LLM: Claude (Anthropic API) — tool use / function calling (OpenAI değil)
CRM: HubSpot (@hubspot/api-client) — HubSpot-first
Billing: Stripe subscription + usage-based meters
Email: SendGrid veya Amazon SES
Auth: JWT + OAuth2 Google
Observability: OpenTelemetry + Pino
Container: Docker Compose (self-hosted taşınabilir)
CI/CD: GitHub Actions
Validation: Zod
```

**Önemli**: Claude API KEY, OpenAI DEĞİL. Ajan önerilerinde "OpenAI + Anthropic multi-model" derken Claude-first hatırla.

---

## 📋 VERİTABANI — 20 TABLO

Ajan, audit sırasında bu tabloların var olduğunu bilir:
`tenants, users, companies, agents, pipelines, runs, run_steps, tool_calls, approvals, memory_items, memory_embeddings, memory_edges, contacts, deals, outreach_sequences, outreach_enrollments, usage_meters, eval_results, activity_log, drafts`

---

## 🌐 API ENDPOINT (Özet)

- `/api/v1/companies` — CRUD + pause/resume
- `/api/v1/pipelines/:id/run` — pipeline çalıştır
- `/api/v1/runs/:id` — run detay + stop/pause/resume
- `/api/v1/run-steps/:id/rollback` — step rollback
- `/api/v1/run-steps/:id/rerun` — step tekrar çalıştır
- `/api/v1/approvals` — onay kuyruğu
- `/api/v1/memory/search` — semantic arama
- `/api/v1/drafts` — taslak yönetimi
- `/api/v1/dashboard/*` — health, usage, finance
- `/api/v1/billing/usage` — metering
- `/api/v1/auth/register` + `/login`
- `/api/v1/growth/pql` — PQL skoru
- `/api/v1/growth/blueprint/*` — blueprint sharing
- `/hooks/:company_slug/:event` — webhook handler (HMAC validated, Faz 17)

---

## ✅ TAMAMLANMIŞ FAZLAR

| Faz | İçerik | Durum |
|---|---|---|
| 0 | İskelet + Docker + DB şeması | ✅ |
| 1 | Orchestrator API + Company Builder + Pipeline Runner + Claude Agent | ✅ |
| 2 | Memory Engine (episodic + semantic + graph) | ✅ |
| 3 | HubSpot CRM + Outreach Automation | ✅ |
| 4 | Dashboard UI (Next.js) | ✅ |
| 5 | Stripe Billing + Usage Metering | ✅ |
| 6 | Governance + Risk Detection + Eval Suite | ✅ |
| 7 | OpenTelemetry + Observability | ✅ |
| 8 | Free Plan Onboarding (Hero Company) | ✅ |
| 9 | Referral + Growth Engine | ✅ |
| 10 | Self-Hosted + CI/CD | ✅ |
| 11 | Auth + Context Builder + Tool Executor + Outreach Runner + UI Pages | ✅ |
| 12 | PQL Scoring + Blueprint Sharing + Model Graders + Kanban Board | ✅ |
| 13 | Google OAuth + Local CLI Mode + UI Redesign | ✅ |
| 14 | Bug fixes (create_draft, consolidation-cron, draft validation, scheduled cron) | ✅ |
| 15 | SSE real-time run streaming | ✅ |
| 16 | Export system (CLAUDE.md, skills, hooks, bundle) + Export UI | ✅ |
| 17 | Security hardening (rate limiting, account lockout, HMAC webhooks, CSP, HSTS, security headers) | ✅ |
| 18 | Production readiness (health check, graceful shutdown, BYPASS_BILLING guard) | ✅ |

**Ajan bulgularını değerlendirirken:** "zaten çözüldü mü?" kontrolünü Faz geçmişine göre yapar. Örn: rate limiting = Faz 17 = çözüldü ✓.

---

## 🏢 REPO GOD KONUMU (Önceden keşfedilmiş)

**Yol**: `/Users/mustafakaankocak/AI Holding Claude/The Repo God/`
**Index**: `/Users/mustafakaankocak/AI Holding Claude/The Repo God/INDEX.md`

Envanter: `.claude/context/repo-god-inventory.md` (50 repo detaylı listelenmiş)

Ajan Repo God aramasında direkt buraya gitmeli, `find /` yapmaya gerek yok.

---

## 📝 AJAN ÇIKTILARI

Ajanlar raporlarını `.claude/context/reports/{ajan-adi}-{YYYY-MM-DD}.md` altına yazar.

Orchestrator 4 final çıktı üretir (launch değil **V1 production hardening** odaklı, Faz 18 sonrası):
- `docs/roadmap/launch-roadmap.md` — V1 launch / ilk 1000 user plan
- `docs/daily/daily-checklist.md` — günlük operasyon
- `docs/marketing/marketing-plan.md` — go-to-market
- `docs/manual-tasks.md` — Mustafa'nın manuel yapacakları

---

## 🗣 DİL

- Raporlar: **Türkçe**
- Kod + commit mesajları: İngilizce OK
- Landing/marketing copy: İngilizce (global pazar)

---

## ⚠️ AJAN İÇİN UYARILAR

1. **Pricing önerilerini fait accompli yapma** — Braavolabs pricing henüz sabitlenmedi. Öneri yap, varsayım yapma.
2. **"Zapier alternative" pozisyonlamasını sorgula** — Braavolabs o kategoride DEĞİL. Marketing önerilerinde kategori netleştir.
3. **"Pipeline" terimini iki anlamda kullan**: (a) template (`pipelines` tablosu), (b) genel workflow kavramı. Bağlamı netleştir.
4. **Zaten çözülmüş şeyi tekrar önerme** — Faz listesinden kontrol et. Örn: BullMQ queue zaten var, Stripe webhook HMAC zaten var (Faz 17).
5. **Export/skills/hooks/CLAUDE.md üretimi proje içinde bir özellik** — kullanıcı kendi AI şirketini export edebilir (Faz 16). Karıştırma.

---

**Bu dosya güncel tutulur. Yeni Faz tamamlanınca, yeni rakip bulunursa, pricing netleşince update edilir.**
