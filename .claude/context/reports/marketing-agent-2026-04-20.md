# MARKETING AGENT RAPORU — 2026-04-20

Proje: AI Company OS (creatably.com) — Faz 18 tamamlanmış
Ajan: marketing-agent (pozisyonlama, ICP, mesajlaşma, funnel, PLG)

## ÖZET
- ICP netlik skoru: 6/10 (Alex+Marcus net, Kenji V1.5'a ertelenmeli, Priya bundled credits sonrası)
- Mesajlaşma güç skoru: 4/10 (Zapier çağrışımı ürünü yanlış kategoriye iter, hero company landing'de yok)
- Rakip farklılaşma: 7/10 (Claude-native + self-hostable + full audit log unique)
- Funnel doluluk: TOFU ✗ / MOFU ✗ / BOFU kısmen
- Ana fırsat: "Autonomous AI Company" blue ocean kategorisi — rakip yok

## KATEGORİ ÖNERİSİ
AI Company OS **"Zapier alternative" DEĞİL** (workflow automation kategorisi yanlış). Gerçek kategori: **"Autonomous AI Company-in-a-Box"**.

Yakın (ama farklı) rakipler:
- Relevance AI ("AI Workforce") — agent platform
- Lindy ("AI Executive Assistant") — task-agent
- Gumloop — AI-native workflows
- Crew AI / Autogen — dev-heavy agent frameworks
- Decagon / Sierra — customer-support AI agent

**Farklılaşma**: AI Company OS full-company abstraction (9 Primitives + Holding Brain + freeform clarification loop + export-to-Claude-Code). Bu kombinasyon pazarda yok — **brand-owning opportunity**.

Önerilen kategori tagline: **"AI Business Operating System for solo founders and creators"**.
Kaçınılması gereken: "agent builder" (teknik), "automation" (Zapier), "AI workforce" (Relevance).
Lean into: **"autonomous company"** (somut, sahiplenilmemiş, ICP-friendly).

## ICP TOP 3 (user-agent ile çapraz doğrulanmış)

### 1. Alex — US Developer Side-Hustler (%18 conv)
- 22-35, power user
- Claude Code kullanıcısı, self-host sever, audit log değeri anlar
- Export-to-skill differentiator direkt ona konuşur
- Reddit (r/ClaudeAI, r/LocalLLaMA) + HN kanalı
- **En yüksek conversion rate, V1 launch için birincil hedef**

### 2. Marcus — US Faceless Creator/Solopreneur (%8 conv, geniş TAM)
- 25-40, 50K+ followers, Zapier bir kez denemiş
- TAM ~5M globally (en büyük segment)
- Hero company (Social Media + Content Studio) direkt uyarlı
- "Set and forget" vaadi + bundled credits ile drop-off çözülür
- Meta + TikTok ana kanalı

### 3. Sarah — UK iPad-First Micro-Founder (%3 conv, opportunity)
- Marcus'la benzer ama mobile-first
- Mobile UX fix + yearly billing + email bildirim sonrası converts
- "Set and forget" ile hero segment

**Ertelenenler**:
- **Kenji** (agency) — white-label + SSO + team features yok (V1.5'a ertele)
- **Priya** (IN non-tech founder) — jargon reduction + bundled credits + PPP pricing sonrası hazır

## 5 MESAJLAŞMA REVİZYONU

| # | Alan | Mevcut | Önerilen | Etki |
|---|---|---|---|---|
| 1 | H1 | "Your company, running itself." | **"Your AI company. Built in 10 minutes. Runs on autopilot."** | Bounce -15%, somut vaat |
| 2 | Sub | "Describe what you want... agents, pipelines, workflows..." | **"Describe your business. Claude builds a full operation — content, sales, ops — with full audit logs."** | Jargon bypass, value clearer |
| 3 | Badge | "9 AI AGENTS. ONE COMPANY." | **"BUILT FOR CREATORS & SOLO FOUNDERS"** | Jargon kaldır first visit, ICP netleşir |
| 4 | Chips | "Content Agency / Sales / Customer Success / Finance" | **"TikTok Content Studio / Newsletter Growth / Lead Follow-up / Client Reporting"** | ICP-native verbs |
| 5 | Trust | "SOC 2 Ready" | **"SOC 2 audit in progress"** | Kenji flagged "Ready" ≠ certified — legal/trust risk |

## ÖNERİLEN PRICING TİERLERİ

**Mevcut durum**: Free $0 / Pro $49 / Enterprise Custom (middle tier yok, user-agent raporunda "killer gap" işaretli)

**Öneri (pricing henüz kesinleşmedi, öneri modu)**:
- **Free** — $0 — 10 runs, 1 company, TikTok+LinkedIn (aynı)
- **Creator** — $19/mo (YENİ, Free→Pro gap doldurur) — 30 runs, 1 company, tüm channels, HubSpot yok
- **Pro** — $39/mo (DÜŞÜR $49 → $39, Relevance $19 anchor + Lindy $49 ile rekabetçi) — 100 runs, 5 companies, HubSpot
- **Business** — $99/mo (YENİ tier) — 500 runs, team seats (3), white-label prep
- **Enterprise** — Custom — SSO, SLA, compliance

**Ek değişiklikler**:
- Annual %20 off (Creator $15.20/mo, Pro $31.20/mo, Business $79.20/mo)
- PPP India/SEA (Creator $9, Pro $19) — Framer/Notion pattern
- 14-day Pro trial (Stripe `trial_period_days=14` parametresi)
- Free plan bundled Anthropic credits (ilk 10 run platform key)

## FUNNEL DURUMU

### TOFU (Farkındalık) — ✗ eksik
- SEO: 0 blog, 0 pSEO (seo-agent raporu: 240+ sayfa potansiyeli hazır ama auth-gated)
- Content: 0 YouTube, 0 newsletter
- Social: Mustafa X build-in-public başlamamış
- Community: Discord yok, r/ClaudeAI organik yok

### MOFU (İlgi) — ✗ eksik
- Interactive demo yok
- Public template gallery gated (pSEO altın madeni kilitli)
- Lead magnet yok
- Newsletter yok
- Free tier gerçek değer sunuyor ✓ (tek artı)

### BOFU (Dönüşüm) — kısmen
- Trial yok
- Comparison pages yok (/vs-lindy, /vs-relevanceai, /vs-gumloop)
- Stripe Checkout ✓
- Early bird / urgency yok

## PLG MEKANİZMALARI

### Mevcut
- **Blueprint sharing** — publish/list/clone API var (Faz 12)
- **Free tier gerçek çıktı** — 10 run TikTok+LinkedIn

### Eksik
- **Pipeline embed badge** ("Built with AI Company OS") — pipeline output'a eklenebilir
- **Template marketplace public** — Faz 12 API var ama UI'da gated
- **Referral** (1 ay free per referral) — altyapı var (`auth.router.ts` ref kodu) ama campaign yok
- **Team invite viral loop** — Pro tier team seats 3 kişi (Business tier lazım)
- **Export to Claude Code — content side viral** — Alex "I exported my AI company to a Claude Code skill" tweet viral potential

## LAUNCH READINESS VERDICT

**NO-GO public launch.**

Engel listesi (öncelik sırası):
1. **5 kritik güvenlik blocker** (hacker-agent raporu): spend approval bypass, cross-tenant memory leak, blueprint supply-chain injection, cost abuse, Stripe webhook idempotency
2. **%0 test coverage** (qa-agent raporu)
3. **Activation %10-11** (user-agent) — SaaS healthy floor %30+
4. **Free→Paid %4.5** — healthy floor %6+
5. **Tracking altyapısı sıfır** (ads-agent) — Meta Pixel/CAPI, GA4, PostHog yok
6. **Pricing gap** (Free→$49 ziplama) + yearly yok + trial yok

Önerilen yol:
- **T+0–14**: Security 5 blocker kapat + tracking kur + Claude model ID fix (dev-agent)
- **T+14–21**: Pricing revizyon (Creator $19 tier, yearly, trial) + messaging revision (H1, sub, badge, chips, trust)
- **T+21–45**: Private beta 50 davetli (X/HN/r/ClaudeAI organik) — activation target %20+
- **T+45**: Product Hunt launch (dev audience + Marcus amplification), Hacker News Show HN, Twitter mega-thread
- **T+45+**: Paid spend başlat (ads-agent: $5K launch budget, Reddit/Meta/TikTok/Google odaklı)

## ORCHESTRATOR'A DEVREDİLEN GÖREVLER

- [ ] **content-agent**: H1+sub+badge+chips 5 revizyon uygulamasi (landing copy brief)
- [ ] **content-agent**: /vs-lindy, /vs-relevanceai, /vs-gumloop karşılaştırma sayfaları (BOFU)
- [ ] **content-agent**: Lead magnet "Autonomous AI Company Playbook" PDF
- [ ] **content-agent**: 5-day onboarding email series
- [ ] **dev-agent**: Creator $19 tier + yearly toggle + 14-day trial Stripe config
- [ ] **dev-agent**: PPP IP-based detection (IN/SEA için Creator $9 Pro $19)
- [ ] **dev-agent**: Blueprint marketplace public accessible (auth gate kaldır, sadece clone için auth)
- [ ] **dev-agent**: "Built with AI Company OS" embed badge for pipeline output
- [ ] **ads-agent**: Tracking infrastructure (ads-agent raporu)
- [ ] **seo-agent**: /vs-[competitor] pSEO + /integrations/[tool] pSEO
- [ ] **ux-agent**: Pricing page A/B test setup, global quota banner

## PAZARLAMA OLGUNLUK SKORU
- Pozisyonlama: 4/10 (Zapier çağrışımı, hero company bağlantı yok)
- Mesajlaşma: 4/10 (jargon duvarı, abstract H1)
- Funnel: 2/10 (TOFU+MOFU yok)
- PLG: 4/10 (blueprint sharing var ama viral loop eksik)
- Rakip farklılaşma: 7/10 (Claude-native + self-host + full audit — unique)
- **GENEL: 4.2/10** — ama ürün (Faz 18) sağlam, copy + funnel 6-8 hafta'da 7/10'a çıkar

## KISITLAR
- Pricing önerileri fait accompli değil, Mustafa karar verir
- "Zapier alternative" pozisyonlaması kullanma (yanlış kategori)
- Rakip brand'lere saldırı yok
- GDPR-sensitive marketing EU'da dikkat
