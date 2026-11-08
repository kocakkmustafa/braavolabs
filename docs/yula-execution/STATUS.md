# YULA icra durumu — Braavolabs platform

Güncelleme: 2026-11-08 · Kaynak: ana talimat (vault `40 Referanslar/📑 Dört Ürün Ana Talimatı (2026-11-08).md`) · Tek bilet indeksi: vault `10 Holding/📋 YULA İcra Backlog.md` (bu dosya yalnız repo içi kanıtı tutar; ikinci paralel sistem değildir).

Durum kodları: talimat §12.4 (`BACKLOG … IMPLEMENTING, IN_REVIEW, …`). `IMPLEMENTED ≠ DEPLOYED ≠ PRODUCTION_VERIFIED`.

## Biletler

| Bilet | Durum | Kanıt | Sonraki |
|---|---|---|---|
| BRA-P0-01 uçtan uca yetenek tablosu | IN_REVIEW | AUDIT-01 notu, 4 klonda `git fetch` sonrası güncel main (platform `e93cbdc`, desktop `ad6867a`, cli `ed3692e`, mobile `5e60a75`); kod koşulmadı | Orchestration doğrulaması |
| BRA-P0-02a ADR + durum makinesi (bu PR) | IN_REVIEW | Aşağıdaki test kanıtı; `job-state.ts` + `job-state.test.ts`; ADR-0001 | PR denetimi, sonra 02b |
| BRA-P0-02b migration + `transitionRun` + `JOB_STATE_DUAL_WRITE` (varsayılan kapalı) | IN_REVIEW (bu yığılı PR) | Aşağıdaki "02b" bölümü | PR denetimi |
| BRA-P0-02c yazıcıları `transitionRun`a taşı, yaratıcılar `tenantId`/`workspaceId` ayarlasın, sözleşme testleri | BACKLOG | — | 02b kabulünden sonra, küçük PR'lar |
| BRA-P0-05, 08 (nonce, bütçe) | BACKLOG | — | 02b'ye bağlı (şema sütunları) |

## Bu PR'ın değişiklikleri (02a)
- `docs/yula-execution/{STATUS,DECISIONS,BRA-P0-02}.md` (yeni).
- `packages/api/src/modules/run/job-state.ts` — saf durum makinesi; **hiçbir yazara/okuyucuya bağlı değil**, davranış değişmez.
- `packages/api/src/modules/run/__tests__/job-state.test.ts` — 38 test.
- Şema, migration, API yüzeyi, UI: **değişmedi**.

## Test kanıtı (yerel, 2026-11-08)
Ortam: macOS, Node v26.9.0, pnpm 9.15.4, `origin/main` `e93cbdc` üzerine bu dal. Postgres/Redis yok; testler CI ile aynı yer tutucu env ile koşar (`.github/workflows/ci.yml` Test adımı).

| Komut | Sonuç |
|---|---|
| `npx vitest run src/modules/run/__tests__/job-state.test.ts` (packages/api) | 1 dosya, **38/38 geçti** |
| `npx tsc --noEmit` (packages/api; core/memory/integrations/connector-sdk derlendikten sonra) | **0 hata** |
| `npx vitest run` (packages/api, CI env) | **164 dosya geçti, 1 atlandı; 2646 test geçti, 48 atlandı**, 0 başarısız |

`NOT_TESTED`: DB'li entegrasyon (çökmüş koşu devamı, 3× approve yan etki sayısı) 02b kapsamında, burada yok; E2E Playwright ve Docker/Boot Smoke yerelde koşulmadı (CI'da). `pnpm -w lint` api paketinde lint betiği olmadığından uygulanmadı.

## 02b — migration + `transitionRun` + bayrak (yığılı PR, taban: `feat/BRA-P0-02-job-schema-adr`)

Kapsam (PR tek amaçlı): `packages/db/prisma/schema.prisma` (+70 satır: `JobState`, `ResultStatus`, `JobReceipt`, `Run` sütunları), `migrations/20261108000000_job_lifecycle/migration.sql` (yalnız ekleyen; **hiçbir ortama uygulanmadı**), `modules/run/transition.ts` (`transitionRun`, `isJobStateDualWriteEnabled`, `currentJobState`), `modules/run/__tests__/transition.test.ts` (18 test). `transitionRun` hiçbir mevcut yazıcıya bağlı değil (taşıma 02c); `JOB_STATE_DUAL_WRITE` varsayılan kapalı.

Test kanıtı (yerel, 2026-11-08, aynı ortam): `transition.test.ts` **18/18**; `tsc --noEmit` **0 hata** (Prisma istemcisi yeni şemayla üretildi); `vitest run` (packages/api, CI env) **165 dosya geçti, 1 atlandı; 2664 test geçti, 48 atlandı**, 0 başarısız. Şema `prisma validate` geçti; migration SQL `prisma migrate diff` çıktısıdır (eski → yeni şema), üzerine yalnız RLS politikası ve tenant geri dolgusu eklendi.

`NOT_TESTED`: migration'ın gerçek Postgres'te uygulanması (CI "DB Migration Check" koşar; yerelde hiçbir veritabanına uygulanmadı), gerçek Postgres'te CAS yarışı (testler `updateMany` anlamını taklit eden bellek içi depoyla karar mantığını kanıtlar), RLS politikasının davranışı.

Maliyet 0 USD, yeni sır yok. Geri alma: migration eklemelidir, bayrak kapalıyken hiçbir kod yeni sütuna dokunmaz; dal revert + (uygulandıysa) sütunlar yok sayılır.

### Bilinen açıklar ve etkiler (kasıtlı olarak açık yazıldı)
- **Onay atlama (BRA-P0-05'e kadar açık):** bugünkü `/handoff` + `/continue` yolu PENDING onay varken koşuyu RUNNING yapar ve iki rotada `approval:decide` izni aranmaz; model (`decideResume`) bunu `retry` niyeti olarak bilinçli taşır, **02b bunu kapatmaz ve test etmez**. Kapatma: BRA-P0-05'te `/continue` ya `approval:decide` ister ya da bekleyen onayı CANCELLED yapar (ADR madde (c)). Bu yazıcılar `transitionRun`a taşınmadıkça davranış değişmez.
- **Yanıt yüzeyi:** `GET /api/v1/runs/:id` ham `Run` satırını döndürür (`run/router.ts:91`); migration uygulanınca yeni alanlar (`state`, `tenantId`, `workspaceId`, `idempotencyKey`, `planVersion`, `resultStatus`, `deadline`, `evidenceRef`, `retryCount`, `heartbeatAt`) bayrak kapalıyken bile yanıta eklenir. Eklemelidir ve çağıranın kendi kiracısının verisidir; mobil/desktop kaynağında `.strict()` şema bulunmadı (CLI'daki tek `.strict()` ayrı bir test şemasında). 02c bir yanıt-anahtarı sözleşme testi ekler.
- **Geri dolgu:** `state` bilerek doldurulmadı; `tenant_id`/`workspace_id` tek `UPDATE` ile (prod boyutu bilinmiyor); migration sonrası yaratılan koşularda NULL. Ayrıntı ADR karar 2.

## Maliyet, veri, izin
- Yeni ücretli kaynak: **0 USD**. Yeni veri akışı: yok. Yeni izin/sır: yok.
- Deploy/migration: **yok** (platform `v*` etiketi = prod deploy = kurucu onayı).

## Geri alma
`job-state.ts` hiçbir yere bağlı değil: commit revert yeterli, kullanıcıya etkisi yok. 02b için ADR-0001 "Geri alma".

## Bağımsız denetim (talimat §12.3)
Denetçi: `reviewer` alt ajanı (yazan oturumdan ayrı, salt-okur; test koşturmadı, yalnız okudu).

**Tur 1 (2026-11-08): DEĞİŞİKLİK GEREKLİ.** Bulgular ve karşılığı:

| # | Bulgu (önem) | Karşılık |
|---|---|---|
| 1 | Çökme kurtarması geçiş tablosuyla çelişiyordu: RUNNING→RESUMING tabloda yoktu, RESUMING→RESUMING no-op olurdu (yüksek) | Tabloya RUNNING→RESUMING eklendi; no-op için yan etki `(state, retryCount)` CAS'ine bağlandı (`consumesRetry`); testler eklendi |
| 2 | `decideResume(FAILED)` düz resume ile FAILED'ı başlatıyordu; bugün yalnız devir kaydıyla olur (yüksek) | `decideResume(state, intent)`: `approve`/`unpause`/`retry` niyet ayrımı; FAILED yalnız `retry` |
| 3 | "Mevcut davranışı bozmaz" iddiası yanlıştı (`/pause` terminalde, `/stop` PENDING, `/resume` RUNNING, runner koşulsuz yazım, RESUMING→PAUSED yok) (orta) | ADR'ye "Bilinçli davranış değişiklikleri" tablosu; RESUMING→PAUSED eklendi; HTTP kodu 400 korunur |
| 4 | Yorum yanlış: "expiry→FAILED" (süresi dolan HANDOFF-dışı onay koşuyu CANCELLED yapar) (orta) | Tablo yorumu ve ADR düzeltildi; kenar kaynakları listelendi |
| 5 | Düz `/resume` bekleyen onayı atlayabilir (mevcut açık) (orta) | Niyet ayrımıyla yalnız düz `/resume` yolu kapandı; `/handoff`+`/continue` yolu (PENDING onay açıkken RUNNING) bugünkü gibi açık, BRA-P0-05'e/02b'ye kaldı (tur 3 #1); uygulama BRA-P0-05 ile birlikte (ADR'de yazılı) |
| 6 | `retries`/`heartbeat` kaynağı yok; `resumeCursor` kullanılmıyor, ADR yanlış söylüyordu (orta) | ADR'ye `retryCount`, `heartbeatAt` sütunları; devam noktası `RunStep`/`planResume` olarak düzeltildi |
| 7 | `deriveResultStatus` boş kanıtta VERIFIED, `ok` eksik testte geçmiş sayıyordu (fail-open) (orta) | Fail-closed: kanıt yok ⇒ UNVERIFIED; test için `ok === true` şart; testler |
| 8 | Sınır girdileri (negatif/kesirli/∞ sayaç) (düşük) | Bozuk sayaç işi bitirir; testler |
| 9 | Bazı testler yarışı değil karar fonksiyonunu kanıtlıyordu, başlık abartıyordu (düşük) | Başlıklar "decision only; CAS race is 02b" olarak düzeltildi; DB'li kanıt 02b'de |
| 11 | ADR olgu hataları (`expiry-cron.ts:94` yazarı, `planResume` satırı 130, `EXPIRED` vs `REJECTED`) (düşük) | Düzeltildi |
| 10, 12, 13 | Projeksiyon ADR ile birebir; 20+ yazım sayısı doğru; "hiçbir yere bağlı değil" doğru; istemcileri kıracak adım yok (olumlu) | — |

**Tur 2 (2026-11-08, PR #108 `b0ddc8f`): DEĞİŞİKLİK GEREKLİ.** Tur 1 bulgularının 1-9 ve 11'i kapandı; yeni bulgular:

| # | Bulgu (önem) | Karşılık |
|---|---|---|
| 1 | `retry` yalnız FAILED'dan başlıyordu; bugünkü `/continue` durum denetlemez, `/handoff` RUNNING→PAUSED park eder, yani manuel devir akışı (`run/router.ts:336,374-376,427-465`) kırılırdı; test bunu sabitliyordu; ADR "değişmez" diyordu (yüksek) | `retry` FAILED/PAUSED/NEEDS_APPROVAL'dan başlar; akış testi eklendi; ADR + tablo düzeltildi; terminal koşuda stale kayıt reddi ADR'ye yazıldı |
| 2 | `ref`i boş başarısız test veto edemiyordu (fail-open) (orta) | Test vetosu tüm kanıt üzerinden; `trim()`; testler |
| 3 | `RESUMING` koşunun heartbeat'i bayat, zamanlayıcı yanlışlıkla retry yakabilir (orta, olası) | ADR karar 6 notu: 02b'de RESUMING için bekleme süresi şart |
| 4 | ADR `resultStatus` tarifi koddan geri (düşük) | ADR karar 4 güncellendi |
| 5 | Test başlığı "terminal or FAILED", gövde yalnız terminal (düşük) | Başlık düzeltildi |
| 6 | Bilet `IMPLEMENTING`, STATUS `IN_REVIEW` (düşük) | Bilet `IN_REVIEW` |
| 7 | `PAUSED→COMPLETED/NEEDS_APPROVAL` kenarı yok; adım ortasında duraklatma final yazımı CAS'te reddedilebilir (düşük, olası) | ADR "02b'de ele alınacak" notu |

**Tur 3 (2026-11-08, `ac2c5bc`): kod doğru, DEĞİŞİKLİK GEREKLİ yalnız yorum/belge.** Tur 2 #1-#7 kapandı (kod/test/ADR doğrulandı; 38 `it(` sayıldı). Yeni bulgular:

| # | Bulgu (önem) | Karşılık |
|---|---|---|
| 1 | `NEEDS_APPROVAL + retry` (handoff + `/continue`) bekleyen onayı atlıyor; iki rotada `approval:decide` yok; bugün de var, "kapandı" denemez (orta) | Yorum ve tur 1 #5 satırı dürüstleştirildi; ADR'ye 02b/BRA-P0-05 maddesi (c): `/continue` `approval:decide` istemeli ya da bekleyen onayı CANCELLED yapmalı |
| 2 | `job-state.ts` yorumu "approve tek niyet" derken retry de NEEDS_APPROVAL'ı başlatıyordu (orta) | Yorum düzeltildi |
| 3 | ADR tablosunda "yalnız approve" satırı `retry` istisnasını söylemiyordu (orta) | Satıra istisna eklendi |
| 4 | `/continue` RUNNING'de ikinci kez kuyruğa alıyor, tabloda yok (düşük) | Tabloya satır eklendi |
| 5 | `ref` null/eksik ise `trim()` TypeError (düşük) | ADR madde (d): 02b'de JSON doğrulaması |

Kod değişmedi (yalnız yorum); bu yüzden dördüncü tur yapılmadı, 38 test ve tsc yeniden koşuldu (aşağıdaki tablo).

