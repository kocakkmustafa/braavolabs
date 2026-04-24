# MUSTAFA'NIN MANUEL GOREV LISTESI

Son guncelleme: 2026-04-20
Kaynak: 9 ajan raporu + orchestrator sentez
Reference: `.claude/context/master-issues.json`

---

## ACIL — LAUNCH ONCESI (Faz V1-Lockdown 10-14 gun)

### Hukuki (Bloker)
- [ ] **Terms of Service legal review** — Termly $75/yil veya avukat $500-1500. GDPR Article 14 + CCPA Cal. Civ. Code 1798.100 uyum. `packages/ui/app/terms/page.tsx` mevcut standard text var, review gerekli. (ISS-099)
- [ ] **Privacy Policy legal review** — ayni Termly veya avukat kapsam.
- [ ] **DPA template** — Business tier musteriler icin (Stripe Atlas template mevcut). Enterprise sonrasi zorunlu.
- [ ] **Cookie policy** — GDPR + ePrivacy Directive. `cookieyes` self-hosted banner (ISS-069 tracking ile birlikte).

### Altyapi (Bloker)
- [ ] **Domain braavolabs.com DNS setup** — Cloudflare veya Vercel DNS. *.braavolabs.com wildcard (docs, status subdomain icin). SSL wildcard cert. (ISS-098)
- [ ] **Vercel Pro hesap** ($20/ay) — team deploy + analytics; production deployment icin zorunlu.
- [ ] **Production Postgres** — Neon $19/ay veya Railway Starter. pgvector extension. DATABASE_URL?connection_limit=20 (ISS-085).
- [ ] **Production Redis** — Upstash $10/ay veya Railway. BullMQ + rate-limit + session store.
- [ ] **Stripe hesap live activation** (ISS-100) — business info, tax ID (Stripe Atlas US LLC $500 opsiyon veya Turkiye LLC). Test mode → live switch.
- [ ] **Stripe Tax setup** — free $500 thresh'e kadar. EU/US tax automatic.
- [ ] **Email sending** — SendGrid $19/ay veya Amazon SES (avg $0.10/1K email). SPF/DKIM/DMARC setup domain.
- [ ] **OpenTelemetry Jaeger/Tempo** — Grafana Cloud $0/ay free tier veya self-host. OTEL_EXPORTER_OTLP_ENDPOINT.
- [ ] **PostHog Cloud** — free tier initial (100K events/ay), product analytics (ISS-069).
- [ ] **ENCRYPTION_KEY production** — `openssl rand -hex 32` generate, env var set. NODE_ENV=production'da placeholder check (ISS-008).
- [ ] **JWT_SECRET production** — `openssl rand -hex 64` generate (min 32 char, recommend 64+).

### Kritik Urun Kararlari (Bloker)
- [ ] **Pricing tier approval** (ISS-059) — Creator $19 + Pro $39 (DUSUR $49→$39) + Business $99 + Enterprise Custom. Yearly 20% off. 14-day Pro trial. PPP IN/SEA ($9/$19). Mustafa karar: Bu tier yapisini onayliyor musun?
- [ ] **Bundled AI credits policy** (ISS-045) — Free plan ilk 10 run platform API key (Anthropic bundled credits). Mustafa'nin ay basi Anthropic faturasi: 10 run avg $0.20 × 1000 Free user = $200/ay. Acceptable mi?
- [ ] **Beta user source karar** (ISS-097) — 50 davetli. Mustafa'nin X personal network + r/ClaudeAI + IndieHackers mi? Yoksa Y Combinator founder Slack + Twitter waitlist mi? Allocation gerek.
- [ ] **V1 launch tarih** — 2026-06-01 target. Faz V1-Lockdown + V1-Hardening + Private Beta = 30-45 gun. Mustafa ok mi?

---

## ORTA ONCELIK — ILK 30 GUN (Faz V1-Hardening + Private Beta)

### Partnership / Credit Basvurulari (Mustafa outreach — ISS-101)
- [ ] **Anthropic Claude credits** — founders@anthropic.com pitch. $5-25K hedef. AI Company OS Claude-first stack + production use case + early-stage startup. 2-3 hafta response.
- [ ] **Vercel Startup Program** — vercel.com/startup-program basvuru. Free Pro tier + $2000 credit avg.
- [ ] **Neon/Railway Startup** — $500-2000 credit. Production Postgres.
- [ ] **GitHub Education Pack** — Mustafa kisisel (opsiyonel ucretsiz tool).
- [ ] **Stripe Atlas** — US LLC $500 bir kerelik ($150/yil Delaware franchise tax). Eger Turkiye LLC tercih edilmezse.

### Sosyal Medya + Community (ISS-103, ISS-107)
- [ ] **Twitter/X @braavolabsapp** — handle reserve, profile bio + banner + pinned build-in-public thread.
- [ ] **LinkedIn company page** — AI Company OS, description + logo + cover.
- [ ] **YouTube channel** — AI Company OS, channel art + intro music + banner.
- [ ] **Product Hunt maker account** — Mustafa personal + AI Company OS product page (draft, launch day publish).
- [ ] **Discord server** — 7 channel: welcome / announcements / support / showcase / feedback / off-topic / dev. MEE6 welcome bot. Roles: member/creator/pro/dev.
- [ ] **TikTok account** — @braavolabsapp creator account (spark ads icin gerekli).
- [ ] **Instagram** — opsiyonel ancak ROI dusuk, Faz Growth gec.
- [ ] **Reddit account** — Mustafa personal 14 gun karma build r/ClaudeAI, r/AI_Agents, r/LocalLLaMA (ISS-093). Authentic post, self-promo yasak.

### Branding (ISS-105)
- [ ] **Logo design** — Canva $0 veya designer $100-500. Minimal (gradient AI/robot-y avoid). Monochrome + color variants.
- [ ] **Brand guidelines doc** — Notion public. Primary color, font (Inter sized), tone.
- [ ] **Landing hero image** — Midjourney `/imagine cinematic photograph autonomous AI company office modern minimalist` veya custom. Retina 2x.
- [ ] **OG image template** — Figma + @vercel/og dynamic. 1200×630.
- [ ] **Favicon** — 16×16 + 32×32 + apple-touch-icon 180×180.

### Help Desk + Status (ISS-106)
- [ ] **Help desk Crisp** — free tier. UI widget bottom-right (opt-in post-login).
- [ ] **Status page status.braavolabs.com** — Statushero $29/ay veya self-host Uptime Kuma (free). Incident communication.
- [ ] **Better Uptime $15/ay** — API + UI + webhook endpoint ping every 1min.
- [ ] **Knowledge base knowledge.braavolabs.com** — Notion public veya Gitbook. FAQ, getting started, troubleshooting.

### Testimonial + Case Study (ISS-104)
- [ ] **Ilk 5 beta user personal outreach** — private beta 50 aktifinden 5 se. Zoom 30dk case study interview.
- [ ] **Logo permission** — yazili (DocuSign veya email).
- [ ] **Landing trust section** — logos grid + 2 video + 3 written testimonial.
- [ ] **Ilk 3 case study blog post** — content-agent draft.

---

## UZUN VADE — 30-90 GUN (Faz Public Launch + Growth)

### Compliance + Enterprise (V1.5+)
- [ ] **SOC 2 Vanta/Drata onboarding** — $15-30K 6-9 ay (ISS-108). Kenji persona + enterprise sales blocker. Business tier launched olduktan sonra zorunlu.
- [ ] **Tax compliance quarterly filing** — accountant $500/quarter. Stripe Atlas icinde dahil.
- [ ] **Business bank account** — Mercury veya Brex. Ayri kart for business transactions.

### Affiliate + Partnership Outreach (ISS-125)
- [ ] **Lenny's Newsletter** — sponsor slot (pahali ~$5K/send) veya organik mention ile pitch.
- [ ] **Ben's Bites** — AI daily roundup mention (organik pitch).
- [ ] **Latent Space (Swyx)** — podcast episode pitch.
- [ ] **TLDR AI** — daily digest mention.
- [ ] **Anthropic Cookbook GitHub PR** — AI Company OS example.
- [ ] **Awesome-Claude list PR** — GitHub visibility.
- [ ] **Dev.to, Hashnode guest posts** — 2-3 post /ay developer audience.
- [ ] **AI YouTubers outreach** — min 50K subs, creator/solopreneur focused, 10 partner.

### Ambassador Program (ISS-107)
- [ ] **Stripe Connect setup** — 30% commission infrastructure.
- [ ] **Ambassador program doc** — Notion public. Signup form Tally.
- [ ] **Partnerstack veya Rewardful integration** — affiliate tracking.
- [ ] **Referral campaign launch** — 1 ay free per successful referral (altyapi Faz 9 var).

### Content Hiring Ileride (Faz Growth 60+ gun)
- [ ] **Freelance writer** — 2 blog/hafta sustain, Mustafa'nin zamani kazandir. $500-800/post.
- [ ] **Video editor** — YouTube + Shorts editing, $500-1000/month retainer.
- [ ] **Community manager** (part-time) — Discord + Reddit engagement, $1000-2000/month.
- [ ] **CS hire** (first customer support) — Crisp ticket volume 30+/gun olunca, $3-5K/month full-time or $1-2K part-time.

---

## OPSIYONEL ama DEGERLI (ISS-109)

- [ ] **Swag (t-shirt, sticker)** — launch celebration 50-100 beta user + press kit. $300-500.
- [ ] **Beta kullanicilarina el yazisi note** — Mustafa imza 50 kart, ship $100.
- [ ] **Launch videosu** — Mustafa founder story 90s, YT + landing hero backup. Kendi cekim veya $500-1000 editor.
- [ ] **Podcast pitch listesi 10 podcast**:
  - Lenny's Podcast
  - Acquired
  - Startup School (Y Combinator)
  - Indie Hackers
  - My First Million
  - Invest Like the Best
  - Product Hunt Radio
  - Founder Stories
  - SaaS Origins
  - Latent Space

---

## PRICING DECISION (ACIL — Faz V1-Lockdown bloker)

Marketing-agent + user-agent + ux-agent pricing revize onerdi:

| Tier | Aylik | Yillik (20% off) | Runs | Companies | Channels | HubSpot | Team | Audit? |
|---|---|---|---|---|---|---|---|---|
| **Free** | $0 | - | 10 (platform key) | 1 | TikTok+LinkedIn | Yok | 1 | Basic |
| **Creator** (YENI) | $19 | $15.20 | 30 | 1 | Tum | Yok | 1 | Full |
| **Pro** (DUSUR $49→$39) | $39 | $31.20 | 100 | 5 | Tum | Var | 1 | Full |
| **Business** (YENI) | $99 | $79.20 | 500 | 10 | Tum | Var | 3 | Full + export |
| **Enterprise** | Custom | - | Unlimited | Unlimited | Tum | Var | Unlimited | SSO + SLA + compliance |

**14-day Pro trial** (Stripe trial_period_days=14).
**PPP IN/SEA** (IP + payment BIN detection): Creator $9, Pro $19.

Mustafa karar noktalari:
1. Yukaridaki tier yapisini onayliyor musun?
2. Creator $19 yerine $15 veya $25 alternatif?
3. PPP region sinirlarini onayliyor musun (IN, BD, PK, PH, VN, ID primarily)?
4. Yearly discount %20 vs %30 tercih?

Onay sonrasi dev-agent Stripe config yapar (ISS-059 — 12 saat).

---

## TURKIYE vs US LLC KARARI

Mustafa'nin legal entity secimi:

### Opsiyon A: Stripe Atlas US LLC (Delaware)
- $500 bir kerelik setup
- $150/yil Delaware franchise tax
- Mercury US business bank (free)
- Stripe + Claude API + Meta/Google Ads US-native
- Global payment receive Kolay
- US tax filing quarterly (accountant $500/qtr)

### Opsiyon B: Turkiye LLC
- ~₺5000 setup
- Vergi dairesi monthly filing (muhasebeci ₺3000-5000/ay)
- Turkiye payment gateway (Iyzico, PayTR — Stripe Turkiye yok)
- Dovizle gelir TL'ye cevir (dalgaÍanma riski + vergi)
- Global payment receive zor (Wise business workaround)
- KDV ayri muhasebe

### Opsiyon C: Hybrid (Turkiye residence + US LLC)
- Stripe Atlas + Turkiye tax residence
- Double taxation agreement OK
- En cok startup bu rotu seciyor

Mustafa karar: Hangi opsiyon?

---

## METRICS TRACKING SHEET (ISS-069 tracking ile birlikte)

Mustafa'nin her gun gorecegi dashboard (Notion/Sheets):

| Metric | Target Baseline | Daily Check |
|--------|-----------------|-------------|
| Signup | +25/gun launch week | Stripe/PostHog |
| Activation rate | >%20 | PostHog funnel |
| Free→Paid | >%8 | Stripe dashboard |
| Churn rate | <%5 month-over-month | Stripe |
| MRR | Ay 1 $500 | Stripe |
| CAC | <$60 | GA4 + Meta Ads + Stripe |
| LTV:CAC | >3:1 | Calculated |
| Organic traffic | 500/ay ay 1 | GA4 |
| Ad spend | $5K launch week | Meta + Google + Reddit |
| ROAS | >2.5x | Meta CAPI + GA4 |
| Daily active user | 30% of paying | PostHog |
| Support ticket | <10/gun | Crisp |
| Critical bug | 0 | OTEL alerts |

---

## SIRA IZLEME (Priority Order)

Hafta 1 (V1-Lockdown):
1. Pricing tier onay (blocker)
2. Domain + DNS + SSL
3. ToS + Privacy legal review (Termly)
4. Stripe live activation + Tax

Hafta 2 (V1-Lockdown finali):
5. ENCRYPTION_KEY + JWT_SECRET prod generate
6. Social media accounts reserve
7. Logo + branding
8. Anthropic credits basvuru

Hafta 3 (V1-Hardening):
9. Vercel + Neon + Upstash production deploy
10. Discord server
11. Help desk Crisp
12. Ilk blog post yayinla + newsletter Week 1

Hafta 4 (Private Beta start):
13. 50 beta davet (X personal network + r/ClaudeAI + IndieHackers)
14. Reddit organik 14 gun seeding baslat
15. User interview weekly kick-off
16. Testimonial outreach (aktif user'lardan)

Hafta 5-6 (Private Beta):
17. Tracking infrastructure validate (Meta CAPI + GA4 DebugView)
18. pSEO blueprint + integration pages live review
19. Case study + logo + testimonial collect
20. Launch week planning (PH + HN + X thread)

Hafta 7 (Launch):
21. Product Hunt launch Pazartesi 9 AM PST
22. HN Show HN Sali 9 AM ET
23. Twitter mega-thread Cars
24. Newsletter launch announce Per
25. Reddit posts Cum

Hafta 8+ (Growth):
26. Paid launch $5K test
27. Content velocity 2 blog/hafta sustain
28. Partnership outreach (Lenny's, Latent Space, Anthropic Cookbook PR)
29. Ambassador program launch
30. Monthly /next-cycle audit

---

## NOTLAR

- Bu doc live update edilecek. Her Cuma weekly review'da gozden gecir.
- Manuel task'lar dev-agent'a delegete edilemez — Mustafa'nin kendi eli gerekli.
- Pricing + beta source + legal entity kararlari 24-48 saat icinde olmali (Faz V1-Lockdown bloker).
- Opsiyonel task'lar launch sonrasi 30-60 gun penceresinde. Focus ilk olarak critical path.

Reference: `.claude/context/master-issues.json`, `docs/roadmap/launch-roadmap.md`, `docs/marketing/marketing-plan.md`.
