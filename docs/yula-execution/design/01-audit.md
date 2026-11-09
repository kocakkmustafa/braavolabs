# BRA-UX-01 · 01 — Braavolabs mevcut ürün envanteri (Aşama 1)

Tarih: 2026-11-09 · Kapsam: yalnız durum tespiti. Tasarım, konsept, renk önerisi yoktur (sonraki bilet). Renk hex değerleri yalnız KAYDEDİLİR.
Atıf biçimi: platform için `packages/...:satır`; diğer üç yüzey için `desktop/...`, `cli/...`, `mobile/...`. Doğrulanamayan her şey "doğrulanamadı" yazılır.

## 0. Kapsam, kaynak sürümleri ve doğrulama yöntemi

| Yüzey | Depo / dal | Okunan SHA | Not |
|---|---|---|---|
| Platform (web+API) | `wt-bra-ux-01`, dal `docs/BRA-UX-01-design-audit` | `95872d1348daf4a20797a7a17eee84665c504e46` (= origin/main, #124 merge) | Kod bu SHA'dan okundu |
| Desktop | `desktop`, `git archive origin/main` | `ad6867a9fb3890c7b0a5e4e44c99dd032b19a710` | Yerel dal `release/1.1.0` = `927c927`, origin/main'in atasıdır (geride); main'de `package.json:version` ve `src-tauri/tauri.conf.json` 1.1.0 |
| CLI | `cli`, `git archive origin/main` | `ed3692e0…` (`ed3692e462…`) | Yerel dal `feat/tasks-budget` `d0b3135`, main'in 35 commit gerisindedir ve `package.json:3` 0.2.0 der; origin/main'de sürüm 1.1.0 (`git show origin/main:package.json`). Çelişkinin nedeni bayat yerel dal; `release/1.1.0` (`ffbacdd`) main'in atasıdır |
| Mobil | `mobile`, `git archive origin/main` ve `origin/release/1.1.1` | main `5e60a75`, release/1.1.1 `2a04e90` | main `app.json` 1.1.0; release/1.1.1 `app.json` ve `package.json` 1.1.1 |

Yöntem: `git fetch` + `git rev-parse`; üç salt-okur depo çalışma ağacına dokunulmadan `git archive … | tar -x` ile oturum scratchpad'ine açılıp satır numaraları oradan alındı. Kod koşulmadı, uygulama çalıştırılmadı; yalnız statik okuma. Ekran görüntüsü yok (bölüm 10).

Çelişen sürüm bilgileri:
- CLI "0.2.0" ↔ "1.1.0": yerel bayat dal ↔ origin/main (yukarıda). npm `latest` doğrulanamadı (vault panosu "1.1.0 npm latest" diyor, bu denetimde npm okunmadı).
- Mobil versionCode: `app.json`'da `versionCode` yok; `eas.json` `appVersionSource: "remote"` ve `autoIncrement: true` (`mobile/eas.json:4`, `:38`). `android/` dizini `.gitignore`'da (`mobile/.gitignore:15`); yerel üretilmiş `android/app/build.gradle:95-96` `versionCode 1 / versionName "1.0.4"` içerir ve kaynak değildir. "versionCode 30" yalnız vault panosunda (`20 Şirketler/Braavolabs/📊 Durum & Mağaza Panosu.md:16`, `:25`) ve EAS makbuzunda geçer; depoda doğrulanamadı.
- Desktop dalı: mağaza/yayın dalı `release/1.1.0`, ama yerel kopya main'den geridir; denetim origin/main'dendir.

Sayı iddiaları ve komutları:
- `find packages/ui/app -name page.tsx | wc -l` → 52 sayfa (ipucundaki "~90" yanlıştı).
- `grep -rlE "backdrop-filter|backdropFilter|backdrop-blur" app components | wc -l` → 28 dosya (ipucu 61).
- `grep -c "text-\[[0-9]*px\]"` toplamı → 62 (ipucu 85).
- `grep -c "^model " packages/db/prisma/schema.prisma` → 58.
- `sed -n 238,251p packages/api/src/services/ai-client.ts | grep -o '"[^"]*"' | wc -l` → 55 model kimliği.
- `find … -name '*.test.ts*'` (ui, node_modules hariç) → 17; `ls e2e/*.spec.ts | wc -l` → 11.
- `grep -rEo "#[0-9a-fA-F]{6}\b" app components --include='*.tsx' | wc -l` → 201 sabit hex.

## 1. Platform web (`packages/ui`)

### 1.1 Ekranlar ve navigasyon
- 52 `page.tsx`: ürün içi (giriş sonrası): `dashboard`, `companies`, `companies/new`, `companies/[id]`, `companies/[id]/export`, `companies/[id]/runs/[runId]`, `pipelines`, `pipelines/[id]`, `runs`, `runs/[id]`, `approvals`, `drafts`, `analytics`, `risks`, `integrations`, `integrations/import`, `connections`, `ab-tests`, `ab-tests/[id]`, `webhooks`, `billing`, `settings`, `settings/identity`, `onboarding`, `status`, `errors`; kalanı pazarlama/yasal/giriş (`/bench`, `/compare` public pazarlama sayfaları: `packages/ui/app/compare/page.tsx:1-20`, `packages/ui/app/bench/page.tsx:1-12`).
- Yan menü sabit 14 öğe: `packages/ui/components/Sidebar.tsx:14-28`. `/runs` yan menüde YOK; yalnız `packages/ui/app/dashboard/page.tsx:434` ve `packages/ui/app/pipelines/[id]/page.tsx:421` bağlantılarıyla erişilir.
- Mobil çekmece: `packages/ui/app/AuthLayout.tsx:65-83`. Yetkisiz kullanıcı `/login`e yönlenir: `packages/ui/lib/useAuthGuard.ts:24-25`.
- Sohbet, model listesi, ajan listesi ve kod/IDE ekranı yok (52 sayfanın hiçbiri; `find` ile doğrulandı). Ajanlar yalnız şirket detayında bir sekme: `packages/ui/app/companies/[id]/page.tsx:26`, `:63`, `:376`.
- Bozuk bağlantı: `packages/ui/app/pipelines/[id]/page.tsx:422` `/agents`e gider; `/agents` rotası yok. (`packages/ui/components/PresenceBar.tsx:32` de `/agents/:id` yolunu varsayar.)

### 1.2 Çalışan akışlar
- Niyet tarifine en yakın akış: `companies/new` sihirbazı `describe → clarify → preview → creating → done`: `packages/ui/app/companies/new/page.tsx:23`, `:361`, `:495`. Bu bir şirket kurma akışıdır, genel iş/sohbet girişi değildir.
- Koşu listesi `/dashboard/runs`ten gelir ve yalnız `status` ile süzer (all/running/completed/pending/failed): `packages/ui/lib/api.ts:509-510`, `packages/ui/app/runs/page.tsx:56`, `:62`, `:69`, `:188`. `GET /runs?bucket=` (04b) web tarafından çağrılmaz (`grep -n "bucket" packages/ui/lib/api.ts` boş).
- Koşu detayı: adımlar ve araç çağrıları `packages/ui/app/runs/[id]/page.tsx:54`, `:671`, `:730`; maliyet `:471`, `:645`; onay listesi (salt okunur) `:419-428`; devir paneli `:411-416`; yönlendirme (steer) yalnız RUNNING iken `:516-518`.
- Onaylar: `packages/ui/app/approvals/page.tsx`: liste `:36` (hata `.catch(() => {})` ile yutulur), tutar `:166-175`, koşu bağlantısı `:179`, taslak içeriği `:197`, Onayla `:205`, Reddet `:220`. Araç adı, risk, yetki kapsamı veya veri aktarımı gösterilmez (ekranda yok).
- Ajan yönetimi: şirket detayında model `packages/ui/app/companies/[id]/page.tsx:132-145` ve özerklik (SUPERVISED/BALANCED/AUTONOMOUS) `:164-176`. `createAgent`, `deleteAgent`, `rollbackAgent`, `nlEditPreview` API'de tanımlı (`packages/ui/lib/api.ts:617-622`, `:751-757`) ama ekranda kullanım doğrulanamadı.
- Çoklu model karşılaştırma yalnız şirket detayı "compare" sekmesinde: `packages/ui/components/ComparePanel.tsx:58`, `:128`; sekme `packages/ui/app/companies/[id]/page.tsx:374`.
- Model/BYOK: Ayarlar `ai_provider` bölümü `packages/ui/app/settings/page.tsx:58`, kayıt `:408` (`PUT /settings/ai-config`), sağlayıcı listesi `:235`, bağlantı testi `:444`; onboarding BYOK kapısı `packages/ui/app/onboarding/page.tsx:157`, `:340`.
- Dashboard: 4 KPI kartı `packages/ui/app/dashboard/page.tsx:215-240` (`KpiCard` `:341`).

### 1.3 Tasarım sistemi (kayıt; değişiklik önerisi yok)
- Tokenlar `packages/ui/app/globals.css:4-71` (Tailwind `@theme`). Koyu (varsayılan): background `#06070A`, surface `#0B0D12`, on-surface `#E8EBF0`, on-surface-variant `#9AA3B2`, primary `#60A5FA`, primary-container `#3B82F6`, secondary `#7DD3FC`, error `#FF8A8A`, success `#6EE7B7`, warning `#FBBF24`, outline `#8C96A5` (`:8-56`). Açık tema `html.light` `:74-117`: background `#f5f7fa`, surface `#ffffff`, on-surface `#1a1c20`, primary `#006880`, error `#ba1a1a`.
- Durum tokenları (koşu durumu renkleri) `:813-817`: running `#FF7A1A`, completed `#3B82F6`, paused `#3A4150`, failed `#FF4D4D`, cancelled `#5B6473`; açık temada running `#9A3412` (`:851`). Marka kobalt `:782-784` (`#3B82F6`, `#2563EB`, `#1E3A8A`).
- Tipografi: Space Grotesk (başlık), Inter (gövde), JetBrains Mono (mono): `:67-70`, `:822-824`; sınıflar `.bv-display` 30px, `.bv-headline` 24px, `.bv-title` 16px `:998-1000`. Fontlar `packages/ui/app/layout.tsx:17-19` (JetBrains Mono için `@fontsource` kaydı doğrulanamadı; yalnız CSS yığınında adı geçer). 62 adet `text-[Npx]` rastgele boyut (bölüm 0 komutu).
- Bileşenler: `.bv-btn` `:1014`, `.bv-btn-primary` `:1040`, `.bv-fpill`, `.bv-glass` `:873`; 22 bileşen dosyası `packages/ui/components/` (Sidebar, CommandPalette, PipelineCanvas, ComparePanel, Toast, NotificationBell, …).
- Glass kullanımı: `.glass-panel` `:224`, `.glass-card` `:235`, `.card-glass` `:576`, `.bv-glass` `:875`, tokenlar `--bv-glass-bg` `rgba(15,18,25,0.6)` `:793`, açıkta `rgba(255,255,255,0.72)` `:839`; çekmece örtüsü `blur(4px)` `packages/ui/app/AuthLayout.tsx:76-77`; toplam 28 dosyada backdrop-filter.
- Koyu tema varsayılan: `packages/ui/app/layout.tsx:260` (`className="dark"`).

### 1.4 Veri / iş sözleşmesi
- Web `Run`/`Approval` tiplerini `any` kullanır (`packages/ui/lib/api.ts:385-386`, `:509`); `Job`/`Receipt` kavramı yüzeyde yok (`/runs/:id/receipt` çağrısı yok: `grep -n receipt packages/ui/lib/api.ts` boş). 04a–04d tipleri (`InboxBucket`, `JobReceipt`) web'de kullanılmaz; yalnız vitest takma adı `@ai-company-os/core` var (`packages/ui/vitest.config.mjs:6`).
- Onay çağrısı `POST /approvals/:id/decide` (`packages/ui/lib/api.ts:389-391`); liste `GET /approvals?status=` (`:385-386`), yani 04b `limit/cursor/groupBy` kullanılmaz.

### 1.5 Onay akışı, 1.6 model ayarları
Bkz. 1.2. Onay tek adımlı: Onayla/Reddet (`approvals/page.tsx:205`, `:220`). Model: ayarlarda tenant düzeyi sağlayıcı+anahtar (`settings/page.tsx:408`), ajan düzeyi model (`companies/[id]/page.tsx:132`).

### 1.7 Erişilebilirlik
- Odak halkası `globals.css:716-722`; `.bv-btn:focus-visible` `:1039`; azaltılmış hareket `@media` `:1375`, `:1421`, `:1451`.
- `aria-` geçen 52 / 110 tsx dosyası (`grep -rl "aria-" app components --include='*.tsx' | wc -l`).
- SkipLink `packages/ui/components/SkipLink.tsx:7` hedefi `#main-content`; hedef yalnız 4 yasal sayfada var (`privacy`, `terms`, `kvkk`, `cookies` `page.tsx`); ürün sayfalarında hedef yok (`grep -rln 'id="main-content"'`).
- Kontrast: ölçülmedi, doğrulanamadı (ipucundaki 3.68 hesaplanmış, yeniden hesaplanmadı).

### 1.8 i18n
- 14 dil: `packages/ui/i18n/locales.ts:2` (tr, en, es-419, pt-BR, de, fr, ja, ar, it, ko, id, pl, hi, zh-Hans); RTL yalnız `ar`: `packages/ui/app/layout.tsx:259`. Fiziksel yön sınıfları 18 tsx dosyasında (`grep -rlE "\b(ml|mr|pl|pr)-[0-9]|marginLeft|marginRight|…"`).
- PWA manifest / service worker yok (`find` boş).

### 1.9 Testler
- ui: 17 test dosyası; vitest yalnız `lib/**` ve `i18n/**` kapsar: `packages/ui/vitest.config.mjs:9`. `app/` ve `components/` birim testsiz. Playwright e2e 11 spec (`e2e/*.spec.ts`: approval, billing, onboarding-first-run, smoke …). axe/Lighthouse kurulumu bulunamadı (`grep -rn "axe\|lighthouse" package.json e2e` boş).

## 2. Desktop (Tauri v2, origin/main `ad6867a`, sürüm 1.1.0)

Kaynak: `git archive origin/main`; satır numaraları bu arşivdendir (ipucu dosyasındaki numaralar kaymıştı; `desktop/src/ui.ts` 2940 satır: `wc -l`).
- Ekranlar/navigasyon: vanilla DOM; giriş `desktop/src/ui.ts:351` (`renderLogin`), çalışma alanı `:505` (`renderWorkspace`), sağ inspector (Inspector | Activity sekmeleri) `:967-970`, onay modalı `:2362`, anahtarlar `:2503`, MCP `:2690`. React yalnız şirket paneli: `desktop/src/company-panel/` (mount dosyasının satırı doğrulanamadı). Çoklu model karşılaştırma `/research/*` ile: `desktop/src/client.ts:336`, `:350`, `:441` (cascade).
- Çalışan akışlar: yerel eylem kapısı `gateAction` `desktop/src/ui.ts:2279` (karar `deny` / `require-approval` → modal `:2362`); çalıştırma noktaları `:1750`, `:1906`, `:1936`; yerel/sunucu dağıtımı. Şirket listesi/duraklat/sürdür `desktop/src/client.ts:491`, `:512`, `:526`; zamanlanmış pipeline `:503`; hafıza `:481`; tasarruf raporu `:465`; giriş `:283`, profil `:325`; relay `desktop/src/relay-transport.ts:138`.
- Veri/iş sözleşmesi: Job/Run/Approval için platform sözleşmesi kullanılmaz: `client.ts` içinde `/runs` ve `/approvals` çağrısı yok (`grep -n '/approvals\|/runs' desktop/src/client.ts` yalnız yorumda); onay kaydı yerel ledger (`desktop/src/governance.ts`, Rust tarafı aynı politika). 04a–04d tipleri kullanılmaz; çekirdek paket bağımlılığı yok (`desktop/package.json` içinde `@ai-company-os/core` yok).
- Onay akışı: çift onay vardır. UI modalı (`desktop/src/ui.ts:2362`, `gateAction` `:2279`) onaylandıktan sonra Rust `approve_action` (`desktop/src-tauri/src/lib.rs:1424`) ikinci kez yerel iletişim kutusu açar: `native_confirm` çağrısı `lib.rs:1445`, tanım `:1497`. Güvenlik politikası kopyası: `desktop/src/governance.ts:97` (TS) ve `desktop/src-tauri/src/lib.rs:718-720` (Rust "require-approval" kararları); iki kopya arasında eşitlik testi doğrulanamadı. Platform `approvals` ile eşleme yok.
- Model/sağlayıcı: anahtarlar `desktop/src/ui.ts:2503` (`keyvault.ts`), MCP `:2690`; BYOK kasası yerel.
- Tasarım sistemi (yalnız kayıt): `desktop/src/styles.css:2-10` açıklaması "obsidian kimliği, yeşil yok": obsidian `#0A0B0F`, arc-blue `#3B82F6/#60A5FA`, ember `#F97316` (çalışıyor), molten `#FF4D4D` (hata), metrikler JetBrains Mono; token `--ember: #f97316` `:18`; açık tema `:45`; tek `backdrop-filter: blur(3px)` onay örtüsünde `:950`; `prefers-reduced-motion` `:456`, `:1926`.
- Erişilebilirlik: `aria-` geçen 39 satır `desktop/src/ui.ts` (`grep -c "aria-"`); kontrast/ekran okuyucu ölçülmedi: doğrulanamadı.
- i18n: 14 dil `desktop/src/i18n-extra.ts:2`, `:40` (README "sekiz" derse 8 yalnız `BASE_LANGUAGES`; README satırı okunmadı).
- Testler: `find src -name '*.test.ts*'` 53 dosya (`desktop/src/__tests__/`, `contract.test.ts` dahil); Rust `grep -rn "#\[test\]" src-tauri/src | wc -l` 172.
- Yayın: `desktop/package.json` ve `tauri.conf.json` 1.1.0; `desktop/CHANGELOG.md:12` `[Unreleased]`; Windows imzasız (`NotSigned`, vault panosu `:19`, `:44`); CSP `connect-src 'self' https: …` `desktop/src-tauri/tauri.conf.json:28`.

## 3. CLI (origin/main `ed3692e`, sürüm 1.1.0)

- Komutlar/navigasyon: `COMMAND_HELP` 46 satır (`grep -c '^\["' cli/src/forge/help.ts` → 46; ipucu "43" yanlış), yardım `cli/src/forge/help.ts:5-50`; dağıtım `cli/src/braavo.ts` (2689 satır; `wc -l`). `ask`, `cascade`, `savings` (research/maliyet), `steer`, `approve`, `pause`, `stop`, `company approvals|task|budget` ve tetikleyici alt komutları (`cli/src/braavo.ts:1880-1884`).
- Çalışan akışlar: `runs` → `GET /dashboard/runs?limit=20` `cli/src/braavo.ts:1325`; `steer` → `POST /runs/:id/steer` `:1351-1357`; `approve` → `POST /approvals/:id/decide` `:2518-2526` (`--deny` → REJECTED, `--yes` onayı); `pause` `:2544`, `stop` `:2554`. Platformda onay LİSTE ucu çağrılmaz (`GET /approvals` yok); `company approvals` yerel daemon'a gider `cli/src/daemon/server.ts:420`.
- Veri sözleşmesi: Run/Approval için tür yok (serbest JSON); `status` okunur; 04a–04d kullanılmaz. Yerel daemon: onay `POST /approvals/:id` `cli/src/daemon/server.ts:424-430`, bütçe `WARN_AT = 0.8` `cli/src/daemon/budget.ts:15`, eşik denetimi `:64`.
- Onay akışı: `requireConfirmation` (`--yes`) ile yıkıcı komut onayı (`cli/src/braavo.ts:1356`, `:2523`); araç/risk ayrıntısı gösterilmez: doğrulanamadı (çıktı biçimi ayrıca okunmadı).
- Model/sağlayıcı: `--models PROVIDER/model,...` (`help.ts:9`), yerel Ollama `cli/src/forge/local.ts:4-8`.
- Tasarım/erişilebilirlik: `--json` tek JSON belge `cli/src/forge/output.ts:56-57`; `NO_COLOR` renk ve animasyonu kapatır `cli/src/forge/help.ts:67`; 14 dil `cli/src/forge/locale.ts:3`.
- Bağımlılıklar: `@anthropic-ai/sdk` ve `zod` (`cli/package.json:22-25`); "tek bağımlılık zod" iddiası README'de arandı, okunmadı (doğrulanamadı).
- Testler: `find . -name '*.test.ts' | wc -l` → 60 (ipucu 46 yanlış).
- Yayın: origin/main `package.json` 1.1.0; bayat yerel dal `feat/tasks-budget` 0.2.0 (bölüm 0); `v*` etiketi yalnız `v0.1.1`; npm doğrulanamadı. Slack/GitHub tetikleyici ayrı dallarda (`feat/slack-trigger`, `feat/github-trigger`, `git branch -a`); main'e girmedi (doğrulama: dal listesi).

## 4. Mobil (origin/main `5e60a75`, 1.1.0; `origin/release/1.1.1` `2a04e90`, 1.1.1)

- Ekranlar: 31 `.tsx` (`find app -name '*.tsx' | wc -l`); sekmeler `mobile/app/(tabs)/`: `index`, `workflows`, `approvals`, `companies`, `more`; yığın: `companies/[id]`, `workflows/[id]`, `drafts`, `risks`, `analytics`, `companion/*`, `runs/[id]`, `chat/index`, `settings` (`mobile/app/_layout.tsx:259-300`). Mobilde sohbet ekranı vardır (`mobile/app/chat/index.tsx`).
- Uçlar: `mobile/lib/api.ts`: `GET /dashboard/runs` `:1139`, `GET /approvals?status=` `:1276`, `POST /approvals/:id/decide` `:1286`, `POST /runs/:id/steer` `:1243`; `bucket` ve `/receipt` kullanılmaz (`grep -n "bucket\|/receipt" mobile/lib/api.ts` boş). 04a–04d tipleri kullanılmaz.
- Veri sözleşmesi uyumsuzluğu: mobil `Approval` tipi `companyId`, `pipelineRunId`, `reason`, `costUsd`, `payload` bekler (`mobile/lib/api.ts:997-1008`) ve ekran `approval.reason` / `costUsd` okur (`mobile/app/(tabs)/approvals.tsx:124`, `:247`); platform `Approval` modeli `runId`, `description`, `amountUsd`, `metadata` taşır (`packages/db/prisma/schema.prisma`, `model Approval`, sütunlar `description`, `amount_usd`, `metadata`). Alan adları eşleşmez; bu uyumsuzluğun canlı yanıtta etkisi çalıştırılarak doğrulanamadı (statik okuma).
- Onay akışı: `mobile/app/(tabs)/approvals.tsx`; ret/onay + steer + kill mock'ta test edilemiyor yorumu `mobile/lib/api.ts:492`; çevrimdışı yönlendirme `:1357-1363`.
- Dikte: `expo-speech-recognition` hem main hem release/1.1.1 `package.json:47`'de; kod `mobile/lib/voice.ts:77`; yani dikte main'dedir (ipucundaki "doğrulanamadı" kapandı); mağazada yalnız Android Alpha 1.1.1 vault panosuna göre.
- Tasarım (kayıt): `mobile/lib/palette-primitives.json` açık: canvas `#faf9f6`, surface `#fffefa`, ink `#262724`, accent `#4e6793`, warm `#8f5a3b` (`:3-10`); koyu: canvas `#232420`, surface `#2a2b27`, ink `#edeee6`, muted `#a6a79d` (`:17-22`). `BlurView`/`expo-blur` kullanımı yok (`grep -rln "BlurView\|expo-blur"` boş): glass bulanıklık yok.
- Erişilebilirlik: `accessibilityLabel/Role` 41 dosya; `useReducedMotion`/`reduceMotionEnabled` 23 dosya (`grep -rl … | wc -l`); `allowFontScaling` bulunamadı (doğrulanamadı).
- i18n: 14 dil `mobile/lib/localeRegistry.ts:2`.
- Testler: 101 `*.test.ts(x)` (`find`); lint = `tsc --noEmit` `mobile/package.json:16`, test `vitest run` `:17`.
- Sürüm: main `app.json` 1.1.0 (`mobile/app.json:5`), release/1.1.1 `app.json:5` 1.1.1 (`git show`); versionCode kaynağı EAS remote (`mobile/eas.json:4`, `:38`), `android/` gitignore'da (bölüm 0). Gerçek yayın: iOS 1.1.0 satışta; Android Alpha 1.1.1 (vault panosu `:15-16`).

## 5. Platform API ve sözleşme katmanı (`95872d1`)

### 5.1 Rotalar
`/api/v1` altında: `/runs` `packages/api/src/index.ts:293`, `/jobs` `:294`, `/approvals` `:299`, `/agents` `:331`, `/settings` `:330`, `/integrations` `:329`, `/companies` `:291`, `/pipelines` `:292`, `/dashboard` `:302`. Chat/models/agents için ayrı sohbet rotası yok (`ls packages/api/src/modules` içinde `chat` yok).
- Koşu rotaları `packages/api/src/modules/run/router.ts`: `GET /` `:86` (`?bucket`, `?limit`, `?cursor`; dar `select` `:107-121`; yanıt `{runs, nextCursor}` `:137`), `GET /:id` `:142` (ham koşu + adımlar + onaylar `:146-153`), stop `:288`, pause `:330`, resume `:361`, retry `:431`, handoff `:540`, continue `:632`, handoffs `:789`, steer `:816`, stream `:867`, adım rollback `:1033`, rerun `:1064`, receipt `:1145`.
- Onaylar `packages/api/src/modules/approval/router.ts`: `GET /` `:87` (parametresiz düz dizi, `limit/cursor/groupBy=run` ile sayfalı `:82-86`; satır `run→pipeline→company` içerir `:106-108`), `POST /:id/decide` `:247` (`approval:decide` izni).
- Plan kartı `POST /jobs/plan` `packages/api/src/modules/jobs/router.ts:30`: sohbet ise `{intent:"chat"}` `:42-45`; plan adımlarında `needsApproval`/`risk` `packages/api/src/modules/jobs/plan.ts:29`, `:302-310`.
- `POST /jobs/start` (03b) bu SHA'da yok: açık PR #123, başı `01fe1ea7ae71012e10bf29b3aa176107df33b1b1`, `gh pr view 123` durumu OPEN (2026-11-09); `grep -rn "jobs/start" packages` boş. Vault backlog bilet adı `POST /jobs/plan/:id/start` (`10 Holding/📋 YULA İcra Backlog.md:138`).

### 5.2 Sözleşme tipleri
- `packages/core/src/types/job.ts`: `JOB_STATES` `:10`, `RESULT_STATUSES` `:24`, `JobReceipt` `:48`, `INBOX_BUCKETS` `:62`, `STATE_BUCKET` `:76`, `jobBucket()` `:129` (state kazanır, bilinmeyen → stuck `:135-139`, bayat heartbeat → stuck `:153`). ADR-0003: `docs/yula-execution/DECISIONS.md:161-176`. Veritabanı enumları: `RunStatus` `packages/db/prisma/schema.prisma:1771` (7 değer, donmuş, ADR-0001), `JobState` `:1783`, `ApprovalStatus` `:1862`.
- 04a (tipler/kova), 04b (`GET /runs?bucket`, `/approvals` sayfa/grup), 04c (`GET /runs/:id/receipt` `run/router.ts:1145`), 04d (heartbeat `run/heartbeat.ts:8`, `POST /runs/:id/retry` `:431`) main'dedir (backlog `:133-136`). Hiçbiri web/desktop/CLI/mobil tarafından kullanılmıyor (bölüm 6).

### 5.3 Bayraklar ve zorlama
- `JOB_STATE_DUAL_WRITE` yalnız literal "true" ile açılır `packages/api/src/modules/run/transition.ts:57`; kapalıyken heartbeat sorgusu yok `run/heartbeat.ts:8`, retry `retry_disabled` (`docs/yula-execution/DECISIONS.md:189-198`). `EXACT_ACTION_APPROVAL` `packages/api/src/modules/approval/exact-action.ts:27`; kapalıyken SPEND damgası yok `packages/api/src/modules/agent/tool-executor.ts:478`. İkisi de varsayılan kapalı (ADR-0002, `docs/yula-execution/STATUS.md:201`); prod'da açık olduğu doğrulanamadı.
- Onay/risk zorlaması: araç kapısı `tool-executor.ts:439` (`requiresApprovalForAutonomy`, `registry.ts:63`); governance sıra `packages/api/src/modules/governance/engine.ts:52` (`job_budget` önce), durdurucular `:159-169`.
- 03d boşluğu: plan kartı `needsApproval` yalnız `jobs/plan.ts`'te var; yürütücüde yok (`grep -rn needsApproval packages/api/src` yalnız `jobs/plan.ts`); backlog `10 Holding/📋 YULA İcra Backlog.md:141` bileti READY ("`needsApproval` yürütücüde zorlanmıyor").
- Model/sağlayıcı: 14 sağlayıcı `schema.prisma:1962-1985` (enum), 55 model kimliği `packages/api/src/services/ai-client.ts:237-251` (ANTHROPIC `:238`); sağlayıcı tenant ayarından seçilir `packages/api/src/modules/jobs/router.ts:48-53`; otomatik yönlendirme bulunamadı.

## 6. Yüzeyler arası uyumsuzluk matrisi

| Kavram | Platform API | Web | Desktop | CLI | Mobil |
|---|---|---|---|---|---|
| Koşu durumu/kova | `status`(7)+`state`(10)+`bucket`(4) `run/router.ts:126-136` | yalnız `status`, 5 süzgeç `runs/page.tsx:188` | `/runs` çağrısı yok (yerel ledger) | `GET /dashboard/runs` `cli/src/braavo.ts:1325` | `/dashboard/runs` `mobile/lib/api.ts:1139`; bucket yok |
| Onay | `approval/router.ts:87`, decide `:247` | düz liste, tek adım `approvals/page.tsx:205` | UI modal + `native_confirm` çift onay `desktop/src-tauri/src/lib.rs:1445` | decide var `cli/src/braavo.ts:2524`, platform liste yok | `reason/costUsd/payload` bekler `mobile/lib/api.ts:997-1008`; API `description/amountUsd/metadata` |
| Maliyet | `Run.costUsd`, `job_budget` `engine.ts:52` | koşu detayında `runs/[id]/page.tsx:471`; onayda `amountUsd` `approvals/page.tsx:166` | `/billing/savings` `desktop/src/client.ts:465` | yerel aylık bütçe `cli/src/daemon/budget.ts:15` | `Approval.costUsd` alanı (API'de yok); diğer doğrulanamadı |
| Model seçimi | tenant `ai-config` + ajan `model` | ayarlar `settings/page.tsx:408`, ajan `companies/[id]/page.tsx:132` | yerel anahtar kasası `desktop/src/ui.ts:2503` | `--models`, Ollama `cli/src/forge/local.ts:4-8` | ayar ekranı `settings/`; doğrulanamadı |

## 7. Teknik sınırlar
- Migration'lar (`20261108000000_job_lifecycle`, `20261108010000_approval_exact_action`) hiçbir ortama uygulanmadı (`docs/yula-execution/STATUS.md:201`); `v*` etiketi yok; yeni durum alanları canlıda boş olabilir, bu yüzden kova eski `status`tan hesaplanır (`DECISIONS.md:161-176`).
- Web `/runs` yan menüde yok, 04b yanıtı web'de tüketilmez (1.2). Heartbeat yazarı bayrak kapalıyken çalışmaz (5.3).
- Hiyerarşik retry kapalı (`DECISIONS.md:182`). `Run` yanıtı ham satırdır `run/router.ts:159` (Company sırları SEC-01 ile temizlenir).

## 8. README ≠ kod

| # | İddia | Kaynak | Gerçek | Kanıt |
|---|---|---|---|---|
| 1 | "6 locale (en/tr/es/de/fr/ar)" | `CLAUDE.md:28`, `README.md:44` | 14 dil | `packages/ui/i18n/locales.ts:2` |
| 2 | "47 models" | `CLAUDE.md:54` | 58 Prisma modeli | `grep -c "^model " schema.prisma` |
| 3 | "650 tests passing" | `README.md:17`, `:150` | STATUS: 171 dosya / 2777 test (sonra 3128) | `docs/yula-execution/STATUS.md:87`; backlog `:135` |
| 4 | `GET /runs/:id` ham satır `run/router.ts:91` | `docs/yula-execution/STATUS.md:71` | rota `:142`; satır numarası eskimiş | `packages/api/src/modules/run/router.ts:142` |
| 5 | Web 4 kovalı gelen kutusu | 04b notu | web süzgeci `status` tabanlı | `packages/ui/app/runs/page.tsx:188` |
| 6 | Desktop "sekiz dil" (README) | desktop README (okunmadı) | 14 dil | `desktop/src/i18n-extra.ts:40` (README satırı doğrulanamadı) |
| 7 | CLI "zod tek runtime bağımlılığı" | cli README (okunmadı) | `@anthropic-ai/sdk` da var | `cli/package.json:22-25` |
| 8 | CLI sürüm 0.2.0 | yerel dal `cli/package.json:3` | origin/main 1.1.0 | `git show origin/main:package.json` |
| 9 | Mobilde dikte yok / yalnız izin | ipucu | `expo-speech-recognition` main'de | `mobile/package.json:47`, `mobile/lib/voice.ts:77` |

## 9. Gerçek yayın durumu

| Yüzey | Durum | Kaynak |
|---|---|---|
| iOS | 1.1.0 `READY_FOR_SALE` (ASC API, 2026-11-07) | vault `📊 Durum & Mağaza Panosu.md:15` |
| Android | Alpha 1.1.1 (versionCode 30) canlı, kapalı test | aynı pano `:16`; depoda versionCode doğrulanamadı |
| Desktop | main `ad6867a`, Windows 1.1.0 kabulü, imzasız | aynı pano `:19`, `:44` |
| CLI | 1.1.0 npm `latest` (pano), main `ed3692e` | aynı pano `:18`; npm bu denetimde okunmadı: doğrulanamadı |
| Platform canlı | main `95872d1`; canlı `f3f7532` (2026-11-02, doğrula) | pano `:17` eski; `STATUS.md:205` "migration uygulanmadı, `v*` yok" |

## 10. Ekran görüntüleri

Web: BURAYA EKLENECEK
Desktop: BURAYA EKLENECEK
CLI: BURAYA EKLENECEK
Mobil: BURAYA EKLENECEK
