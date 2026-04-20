# AI COMPANY OS — GUNLUK OPERASYON CHECKLIST

Post-launch (V1 public launch sonrasi) Mustafa'nin her gun yapacagi rutin.

---

## SABAH (9:00-10:00) — 30 dakika

### Metric Dashboard Turu
- [ ] **Uptime** — status.creatably.com yeşil mi, Better Uptime bildirim?
- [ ] **Stripe Dashboard** — dun net MRR, yeni subscription, failed payments, refund var mi?
- [ ] **OpenTelemetry / Grafana** — error rate, run success rate, Claude API spend last 24h
- [ ] **Signup metric** — dun yeni kayit X (hedef baseline)
- [ ] **Activation rate** — dun activation X (ilk basarili run)
- [ ] **Approval queue** — /approvals pending X tane, $1K+ onayi var mi?
- [ ] **Cost anomaly flag** — run maliyet asimi alert?
- [ ] **Failed run rate** — %5 uzerine mi?
- [ ] **Support tickets** — Crisp veya email — X ticket
- [ ] **Discord/X/LinkedIn** — 50+ engagement overnight?

### Triage
- [ ] Critical bug OTEL exception? → dev branch hotfix
- [ ] Yeni high-value user (Pro upgrade) → email founder welcome
- [ ] Paid spend asim (>$200/gun) — ads-agent pause trigger

---

## GUNDUZ (10:00-17:00) — Deep work

### Pazartesi — Weekly Review + Content
- [ ] Weekly metrics review: activation, Free→Paid, churn, MRR, CAC, LTV trend
- [ ] 1-2 user interview (Zoom 15 dk) — activation drop-off + aha moment
- [ ] 1 blog post yayinla (content-agent brief'inden)
- [ ] Newsletter draft icin malzeme topla

### Sali — Feature Dev
- [ ] Sprint taski (roadmap'ten): dev-agent PR review veya kendi kod
- [ ] Social post: X thread (Pzt review paylas) + LinkedIn thought piece
- [ ] Pipeline/draft QA spot-check — 3 random run kontrol

### Cars — Video + Ads
- [ ] YouTube long video cekim + montaj (pillar content)
- [ ] Ads campaign dashboard review (CPA <$60, ROAS >2.5x)
- [ ] Winner creative 2x budget, loser pause
- [ ] LinkedIn case study post (blueprint user)

### Per — Content + Ads
- [ ] 1 blog post yayinla
- [ ] 3 Shorts yayinla (schedule Buffer)
- [ ] Reddit community engagement (r/ClaudeAI r/AI_Agents r/LocalLLaMA — authentic reply)
- [ ] Retargeting audience refresh (7-day visitors)

### Cum — Newsletter + Weekly Review
- [ ] Newsletter send 09:00 EST (haftalik 'The Autonomous Company')
  - (a) This Week in Autonomous AI 150w
  - (b) Company of the Week 120w + blueprint CTA
  - (c) Mustafa's Build Log 200w
  - (d) 3 Quick Wins
  - (e) Jargon Decoder
- [ ] Weekly review doc (Notion): metric snapshot, lessons, next week top-3
- [ ] PR merge (hafta biriktirdiklerini)
- [ ] Eger deploy gerekliyse weekend deploy (low-traffic Sat 2 AM UTC)

### Cts-Paz — Light Engagement
- [ ] Discord + X engagement (reply hizi bozulmasin)
- [ ] Deep thinking session (Cumartesi) — strategy + roadmap + pricing
- [ ] Hafta icinde kaybedilen fokus workun catchup (Pazar)

---

## AKSAM (20:00-22:00) — 30 dakika

### Metric Snapshot + Plan
- [ ] Notion/Sheets gunluk metric tablosu doldur:
  - Signup/Activation/Paying/Churn/MRR/Traffic/Blog traffic/Ads spend/Conv
- [ ] Yarin icin top-3 oncelik (imkansiz degilse sadece 3 task)
- [ ] Hizli Twitter/LinkedIn reply (backlog sakince temizle)
- [ ] Discord spot-check (hos, empath, quick)

---

## HAFTALIK (Her Cuma)

- [ ] Weekly metrics review + weekly goals review
- [ ] Kullanici interview notes sentez (pattern var mi?)
- [ ] Roadmap update (launch-roadmap.md)
- [ ] `/run-agent` tek bir domain icin deep-dive (rotation: hacker → ux → marketing → content → ads → seo → qa → dev)
- [ ] Hafta Cuma 2000 GMT: team retro notes (Mustafa solo ise kendi retrosu)

---

## AYLIK (Her ayin 1'i veya son Cuma)

- [ ] **`/next-cycle`** — tam 9-agent audit re-run
  - Orchestrator yeni master-issues.json karsilastir
  - Yeni bulgu trend analizi (iyilesme/kotulesme metric)
  - Roadmap trim (scope)
- [ ] Quarterly planning (Q1/Q2/Q3/Q4)
- [ ] Pricing A/B test sonuc review
- [ ] Content takvimi revizyon (hangi pillar performans)
- [ ] Rakip guncel analiz (Lindy/Relevance/Gumloop pricing/feature)
- [ ] Ads spend review — CAC trend, LTV:CAC ratio, channel performance

---

## ACIL DURUM PROTOKOLU

### Site down (creatably.com 5xx)
1. status.creatably.com guncel mi? (Better Uptime)
2. Docker Compose health check fail? `docker compose ps` + `docker logs api`
3. Prisma connection pool exhausted? Grafana/OTEL connection_limit metric
4. Redis down? BullMQ queue paused mi?
5. Son deploy `git log --oneline -20`
6. Rollback: `docker compose down && git revert HEAD && docker compose up -d`
7. Mustafa → Discord + X announcement (15 dk'da update)

### Odeme down (Stripe webhook fail)
1. Stripe Dashboard → Events → son 10 event fail/delivered?
2. Webhook endpoint /hooks/stripe HTTP log (ISS-021 mount order dogrulama)
3. Eger hata: `redis-cli KEYS 'stripe:evt:*'` — idempotency cache doldu mu?
4. Stripe CLI local replay: `stripe trigger checkout.session.completed`
5. Mustafa → affected user email (Stripe Customer Management)
6. Stripe support ticket (enterprise-level support Faz Growth sonrasi)

### Data leak veya guvenlik insan
1. **Izole et**: hatta etkilenmis tenant pause (`prisma.tenant.update status='SUSPENDED'`)
2. **Hacker-agent** acil deep-dive
3. **Mustafa alert**: immediate SMS/Telegram (Claude Agent SDK webhook)
4. **GDPR 72h window** — etkilenmis user'lara DPA-compliant email
5. **Postmortem doc** — Notion
6. **Patch** → `/run-agent hacker` yeni audit + dev acil PR

### Cost anomaly spike (Claude API > $500/gun)
1. `governance/engine.ts` cost_anomaly_stop fire mi?
2. OTEL dashboard: Claude API spend per tenant last 1h
3. Ust tenant'lari pause (`prisma.tenant.update`)
4. Anthropic Dashboard — spike hangi model/endpoint?
5. `/pipelines/:id/run` rate-limit aktif mi? (ISS-004)
6. Mustafa → affected tenant direct outreach (abuse veya legit?)

### Runaway agent (prompt injection)
1. `runs` table FILTER status=RUNNING cost>budget
2. Hard stop manuel: `/api/v1/runs/:id/stop`
3. Agent systemPrompt audit (blueprint kaynagi mi?)
4. Blueprint REVIEW_PENDING'e geri al (ISS-003)
5. Governance engine pattern augment

---

## HAFTALIK METRIK TARGETS (launch sonrasi 90 gun)

| Gun | Ziyaretci/gun | Signup/gun | Activation | Paying (cumulative) | MRR |
|-----|---------------|------------|------------|---------------------|-----|
| 0 | 500 | 25 | 5 | 2 | $78 |
| 7 | 800 | 45 | 10 | 8 | $320 |
| 30 | 1500 | 80 | 20 | 22 | $870 |
| 60 | 2500 | 110 | 24 | 60 | $2350 |
| 90 | 3500 | 140 | 28 | 100 | $3900 |
| 180 | 7000 | 250 | 60 | 300 | $11700 |

MRR hesabi: Avg $39 (Creator $19, Pro $39, Business $99 mix) × paying × retention faktoru 0.92.

---

## RUTINE YONETICI UYARILARI

- **"Deep thinking" saati Cmt 10-14** — Mustafa'nin haftanin en degerli zamani.
- **"Reply hizi <30dk hedef"** — launch aysinda. Ay 2-3 <2 saat. Community trust icin kritik.
- **"Haftalik newsletter kacirilmaz"** — `/content-agent` her Carsamba Thursday hazirlik.
- **"1 user interview/hafta minimum"** — feedback loop kritik.
- **"Feature vs. stability tradeoff"** — post-launch 30 gun stability > feature. Critical bug olmazsa yeni feature ayni sprint.
- **"Cost anomaly alert HER ZAMAN incele"** — false positive %10 ama true positive $$$ kayip.

---

## NOTLAR

- Mustafa TTS veya Tana Capture ile daily standup kaydi olusturabilir (transcript → Notion).
- `/daily-briefing` slash command hergun otomatik olustur (Claude Code skill).
- Haftalik weekly review'da `/status` komutuyla otomatik metric karsilastirma.
- `/next-cycle` ay sonunda orchestrator rerun — yeni master-issues.json + launch-roadmap.md guncelle.

Reference: `.claude/context/master-issues.json`, `docs/roadmap/launch-roadmap.md`.
