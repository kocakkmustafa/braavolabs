# AI COMPANY OS — V1 LAUNCH ROADMAP

Son guncelleme: 2026-04-20
Proje durum: Faz 18 tamamlandi (production-ready AMA public launch BLOKLU)
Hedef: V1 public launch 2026-06-01 civari

## STRATEJIK OZET

AI Company OS urun olarak **teknik saglam** (18 Faz). Ama 9 ajanin audit'inden 5 kritik mimari guvenlik blokeri cikti. Bu 5'i **otomatik cozulemez** (tenant isolation, approval flow, blueprint sanitization, Stripe idempotency, SQL migration — hepsi design decision gerektiriyor).

**Paid reklam harcamasi 2026-06-01 oncesi istatistiksel olarak para kaybi** — tracking altyapisi sifir, activation %10-11, Free→Paid %4.5 (saglikli floor %6+), middle tier yok. Ads-agent NO-GO verdict'i.

5 faz yol haritasi asagida. Her fazda **cikis kriteri** net — kapatilmadan sonraki faza gecis yok.

---

## FAZ V1-LOCKDOWN (10-14 gun) — Kritik guvenlik + urun blokerlerini kapat

Hedef: V1 launch-ready guvenlik olgunlugu 5.5/10 → 7.5/10.

### Guvenlik Blokerler (hacker + dev-agent)
- [ ] **ISS-001** Spend approval bypass — Claude loop executeTool wrapper'dan gitsin (8 saat)
  - `packages/api/src/modules/agent/claude.ts:154` executeTool cagri
  - `PENDING_APPROVAL` return'de loop break + run.status = WAITING_APPROVAL
  - Context (runId, runStepId, companyId, tenantId) agent loop signature'a
- [ ] **ISS-002** Memory tool tenant isolation — registry.ts 60+ tool'da ctx.tenantId enforcement (16 saat)
  - `prisma.company.findFirst({where:{id,tenantId:ctx.tenantId}})`
  - tool-executor wrapper context propagation
- [ ] **ISS-003** Blueprint supply-chain sanitize (20 saat)
  - systemPrompt max 5KB + keyword regex + preview modal
  - Tool allowlist: requiresApproval:true cikar veya reviewed:true gerektir
  - Blueprint quarantine: ilk N clone'a kadar REVIEW_PENDING
- [ ] **ISS-004** Claude API cost abuse — pahali endpoint rate-limit (4 saat)
  - expensiveRateLimit 10 req/dk: /pipelines/:id/run, /pipelines/from-natural-language, /memory/search, /companies/build
  - description schema max(2000)
- [ ] **ISS-005** Stripe webhook idempotency — Redis SETNX dedup (4 saat)
  - `redis.set('stripe:evt:'+event.id,'1','NX','EX',604800)` + 500 on error (Stripe retry)
- [ ] **ISS-006** Memory SQL injection — Prisma.sql template literals (2 saat)
  - `packages/memory/src/search.ts:24-29` `$queryRawUnsafe` → Prisma.sql
- [ ] **ISS-007** Tool registry Zod schema her tool (16 saat)
  - `withZodValidation` helper + 60+ tool input validation
- [ ] **ISS-008** ENCRYPTION_KEY scrypt derive + prod placeholder check (8 saat)
  - `getKey()` scryptSync(key, salt, 32), env.ts prod guard
- [ ] **ISS-014** Claude model ID fix — env.CLAUDE_MODEL kullan (30 dakika)
  - `claude-sonnet-4-6` invalid — dogru 2026-04 model ID'leri (claude-sonnet-4-5-20250929 vs.)
- [ ] **ISS-021** Stripe webhook mount order — raw body express.json() oncesi (1 saat + Stripe CLI test)

### Urun Blokerleri (qa-agent + dev-agent)
- [ ] **ISS-009** Run wall-clock timeout — BullMQ timeout:15\*60\*1000 (3 saat)
- [ ] **ISS-010** Quota TOCTOU fix — pre-check + atomik UPDATE (4 saat)
- [ ] **ISS-043** Test coverage %20 kritik flow (16 saat)
  - Stripe webhook idempotency (supertest+Stripe fixtures)
  - Quota enforcement boundary (checkQuota 9/10/11)
  - Pipeline runner integration (pg-mem + BullMQ in-memory)
  - Auth e2e (register → login → refresh revoke)
  - /hooks HMAC invalid/timestamp

### UX Kritik Blokerler (ux + user-agent)
- [ ] **ISS-045** Bundled AI credits — Free plan ilk 10 run platform key (8 saat)
  - `usage_meters.platform_credits_used` + run pre-check
- [ ] **ISS-046** Tek onboarding path — /welcome segmentation + /companies/new sub-flow (8 saat)
  - Sidebar 'New Company' gizle
- [ ] **ISS-048** Logged-out dashboard fix — 'Example data' label (2 saat)

### Content + Marketing Blokerler
- [ ] **ISS-057** Landing copy 5 revizyon (H1/sub/badge/chips/trust) (4 saat)
- [ ] **ISS-058** Category fix — 'Zapier alternative' YASAK, 'autonomous AI company' (2 saat)
- [ ] **ISS-059** Pricing revizyon — Creator $19 + Pro $39 + Business $99 + yearly 20% + 14-day trial (Mustafa onay + 12 saat dev)

### SEO Blokerler (seo-agent)
- [ ] **ISS-060** robots.txt + sitemap.xml dinamik (2 saat)
- [ ] **ISS-070** Paid launch NO-GO onay — 2026-06-01 tarihine kadar harcama YOK (Mustafa karar)

### Mustafa Manuel (paralel)
- [ ] **ISS-098** Domain braavoo.com DNS + SSL (1 saat)
- [ ] **ISS-099** ToS + Privacy legal review (Termly $75 veya avukat $500-1500)
- [ ] **ISS-100** Stripe live activation + Tax setup

### Cikis Kriteri Faz V1-Lockdown
- [x] 5 kritik guvenlik blocker kapali (ISS-001..005)
- [x] SQL injection + model ID + Zod validation kapali
- [x] Test coverage >%20
- [x] Bundled credits + tek onboarding + logged-out dashboard fix
- [x] Landing copy revizyon live
- [x] Domain + ToS + Stripe hazir

---

## FAZ V1-HARDENING (7-10 gun) — Pre-beta stabilize

Hedef: Beta user feedback icin urunu saglam tut. Activation %11 → %15 projected.

### High-Priority Fixleri
- [ ] **ISS-012** JWT refresh token algorithms constraint (15 dakika)
- [ ] **ISS-013** Password + email max length (10 dakika)
- [ ] **ISS-015** outreachQueue konsolide (1 saat)
- [ ] **ISS-016** Stripe client cache Map (15 dakika)
- [ ] **ISS-019** Parallel step governance check (2 saat)
- [ ] **ISS-020** Stripe webhook eksik eventler — payment_failed + refund + trial_will_end (8 saat)
- [ ] **ISS-022** Claude loop recursive detection (4 saat)
- [ ] **ISS-023** Company desc + NL-edit prompt injection sanitize (3 saat)
- [ ] **ISS-024** Webhook secret encrypt (2 saat)
- [ ] **ISS-026** OAuth state/ref Zod constraint (15 dakika)
- [ ] **ISS-035** Draft email fail handler (1 saat)
- [ ] **ISS-036** Pipeline/agent count quota (2 saat)
- [ ] **ISS-037** Concurrent run limit (2 saat)
- [ ] **ISS-038** Integration API key real test call (4 saat)
- [ ] **ISS-040** Refresh token getdel atomik (30 dakika)

### UX Cilalama
- [ ] **ISS-047** Global quota banner AuthLayout (3 saat)
- [ ] **ISS-049** Error message revizyon 14 ErrorCard pattern (6 saat)
- [ ] **ISS-050** Empty states 8 sayfa CTA (4 saat)
- [ ] **ISS-051** Jargon tooltip + useTerminology() (8 saat)
- [ ] **ISS-052** Mobile sidebar fix onFocus+onTouchStart + 44px targets (6 saat)
- [ ] **ISS-054** Email bildirim run.completed SendGrid (4 saat)
- [ ] **ISS-088** '10 dakika' copy revize (1 saat) — artik dogru (bundled credits sonrasi)

### Content Pre-beta
- [ ] **ISS-092** Micro-copy 24 revizyon (4 saat)

### Cikis Kriteri Faz V1-Hardening
- [x] Tum P2 blockers kapali
- [x] Email bildirim aktif
- [x] Quota banner + error messages revize
- [x] Activation test: iki beta user flow tamamliyor

---

## FAZ PRIVATE BETA (14-21 gun) — 50-100 davetli, organik only

Hedef: Activation >%20, Free→Paid >%8 validate. 3 testimonial. Tracking baseline.

### Beta Kullanici Source (ISS-097)
- [ ] Mustafa personal X network (50 kisi waitlist)
- [ ] r/ClaudeAI organik 14 gun seeding (ISS-093)
- [ ] IndieHackers + Y Combinator founder Slack (20 kisi)
- [ ] Build-in-public Twitter thread (100+ waitlist)
- [ ] 100 davet → hedef 50 aktif

### Beta Operasyon
- [ ] Activation baseline olc: landing → signup → company → first run → Day 7 retention
- [ ] 1-2 user interview/hafta (Zoom 15 dk)
- [ ] In-app Canny widget feedback
- [ ] Daily Discord check
- [ ] 3 aktif user testimonial + logo izni (ISS-104)

### Tracking Infrastructure (ISS-069 paralel dev)
- [ ] GTM server-side + Meta Pixel + CAPI (3 gun)
- [ ] GA4 + Google Ads conversion 7 event import (2 gun)
- [ ] PostHog adapter (1 gun)
- [ ] Stripe → Meta/Google conversion bridge (2 gun)
- [ ] TikTok + Reddit Pixels (1 gun)
- [ ] UTM session persist + users.firstTouchUtm (4 saat)
- [ ] Cookie consent GDPR banner (4 saat)

### SEO Unblock (ISS-062)
- [ ] /blueprints/[slug] public SSG — 42 sayfa (ISS-062)
- [ ] /integrations/[slug] public SSG — 147 sayfa (ISS-062)
- [ ] Server Component migration marketing pages (ISS-017) — LCP 3.2s → 1.8s
- [ ] Schema markup Organization + WebSite + SoftwareApplication + FAQPage (ISS-061)
- [ ] generateMetadata marketing + blueprint/integration pages (ISS-063)
- [ ] OG image dynamic @vercel/og (ISS-064)
- [ ] CWV optimization (font dupe fix + canvas defer + next/image) (ISS-065)
- [ ] robots.txt + sitemap.xml dynamic (ISS-060)

### Content Baslangic
- [ ] Ilk 3 pillar blog post live (Autonomous AI Companies Explained, 9 Primitives, AI vs Automation)
- [ ] Newsletter Hafta 1 'Launch Week' send
- [ ] Twitter build-in-public baslat
- [ ] Landing /creator + /developer dedicated ICP pages (ISS-071)

### Cikis Kriteri Faz Private Beta
- [x] Activation >%20 (50 aktif user'dan 10+ ilk basarili run)
- [x] Free→Paid >%8 (50 aktif'tan 4+ Pro)
- [x] 3 testimonial + 3 logo
- [x] Tracking events dogrulandi (Meta CAPI + GA4 DebugView OK)
- [x] 42 blueprint + 147 integration pSEO live
- [x] 3 blog post + 4 newsletter
- [x] Kritik bug report sifir (community + OTEL)

---

## FAZ PUBLIC LAUNCH (3-5 gun) — Product Hunt + HN Show HN + Twitter mega

Hedef: Launch day 1000 signup, 200 activation, 20 paying. 30 gun 500 paying.

### Launch Gun Operasyon
- [ ] **Pazartesi 9 AM PST** — Product Hunt launch (3-5 hunter outreach onceden — ISS-094)
  - Title: 'AI Company OS — Build autonomous AI companies in 10 minutes'
  - Tagline: 'Your AI employee, hired in 10 minutes'
  - Creative Meta video (ISS-072 Creative 1)
- [ ] **Sali 9 AM ET** — HN Show HN
  - 'Show HN: AI Company OS — Build autonomous AI companies that run themselves'
  - Full audit log + Claude-native + self-host fokus
- [ ] **Cars 10 AM ET** — Twitter mega-thread (Mustafa)
  - 12-15 tweet thread — origin story, demo, hero company, export to Claude Code
- [ ] **Per** — Newsletter launch announcement
- [ ] **Cum** — Reddit posts (r/ClaudeAI, r/LocalLLaMA, r/SaaS, r/Entrepreneur — authentic, kendi karman destegi 14 gunluk seeding'ten)

### Launch Destek
- [ ] Discord 24 saat canli
- [ ] X/LinkedIn reply hizi <30 dk
- [ ] Hotfix hazirda dev-agent
- [ ] Launch video Mustafa founder story (ISS-109) opsiyonel
- [ ] Pricing revize live (Creator $19, Pro $39, Business $99, yearly, trial)

### Cikis Kriteri Faz Public Launch
- [x] 1000+ signup launch week
- [x] Activation >%18 sustained
- [x] PH Top 5 finish OR HN front page OR 500+ signup organik kanal
- [x] 5+ basin/creator mention
- [x] Zero critical bug (OTEL)

---

## FAZ GROWTH (ongoing) — Paid + Content + Partnership

Hedef: 30 gun 500 paying / 90 gun 3K signup + 200 paying + $6-8K MRR.

### Paid Reklam (ISS-069 tracking kurulu + activation validated)
- [ ] Launch week: $5K test budget (Reddit 24% / Meta 20% / TikTok 16% / Google 16% / X 10% / HN 8% / LinkedIn 4% / PH 2%)
- [ ] Ay 2: $10K winner 2x + retargeting + LAL seed
- [ ] Ay 3: $25K scale + ABM (Kenji V1.5'a ertelenmisti, Business tier launched olursa LinkedIn etkisi)
- [ ] 3 creative brief hazir (ISS-072)

### Content Velocity
- [ ] 2 blog/hafta (ISS-089) — 5 pillar + 20 cluster
- [ ] 1 newsletter/hafta Cuma (ISS-091)
- [ ] 1 YouTube long + 3 Shorts/hafta (ISS-090)
- [ ] Social calendar X/LinkedIn/TikTok (ISS-127)
- [ ] Lead magnet PDF (ISS-117)
- [ ] 5-day onboarding email series (ISS-073)

### Partnership + Affiliate
- [ ] Anthropic Claude credits partnership (Mustafa — ISS-101)
- [ ] Vercel Startup Program (ISS-101)
- [ ] Neon/Railway startup program (ISS-101)
- [ ] Ambassador Stripe Connect + 30% commission (ISS-107)
- [ ] 20 partner outreach (Lenny's, Ben's Bites, Latent Space, TLDR AI) (ISS-125)

### SEO Gelisim
- [ ] 6 vs-competitor sayfasi (Lindy, Relevance, Gumloop, Sidekick, Bardeen, Autogen) (ISS-067)
- [ ] 5 /for/[persona] + 15 /use-cases/[case] (ISS-068)
- [ ] 5 pillar + 20 cluster blog (ISS-089)
- [ ] Free tool /tools/ai-agent-cost-calculator backlink magnet (ISS-118)
- [ ] Anthropic Cookbook PR + GitHub README badge (Tier 2 backlink)

### Ops Maturity
- [ ] SOC 2 Vanta/Drata onboarding (Kenji V1.5) (ISS-108)
- [ ] Discord server + Ambassador program (ISS-107)
- [ ] Help desk Crisp + status.braavoo.com + Better Uptime (ISS-106)
- [ ] Prisma middleware auto tenant filter (ISS-083) V1.1
- [ ] Holding brain cross-company schema (ISS-081) V1.1
- [ ] BullMQ events SSE migration (ISS-126)
- [ ] WCAG 2.2 AA accessibility (ISS-074)

### Aylik Cycle
- [ ] `/next-cycle` tam audit — 30 gun post-launch
- [ ] User interview weekly (5 kisi)
- [ ] Metric review weekly — Activation, Free→Paid, Churn, CAC, LTV, MRR
- [ ] Roadmap update monthly
- [ ] Pricing A/B test sonuc review quarterly

---

## KRITIK METRIK HEDEFLER

| Metric | 30 gun | 60 gun | 90 gun | 180 gun |
|--------|--------|--------|--------|---------|
| Signup (cumulative) | 1500 | 3000 | 4500 | 10000 |
| Activation rate | %18 | %20 | %22 | %25 |
| Aktif user | 270 | 600 | 990 | 2500 |
| Free→Paid (activated'dan) | %8 | %10 | %10 | %12 |
| Paying user | 22 | 60 | 100 | 300 |
| MRR | $500 | $1800 | $3500-$5000 | $12-18K |
| Organic traffic | 500/ay | 2K/ay | 5K/ay | 15K/ay |
| Blog post | 3 | 11 | 20 | 40 |
| Backlinks | 5 | 15 | 35 | 80 |
| Churn/ay | N/A | %8 | %6 | %4 |
| CAC | N/A | <$60 | <$50 | <$45 |
| LTV | N/A | $120 | $180 | $250 |

Not: MRR hedef Creator $19 + Pro $39 + Business $99 pricing senaryosunda. Pricing revize onaylanmazsa Pro $49 default → MRR hedef ~%15 asagi.

---

## RISK REGISTER

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Claude model ID yanlis prod'da → ilk run %19 fail | Yuksek | Olan | ISS-014 Faz Lockdown |
| Tenant leak PR'si post-launch | Critical | Orta | ISS-002 + V1.1 Prisma middleware |
| Stripe webhook idempotency kacti → referral abuse | Yuksek | Orta | ISS-005 Faz Lockdown |
| Blueprint supply-chain post-launch viral | Critical | Dusuk ama catastrophic | ISS-003 + quarantine + review queue |
| Tracking gap → paid spend waste | Yuksek | Olan | ISS-069 private beta paralel + paid launch GO kriter |
| PPP region abuse (VPN Creator $9) | Orta | Orta | IP + device + credit card BIN triangulation, IP + payment method mismatch engelle |
| Private beta activation %15 altina dusme | Yuksek | Orta | Clarification 3→2 round + jargon tooltip + bundled credits |
| Launch week PH veya HN miss | Orta | Dusuk | Multi-channel organik (r/ClaudeAI + X + newsletter fallback) |
| Cost anomaly retrospective → Anthropic bill spike | Yuksek | Dusuk | ISS-004 rate-limit + ISS-019 parallel governance + monitoring alert |
| V1 launch delay 2026-06 sonrasi | Orta | Orta | Faz V1-Lockdown 14 gun hard cap, scope trim |

---

## MAYIS 2026 AY SONU HEDEF STATUS

(Bu dokuman live update edilecek. Her Cuma weekly review)

- Faz V1-Lockdown: tamamlandi (dedicated sprint Hafta 1-2)
- Faz V1-Hardening: tamamlandi (Hafta 3)
- Faz Private Beta: acildi (Hafta 4-6), 50 aktif user, activation benchmark
- Faz Public Launch: hazir (Hafta 7), PH+HN scheduled 2026-06-01 haftasi
- Faz Growth: baslangic (2026-06 sonrasi)

Reference: `.claude/context/master-issues.json` 127 issue detay.
