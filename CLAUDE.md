# CLAUDE.md — AI Company OS Proje Bağlam Dosyası

## Proje Nedir?
AI Company OS — kullanıcıların serbest metinle AI şirketi kurup çalıştırabildiği, izlenebilir, düzenlenebilir, kendini geliştiren otonom şirket oluşturma platformu. "10 dakikada AI şirketini kur" vaadi ile çalışır.

## Ürün Kararları (SABİT — değiştirme)
- Freeform company creation: kullanıcı serbest metinle şirket kurar
- Clarification loop: Claude eksik bilgileri sorar (max 3 tur)
- 9 Primitive sistemi: acquisition, sales, delivery, content, operations, finance, analytics, memory, governance — her şirket tipi bu primitive'lerden derlenir
- Hero company: Social Media Management + Autonomous Content Studio
- Free plan: 1 şirket, TikTok + LinkedIn, 10 run/ay, gerçek çıktı
- Onay politikası: SADECE para harcamada onay gerekir (spend approval), diğer tüm aksiyonlar serbest
- Full audit log: HER aksiyon, HER tool call, HER karar gerekçesi loglanır
- "Neden bu kararı verdin?" açıklaması: her run step'te ZORUNLU reasoning alanı
- Memory lifecycle: candidate → approved → deprecated (tek örnekle genelleme YAPMA)
- Holding brain'e taşıma: 2+ farklı şirkette tekrar eden başarı gerekli
- Cloud + Self-hosted hibrit deployment
- Docker Compose tabanlı taşınabilir mimari
- HubSpot-first CRM
- Stripe usage-based billing
- Risk stops: hard_stop, loop_stop, cost_anomaly_stop, spam_stop, brand_violation_stop

## Teknik Stack
- **Monorepo:** pnpm workspaces
- **Backend:** TypeScript + Node.js (Express)
- **Frontend:** Next.js 14+ App Router + Tailwind CSS + shadcn/ui
- **Database:** Postgres 16 + pgvector extension + JSONB
- **Cache/Queue:** Redis 7 + BullMQ
- **Workflow:** n8n (V1), Temporal (V2 roadmap)
- **LLM:** Claude (Anthropic API) — tool use / function calling
- **CRM:** HubSpot (@hubspot/api-client)
- **Billing:** Stripe (subscription + usage-based meters)
- **Email:** SendGrid veya Amazon SES
- **Auth:** JWT + OAuth2 (Google)
- **Observability:** OpenTelemetry + structured logging (Pino)
- **Container:** Docker Compose
- **CI/CD:** GitHub Actions
- **ORM:** Prisma
- **Validation:** Zod

## Komutlar
```bash
pnpm install                       # Bağımlılıkları kur
pnpm dev                           # Tüm servisleri başlat (turbo)
pnpm build                         # Tüm paketleri build et
pnpm lint                          # Lint
pnpm test                          # Test
pnpm db:migrate                    # Prisma migration
pnpm db:seed                       # Seed data
pnpm db:generate                   # Prisma client generate
pnpm docker:up                     # Docker Compose up
pnpm docker:down                   # Docker Compose down
```

## Proje Yapısı
```
AI_COMPANY_OS/
├── CLAUDE.md
├── package.json                 # pnpm workspace root
├── pnpm-workspace.yaml
├── turbo.json
├── .env.example
├── ENV/                         # Docker Compose + Dockerfile
├── packages/
│   ├── db/                      # Prisma schema + migrations
│   ├── core/                    # Shared types, utils, constants
│   ├── api/                     # Backend API (Express)
│   ├── ui/                      # Next.js Dashboard
│   ├── memory/                  # Memory engine
│   └── integrations/            # External adapters
├── HOLDING_CORE/                # Policies, templates, evals
└── COMPANIES/                   # Runtime data (gitignored)
```

## Veritabanı Tabloları (20 tablo)
tenants, users, companies, agents, pipelines, runs, run_steps, tool_calls, approvals, memory_items, memory_embeddings, memory_edges, contacts, deals, outreach_sequences, outreach_enrollments, usage_meters, eval_results, activity_log, drafts

## API Endpoint Özeti
- `/api/v1/companies` — CRUD + pause/resume
- `/api/v1/pipelines/:id/run` — pipeline çalıştır
- `/api/v1/runs/:id` — run detay + stop/pause/resume
- `/api/v1/run-steps/:id/rollback` — step rollback
- `/api/v1/approvals` — onay kuyruğu
- `/api/v1/memory/search` — semantic arama
- `/api/v1/drafts` — taslak yönetimi
- `/api/v1/dashboard/*` — health, usage, finance
- `/api/v1/billing/usage` — kullanım metering
- `/api/v1/auth/register` — kullanıcı kayıt
- `/api/v1/auth/login` — kullanıcı giriş
- `/api/v1/run-steps/:id/rerun` — step tekrar çalıştır
- `/api/v1/growth/pql` — PQL skoru
- `/api/v1/growth/blueprint/*` — blueprint paylaşımı (publish, list, clone)
- `/hooks/:company_slug/:event` — webhook handler

## Kritik Kurallar (BUNLARA UYULMALI)
1. **Her tool call loglanır** — tool_calls tablosuna kayıt zorunlu
2. **Her step'te reasoning zorunlu** — "neden bu kararı verdin" alanı boş bırakılamaz
3. **Spend approval zorunlu** — para harcayan aksiyonlarda approval tablosu
4. **Tek örnekle genelleme yok** — holding brain'e taşıma için 2+ şirkette tekrar gerekli
5. **Memory status lifecycle** — candidate → approved → deprecated, direkt approved yazma
6. **Spam koruması** — aynı hedefe cevapsız 3+ gönderim engellenir
7. **Loop detection** — 5+ başarısız tekrar → otomatik durdurma
8. **Cost anomaly** — run maliyeti bütçenin %20'sini aşarsa durdur
9. **Activity log her yerde** — her CRUD, her gönderim, her karar activity_log'a yazılır
10. **Tenant isolation** — her DB sorgusu tenant_id filtrelemeli

## Dosya Düzenleme Kuralları
- Her yeni modül `packages/` altında ilgili pakete gider
- Shared tipler `packages/core/src/types/` altında
- Her adapter `packages/integrations/src/` altında
- Politika dosyaları `HOLDING_CORE/policies/` altında
- Eval testleri `HOLDING_CORE/evals/` altında
- Şirket template'leri `HOLDING_CORE/templates/` altında
- Environment değişkenleri `.env.example`'a eklenir
- Docker servisleri `ENV/compose.yaml`'a eklenir

## Mevcut Durum ve Sıradaki İş
- [x] Faz 0: Proje iskeleti + Docker Compose + DB şeması
- [x] Faz 1: Orchestrator API + Company Builder + Pipeline Runner + Claude Agent
- [x] Faz 2: Memory Engine (episodic + semantic + graph)
- [x] Faz 3: HubSpot CRM + Outreach Automation
- [x] Faz 4: Dashboard UI (Next.js)
- [x] Faz 5: Stripe Billing + Usage Metering
- [x] Faz 6: Governance + Risk Detection + Eval Suite
- [x] Faz 7: OpenTelemetry + Observability
- [x] Faz 8: Free Plan Onboarding (Hero Company)
- [x] Faz 9: Referral + Growth Engine
- [x] Faz 10: Self-Hosted + CI/CD
- [x] Faz 11: Auth + Context Builder + Tool Executor + Outreach Runner + UI Pages
- [x] Faz 12: PQL Scoring + Blueprint Sharing + Model Graders + Kanban Board
- [x] Faz 13: Google OAuth + Local CLI Mode + UI Redesign
