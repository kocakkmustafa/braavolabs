# AI şirketi — dört reponun envanteri ve genişleme noktaları (Faz 0.2)

Tasarım: [TASARIM.tr.md](TASARIM.tr.md). Bu belge 2026-10-31 kesitidir; HEAD'ler §0'da. Dosya yolları her reponun kendi köküne göredir (platform yolları `packages/api/src/` altındadır, kısaltılmıştır).

Hazırlanış: 2026-10-31, salt-okunur. Hiçbir repoda checkout/commit/pull/install/build yapılmadı; yalnız `git fetch` + `git archive <ref>` ile scratchpad'e ağaç çıkarıldı ve oradan okundu. `.env*`, keystore, p8/p12, credential dosyaları **açılmadı** (yalnız yolları §0'da).

## 0. Okunan referanslar (HEAD'ler)

| Repo | Yerel dal @ SHA | origin/main | İnventerlenen ağaç | Not |
|---|---|---|---|---|
| platform (`kocakkmustafa/braavolabs`) | `main` @ `33c2c44` (29 Eki) | `300e17d` (30 Eki, **canlı üretim**) | **origin/main `300e17d`** | Yerel 5 commit geride: `52f04fc/70efb4f` (Apple EULA terms), `c6dee70` (B-06: outbound e-posta/outreach/voice varsayılan KAPALI) |
| desktop (`braavolabs-desktop`) | `codex/desktop-night-acceptance-20261016` @ `a16e803` (27 Eki) | `f7a8879` (29 Eki) | **origin/main `f7a8879`** (daha yeni) | origin/main = `a16e803` ağacı (PR #24 merge `4cdd202`) + `8178a09` zod 4.6.7 (PR #25). Yerel 3 commit geride, fonksiyonel fark yalnız zod 4 |
| cli (`braavolabs-cli`) | `ekip1/license-yula-lab` @ `0fd8f4a` (24 Eki) | `0fd8f4a` | **`0fd8f4a`** (eş) | package.json 0.2.0; npm'de yayınlı son: 0.1.1 (VENTURE.md 25 Eyl) |
| mobile (`braavolabs-mobile`) | `consolidation/mobile-5384bde6` @ `75ca72c` (27 Eki) | `b62a1bb` (23 Eyl, eski) | **PR #32 head `262654b`** (30 Eki) | 262654b = 75ca72c + 2 commit (`f14c62b` decode-uri-component, `262654b` "Send email" build flag arkasında, B-06). Yerel, origin/main'den 27 commit ileride |

Ayrıca okundu: `ventures/braavolabs/VENTURE.md` (son giriş 2026-10-20), `workspace/HANDOFF-2026-10-27.tr.md` (guncelleme 2026-10-28).

Sırlar — yalnız yol (içerik okunmadı): `platform/.env`, `platform/.env.example`, `mobile/.env.example`, `mobile/android/app/debug.keystore`. Handoff'a göre `GITHUB_MOBILE_CLIENT_SECRET` host `.env`'inde.

Durum (HANDOFF 27 Eki): yayın kapıları kurucu/Yönetim manuel görevlerinde (Y2 Actions bütçesi, Y7 npm publish, Y8 değişken/ACL/yedek/notary/EAS, Y17 geri alınamaz migration onayı, BRV-15 deploy). Zod 3→4 (K-12) platform+desktop'ta merge edilmiş görünüyor: platform api `zod ^4.6.7`, desktop `zod ^4.6.7`.

---

## 1. PLATFORM (sunucu + web) — origin/main `300e17d`

### 1.1 Stack
- pnpm 9 + Turborepo monorepo, kök paket adı `ai-company-os` ("Autonomous AI company creation platform") — `package.json:2-5`. Node `>=24.22.0`.
- `packages/api`: Express 4.22 + TypeScript, `@anthropic-ai/sdk ^0.39`, BullMQ 5.76, ioredis, zod 4, pino, Sentry, OpenTelemetry (`packages/api/package.json`).
- `packages/db`: Prisma 6.3, PostgreSQL 16 + **pgvector** (`ENV/compose.yaml:3` `pgvector/pgvector:pg16`, `ENV/compose.prod.yaml:7`), Redis 7 (`compose.prod.yaml:31`). Schema 2.049 satır, ~55 model.
- `packages/ui`: Next.js 15.5.28 + React 19.2 (App Router), next-intl mesajları (`packages/ui/messages`).
- `packages/core` (paylaşılan tipler/sabitler, governance config), `packages/memory` (episodic/semantic/procedural/graph/vault/search), `packages/integrations` (HubSpot, GitHub, Slack, Discord, WhatsApp, Notion, Airtable, Google Calendar/Docs/Sheets, Shopify, WordPress, Mailchimp, Intercom, Zendesk, Trello, Stripe, n8n webhook), `packages/connector-sdk` (manifest şeması + `createConnector`).
- Dağıtım: Docker imajları `ghcr.io/kocakkmustafa/braavolabs/{api,ui}` (`compose.prod.yaml:66,232`), Lightsail tek host (1.9 GB notu `schema.prisma` MediaAsset yorumu), Caddy/nginx, pg_dump backup servisi.

### 1.2 Ürün bölümleri (kanıtla)
| Bölüm | Var mı | Kanıt |
|---|---|---|
| Chat/asistan | **Kısmen** — sohbet ekranı yok; "Ask" = tek atış çok-modelli `POST /research/cascade` (ucuz modelden başla, düşük güvende yükselt) ve `/research/compare` (paralel çok model + sentez) | `modules/research/research.router.ts:151,182`, `lib/cascade.ts:4-8`, `services/multi-model.ts`. Web `app/` altında `chat` sayfası yok |
| AI şirket kurulumu / onboarding | **Var** — doğal dil açıklamadan şirket + ajan + pipeline üretimi | `modules/company/builder.ts` (LLM çağrısı, `PLAN_LIMITS`, `assertCompanyCapacity`), web `app/companies/new`, `modules/onboarding/router.ts`, sağlayıcı kurulum sihirbazı `modules/onboarding-forge/router.ts`, starter şablonları `modules/starter/*`, şablon pazarı `modules/templates/*` |
| Ajanlar / koşular | **Var** — Company → Agent (rol, systemPrompt, tools, model, maxTokens, autonomy) → Pipeline (steps JSON) → Run → RunStep (zorunlu `reasoning`) → ToolCall | `schema.prisma:414-637` |
| Alt-ajan / hiyerarşi | **Var (sunucuda)** — `HIERARCHICAL` pipeline: manager ajan `delegate(agentId, task)` aracıyla worker ajanları çağırır, `maxDelegationDepth` (vars. 3) | `schema.prisma:496-531`, `modules/pipeline/hierarchical.ts:6-31`, `hierarchical-runner.ts` |
| Mid-run steering / ask_user | **Var** — `SteeringMessage(INPUT/STEER)`, döngü her tur başında drain eder; `ask_user` aracı INPUT approval açıp run'ı `WAITING_APPROVAL`'a alır | `schema.prisma:667-688`, `modules/agent/claude.ts:595-650,979-980`, `registry.ts:1645`, `run/router.ts:508` (`POST /runs/:id/steer`) |
| Onaylar | **Var** — `Approval` tipleri SPEND / INPUT / EXTERNAL_CONTROL / HANDOFF; süre aşımı cron'u | `schema.prisma:639-665,1753-1782`, `modules/approval/router.ts:111` (`/approvals/:id/decide`, RBAC `approval:decide`), `approval/expiry-cron.ts` |
| Graduated autonomy | **Var** — Agent.autonomy SUPERVISED/BALANCED/AUTONOMOUS; para dokunan araç her zaman onay | `schema.prisma:457-466`, `tool-executor.ts:398-403` |
| Zamanlanmış görev | **Var (sunucu)** — `PipelineTrigger.SCHEDULED` + `Pipeline.schedule` (cron ifadesi) → BullMQ JobScheduler | `schema.prisma:510-515`, `pipeline/runner.ts:625-680,834`, `GET /pipelines/scheduled` (`pipeline/router.ts:307`) |
| Otomasyon konnektörleri | **Var** — (a) dış otomasyon kontrol düzlemi N8N/MAKE/ZAPIER/GENERIC (tetikle/duraklat/sürdür, onaylı) + poller; (b) içe aktarıcı: n8n, OpenClaw, Claude automation, MCP, generic → ajan sentezi (Make içe aktarıcısı yok); (c) webhook trigger + şablonlar | `schema.prisma:1619-1675`, `modules/external/{control,poller}.ts`, `adapters/{n8n,make,generic}.ts`; `modules/automation-importer/adapters/{n8n,openclaw,claude-automation,mcp,generic}.ts`, `agent-synthesis.ts`, `mask-secrets.ts`; `modules/webhook/*` |
| MCP | **İstemci (HTTP)** — JSON-RPC 2.0 `tools/list` + `tools/call`, stdio YOK; pazar yeri konnektörleri `mcp_{slug}_{tool}` dinamik araç olarak ajanlara eklenir, imzalı manifest | `lib/mcp.ts:1-20`, `modules/marketplace/{dynamic-tools,manifest-signature,connector-tool-risk}.ts`. **MCP sunucusu yok** |
| Tarayıcı / bilgisayar kontrolü | **Yok (sunucu)**; yalnız `web_search`, `web_research_deep` (WebResearchSession) | `registry.ts:1103,1595`, `schema.prisma:1226-1288` |
| Kodlama ajanı | **Yok** — dosya düzenleme/shell/diff aracı yok; yalnız `get_github_pr_status`, `get_github_branch_status` okuma araçları | `registry.ts:1436,1483` |
| Skills/plugins | **Kısmen** — "skill" kavramı yok; eşdeğeri konnektör pazarı + connector-sdk + şirket şablonları | `packages/connector-sdk`, `modules/marketplace`, `modules/templates` |
| Bildirim/push | **Var** — Expo push (`exp.host/--/api/v2/push/send`), türler approval/risk/draft/run/company, 14 dil kopya, `NotificationPref` | `services/push.ts:3,29-32`, `lib/notificationCopy.*`, `modules/device/router.ts` |
| Mobilden yerel oturum uzaktan kontrolü | **Var (relay)** — masaüstü/CLI oturumu kaydolur, olayları yukarı (SSE + poll), komutları (steer/approve/reject/kill) aşağı; Redis tamponu TTL 3600 sn, oturum kaydı süreç içi `Map` | `modules/relay/protocol.ts:1-35`, `relay.core.ts:42,58`, `bus.ts:41`, `relay/router.ts:97-309` |
| Cross-model handoff | **Var** — sağlayıcı zinciri ölünce turn checkpoint'ten başka sağlayıcıya devir; ledger | `schema.prisma:690-751` (HandoffLedger), `run/handoff.*`, `services/takeover-config.ts` |
| Diğer | CRM (Contact/Deal), outreach sequence, voice agent (Vapi/Retell/Twilio-Deepgram/custom), media üretimi (BYOK), A/B test, bench (ajan muhakeme/audit/harcama-onayı suit'leri), governance risk-stop'ları, SSO/OIDC, Stripe + Apple/Google IAP | `modules/*` |

Web sayfaları (`packages/ui/app`): dashboard, companies(+new, [id], runs/[runId], export), pipelines, runs, approvals, drafts, connections, integrations(+import), webhooks, analytics, bench, compare, cost-calculator, risks, settings(+identity), billing + pazarlama/yasal sayfalar. **Chat sayfası yok.**

### 1.3 Model/sağlayıcı soyutlaması
- Enum `AIProvider` (`schema.prisma:1877-1901`): ANTHROPIC, OPENAI, GOOGLE (Gemini), MISTRAL, GROQ, OPENROUTER, DEEPSEEK, KIMI, QWEN, CEREBRAS, ZHIPU, **OLLAMA, LMSTUDIO, CUSTOM** (OpenAI-uyumlu, kullanıcı `baseUrl`).
- Tek giriş: `services/ai-client.ts` `chatCompletion()` (`:984-1044`) — ANTHROPIC SDK yolu, GOOGLE kendi dönüştürücüsü (`toGeminiContents`), geri kalan hepsi `callOpenAICompatible` (`:711-806`). Native tool-use deny-list'i + "prompt-fallback" (araçları prompt'a gömme) (`:385`, `claude.ts:653`).
- **Sağlayıcı kiracı (tenant) düzeyinde**, ajan düzeyinde değil: `UserAIConfig` tenant başına sağlayıcı başına bir satır, `isDefault` = aktif, `fallbackOrder` = failover zinciri, `allowSystemFallback` (vars. false) (`schema.prisma:65-115`). Agent yalnız `model` string'i taşır; tenant sağlayıcısıyla uyumsuzsa sessizce tenant/varsayılan modele düşer (`ai-client.ts:304-320` `resolveModelForProvider`). → **Ajan başına sağlayıcı seçimi yok.**
- Zincir/devre kesici: `services/provider-chain.ts` (`buildTenantProviderChain`, `classifyProviderError`, `isProviderTripped`).
- Efor: `services/reasoning-effort.ts` — low/medium/high, **yalnız CEREBRAS `gpt-oss-120b`** için pozitif profil; diğerlerinde açık efor 400 (`UnsupportedReasoningEffortError`). Discovery: `GET /research/compare/options` (`reasoningEfforts`), `settings/provider-models.ts`, `GET /settings/ai-providers/:provider/models`. Agent modelinde efor alanı yok.
- Şirket anahtarı / deneme: holding'e ait **Groq** anahtarıyla deneme (`services/trial-llm.ts:3-13`, `Tenant.trialRunsUsed/Limit` vars. 3, deneme koşusu `TRIAL_MAX_TURNS=4` `claude.ts:730`); sistem Anthropic anahtarı yalnız opt-in/PAID (`company/builder.ts` D-009/D-013 yorumu).
- Yerel mod: `LLM_PROVIDER=local` (`config/env.ts:43`) → `modules/agent/claude-local.ts` `claude` CLI'yı (Claude Code) `spawn` eder (geliştirici/self-host; araçlar prompt'a gömülü).
- Anahtar saklama: Postgres `user_ai_configs.encrypted_api_key`, AES-256-GCM, scrypt/HKDF türetme, v3/v4 format + AAD (tenantId|rowId|column) (`lib/encryption.ts:1-40`). Media anahtarları `MediaProviderKey`, konnektör kimlikleri `TenantConnector` (şifreli). Ana anahtar env'de (değer okunmadı).
- OLLAMA/LMSTUDIO sunucu tarafında: çağrı `safeExternalFetch` + `networkPolicy` ile; loopback/RFC1918 yalnız açık opsiyonla (`lib/ssrf.ts:46-52,636-647`). Bulut üretimde kullanıcının localhost'u erişilemez → pratikte self-host senaryosu.
- Embedding: Voyage `voyage-3` (env anahtarı varsa), yoksa deterministik hash embedding (`packages/memory/src/embedding.ts:6-30`), 1536 boyut.

### 1.4 Zamanlama altyapısı (tamamı sunucu)
- BullMQ kuyrukları `pipeline-runs` (yürütme) ve `pipeline-schedules` (JobScheduler tekrarları) — ayrı kuyruk gerekçesi `lib/queue.ts:10-24`; worker lockDuration 10 dk (`:34-38`); `createWorker` factory (`:47`) tenant'sız bağlam işaretler.
- Boot'ta: `initPipelineRunner`, `initScheduledTickWorker`, `initScheduledPipelines` (uzlaştırma), `initOutreachWorker`, `initConsolidationCron` (setInterval 24 saat), `initApprovalExpiryCron`, `initExternalPoller` (setInterval) — `index.ts:341-372`.
- Kök `package.json` `node-cron` bağımlılığı var; aktif kullanım doğrulanamadı (ana yollar BullMQ + setInterval).
- Genişleme noktası: yeni zamanlanmış iş türü = `lib/queue.ts`'e kuyruk + `createWorker`, tetik = `Pipeline.trigger/schedule`; `processScheduledTick` → `enqueueRun("execute-run")`.

### 1.5 Veri modeli (ajan/koşu/görev/bellek ile ilgili Prisma modelleri)
`Tenant`, `User`, `UserAIConfig`, `Company` (status DRAFT/ACTIVE/PAUSED/ARCHIVED, `primitives[]`, `config` JSONB), `Agent`, `AgentVersion` (snapshot + NL edit, `modules/agent/version-control.ts`, `nl-editor.ts`), `Pipeline` (SEQUENTIAL/HIERARCHICAL, trigger MANUAL/SCHEDULED/WEBHOOK/EVENT, `schedule`, `lastRunAt`, `steps` JSON), `Run` (status PENDING…WAITING_APPROVAL…CANCELLED, `costUsd`, `budgetUsd`, `resumeCursor`), `RunStep` (`reasoning` zorunlu, token sayıları, `transcript` JSON checkpoint), `ToolCall`, `Approval`, `SteeringMessage`, `HandoffLedger`, `MemoryItem` (EPISODIC/SEMANTIC/PROCEDURAL; CANDIDATE/APPROVED/DEPRECATED; confidence/useCount), `MemoryEmbedding` (`vector(1536)`, HNSW index migration `20260423_pgvector_hnsw_index`), `MemoryEdge` (graf), `ActivityLog`, `Draft`, `UsageMeter`, `EvalResult`, `BenchSuite/BenchRun`, `ExternalConnection/ExternalRun`, `Connector/TenantConnector`, `WebResearchSession/Source`, `Device/PushSession/PushTokenFence/NotificationPref`.
- **Eksik**: Agent'ta `status`, `parentAgentId/reportsTo` (org şeması), `provider`, `reasoningEffort` alanı yok; sohbet/konuşma (Conversation/Message) modeli yok; Task (pipeline'dan bağımsız tekil görev) modeli yok.
- RLS: Prisma sarmalayıcısı `set_config(app.tenant_id)` aynı batch transaction içinde (`lib/db.ts:16-26`); HANDOFF/VENTURE'a göre Stage-2 RLS canlı kabulü ayrı iş (`workspace/RLS-STAGE2-RUNBOOK.md`).

### 1.6 Bellek / bağlam yönetimi
- `packages/memory`: episodic/semantic/procedural/graph/vault/search modülleri; ajan araçları `store_memory`, `recall_memory`, `consolidate_memories`, `knowledge_base_search` (`registry.ts:513-660,1126`).
- Konsolidasyon: günlük setInterval — yüksek güven+kullanımda CANDIDATE→APPROVED, 90 gün kullanılmayan APPROVED→DEPRECATED (`modules/memory/consolidation-cron.ts:1-40`). LLM özetleme yok.
- Bağlam: `modules/agent/context-builder.ts` (şirket config dilimi + son aktiviteler; önceki adım çıktılarının prompt-injection yayılımı nedeniyle sınırlandığı not `:128`).
- Sıkıştırma: gerçek "compaction" yok. Checkpoint 1 MB üstünde son turlara kırpılır (`claude.ts:380-445` `truncateToLastTurns`, `truncated:true`); handoff için LLM'siz mekanik özet `modules/run/handoff-summary.ts:1-25`.
- `HandoffLedger` yorumu: bellek katmanı "3 implementasyona bölünmüş, 0 test" (F-005) — `schema.prisma:695-697`. → Bellek teknik borcu kayıtlı.

### 1.7 Güvenlik
- Araç yürütme: `modules/agent/tool-executor.ts` — tenant izolasyonu (companyId'den tenant türetme, prompt-injection ile çapraz-tenant mutasyon engeli `:63,214`), onay kapısı, araç başı dakikalık rate limit (`:484-498`), audit. Sunucuda shell/dosya aracı olmadığı için sandbox gereksinimi yok.
- Governance engine risk-stop'ları adımlar arasında, push ile bildirim (`modules/governance/engine.ts:1-20`); aylık bütçe tavanı `Tenant.monthlyBudgetUsd`.
- Egress: `lib/ssrf.ts` (650 satır; DNS çözüm sonrası IP denetimi, IPv6 özel aralıklar) tüm dış fetch'lerde; MCP çağrıları `assertSafeExternalUrl`.
- Outbound kişi teması (e-posta/outreach/voice) env bayrağıyla varsayılan KAPALI (`lib/outbound-gates.ts:1-15`, commit `c6dee70`).
- Otomasyon içe aktarımında sır maskeleme (`automation-importer/mask-secrets.ts`); relay'de `redact()` (`relay/protocol.ts:20-35`).
- Auth: JWT + refresh cookie, RBAC (`lib/rbac.ts`, `middleware/require-permission.ts`), SSO/OIDC, rate limit middleware.

### 1.8 Ajan döngüsü / runtime
- Koşu **sunucu worker'ında** çalışır: `POST /pipelines/:id/run` → BullMQ `pipeline-runs` → `modules/pipeline/runner.ts` → `executor.ts` (SEQUENTIAL) / `hierarchical-runner.ts` → `modules/agent/claude.ts` `runAgentLoop` / `runProviderAgentLoop` (vars. `maxTurns=10`, `:813-822`), tool-call eşzamanlılığı `mapWithConcurrency`, her turda checkpoint + steering drain + interrupt kontrolü (`:970-980`).
- İstemci bağlantısı: REST `/api/v1/*` + **SSE** `GET /runs/:id/stream` (Redis pub/sub + `Last-Event-ID` replay, `lib/runEvents.ts:1-12`, `run/router.ts:559`); relay için SSE + poll (`relay/router.ts:171,263`). WebSocket yok.
- Yerel daemon yok; sunucu tek süreç (API + worker'lar aynı Express sürecinde boot olur, `index.ts:341`).

---

## 2. DESKTOP — origin/main `f7a8879` (yerel `a16e803` + zod 4)

### 2.1 Stack
- **Tauri v2** (Rust host, `src-tauri/Cargo.toml`: tauri 2, tauri-plugin-dialog, tokio, **portable-pty 0.9**, tokio-tungstenite 0.21 (CDP), `keyring` yalnız macOS/Windows) + webview frontend **framework'süz TypeScript** + Vite 6.4.5, Vitest 4. Tek bağımlılık zod 4.6.7 (`package.json`). Sürüm 0.1.1.
- Büyük dosyalar: `src/ui.ts` 2.462, `src-tauri/src/lib.rs` 3.897, `sandbox.rs` 1.047, `browser.rs` 763, `pty.rs` 645 satır.
- CI: `.github/workflows/{ci,release-linux}.yml`; mac universal build script'leri (imza/notary manuel Y8).

### 2.2 Ürün bölümleri
Üç yüzey: **Chat / Code / Company** (`src/ui.ts:494-499,1177`).
| Bölüm | Var mı | Kanıt |
|---|---|---|
| Chat | **Var** — 4 kaynak şeridi: Cascade, Compare (sunucu), **Local (Ollama)**, **Direct (BYOK)**; tek atış, stream yok (Ollama `stream:false`) | `README.md` Lane-A bölümü, `src/local.ts`, `src/direct.ts`, `src/client.ts` |
| Yerel sohbet geçmişi | **Var** — localStorage, düz metin (BUGÜN/ÖNCE listesi) | `src/sessions.ts:1-12` |
| Kodlama ajanı | **Delegasyon** — kendi ajanı yok; Lane-B kullanıcının imzalı `claude`/`codex` CLI'sını tespit eder ve başlatma komutunu gösterir (`braavo spawn`'a devreder); vendor stdout'u opak, parse edilmez. Değişiklikler `git` ile okunur (`git_changed_files`) — diff/apply UI yok | `src/spawn.ts`, `src/changes.ts:1-10`, `ui.ts:536-550` ("this UI reveals the launch command; it does not drive a PTY") |
| Gömülü PTY | **Host hazır, UI bağlı değil** — `pty_spawn/write/resize/kill` komutları + sandbox + governance token; `src/pty.ts` çekirdeği `ui.ts`'den import edilmiyor | `src-tauri/src/pty.rs:1-25`, `lib.rs:3867-3870`; `grep` ile `./pty` importu yok |
| Tarayıcı kontrolü (Lane-C, CDP) | **Host hazır, UI bağlı değil** — `browser_discover/connect/dispatch`, onaylı tek kullanımlık token, http(s) dışı hard-deny | `src-tauri/src/browser.rs:1-22`, `ui.ts:208-211` ("no surface in this UI opens one") |
| MCP | **İstemci (stdio)** — sunucu kaydı, tools/list, onay kapılı tools/call; config `mcp.json` (app data) | `src/mcp.ts` (548), `lib.rs:3876-3882`. MCP sunucusu yok |
| Onaylar / governance | **Var** — fail-closed politika `classifyAction` (auto-allow / require-approval / deny), tek kullanımlık onay token'ı (host `action_scope.rs`), native OS dialog (webview taklit edemez), append-only 0600 audit | `src/governance.ts:1-20,95-107,258-300`, `src-tauri/src/action_scope.rs`, `lib.rs:3858-3866` |
| Company yüzeyi | **Salt-okur bulut durumu** + 2 yaşam döngüsü eylemi (API'nin sunduğu); next-run'ı uydurmaz | `src/company.ts:1-12`, `ui.ts:633-636` |
| Mobil companion | **Var** — relay bridge: olaylar yukarı, steer/approve/reject/kill aşağı; aynı hesap owner-binding; steer = yazılmış prompt gibi çalışır, dispatch sürerken reddedilir | `src/relay-bridge.ts:1-30`, `relay-transport.ts` (fetch+SSE), `ui.ts:851-895` |
| Zamanlanmış görev | **Yok** (yerel scheduler yok; Company yüzeyi sunucu job'larını gösterir) | `company.ts`, `ui.ts:1123` |
| Bildirim | Yok (doğrulanamadı: native notification kullanımı bulunmadı) | — |

### 2.3 Sağlayıcılar / anahtarlar
- Direct BYOK: yalnız **anthropic, openai, groq**, sabit varsayılan modeller (`claude-3-5-sonnet-20241022`, `gpt-4o-mini`, `llama-3.1-8b-instant`), model alanı elle override (`README.md`, `src/direct.ts`). Local: Ollama `localhost:11434` (`/api/tags`, `/api/chat`); CSP `connect-src 'self' https: http://localhost:* http://127.0.0.1:*` (`tauri.conf.json:28`) → LM Studio vb. loopback teknik olarak mümkün ama kod yalnız Ollama.
- Sunucu Compare: tam model/efor seçimi sunucu discovery'sinden (`src/compare-selection.ts`, `compare-controls.ts`).
- Anahtar saklama: macOS Keychain / Windows Credential Manager (`keyring`), Linux'ta tek `vault.json` 0600; `keys-index.json` yalnız maskeli parmak izi; ham değer yalnız `key_get` ile dispatch anında (`README.md` S-010, `src/keyvault.ts`, `lib.rs` `secure_store_*`, `key_*`). Auth token da secure store'da (`src/store.ts`).

### 2.4 Yerel veri modeli
- SQLite/DB **yok**. Keychain (token + BYOK), app-data dosyaları (`keys-index.json`, `mcp.json`, 0600 audit log), localStorage (sohbet oturumları, apiUrl, tercih/tema/dil — `src/prefs.ts`, `sessions.ts`).

### 2.5 Güvenlik
- OS sandbox: `src-tauri/src/sandbox.rs` — macOS `sandbox-exec` SBPL profili, Linux `bwrap`; varsayılan politika: okuma = sistem seti + cwd, yazma = yalnız cwd, **ağ KAPALI**; kökler `canonicalize` ile symlink/firmlink çözülür, çözülemeyen yazma kökü fail-closed (`sandbox.rs:1-28,42-65`). Windows'ta sandbox/MCP fail-closed HOLD (VENTURE.md 20 Eki).
- Governance hard-deny: `rm -rf`, `mkfs`, `dd if=` vb. yıkıcı komut; path traversal; non-http(s) navigasyon; PTY'de izin-atlatma bayrakları (ör. permission-skip) ve sistem/sır dizinlerinde cwd (`governance.ts:109-113,262-295`).
- Auto-allow yalnız `probe.detect`, `local.dispatch`, `server.dispatch` (`governance.ts:103-107`); diğer her şey insan onayı.
- Relay'den gelen approve ile native dialog yarışı modellenmiş/test edilmiş (`relay-bridge.ts:20-30`).

### 2.6 Runtime
- Kendi ajan döngüsü **yok**. Chat = sunucu REST (cascade/compare + poll `/research/:id`) veya doğrudan sağlayıcı/Ollama tek atış. Uzun süreli yerel daemon yok; Tauri süreci kapanınca PTY çocukları öldürülür (`lib.rs:3886-3888`).

---

## 3. CLI — `0fd8f4a` (= origin/main)

### 3.1 Stack
- Node ≥24.22, TypeScript, **neredeyse bağımlılıksız** (yalnız zod 4.6.6, `--bridge` relay için). Bin `braavo` (`dist/braavo.js`). ~6.000 satır; `src/braavo.ts` 1.385 satır tek komut dağıtıcısı (`switch(cmd)`).

### 3.2 Komutlar / ürün bölümleri (`src/braavo.ts:474-1353`)
- Konsey (council): `ask`, `cancel`, `cascade`, `savings`, `models`, `image`, `voice`, `media-key`.
- Lane-A: `local` (Ollama, `src/forge/local.ts`), `direct` (anthropic/openai/groq, `src/forge/direct.ts:20-34`), `keys add|list|rm`.
- Lane-B: `spawn` (vendor `claude`/`codex` `stdio:"inherit"`, opak; `--bridge` ile relay companion → `spawnVendorBridged`, `src/forge/spawn.ts:14,140-146`, `braavo.ts:781-852`).
- `fix --cmd "<test>"`: test kırmızıysa çıktı kuyruğunu modele gönderir, **yalnız öneri basar, dosya yazmaz/patch uygulamaz** (`src/forge/fix.ts:1-20`).
- `mcp add|list|rm|tools|call` — stdio MCP istemcisi, config `~/.braavo/mcp.json` (`src/forge/mcp.ts:3-20`).
- Pipeline kontrolü (sunucu): `runs`, `run`, `steer`, `handoffs`, `handoff`, `continue`, `connections`, `watch` (poll), `approve`, `pause`, `stop`, `cost`, `policy`, `audit`, `connect`, `agent` (şirket ajan listesi), `session` (relay oturumları), `whoami`, `use`, `init`, `doctor`, `login/logout`.
- Yok: yerel ajan döngüsü, dosya düzenleme/shell aracı (fix hariç kullanıcının kendi komutu), zamanlama, tarayıcı, kendi chat REPL'i (tek atış komutlar).

### 3.3 Yerel veri / anahtar
- `~/.braavo/config.json` (apiUrl, token, refreshToken, defaultCompany, custom-host opt-in; `doctor` 0600 denetler) — `src/forge/config.ts:1-40`, `doctor.ts:43`.
- BYOK: macOS login keychain (`security … generic-password`, servis `braavo-cli`) + isim indeksi; diğer OS'ler `~/.braavo/keys.json` chmod 600 düz metin uyarılı (`src/forge/keys.ts:1-14,97`). Anahtarlar sunucuya gönderilmez.
- Güvenlik: özel host'a token sızdırmayı önleyen `--allow-custom-host` + `UntrustedHostError` (`config.ts` BR-P0-004, `client.ts:201`); argv dizisi, shell yok (spawn); belgelenmiş çıkış kodları (`forge/exit-codes.ts`). Sandbox yok (CLI'de host OS sandbox kullanılmıyor).

---

## 4. MOBILE — PR #32 head `262654b` (yerel `75ca72c` + 2)

### 4.1 Stack
- **Expo SDK 54**, React Native 0.81.5, React 19.1, expo-router 6, NativeWind 4.1, zustand 5, expo-secure-store 15, AsyncStorage 2.2, expo-notifications 0.32; sürüm 1.0.4; EAS (`eas.json`). Testler Vitest (saf `lib/*` çekirdekleri).

### 4.2 Ürün bölümleri (`app/`)
| Bölüm | Var mı | Kanıt |
|---|---|---|
| Sekmeler | Ana sayfa, Companies, Workflows (pipeline), Approvals, More | `app/(tabs)/*` |
| Chat ("Ask") | **Var** — bulut cascade (`/research/cascade`, `/cascade/options`, `/cascade/selected` ile model seçimi `AskModelPicker`); telefonda sağlayıcı anahtarı **yok**; thread secure store'da kalıcı | `lib/chat.ts:1-7`, `app/chat/index.tsx`, `lib/askSelection.ts`, `lib/store.ts:48,161` |
| Koşu detayı + steering | **Var** — `SteerComposer` → `POST /runs/:id/steer`; run stop | `app/runs/[id].tsx:197-261`, `lib/api.ts:1167-1170` |
| Onaylar | **Var** — `/approvals?status=…`, `/approvals/:id/decide` (SPEND/INPUT/EXTERNAL_CONTROL/HANDOFF aynı kuyruk) | `app/(tabs)/approvals.tsx`, `lib/approvalDecision.ts`, `useApprovalDecision.ts` |
| Companion (yerel oturum uzaktan kontrol) | **Var** — masaüstü/CLI oturumunu izle/steer/approve; RN fetch SSE tutamadığı için poll | `app/companion/{index,[id]}.tsx`, `lib/companion.ts:1-14` |
| Şirket yaşam döngüsü, workflows (scheduled), drafts, risks, analytics | Var | `app/companies/[id].tsx`, `app/workflows/[id].tsx`, `/pipelines/scheduled`, `app/drafts`, `app/risks`, `app/analytics` |
| Push | **Var** — Expo push token kaydı, locale senkronu, sahiplik fence | `lib/usePushNotifications.ts`, `pushLocaleSync.ts`, `pushOwnership.ts`, `/devices/push-token` |
| On-device Gemma | **Yalnız seam (pasif)** — `ON_DEVICE_MODELS=[gemma-3n-e2b 1400MB]`, `registerOnDeviceBackend` hiçbir yerde çağrılmıyor; native runtime (react-native-executorch) bağlı değil; offline modda bulut AI dispatch reddedilir | `lib/onDeviceLLM.ts:1-75`, `lib/offlineRouting.ts`, `app/settings/offline.tsx` |
| AI veri onayı / IAP / hesap silme | Var | `components/AIConsentSheet.tsx`, `lib/iap.ts`, `app/settings/delete-account.tsx` |
| "Send email" (taslak) | Build bayrağı arkasında, varsayılan kapalı (B-06) | commit `262654b` |
| Kodlama ajanı, MCP, tarayıcı, yerel scheduler | **Yok** | — |

### 4.3 Yerel veri
- zustand `persist` → `createJSONStorage(() => secureStorage)` (expo-secure-store, `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`) — oturum, chat thread, tercih (`lib/store.ts:96-161`, `lib/secureStorage.ts:41-64`). AsyncStorage yalnız görünüm + dil (`appearanceStore.ts`, `i18n.ts:3516`). SQLite yok.

---

## 5. Çapraz özet matrisi

| Yetenek | Platform (sunucu/web) | Desktop | CLI | Mobile |
|---|---|---|---|---|
| Sohbet (çok turlu, akışlı) | Yok (tek atış cascade/compare) | Tek atış + yerel geçmiş | Tek atış | Tek atış thread |
| Kodlama ajanı (edit/shell/diff) | Yok | claude/codex delegasyonu + git değişiklik listesi; PTY host hazır, UI yok | `spawn` delegasyonu, `fix` öneri | Yok |
| Zamanlanmış görev | BullMQ JobScheduler (pipeline cron) | Görüntüleme | Yok | Görüntüleme |
| AI şirket / ajan org | Company→Agent→Pipeline, hiyerarşik delegate | Salt-okur | `agent` listesi | Şirket/workflow görüntüleme |
| Steering / ask_user | Var | Relay ile steer | `steer` | Var |
| Onay | Approval kuyruğu + autonomy | Yerel governance + native dialog | `approve`, `policy`, `audit` | Var |
| MCP | HTTP istemci (pazar) | stdio istemci (onaylı) | stdio istemci | Yok |
| Tarayıcı/bilgisayar | Yok | CDP host hazır, UI yok | Yok | Yok |
| Sandbox | Gerek yok (shell yok) | seatbelt/bwrap, ağ kapalı | Yok | — |
| Yerel model | OLLAMA/LMSTUDIO/CUSTOM (self-host'ta) | Ollama | Ollama | Gemma seam (pasif) |
| Anahtar | DB AES-256-GCM | Keychain/CredMan | macOS keychain / 0600 dosya | Anahtar yok |
| Uzaktan kontrol | Relay sunucusu | Relay istemci | `spawn --bridge` | Companion |

---

## 6. Hedefe göre boşluklar
Hedef: local-first AI çalışma alanı = chat + kodlama ajanı + zamanlanmış görevler + "AI company" (ajan org şeması, ajan başına model/efor, durum, chat/görev geçmişi paneli); desktop + CLI + mobile paralel.

1. **Local-first değil, server-first.** Tüm ajan/koşu/zamanlama/bellek Postgres+Redis+BullMQ'lu bulut sunucuda (`index.ts:341-372`). Desktop/CLI'de yerel ajan döngüsü, yerel DB, yerel scheduler yok. Self-host mümkün (docker compose) ama ağır (PG+Redis+API+UI).
2. **Çok turlu sohbet yok.** Conversation/Message modeli yok; tüm yüzeylerde "Ask" tek atış cascade/compare. Stream yok (Ollama `stream:false`, cascade senkron).
3. **Yerel kodlama ajanı yok.** Dosya edit/shell/diff-apply araçları hiçbir katmanda yok; kodlama tamamen claude/codex CLI'ye devredilmiş ve stdout'u bilinçli olarak opak (Lane-B sözleşmesi) → Braavolabs kodlama oturumunun içini göremiyor, tool/diff akışı veremiyor. PTY + sandbox host'u hazır ama UI'ya bağlı değil.
4. **Ajan org şeması yarım.** Agent'ta `role` var; `reportsTo/parent`, `status`, `provider`, `reasoningEffort` alanları yok. Hiyerarşi yalnız pipeline düzeyinde (`managerAgentId` + `delegate`). CLI `agent` komutu `a.status` basıyor ama modelde alan yok (doğrulanamadı: API ek alan türetiyor olabilir).
5. **Ajan başına sağlayıcı/efor yok.** Sağlayıcı tenant düzeyinde; ajan modeli uyumsuzsa sessizce düşüyor; efor yalnız Cerebras gpt-oss-120b. Anthropic extended thinking/effort, OpenAI reasoning_effort, Gemini thinking budget bağlı değil.
6. **Görev (task) kavramı yok.** Her iş Pipeline→Run; ad-hoc "ajana görev ver" + görev geçmişi paneli için ayrı model yok (Run/RunStep/ToolCall yeniden kullanılabilir).
7. **Yerel zamanlama yok.** Desktop/CLI'de launchd/Tauri arka plan/cron yok; uygulama kapalıyken yerel iş koşamaz.
8. **Bellek parçalı.** 3 implementasyon / 0 test notu (`schema.prisma:695-697`); compaction/LLM özetleme yok; embedding Voyage yoksa hash (anlamsal değil).
9. **İstemciler arası paylaşılan protokol kopya.** Relay protokolü desktop `src/relay-protocol.ts`, CLI `src/forge/relay-protocol.ts`, sunucu `modules/relay/protocol.ts` olarak ayna kopyalar; ortak paket yok. Sağlayıcı istemcisi de üçlü kopya (CLI `direct.ts`, desktop `direct.ts`, sunucu `ai-client.ts`) ve desktop/CLI yalnız 3 sağlayıcı.
10. **Mobil yerel model pasif.** Gemma seam var, runtime bağlı değil.
11. **Desktop Windows** sandbox/MCP fail-closed (HOLD); Linux keychain yok (0600 dosya).
12. **MCP sunucusu yok** (Braavolabs ajanlarını/araçlarını dış ajanlara açan bir uç yok); stdio MCP sunucu tarafında yok.

---

## 7. Genişleme noktaları (somut dosyalar)

**Sunucu (platform `packages/api/src`)**
- Yeni ajan aracı: `modules/agent/registry.ts` `registerTool()` (`:115`); risk/onay meta'sı aynı tanımda; yürütme kapısı `modules/agent/tool-executor.ts`.
- Ajan döngüsü / turn kancaları: `modules/agent/claude.ts` `runProviderAgentLoop` (`:813`), steering drain (`:979`), checkpoint (`:473`). Compaction buraya (checkpoint serileştirme `serializeCheckpoint` `:425`) eklenebilir.
- Sağlayıcı/efor: `services/ai-client.ts` `chatCompletion` switch (`:1020-1044`), `services/reasoning-effort.ts` `REASONING_EFFORT_CAPABILITIES`, `services/provider-chain.ts`, `modules/settings/provider-models.ts`.
- Ajan başına model/efor/durum/org: Prisma `Agent` (`schema.prisma:445`) + `modules/company/agent-update.ts`, `agent/version-control.ts`, `pipeline/executor.ts:294` (`model: agent.model`).
- Zamanlama: `lib/queue.ts` (`createWorker`), `modules/pipeline/runner.ts` (`upsertJobScheduler` `:673`, `initScheduledPipelines` `:834`).
- Olay akışı: `lib/runEvents.ts` + `run/router.ts:559` SSE.
- Uzaktan kontrol: `modules/relay/{protocol,relay.core,bus,router}.ts` (oturum kaydı süreç içi `Map` → çok örnekli dağıtımda Redis/DB'ye taşınmalı).
- MCP: `lib/mcp.ts` (HTTP istemci), `modules/marketplace/dynamic-tools.ts`.
- Bellek: `packages/memory/src/*`, `modules/memory/consolidation-cron.ts`.
- Push: `services/push.ts` (`NotifyKind`).

**Desktop**
- Yüzey ekleme: `src/ui.ts` surface switch (`:494-499,1177`) — tek dosya DOM, framework yok (büyüdükçe yeniden yapılandırma gerekebilir).
- Host komutları: `src-tauri/src/lib.rs` `generate_handler!` (`:3848-3883`); yeni yerel ajan/araç için governance token + `sandbox::wrap_command` deseni (`pty.rs`, `browser.rs`).
- Politika: `src/governance.ts` `classifyAction` + `AUTO_ALLOW`; Rust aynası `lib.rs` `classify`.
- Hazır ama bağlanmamış: `src/pty.ts` + `pty_*`; `src/browser.ts` + `browser_*`.
- Yerel sağlayıcılar: `src/direct.ts`, `src/local.ts`, `src/keyvault.ts`.
- Yerel depolama: şu an localStorage/dosya; SQLite için Tauri plugin eklenmesi gerekir (yok).

**CLI**
- Komut ekleme: `src/braavo.ts` `switch(cmd)`; yardımcılar `src/forge/*` (client, config, keys, mcp, spawn, relay-*).
- Yerel ajan döngüsü için temel parçalar mevcut: `forge/direct.ts` + `forge/local.ts` (sağlayıcı), `forge/mcp.ts` (araç), `forge/audit.ts`/`approvalDecision.ts` (onay/audit), `forge/relay-bridge.ts` (mobil companion).

**Mobile**
- Ekran: `app/` (expo-router); API: `lib/api.ts`; saf çekirdekler `lib/*.ts` (test edilir desen).
- Yerel model: `lib/onDeviceLLM.ts` `registerOnDeviceBackend` + `docs/on-device-inference.md`.
- Companion: `lib/companion.ts`, `app/companion/*`.

---

## 8. Doğrulanamayanlar
- `node-cron` (kök bağımlılık) aktif kullanımı.
- Web UI'da run detay sayfasında steering kompozitörü olup olmadığı (sayfa var: `app/runs/[id]`, `app/companies/[id]/runs/[runId]`; içerik okunmadı).
- Desktop'ta native bildirim kullanımı (bulunmadı).
- Canlı üretimde hangi sağlayıcıların fiilen kullanıldığı, OLLAMA'nın bulutta erişilebilirliği (SSRF politikası opsiyona bağlı; üretim env değeri okunmadı).
- Relay'in canlıda uçtan uca çalıştığı (kaynak + testler var; canlı kabul bu envanterin kapsamı dışında).
- Agent `status` alanının API tarafından türetilip türetilmediği.
