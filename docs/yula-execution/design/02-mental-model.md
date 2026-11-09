# BRA-UX-01 · 02 — Kullanıcının zihinsel modeli (Aşama 2)

Tarih: 2026-11-09. Yalnız durum tespiti ve kullanıcı modeli; tasarım/konsept/renk önerisi yoktur. Atıflar `01-audit.md` bölümlerine (`01 §n`) ve koda gider; desktop/CLI/mobil atıfları ilgili depoların origin/main arşivinden doğrulanmıştır (01 §0).

Personalar: **P1 teknik olmayan birey** (iş tarif eder, sonucu ister), **P2 profesyonel/geliştirici** (model, araç, kod ve maliyet denetimi ister), **P3 şirket yöneticisi** (birden çok şirket, onay, harcama, risk).

Temel UX kararına (talimat §4.1) bağ: karmaşıklık başta gösterilmez, uzmandan hiçbir yetenek saklanmaz; bugün karmaşıklık "başta gösterilir" biçimindedir (girişli kullanıcıya 13 öğeli menü `packages/ui/components/Sidebar.tsx:15-28`); sohbet ve model yönetim ekranı yoktur, ajan yalnız şirket detayında doğal dille kurulur (`packages/ui/app/companies/[id]/page.tsx:195-227`; 01 §1.1-1.2).

## 1. Kullanıcı burada hangi sonuca ulaşmak istiyor?
- P1: bir işin yapılması (yazı, araştırma, otomasyon) ve sonucun teslimi. P2: kod/otomasyonun doğru ve denetlenebilir çıkması. P3: şirketin işlerinin ilerlediğini ve harcamanın sınırda kaldığını bilmek.
- Bugün sonuç ekranı yoktur: `Receipt` (iş makbuzu) API'de var (`packages/api/src/modules/run/router.ts:1145`) ama web'de çağrılmaz (01 §1.4). Sonuç, koşu detayında adım/araç listesi olarak okunur (`packages/ui/app/runs/[id]/page.tsx:671`).

## 2. Uygulamayı neden açıyor?
- (a) Bir iş başlatmak, (b) bir onay beklediği için, (c) bir işin durumuna bakmak.
- Web'de onay açmak için tek sinyal yan menü `/approvals` ve bildirim; liste `GET /approvals` düz dizidir (`packages/api/src/modules/approval/router.ts:87`). İş başlatma ise şirket kurma sihirbazı (`packages/ui/app/companies/new/page.tsx:361`) ya da pipeline çalıştırmadır (`packages/ui/app/pipelines/[id]/page.tsx:183`). Genel "iş tarif et" girişi API'de yalnız `POST /jobs/plan` (`packages/api/src/modules/jobs/router.ts:30`), UI'da yok (03c READY: backlog `:140`).

## 3. İlk 5 saniyede ne anlamalı?
- Girişten sonra ilk ekran `dashboard`: 4 KPI kartı (`packages/ui/app/dashboard/page.tsx:215-240`) ve son 12 koşu (`:117`). "Ne yapabilirim" cevabı verilmez; sohbet kutusu yok (01 §1.1).
- Olması gereken bilgi (durum tespiti açısından): bekleyen onay sayısı ve çalışan işler. Dashboard `listApprovals` çekiyor (`:118`) ama başlığın birincil öğesi KPI'dır.

## 4. En çok hangi ekrana geri dönecek?
- Onay ve iş listesi. Web'de iş listesi `/runs` yan menüde yoktur (01 §1.1: `Sidebar.tsx:14-28`, erişim `dashboard/page.tsx:434`); mobilde onay sekmesi vardır (`mobile/app/(tabs)/approvals.tsx`, `mobile/app/_layout.tsx:259-300`; 01 §4). Bu, "devam eden işi bulabilme" testinin (§4.4 #3) web'de başarısız olmasının nedenidir.

## 5. Sürekli tekrar ettiği işler
- Onayla/reddet (`packages/ui/app/approvals/page.tsx:205`, `:220`), koşuyu duraklat/sürdür/yönlendir (`packages/api/src/modules/run/router.ts:330`, `:361`, `:816`), başarısız işi yeniden dene (`:431`; bayrak kapalıyken `retry_disabled`, `docs/yula-execution/DECISIONS.md:189-198`), model/sağlayıcı seçimi (`packages/ui/app/settings/page.tsx:408`).

## 6. Hangi bilgiler otomatik gelebilir?
- Zaten sunucuda hesaplananlar: kova `jobBucket` (`packages/core/src/types/job.ts:129`), tahmini maliyet bandı ve risk (`packages/api/src/modules/jobs/plan.ts:29`, `jobs/router.ts:59-67`), tenant'ın sağlayıcısı/modeli (`jobs/router.ts:48-53`), plan adımlarındaki `needsApproval`/`risk` (`plan.ts:302-310`). Bunlar API'de otomatik hazırdır; web bunları kullanmaz (01 §1.4).

## 7. Ne zaman konuşmalı, ne zaman dokunmalı, ne zaman ayrıntı incelemeli?
- Konuşma: belirsiz/serbest talep (API `intent:"chat"` dalı `jobs/router.ts:42-45`); UI'da sohbet yok. Dokunma: onay/ret, duraklat/sürdür (tek dokunuşluk işlemler: `approvals/page.tsx:205`). Ayrıntı: adım, araç çağrısı, maliyet (`runs/[id]/page.tsx:645`, `:730`), handoff (`:411-416`). Bugün üç kip ayrışmamıştır: her şey sayfa+form (01 §1.2).

## 8. Hangi karmaşıklık gizlenebilir?
- 4 koşu kovası altındaki 10 `JobState` + 7 `RunStatus` ikilisi (`job.ts:10`, `schema.prisma:1771`, `:1783`): kullanıcıya kova yeter. Sağlayıcı/BYOK ve 14 sağlayıcı (`schema.prisma:1962`) başlangıçta gizlenebilir; onboarding tamamlanma adımında anahtar yoksa uyarı bandı ve "anahtar ekle" düğmesi gösteriyor (`packages/ui/app/onboarding/page.tsx:335-370`); Dashboard bağlantısı serbest (`:373`), yani BYOK engel değil ama P1'e öne çıkarılıyor. Webhook/pipeline/A-B testi menüde ilk seviyede (`Sidebar.tsx:25-26`).

## 9. Hangi kritik bilgiler asla gizlenmemeli?
Açık liste:
1. **Onay ayrıntısı:** işin ne yapacağı, hangi aracı/araç girdisini kullanacağı, tutar, taslak içerik. Bugün web yalnız açıklama + tutar + taslak (`approvals/page.tsx:161-197`); araç adı/risk/veri aktarımı yok. API ham satır dönüyor (`approval/router.ts:100-121`), alan mevcut ama gösterilmiyor.
2. **Maliyet:** harcanan ve öngörülen; iş bütçesi ve sınır aşımı (`packages/api/src/modules/governance/engine.ts:52`, ADR-0002 `docs/yula-execution/DECISIONS.md:95-137`).
3. **Risk/yetki:** ajan özerkliği (`packages/ui/app/companies/[id]/page.tsx:164-176`), araç onay kapısı (`packages/api/src/modules/agent/tool-executor.ts:439`), risk durdurucular (`engine.ts:159-169`).
4. **Hata:** bugün web onay listesi hatayı yutuyor (`approvals/page.tsx:36`, `runs/page.tsx:64`).
5. **Gerçek çalışma durumu:** takılı iş (bayat heartbeat → `stuck`, `job.ts:153`), doğrulanmamış sonuç (`UNVERIFIED`, `job.ts:24`); web yalnız `status` gösterir (`runs/page.tsx:188`).

## §4.2 A–J alanlarının bugünkü karşılığı

Anahtar: var / kısmi / yok. Desktop/CLI/mobil hücreleri 01 §2-4'teki statik okumaya dayanır; çalıştırılarak denenmedi.

| Alan | Web | Desktop | CLI | Mobil | Kanıt |
|---|---|---|---|---|---|
| A Niyet alanı | kısmi (şirket sihirbazı) | yok (yerel eylem kapısı; niyet girişi doğrulanamadı) | kısmi (`ask`, `cli/src/forge/help.ts:9`) | kısmi (`mobile/app/chat/index.tsx`) | `packages/ui/app/companies/new/page.tsx:361`; API `jobs/router.ts:30` |
| B Birleşik çalışma alanı | yok (ayrı sayfalar) | kısmi (`desktop/src/ui.ts:505` çalışma alanı + inspector `:967`) | yok | yok | 01 §1.1 |
| C İşler/görev yönetimi | kısmi (`status` süzgeç) | kısmi (şirket duraklat/sürdür `desktop/src/client.ts:512`) | kısmi (`runs`, `cli/src/braavo.ts:1325`) | kısmi (`mobile/lib/api.ts:1139`) | `runs/page.tsx:56`, `:188` |
| D Kaputu aç | kısmi (adım/araç listesi) | kısmi (inspector `desktop/src/ui.ts:967`) | kısmi (`--json` `cli/src/forge/output.ts:56`) | kısmi (`mobile/app/runs/[id].tsx`; adım ayrıntısı doğrulanamadı) | `runs/[id]/page.tsx:671` |
| E Kod geliştirme | yok | kısmi (`desktop/src/pty.ts`, `computer-pane.ts`) | doğrulanamadı | yok | 01 §1.1 |
| F Şirketler/ekip | var (liste+detay+sekmeler) | kısmi (`desktop/src/client.ts:491`) | kısmi (`company` komutları `cli/src/braavo.ts:1880`) | var (`mobile/app/(tabs)/companies.tsx`) | `companies/[id]/page.tsx:26` |
| G AI ajanları | kısmi (doğal dille kurma `companies/[id]/page.tsx:195-227`, model, özerklik; klasik oluşturma/silme/rollback/NL düzenleme UI'sı yok) | doğrulanamadı | kısmi (`agent` yalnız listeler, `cli/src/forge/help.ts:50`) | yok (`mobile/lib/api.ts`'te agent oluşturma ucu yok) | `companies/[id]/page.tsx:132`, `:164`, `:203`; `lib/api.ts:623` |
| H Model/bağlantı | kısmi (tenant model, BYOK, compare) | kısmi (anahtarlar `desktop/src/ui.ts:2503`, compare `client.ts:336`) | kısmi (`--models`, Ollama `cli/src/forge/local.ts:4-8`) | kısmi (`mobile/app/settings/`) | `settings/page.tsx:408`; `ComparePanel.tsx:58` |
| I Onay/güvenlik merkezi | kısmi (tek adım, ayrıntı eksik) | kısmi (çift onay `desktop/src-tauri/src/lib.rs:1445`) | kısmi (`cli/src/braavo.ts:2524`) | kısmi (alan uyumsuz `mobile/lib/api.ts:997-1008`) | `approvals/page.tsx:166-220`; 01 §6 |
| J Mobil | — | — | — | kısmi (onay+steer+companion var; iş başlatma ekranı doğrulanamadı) | `mobile/lib/api.ts:1243` |

## §4.3 İstenmeyenlerin bugünkü varlığı

1. Çok KPI'lı SaaS dashboard: **var** — 4 KPI kartı + sparkline (`packages/ui/app/dashboard/page.tsx:215-240`).
2. Her şeyi sohbet kutusuna hapsetmek: **yok** (web'de sohbet de yok).
3. Ajan/şirket/görev/proje karışması: **kısmi var** — Company/Workspace/Pipeline ortak adlandırma ve "workspaces" menü etiketi `Sidebar.tsx:17`; `workspaceId = companyId` (ADR-0001 `docs/yula-execution/DECISIONS.md:37`).
4. API/workflow ayarlarını P1'e zorunlu göstermek: **var** — BYOK uyarısı onboarding sonunda öne çıkar (`onboarding/page.tsx:335-370`, atlanabilir `:373`), menüde webhooks/pipelines (`Sidebar.tsx:18`, `:26`).
5. Uzman yeteneğini gizlemek: **kısmi var** — doğal dille ajan kurma UI'da var (`packages/ui/app/companies/[id]/page.tsx:195-227`), ama `createAgent`/`deleteAgent`/`rollbackAgent`/`nlEdit` API'de var, UI'da çağrısı yok (`packages/ui/lib/api.ts:617-622`, `:751-757`); bozuk `/agents` bağlantısı (`pipelines/[id]/page.tsx:422`).
6. Görsel iş akışını gerçek motordan koparmak: doğrulanamadı (`PipelineCanvas.tsx` ile çalıştırıcı ilişkisi okunmadı).
7. Onay ayrıntısını gizlemek: **var** — araç/risk/veri aktarımı yok (`approvals/page.tsx:161-197`); mobil `reason/costUsd/payload` API'de yok (01 §6).
8. Çalışma durumunu olduğundan güvenilir göstermek: **kısmi** — `RunStatus` `COMPLETED` ile `UNVERIFIED` sonuç aynı görünür; web `resultStatus` kullanmaz (`job.ts:24`, `runs/page.tsx:188`); takılı iş bayat heartbeat'le `stuck` hesaplanır ama web göstermez.

## §4.4 Tasarım testinin bugünkü durumu (durum tespiti)

| # | Test | Web | Desktop | CLI | Mobil | Kanıt |
|---|---|---|---|---|---|---|
| 1 | Normal AI sohbeti başlatma | GEÇMEZ (sohbet yok) | doğrulanamadı | kısmi (`ask`) | kısmi (`mobile/app/chat/index.tsx`) | 01 §1.1 |
| 2 | İş tarif edip çalıştırma | kısmi (sihirbaz; `jobs/start` #123 açık) | doğrulanamadı | doğrulanamadı | doğrulanamadı | `companies/new/page.tsx:361`; 01 §5.1 |
| 3 | Devam eden işi bulma | kısmi (`/runs` menüde yok) | doğrulanamadı | var (`runs` `cli/src/braavo.ts:1325`) | var (`mobile/lib/api.ts:1139`) | `Sidebar.tsx:14-28`; `dashboard/page.tsx:434` |
| 4 | Onay isteyen işlemi anlama | kısmi (ayrıntı eksik) | kısmi | kısmi | kısmi | `approvals/page.tsx:161-197` |
| 5 | AI ajanı oluşturma | geçer (kısmi): doğal dil kutusu + oluştur, `companies/[id]/page.tsx:746-791`; klasik oluşturma/silme/rollback UI'sı yok | doğrulanamadı | `agent` komutu yalnız listeler (`cli/src/forge/help.ts:50`); oluşturma doğrulanamadı | doğrulanamadı (`mobile/lib/api.ts`'te composeAgent/createAgent yok) | `companies/[id]/page.tsx:195-227`; `lib/api.ts:623` |
| 6 | Şirket durumunu inceleme | geçer (kısmi) | kısmi | doğrulanamadı | kısmi | `companies/[id]/page.tsx:260` |
| 7 | Gelişmiş görünümden teknik ayrıntı | kısmi (adım/araç) | kısmi | `--json` `cli/src/forge/output.ts:56` | yok (adım ayrıntısı doğrulanamadı) | `runs/[id]/page.tsx:671` |
| 8 | Model maliyeti ve erişim yetkisi | kısmi (koşu maliyeti var `runs/[id]/page.tsx:471`; model başına fiyat gösterimi bulunamadı: `settings/page.tsx` fiyat referansları yalnız plan fiyatı `:688`; erişim yetkisi: ajan özerkliği `companies/[id]/page.tsx:164`) | doğrulanamadı | doğrulanamadı | doğrulanamadı | `runs/[id]/page.tsx:471`; `settings/page.tsx:688` |
