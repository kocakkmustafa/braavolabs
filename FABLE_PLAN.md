# 🗺️ Braavolabs — Site-Özel Yüzey Yol Haritası (Fable)

> Bu, app+site birleşik yol haritasının site-özel kesitidir. Tam koordineli plan: `ventures/braavolabs/mobile/FABLE_PLAN.md`.
>
> Üretim tarihi: 2026-07-08 · Üreten: Fable (claude-fable-5), salt-okunur keşif (web monorepo envanter ajanı).
> **Bu bir uygulama oturumu DEĞİL** — düzeltmeler ayrı oturumda kullanıcı tarafından başlatılacak. Burada yalnızca teşhis + öncelikli görev listesi + doğrulama planı var.

## ⚠️ v2 Programı ile Koordinasyon (site-ilgili örtüşmeler — ÖNCE OKU)

Braavolabs'ın aktif çok-oturumlu bir **v2 programı** var (`ventures/braavolabs/workspace/`), şu an **"Forge — vibe-coding çok-model komuta merkezi"** yönüne pivot etmiş durumda. v2 çalışmalarını `~/braavolabs-worktrees/` altında yürütüyor — ana checkout'ta DEĞİL. Bu roadmap v2'nin yol haritasını TEKRAR YAZMAZ; yalnızca mevcut site yüzeyinin sağlık/güvenlik/cila durumunu çıkarır. **Örtüşen kalemler her görevde açıkça işaretlenmiştir; birleştirme kararı kullanıcıya bırakılmıştır.**

Bilinen site-ilgili örtüşmeler:
- **RLS/tenant sertleştirme** → v2 E9 kapsamında zaten kayıtlı (D-007 dahil). Aşağıdaki DI-2/SEC-1 bunlarla örtüşür.
- **Web token localStorage → httpOnly** → v2 D-007 = E9 kalemi. SEC-1 ile aynı.
- **Forge UI cilası / "yeşil yok" ihlalleri** → v2 D-014 ("chip-dışı UI yeşilleri → Forge cilası") ile örtüşür. DS-1/DS-2 ile aynı aile.
- **Hero-scroll + marka kimliği (coin/maskot)** → v2 marka kapısı (`brand-identity-ui-brief.md`), kullanıcının coin görsellerini vermesini bekliyor. **Bu bağımsız yapılacak iş DEĞİL — v2-sahipli design-gate.** Aşağıda yalnızca "durum" olarak not edildi.

---

## 🌐 BÖLÜM B — Site Bulguları (`ventures/braavolabs/platform`)

**Genel durum:** Web prod CANLI (E0-E5 deploy'lı). Monorepo: api(140 dosya), ui(138), db(42, 47 model/36 migration), integrations(34), core(28), memory(13), cli(5). ~253 endpoint / 33 router. Kod disiplini yüksek; app-layer tenant scoping tutarlı. **Ama ana checkout BAYAT.**

**B0 — [WORKSPACE, P1] Ana checkout 37 commit geride + worktree dallarını hiç fetch etmemiş.** `git status`: `main`, temiz, `origin/main`'in **37 commit gerisinde**. `feat/e8-offline`/`feat/expo-54-upgrade` dalları ana checkout'un `git branch -a` çıktısında YOK. `connector-sdk` paketi ana checkout'ta YOK (yalnız `feat/e5-connector` worktree'sinde). **Sonuç: bu klasördeki kod prod'u/güncel origin/main'i temsil ETMİYOR.** Herhangi bir düzeltme/doğrulama ya origin/main'e senkronlanmış taze checkout'ta ya da güncel worktree'de yapılmalı — yoksa bayat koda karşı çalışılır.

**B1 — [VERİ-YALITIMI, P0-teşhis] Postgres RLS pratikte ETKİSİZ (fail-open).** Üç bağımsız, geliştiricinin kendi dokümantasyonuyla doğrulanmış sebep:
1. **Pool uyumsuzluğu:** `middleware/auth.ts:48` `set_config('app.tenant_id', ..., false)` (session-scoped) set ediyor; Prisma connection pool'da bu SET ile asıl sorgu FARKLI pooled connection'lara düşebiliyor → `current_tenant_id()` sorgu bağlantısında sık NULL → policy `USING (current_tenant_id() IS NULL OR ...)` fail-open'a düşüyor (`docs/security/tenant-rls-extend.sql:46-57`). Gerçek fix (AsyncLocalStorage + Prisma `$extends` query-hook + transaction-local `set_config(...,true)`) **implemente edilmemiş** (`packages/api/src/lib/db.ts` düz PrismaClient, `$extends` grep = 0).
2. **Superuser bypass:** RLS superuser için tümden bypass edilir (`20260616000000_tenant_rls/migration.sql:15`). Prod `DATABASE_URL` `aicos` rolünü kullanıyor = `POSTGRES_USER` = initdb superuser (`ENV/compose.prod.yaml:11-13,87`). Önerilen non-superuser `braavolabs_app` rolü **kurulmamış**. → Prod'da RLS baştan bypass.
3. **`tenant_rls_extend` uygulanmamış:** Bu bir Prisma migration DEĞİL — yalnız `docs/security/tenant-rls-extend.sql` (273 satır, ~25 tablo), CI'nın otomatik uygulamaması için KASITLI dışarıda; operatör elle `psql -f` çalıştırmalı. **Hiç atılmamış görünüyor.** CLAUDE.md'nin "tenant_rls (8) + tenant_rls_extend (kalan)" ifadesi yanıltıcı.

**Kritik yorum:** Gerçekten çalışan TEK izolasyon garantisi = uygulama katmanı `where tenantId` / `company.tenantId` kontrolleri. "Defense-in-depth RLS" isim dışında yok. Bu, kod-inceleme tutarlı olsa da (aşağı) otomatik ağ olmadan tek bir eksik where-clause'un sızıntı yaratabileceği anlamına gelir. **Karar gerekiyor (Bölüm D-2).**

**B2 — [VERİ-YALITIMI, pozitif] App-layer scoping tutarlı ve titiz.** JWT: `AuthPayload {userId, tenantId, role}` (`middleware/auth.ts:6-10`), HS256 pinli (`:35`, alg-confusion kapalı). Prisma merkezî extension YOK → her route elle guard ediyor, iki tutarlı desenle: (a) doğrudan `tenantId` filtresi (`research/research.router.ts:83`); (b) `findUnique + include company + company.tenantId !== auth.tenantId` (`pipeline/router.ts:278,335,388,402,462,517,594`; `run/router.ts` 6 nokta; `approval/router.ts:110-116`; `draft/router.ts:186-190,216-220`; `memory/router.ts:131-137`; `outreach/router.ts:78-84,172-178,192-198`; `governance/router.ts:53-60`). Taranan 35 `findUnique/findFirst`'te eksik-scoping BULUNAMADI. Geçmiş `48af655` denetimi ("app-layer izolasyon airtight, 0 sızıntı", 9-ajan ikinci geçiş) izleri kodda mevcut (ör. `outreach/router.ts:87-99` CRIT-2 fix).

**B3 — [GÜVENLİK, P1] Web token localStorage'da (D-007).** `packages/ui/lib/store.ts:16-33` Zustand persist, custom storage YOK → varsayılan `window.localStorage`, `name:"aicos-auth"` altında HEM access HEM refresh token düz metin JSON. XSS ile exfil edilebilir; httpOnly cookie değil. (Backend refresh token'ları Redis allowlist ile iptal edilebilir ama istemci depolama hâlâ localStorage.) **v2 D-007/E9 ile örtüşür.**

**B4 — [TENANT, İZLE] Bilinçli gevşetme.** `outreach/router.ts:104` yorum: "same tenant, not just same company... for now we accept". Şirket-değil-tenant seviyesinde bir kısıt gevşetmesi. Gelecekte sıkılaştırma noktası — kasıtlı, ama doğrulama sırasında teyit edilmeli.

**B5 — [TASARIM, P2] Forge "yeşil yok" kuralı İHLALLERİ (3 dosya).** `app/login/page.tsx:122` password-strength'te `bg-emerald-500`; `components/StarterPicker.tsx:163` spinner `border-emerald-300`; `components/TrialBanner.tsx:109,113,119,122,132` banner'ın tamamı `emerald-*`. Bu dosyalar Forge paletini bypass edip çıplak Tailwind emerald kullanıyor. **v2 D-014 ile örtüşür.**

**B6 — [TASARIM] Forge token sistemi tutarsız/düşük-benimseme.** `globals.css:750-830` "arc-blue/ember" söylemi var ama gerçek token'lar `--bv-cobalt-*` (mavi) ve isimsiz turuncu `--bv-status-running:#FF7A1A`; "ember" adında token YOK. `bv-*` benimsemesi düşük (11/103 dosya). Bazı public sayfalar hiç `bv-` kullanmıyor: `app/cookies/page.tsx`, `app/reset-password/page.tsx`, `app/errors/page.tsx`. **v2 Forge cilası ile örtüşür.**

**B7 — [GÜVENLİK, temiz] ENV/ + sır hijyeni TEMİZ.** `ENV/` yalnız config (Dockerfile.api/ui, compose.yaml/prod, devcontainer, nginx) — hepsi `${VAR}` interpolasyonu, gerçek değer YOK. `.env` untracked + `.gitignore:12-14`'te + mod 600. `.env.example` 87 placeholder (boş). Git geçmişi: `.env`/`*.pem`/`*.key`/`*.p8`/`*service-account*` **hiçbir commit'te repo ağacına girmemiş** (read-only tüm-ref taraması). Repo GitHub'da **PRIVATE**. **Sır sızıntısı bulunamadı** — ama otomatik guard yok (bkz. SEC-2).

**B8 — [BAKIM] Kullanımdan kaldırılmış şifreleme fonksiyonu.** `packages/api/src/lib/encryption.ts:160` `@deprecated Prefer encryptForTenant` — eski fonksiyon hâlâ kod tabanında, migrasyon planı belirsiz.

**B9 — [DOKÜMAN DRIFT] Bayat/yanıltıcı dokümanlar.** README test badge'i `133 passing` (`README.md:16`) ama repo geçmişi bile 160→193 diyor. CLAUDE.md RLS ifadesi yanıltıcı (B1). CLAUDE.md repo-layout'ta connector-sdk yok.

**B10 — [MİMARİ NOT] SEO: i18n URL-prefix'siz.** `i18n/request.ts:6-12` — locale `NEXT_LOCALE` cookie + `Accept-Language` ile çözülüyor, `/en/`, `/tr/` path YOK ("defer until SEO need is clear"). Çok-dilli içeriğin dile-özgü indekslenmesini zorlaştıran bilinçli tercih. SEO fırsatı/riski — karar noktası.

**B11 — [DURUM] Hero-scroll GSAP/Lenis YOK.** Ana repo + tüm worktree'lerde `gsap`/`lenis` yok; landing hafif elle-yazılmış `useReveal` (IntersectionObserver) kullanıyor. **Bu bir boşluk DEĞİL** — v2 hero-prototipi ayrı (`ventures/braavolabs/workspace/hero-prototype/`, GSAP+Lenis) ve web-app entegrasyonu v2 marka-kapısında (kullanıcının coin görselleri bekleniyor). v2-sahipli.

---

## ✅ BÖLÜM C — Öncelik Sıralı Site Görevleri

Ana plandaki Bölüm C'den SİTE ve HER-İKİSİ (site kapsamını da içeren) etiketli görevler. Her görev: **[OPUS]/[SONNET]** model etiketi + yüzey etiketi + v2 örtüşme notu.

### P0 — Veri-yalıtımı doğrulama & karar
- **DI-1 [OPUS] · HER-İKİSİ · Cross-tenant IDOR doğrulama harness'i (TASARIM + PLAN).** İki test tenant'ıyla tüm "bir-hop" kaynaklarda (pipelines, runs, run-steps, approvals, drafts, memory, outreach contacts/enrollments, companies, agents, integrations, webhooks, ab-tests, exports, analytics) sistematik IDOR taraması tasarla. Hedef: origin/main deployed kod (bayat checkout DEĞİL, B0). Bu oturumda YALNIZCA plan; yürütme ayrı oturumda. *Örtüşme: v2 E9/E10 test.*
- **DI-2 [OPUS] · SİTE · RLS kararı + (seçilirse) sertleştirme.** İki yol: (a) RLS'i GERÇEK yap = non-superuser `braavolabs_app` rolü + AsyncLocalStorage + Prisma `$extends` transaction-local GUC + `tenant_rls_extend` uygula; VEYA (b) "defense-in-depth" iddiasını bırak, tek-katman app-layer'ı dürüstçe dokümante et + otomatik tenant-scope lint ekle. **Bu bir karar (D-2), sonra iş.** *Örtüşme: v2 E9 — birleştirme kararı kullanıcıya.*

### P1 — Yüksek (güvenlik + workspace)
- **SEC-1 [OPUS] · SİTE · Web token localStorage → httpOnly cookie.** (B3/D-007) `packages/ui/lib/store.ts:16-33`. *Örtüşme: v2 D-007/E9 — birleştir/ertele kararı kullanıcıya.*
- **WS-1 [SONNET] · HER-İKİSİ · Ana checkout senkron kararı + uygulama.** origin/main'e 37 commit senkron + worktree dallarını fetch (B0). **git pull = kullanıcı onayı gerektirir; v2 worktree'leriyle çakışmamak için koordine.** (D-5)
- **SEC-2 [SONNET] · HER-İKİSİ · Önleyici sır-tarama guard'ı.** ENV temiz (B7) ama otomatik ağ yok → `gitleaks`/pre-commit + CI secret-scan ekle (her iki repo).

### P2 — Cila & fonksiyonel
- **FN-1 [SONNET] · SİTE · `/devices/*` endpoint doğrulaması.** Mobil README: mobil, `/devices/push-token` + `/devices/notification-prefs` yoksa "fails open". api'de `device` modülü var görünüyor — varlığını + kontrat uyumunu doğrula; eksikse ekle.
- **DS-1 [SONNET] · SİTE · Forge "yeşil yok" ihlalleri.** `login/page.tsx:122`, `StarterPicker.tsx:163`, `TrialBanner.tsx:109-132` emerald→arc/cobalt (B5). *Örtüşme: v2 D-014.*
- **DS-2 [OPUS] · SİTE · Forge token sistemi konsolidasyonu.** İsim tutarlılığı (cobalt→arc, ember token ekle), `bv-*` benimseme artışı, çıplak public sayfalar (B6). *Örtüşme: v2 Forge cilası/D-014 — birleştirme kullanıcıya.*
- **FN-3 [SONNET] · SİTE · `encryption.ts:160` deprecated fonksiyon migrasyon planı.** (B8)

### P3 — Doküman & temizlik
- **WS-2 [SONNET] · HER-İKİSİ · Doküman drift düzeltmeleri.** README test badge, CLAUDE.md RLS ifadesi (B1'e göre dürüstleştir), connector-sdk repo-layout (B9).
- **WS-3 [SONNET] · HER-İKİSİ · Merge'lenmiş yerel dalları sil.** (web yerel dallar).
- **DI-4 [OPUS] · SİTE · `outreach/router.ts:104` gevşetmesini gözden geçir.** Tenant-değil-şirket kısıt kararı (B4).

### Karar-gerektiren / v2-sahipli (bağımsız iş DEĞİL)
- **Hero-scroll + marka kimliği (coin/maskot)** → v2 marka-kapısı, kullanıcının coin görsellerini bekliyor. Yalnız durum. (B11)
- **SEO i18n URL-prefix** (B10) → ayrı SEO kararı.

---

## 🎯 BÖLÜM D — Kullanıcıya Sorulacak Kararlar (site-ilgili)

1. **İkinci test tenant'ı:** Cross-tenant IDOR testi için Tenant A = `appreview@braavolabs.com` (mevcut demo, Helio Skincare). **Tenant B lazım** — yeni bir izole test hesabı/tenant oluşturulsun mu, kimlik bilgileri? (Doğrulama olmazsa yapılamaz.)
2. **RLS yönü:** (a) RLS'i gerçek yap (non-superuser rol + AsyncLocalStorage + $extends + extend-uygula — orta-büyük iş, prod DB rol değişimi) mi, yoksa (b) tek-katman app-layer'ı dürüstçe kabul et + otomatik tenant-scope lint + dokümanı düzelt mi? **v2 E9 ile örtüşüyor — orada mı yapılsın, bağımsız güvenlik-turu mu?**
3. **Web token depolama:** httpOnly cookie'ye ŞİMDİ mi taşınsın, v2 E9'a mı ertelensin?
4. **Forge cila (yeşil-fix + token konsolidasyon):** bağımsız hızlı-tur mu, v2 D-014 Forge-cilasına mı katılsın?
5. **Ana checkout senkronu:** 37-commit geri checkout origin/main'e pull edilsin mi (v2 worktree'leriyle çakışma riski gözetilerek)? Yoksa doğrulama/düzeltme taze worktree'de mi yapılsın?
6. **`outreach/router.ts:104` gevşetmesi:** tenant-içi-çapraz-şirket erişimi kasıtlı mı kalsın, sıkılaştırılsın mı?
7. **SEO i18n:** URL-prefix'li locale routing (`app/[locale]/`) eklensin mi, mevcut cookie-tabanlı yaklaşım korunsun mu?

---

## 🏁 BÖLÜM E — Site İçin "Production-Ready" Tanımı

Web zaten canlı (prod). Buradaki "production-ready" = **sertleştirilmiş + doğrulanmış + tutarlı**:

- **Veri-yalıtımı:** İki test tenant'ıyla tüm bir-hop kaynaklarda cross-tenant IDOR = 403/404 (asla veri). RLS kararı verilmiş (gerçek katman VEYA dürüstçe tek-katman + lint).
- **Güvenlik:** Git'te sır yok (✓ zaten), otomatik sır-tarama guard'ı devrede, web token depolama kararı çözülmüş.
- **Fonksiyonel:** Ölü endpoint yok (`/devices/*` mevcut+kontrat-uyumlu).
- **Tasarım:** Forge paleti onurlandırılmış (yeşil sızıntısı yok), token sistemi tutarlı, app↔site marka tutarlı (marka-asset kapısı = v2).
- **Doküman:** CLAUDE.md/README doğru (yanıltıcı RLS/test iddiası yok).
- **Doğrulama:** Testler yeşil + adversarial yalıtım taraması geçmiş.

---

## 🧪 BÖLÜM F — Site Test / Doğrulama Senaryoları (özellikle veri-yalıtımı)

**Önemli:** Tüm doğrulama **origin/main deployed kod** üzerinde (bayat ana checkout değil, B0). Bu oturumda YALNIZCA plan — yürütme ayrı oturumda, kullanıcı test hesaplarını sağlayınca.

### F-1 Çok-kiracılılık / veri-yalıtımı senaryoları (EN KRİTİK)
İki izole tenant: **A** (`appreview@braavolabs.com`) + **B** (yeni test hesabı, D-1). Her ikisinde de birer kaynak seti oluştur (company, pipeline, run, draft, approval, memory item, outreach contact, webhook, ab-test).

1. **IDOR sweep (her bir-hop kaynak):** B olarak authenticate → A'nın kaynak ID'lerini GET/PATCH/DELETE dene → **beklenen 403/404, asla A'nın verisi.** Kapsam: `/pipelines/:id`, `/runs/:id`, `/run-steps/:id/{rollback,rerun}`, `/approvals/:id`, `/drafts/:id`, `/memory/:id`, `/companies/:id` (+export, +runs), `/agents/:id`, `/integrations/:id`, `/webhooks/:id`, `/ab-tests/:id`, `/analytics` (tenant-scoped mi?).
2. **Liste sızıntısı:** B'nin liste endpoint'leri (dashboard, companies, pipelines, runs, approvals, drafts) A'nın hiçbir kaydını döndürmemeli.
3. **Webhook izolasyonu:** A'nın slug'ına B-imzalı istek → reddedilmeli; cross-tenant slug çözümü yok (H1 fix); HMAC forgery + 5dk replay (H5 SETNX) hâlâ tutuyor mu.
4. **IAP cross-tenant hijack:** Saldırgan-seçimli `transactionId` ile başka tenant'ın planını değiştirme (C1 fix) hâlâ fail-closed mı.
5. **RLS gerçeklik probu:** App DB rolüyle bağlan, `SET app.tenant_id = A`, sonra B'nin satırlarını sorgula → **şu an SIZMASI beklenir** (fail-open + superuser, B1). Bu, "RLS gerçek katman değil"i KANITLAR → D-2 kararını besler. (Non-superuser rol kurulursa yeniden koş.)
6. **Token depolama:** Web localStorage (D-007) XSS exfil senaryosu belgele.

### F-2 Regresyon & sağlık
- api test suite yeşil (origin/main'de 523 test kayıtlı).
- Deploy sonrası health: `braavoolabs.com` 200 + `api.braavolabs.com/health` 200 `{status:ok}`.
- i18n parite: web 1282 leaf-key × 6 — CI'da parite check.

### F-3 Cila doğrulaması
- Forge palet taraması: `emerald|green|#00d1ff|cyan` grep = 0 (yeşil-fix sonrası).

---

## ⚠️ Riskler (site-ilgili)

1. **Bayat ana checkout (B0):** 37-commit geri kod üzerinde çalışmak = yanlış temel. Her iş origin/main'e senkron checkout/worktree'de yapılmalı. **En büyük operasyonel risk.**
2. **"Defense-in-depth RLS" kağıt üstünde (B1):** Yanlış güvenlik hissi. Tek gerçek katman app-layer; otomatik tenant-scope lint yok → gelecekteki tek bir eksik `where tenantId` sızıntı yaratır.
3. **Web token localStorage XSS (B3).**
4. **v2 çakışması:** Ana checkout'ta `packages/api`/`ui` düzeltmesi, `~/braavolabs-worktrees` altındaki aktif E-serisi işiyle çakışabilir. Koordine et; birleştirme kararlarını kullanıcıya bırak.
5. **Marka telif hassasiyeti:** GoT-esinli "Braavos/Yüzsüz-Adam" katmanı IP riski taşır; her asset üretimi v2 IP-güvenlik kapısından (`brand-identity-ui-brief.md` §7) geçmeli. Mevcut shipped asset (forge-iron-mask) temiz.
6. **Doküman drift (B9):** Yanıltıcı RLS/test iddiaları gelecekteki ajanları yanlış yönlendirir.
7. **Otomatik sır-guard yok (B7/SEC-2):** ENV şu an temiz ama pre-commit/CI taraması olmadan gelecekte kaza riski.
