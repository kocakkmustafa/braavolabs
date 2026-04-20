# REPO GOD ENVANTERİ — AI Company OS

**Son keşif**: 2026-04-20 (önceden keşfedilmiş, elle doldurulmuş)
**Repo God konumu**: `/Users/mustafakaankocak/AI Holding Claude/The Repo God/`
**Master index**: `/Users/mustafakaankocak/AI Holding Claude/The Repo God/INDEX.md`
**Toplam**: 50 repo | ~2,802+ skill | ~830+ agent | ~250+ command | ~135+ hook

---

## 🎯 AJAN-SPESİFİK KULLANIM MATRİSİ

Her ajan kendi görevi için hangi Repo God varlığına bakacağını buradan görür.

### 🛡 hacker (güvenlik)

| Repo God Varlığı | Yol | Neden |
|---|---|---|
| `trailofbits-skills/` | `The Repo God/trailofbits-skills/plugins/` | Profesyonel 30 güvenlik skill — kod audit, smart contract, malware, reverse engineering |
| `claude-code-safety-net/` | `The Repo God/claude-code-safety-net/` | Yıkıcı git + rm pattern bloklama hook'u |
| `everything-claude-code/skills/*security*` | `The Repo God/everything-claude-code/skills/` | Genel güvenlik skill'leri |
| `supabase-agent-skills/` | Yok (stack Supabase değil) | — |
| `pg-aiguide/` | `The Repo God/pg-aiguide/` | **PostgreSQL RLS/policy patterns** (AI Company OS Postgres kullanıyor) |

**Ajana özel**: Bizde Supabase RLS yok — `pg-aiguide/` ve Prisma middleware tenant_id pattern'leri uygula.

---

### 👤 user (persona testi)

| Repo God Varlığı | Yol | Neden |
|---|---|---|
| `ui-ux-pro-max-skill/` | `The Repo God/ui-ux-pro-max-skill/src/` | 67 stil, 99 UX kural, arama motoru |
| `accessibility-agents/` | `The Repo God/accessibility-agents/` | 325 agent + 123 a11y skill (persona 4 Sarah mobile için kritik) |
| `agency-agents/` | `The Repo God/agency-agents/` | 176 uzman agent (research/testing kategorileri) |

---

### 🧱 dev-agent (kod/mimari)

| Repo God Varlığı | Yol | Neden |
|---|---|---|
| `open-saas/` | `The Repo God/open-saas/template/` | **React+NodeJS+Prisma+Stripe+S3+Auth+Shadcn boilerplate** — stack birebir örtüşüyor, reference olarak altın değerde |
| `open-saas/template/app/.claude/skills/` | `The Repo God/open-saas/template/app/.claude/skills/` | 3 Claude skill: add-wasp-skills, getting-started, guided-tour |
| `pg-aiguide/` | `The Repo God/pg-aiguide/` | 7 PostgreSQL skill + MCP server — schema design, query writing |
| `claude-skills/engineering/` | `The Repo God/claude-skills/engineering/` | 47 POWERFUL-tier engineering skill — RAG, MCP, CI/CD, observability |
| `claude-skills/engineering-team/` | `The Repo God/claude-skills/engineering-team/` | 59 core engineering skill |
| `wshobson-agents/` | `The Repo God/wshobson-agents/` | 112 agent + 147 skill |
| `superpowers/` | `The Repo God/superpowers/` | TDD + systematic-debugging + planning |
| `serena/` | `The Repo God/serena/` | Semantic code analysis, 52 LSP, symbol access |
| `cartographer/` | `The Repo God/cartographer/` | Codebase haritalama |
| `understand-anything/` | `The Repo God/understand-anything/` | Knowledge graph |

**Ajana özel**: AI Company OS = Next.js + Node.js + Prisma + Postgres + BullMQ → `open-saas/` birebir örtüşüyor. İlk referans!

---

### 🧪 qa-agent (test/edge-case)

| Repo God Varlığı | Yol | Neden |
|---|---|---|
| `superpowers/skills/test-driven-development/` | `The Repo God/superpowers/skills/test-driven-development/` | TDD metodolojisi |
| `superpowers/skills/verification-before-completion/` | `The Repo God/superpowers/skills/verification-before-completion/` | Pre-complete verification checklist |
| `claude-skills/engineering/` | `The Repo God/claude-skills/engineering/` | Test strategy skill'leri |
| `flutter-test-skill/` | — | Flutter değiliz, skip |

---

### 📣 marketing-agent + 🎯 ads-agent

| Repo God Varlığı | Yol | Neden |
|---|---|---|
| `marketingskills/` | `The Repo God/marketingskills/` | **34 pazarlama skill** — CRO, SEO, pricing, analytics, growth |
| `agency-agents/marketing/` | `The Repo God/agency-agents/marketing/` | Marketing uzman agent'ları |
| `claude-skills/business-growth/` | `The Repo God/claude-skills/business-growth/` | Sales eng, customer success, revops |
| `claude-skills/c-level-advisor/` | `The Repo God/claude-skills/c-level-advisor/` | CMO + CRO advisory skill'leri |

---

### 🔍 seo-agent

| Repo God Varlığı | Yol | Neden |
|---|---|---|
| `marketingskills/` | SEO skill'leri burada | — |
| `everything-claude-code/skills/*seo*` | — | Genel SEO skill'leri |

---

### 🎨 ux-agent

| Repo God Varlığı | Yol | Neden |
|---|---|---|
| `ui-ux-pro-max-skill/` | `The Repo God/ui-ux-pro-max-skill/` | **67 stil, 161 renk, 57 font, 99 UX kural** — kritik referans |
| `accessibility-agents/` | `The Repo God/accessibility-agents/` | WCAG 2.2 AA audit |

---

### ✍️ content-agent

| Repo God Varlığı | Yol | Neden |
|---|---|---|
| `marketingskills/` | İçerik + copywriting skill'leri | — |
| `reddit-video-maker/` | `The Repo God/reddit-video-maker/` | Video içerik üretimi (YouTube Shorts / TikTok için adapte edilebilir) |

---

### 🎯 orchestrator (koordinasyon)

| Repo God Varlığı | Yol | Neden |
|---|---|---|
| `ccpm/` | `The Repo God/ccpm/` | **Spec-driven PM: PRD > Epic > GitHub Issue > Paralel yürütme** |
| `ruflo/` | `The Repo God/ruflo/` | Multi-agent orkestrasyon + plugin sistemi |
| `oh-my-claudecode/` | `The Repo God/oh-my-claudecode/` | 32 agent + 32 skill takım orkestrasyonu |
| `claude-octopus/` | `The Repo God/claude-octopus/` | Multi-LLM orkestrasyon, 10 agent, 54 skill, Double Diamond |
| `compound-engineering-plugin/` | `The Repo God/compound-engineering-plugin/` | **brainstorm→plan→work→review→compound** workflow — bu takımın doğal uzantısı |
| `get-shit-done/` | `The Repo God/get-shit-done/` | Context rot önleme, 20+ command |
| `planning-with-files/` | `The Repo God/planning-with-files/` | Persistent planning (task_plan, findings, progress) |
| `continuous-claude-v3/` | `The Repo God/continuous-claude-v3/` | Context yönetimi, memory flush |
| `beads/` | `The Repo God/beads/` | Graph hafıza sistemi, dependency-aware task graph |
| `multi-agent-observability/` | `The Repo God/multi-agent-observability/` | 17 hook, Vue dashboard, WebSocket canlı timeline |

---

## 🏗 AI COMPANY OS İÇİN ÖZEL YÜKSEK DEĞER REPOLAR

Stack'imiz (Next.js + Node + Prisma + Postgres + Claude API + Stripe + BullMQ) için en yüksek değer **3 repo**:

### 🥇 1. `open-saas/`
- **Konum**: `The Repo God/open-saas/template/`
- **Değer**: Stack birebir. Wasp framework olsa da pattern'ler (Auth/Stripe/S3/Shadcn) doğrudan uygulanabilir
- **Kullanım**: `open-saas/template/app/src/` altındaki auth, payment, file-upload pattern'lerini referans et

### 🥈 2. `claude-skills/engineering/` (47 POWERFUL-tier)
- **Konum**: `The Repo God/claude-skills/engineering/`
- **Değer**: RAG, MCP, CI/CD, observability, enterprise pattern'ler
- **Kullanım**: dev-agent & hacker her audit'te buraya bakmalı

### 🥉 3. `ui-ux-pro-max-skill/`
- **Konum**: `The Repo God/ui-ux-pro-max-skill/`
- **Değer**: 67 stil, 161 renk, 57 font, 99 UX kural, arama motoru
- **Kullanım**: ux-agent + content-agent (landing copy + dashboard design)

---

## 🔥 AI COMPANY OS'E ÖZEL (ENTERPRISE) BONUS REPOLAR

| Repo | Kullanım | Hangi Ajan |
|------|---------|-----------|
| `claude-skills/ra-qm-team/` (14 skill, ISO 13485, MDR, FDA, GDPR, ISO 27001) | SOC2 / GDPR compliance roadmap | hacker, orchestrator |
| `claude-skills/finance/` (DCF, SaaS metrics, forecasting) | Pricing modeli + MRR forecasting | marketing-agent, orchestrator |
| `claude-skills/project-management/` (Atlassian MCP, Jira, Confluence) | Roadmap / issue tracking | orchestrator |
| `claude-skills/business-growth/` (sales eng, customer success, revops) | Go-to-market stratejisi | marketing-agent |
| `claude-skills/c-level-advisor/` (CEO/CTO/CFO/CMO/CRO/CHRO) | Strategic advisory | orchestrator |

---

## 🪝 HOOK'LAR (KOPYALANMAYAN, REFERENCE)

AI Company OS için halihazırda pre-edit + post-agent hook'ları var. Ek olarak Repo God'dan alınabilecekler:

| Hook | Repo God Yolu | Kullanım |
|------|--------------|---------|
| Pre-commit lint/TS check | `claude-code-safety-net/hooks/` veya `superpowers/hooks/` | Git safety |
| Git safety net (destructive block) | `claude-code-safety-net/hooks/pretooluse.sh` | Yıkıcı git + rm patternlerini engellle |
| Observability hooks | `multi-agent-observability/.claude/hooks/` (17 hook) | Eğer dashboard istersen |

---

## ⌨️ SLASH KOMUTLAR (Repo God'da olan, alınabilir)

AI Company OS için 6 kendi komut var. Repo God'da ek fayda sağlayabilecekler:

| Komut | Repo God Yolu | Ne zaman |
|------|--------------|---------|
| `/refactor` | `everything-claude-code/commands/` | Kod temizlemek için |
| `/optimize` | `everything-claude-code/commands/` | Performans |
| `/debug` | `everything-claude-code/commands/` | Bug avı |
| `/test-gen` | `everything-claude-code/commands/` | Test üretimi |

**Karar**: İhtiyaç duyulunca kopyalanır. Şimdilik referans yeterli.

---

## 🧠 HAFİZA & CONTEXT

AI Company OS'un kendi Memory Engine'i var (Faz 2). Ama Repo God'daki hafıza sistemleri öğrenme amaçlı faydalı:

| Sistem | Yol | Neden ilgili |
|--------|-----|---|
| `claude-mem/` | `The Repo God/claude-mem/` | 5 skill, SQLite+FTS5 + Chroma. Bizim memory_items / memory_embeddings şemasına benzer |
| `beads/` | `The Repo God/beads/` | Graph hafıza + task dependency. Bizim memory_edges tablosu ile paralel |
| `arscontexta/` | `The Repo God/arscontexta/` | Second brain, 249 research claim, Zettelkasten+PARA sentezi |

---

## 🚫 ALAKASIZ (AI Company OS için kullanılmaz)

| Repo | Neden |
|------|-------|
| `flutter-skills/`, `flutter-ai-rules/`, `flutter-test-skill/` | Biz web SaaS, Flutter değil |
| `reactnative-agent-skills/` | Mobile native yok (şimdilik) |
| `appium-mcp/` | Mobile test değiliz |
| `supabase-agent-skills/`, `supabase-skills/` | Supabase kullanmıyoruz |
| `jupyter-mcp-server/` | Data science projesi değiliz |
| `bio-research/` (biorxiv, ctrials, chembl) | Bio/pharma değiliz |

---

## 🎯 BU PROJEDE KULLANIM STRATEJİSİ

**İlke 1: Reference tercih, kopya son çare**
- Mustafa merkezi (Repo God) güncelledikçe otomatik fayda
- Yerel kopya ancak AI Company OS'a özel uyarlama gerektiğinde

**İlke 2: Stack'e uygun olanı seç**
- Next.js + Node.js + Prisma + Postgres + BullMQ → `open-saas/`, `pg-aiguide/`, `claude-skills/engineering/` önceliklidir
- Flutter/RN/Supabase-spesifik atlanır

**İlke 3: Orchestrator Repo God'u aktif kullanır**
- Her cycle'ın başında bu envanter taranır
- Yeni repo eklenince Mustafa'dan `/discover-repo-god` tekrar çalıştırması istenir

---

## 📌 KEŞİF KOMUTU (Manuel tetikleme için)

```
/discover-repo-god
```

veya spesifik yol:

```
/discover-repo-god "/Users/mustafakaankocak/AI Holding Claude/The Repo God"
```

---

## 🔄 SYNC

Mustafa Repo God'u güncellediğinde:
1. Home `CLAUDE.md` INDEX otomatik okunur (zaten sessionda yükleniyor)
2. `/discover-repo-god` çalıştırılırsa bu envanter refresh olur
3. Yeni repo eklendiyse ajanlara notify edilir
