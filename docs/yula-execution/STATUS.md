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
| BRA-P0-02a/02b | MERGED (2026-11-08) | #108 `32bfb05`, #109 `0318e4c` (CI tamamen yeşil, E2E dahil) | — |
| BRA-P0-05 exact-action onay + onay atlama kapatma | IMPLEMENTING → bu PR | Aşağıdaki "05 + 08" bölümü; ADR-0002 | PR denetimi, CI |
| BRA-P0-08 job bütçesi (`runs.job_budget`, governance denetimi) | IMPLEMENTING → bu PR | Aşağıdaki "05 + 08" bölümü; ADR-0002 | PR denetimi, CI; bütçeyi yazan yaratıcı 02c/03 |

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

Kapsam (PR tek amaçlı): `packages/db/prisma/schema.prisma` (+70 satır: `JobState`, `ResultStatus`, `JobReceipt`, `Run` sütunları), `migrations/20261108000000_job_lifecycle/migration.sql` (yalnız ekleyen; **hiçbir ortama uygulanmadı**), `modules/run/transition.ts` (`transitionRun`, `isJobStateDualWriteEnabled`, `currentJobState`), `modules/run/__tests__/transition.test.ts` (25 test). `opts.tenantId` zorunlu; okuma tenant ilişkisiyle kapsanır, yazma skaler CAS'tır. `transitionRun` hiçbir mevcut yazıcıya bağlı değil (taşıma 02c); `JOB_STATE_DUAL_WRITE` varsayılan kapalı.

Test kanıtı (yerel, 2026-11-08, aynı ortam): `transition.test.ts` **25/25**; `tsc --noEmit` **0 hata** (Prisma istemcisi yeni şemayla üretildi); `vitest run` (packages/api, CI env) **165 dosya geçti, 1 atlandı; 2671 test geçti, 48 atlandı**, 0 başarısız. Şema `prisma validate` geçti; migration SQL `prisma migrate diff` çıktısıdır (eski → yeni şema), üzerine yalnız RLS politikası ve tenant geri dolgusu eklendi.

`NOT_TESTED`: migration'ın gerçek Postgres'te uygulanması (CI "DB Migration Check" yalnız uygulanabildiğini gösterir; yerelde hiçbir veritabanına uygulanmadı), gerçek Postgres'te CAS yarışı ve satır kilidi (testler `updateMany` anlamını taklit eden bellek içi depoyla karar mantığını kanıtlar; gerçek yarış için veritabanlı entegrasyon testi 02c'de), RLS politikasının davranışı.

Maliyet 0 USD, yeni sır yok. Geri alma: migration eklemelidir, bayrak kapalıyken hiçbir kod yeni sütuna dokunmaz; dal revert + (uygulandıysa) sütunlar yok sayılır.

### 02b bağımsız denetim (`reviewer` alt ajanı, PR #109 `ea61abc`)
**Tur 1: DEĞİŞİKLİK GEREKLİ (engel yok).** Migration SQL ↔ şema birebir ve yalnız ekleyen, RLS deseni tutarlı, CAS/`state: null` doğru, `transitionRun` hiçbir yazıcıya bağlı değil: doğrulandı. Bulgular ve karşılığı:

| # | Bulgu (önem) | Karşılık |
|---|---|---|
| 1 | Bayrak kapalıyken `extra` ile yaşam döngüsü sütunları yazılabilir; "dokunmaz" garantisi çağırana kalmış (orta) | `extra` tipi `Omit<…, ReservedRunColumn>`; çalışma anında reddedilir (TypeError); testler her ayrılmış sütun için, bayrak kapalı ve açık |
| 2 | Okuma/yazma yalnız `id` ile; tenant izolasyonu çağırana ve fail-open RLS'e kalmış, kural #10 ile çelişir (orta) | `opts.tenantId` zorunlu; okuma `pipeline → company → tenantId` ilişki filtresiyle kapsanır (yeni sütundan bağımsız), yazma ise skaler CAS'tır (tur 2 #2: ilişki filtreli `updateMany` atomik olmayabilir); başlık yorumu `tenantTx` şartını yazar; çapraz kiracı testi |
| 3 | ADR'nin "02b'de ele alınacak" ve "bayrak açıkken davranış değişiklikleri" maddeleri 02b'de yok (orta) | 02c / BRA-P0-05 olarak yeniden etiketlendi, "02b hiçbirini kapatmaz" yazıldı |
| 4 | "Migration uygulanmamışsa bile güvenli" yalnız `transitionRun` için doğru; yeni istemci + migration'sız DB her `runs` sorgusunu `P2022` ile kırar (orta) | Cümle daraltıldı, dağıtım sırası (migration imajdan önce; deploy betiği zaten böyle) ADR ve STATUS'a yazıldı |
| 5 | Eksik testler: env'den varsayılan KAPALI, kapalıyken `extra.state`; test başlığı yarışı CI migration kontrolüne atfediyordu (düşük) | 7 test eklendi (25 toplam); başlık düzeltildi |
| 6 | `RESUMING→COMPLETED/NEEDS_APPROVAL` kenarı yok, 02c sıralama riski; `state` NULL + aynı-durum no-op iddiası; `job_receipts` append-only yalnız kodda, tenant FK yok; `CREATE INDEX`/`UPDATE` kilidi; ADR imza farkı (düşük) | ADR madde (e), karar 3 ve 5 sözleri, STATUS bilinen açıklar |

**Tur 2 (`8b2c705`): DEĞİŞİKLİK GEREKLİ (engel yok).** Tur 1 #1 doğrulandı (`RESERVED_RUN_COLUMNS` tüm yeni sütunları kapsıyor; `extra` yalnız `data`ya gider, `where`i ezemez). Yeni bulgular ve karşılığı:

| # | Bulgu (önem) | Karşılık |
|---|---|---|
| 1 | İlişki filtreli `updateMany` Prisma'da select-id-sonra-update çalışabilir; `status`/`state` koşulu UPDATE'te yeniden değerlendirilmezse CAS atomik olmaz; bellek içi fake bunu kanıtlayamaz (orta, olası) | Yazma skaler CAS'a indirildi (`id + status (+ state)`), kiracı doğrulaması aynı işlemdeki okumada; test (`where` ilişki filtresi içermez); gerçek-Postgres CAS yarışı `NOT_TESTED` olarak kalır |
| 2 | Eski "02b" etiketleri (karar 6 notu, madde (c)/(d)), karar 3'ün "geri dolgu" cümlesi karar 2 ile çelişiyor (orta/düşük) | Etiketler 02c yapıldı; karar 3 "eşleme, toplu geri dolgu yok" olarak düzeltildi |
| 3 | `id`/`pipelineId` ayrılmış listede yok, tipsiz çağıran koşuyu başka pipeline'a taşıyabilir (düşük) | İkisi listeye eklendi |
| 4 | Test okuma kapsamını doğrudan denetlemiyor; başlık/yorum fazla iddialı; şema-liste tamlık testi yok (düşük) | Okuma `where`i ayrıca kaydedilip denetleniyor, başlık ve yorum düzeltildi; şema-liste tamlık testi **yapılmadı** (liste elle doğrulandı, 02c'ye açık madde) |

**Tur 3:** yapılmadı; kalan düzeltmeler yalnız belge ve küçük kod sıkılaştırması, 25 test ve tsc yeniden koşuldu.

### Bilinen açıklar ve etkiler (kasıtlı olarak açık yazıldı)
- **Onay atlama (BRA-P0-05'e kadar açık):** bugünkü `/handoff` + `/continue` yolu PENDING onay varken koşuyu RUNNING yapar ve iki rotada `approval:decide` izni aranmaz; model (`decideResume`) bunu `retry` niyeti olarak bilinçli taşır, **02b bunu kapatmaz ve test etmez**. Kapatma: BRA-P0-05'te `/continue` ya `approval:decide` ister ya da bekleyen onayı CANCELLED yapar (ADR madde (c)). Bu yazıcılar `transitionRun`a taşınmadıkça davranış değişmez.
- **Yanıt yüzeyi:** `GET /api/v1/runs/:id` ham `Run` satırını döndürür (`run/router.ts:91`); migration uygulanınca yeni alanlar (`state`, `tenantId`, `workspaceId`, `idempotencyKey`, `planVersion`, `resultStatus`, `deadline`, `evidenceRef`, `retryCount`, `heartbeatAt`) bayrak kapalıyken bile yanıta eklenir. Eklemelidir ve çağıranın kendi kiracısının verisidir; mobil/desktop kaynağında `.strict()` şema bulunmadı (CLI'daki tek `.strict()` ayrı bir test şemasında). 02c bir yanıt-anahtarı sözleşme testi ekler.
- **Dağıtım sırası ve kilit:** migration yeni uygulama imajından ÖNCE uygulanmalı (yeni Prisma istemcisi her `runs` sorgusunda yeni sütunları adlandırır; tersi sıra `P2022`); deploy betiği bu sırayı zaten uyguluyor. `CREATE INDEX` ve `runs` satırlarını yeniden yazan geri dolgu `UPDATE`'i çalışırken yazmaları kilitler; prod `runs` boyutu bilinmiyor, büyükse kümeli betik gerekir.
- **`job_receipts`:** "yalnız-ekle" şimdilik yalnız kodla sağlanır (RLS politikası UPDATE/DELETE'e izin verir) ve `tenant_id` için `tenants` FK'si ile run'ın tenant'ıyla tutarlılık denetimi yok; daraltma adımında ele alınır.
- **Geri dolgu:** `state` bilerek doldurulmadı; `tenant_id`/`workspace_id` tek `UPDATE` ile (prod boyutu bilinmiyor); migration sonrası yaratılan koşularda NULL. Ayrıntı ADR karar 2.

## 05 + 08 — exact-action onay, onay atlama kapatma, job bütçesi (PR `feat/BRA-P0-05-08-exact-action-budget`; #109 merge edildi `0318e4c`)

Kapsam: `schema.prisma` (+`approvals.{tenant_id,nonce,action_hash,consumed_at}`, +`runs.job_budget`), `migrations/20261108010000_approval_exact_action` (yalnız ekler; **hiçbir ortama uygulanmadı**; `prisma migrate diff` çıktısıyla birebir doğrulandı), `modules/approval/exact-action.ts` (hash, nonce, `evaluateGrant`, `consumeGrant` CAS, `hasOpenApproval`), `modules/run/job-budget.ts` (şema, `evaluateJobBudget`, `checkJobScope`), `governance/engine.ts` (`checkJobBudget` ilk denetim, `runJobBudgetCheck`), `pipeline/hierarchical-runner.ts` (devir öncesi + nihai bütçe denetimi), `agent/tool-executor.ts` (SPEND kapısı, `EXACT_ACTION_APPROVAL` bayrağı), `run/router.ts` (`/resume` + `/continue` 409 koruması), `approval/router.ts` (`decide` süre denetimi). Karar ve davranış değişikliği tablosu: DECISIONS.md ADR-0002.

**Onay atlama açığı kapandı (bayraktan bağımsız):** `approval-bypass.test.ts` + `handoff-router.test.ts` negatif testleri: bekleyen onayla `/resume` ve `/handoff`→`/continue` **409**, claim/ledger/RUNNING/enqueue/audit yok; sorgu hatası resume'a dönüşmez. Mutasyon kontrolü: korumayı kapatınca 5 test kırıldı, geri alındı.

| Komut (packages/api, CI env) | Sonuç |
|---|---|
| `npx tsc --noEmit` | **0 hata** |
| yeni testler (exact-action 41, job-budget 32, exact-action-gate 11, approval-bypass 7, decide-expiry 5, hierarchical-budget 8, handoff-router +2) | **106 yeni test geçti** |
| `npx vitest run` (tam, denetim tur 2 düzeltmelerinden sonra) | **171 dosya geçti, 1 atlandı; 2777 test geçti, 48 atlandı**, 0 başarısız (önceki: 165 / 2671) |

`NOT_TESTED`: migration'ın gerçek Postgres'te uygulanması (CI "DB Migration Check" bu PR'ın CI'ında okunacak; #109'da gerçek `pgvector/pgvector:pg16` servisinde yeşil koştu), veritabanlı CAS yarışı, RLS, E2E Playwright, Docker/Boot Smoke (CI'da), runner'ın gerçek Redis/BullMQ ile bütçe durdurması. `eslint` api paketinde yapılandırılmamış (`pnpm lint` yalnız ui/braavo-core `tsc`).

Bilinen açıklar ve etkiler: ADR-0002 "Sonuçlar ve bilinenler" (i)–(vi) ve **bekleyen onayı olan PAUSED koşu `/resume` ile açılamaz** (kasıtlı). `runs.job_budget`ı yazan yaratıcı henüz yok (02c/03); bayrak `EXACT_ACTION_APPROVAL` kapalı: prod'da hiçbir şey damgalanmaz/harcanmaz, yalnız atlama koruması + `decide` süre denetimi + (doluysa) bütçe devrededir. **Dağıtım sırası:** migration yeni imajdan ÖNCE; kurucu onayı gerekir (merge onayı değildir).

Geri alma: ADR-0002 "Geri alma".

### 05 + 08 bağımsız denetim (`reviewer` alt ajanı, salt-okur; `cb2abfb`)
**Tur 1: BLOKE EDEN VAR (2).** Bulgu ve karşılığı:

| # | Bulgu (önem) | Karşılık |
|---|---|---|
| 1 | HIERARCHICAL koşuda bütçe/kapsam kapısı hiç çalışmıyor; ADR "runner her grupta çağırır" yanlış olgu (orta-yüksek, bloke) | `runJobBudgetCheck` + `delegate` öncesi kontrol, reddedilen devir koşuyu FAILED yapar (yalnız ret varsa); `hierarchical-budget.test.ts` 6 test; ADR karar 6 düzeltildi |
| 2 | `hasOpenApproval` HANDOFF onayını da sayıyor; elle `/continue` (farklı sağlayıcı) 409 alıyordu (orta, bloke) | HANDOFF tipi korumadan çıkarıldı (`NON_GATING_APPROVAL_TYPE`), sorgu `type: { not: "HANDOFF" }`; ADR karar 4 + testler güncellendi |
| 3 | `timeoutMs` toplam süre değil (runner `startedAt`i her alışta yeniler) (orta) | Kodla değil belgeyle: bir koşu bacağıdır; `job-budget.ts` + ADR "bilinen açıklar" |
| 4 | Kapsam kapısı yeni koşularda boş (yaratıcılar `tenantId`/`workspaceId` yazmıyor) (orta) | KAPANDI 02c-1: 3 yaratıcı yazar; eski NULL satırlar ADR "bilinen açıklar" |
| 5 | `maxRetries` yazarı yok (düşük-orta) | ADR "bilinen açıklar" (02c çökme kurtarma) |
| 6 | Adım içi aşım denetlenmiyor (düşük) | ADR "bilinen açıklar" |
| 7, 8 | `take: 5` canlılık kaybı; `decide` süre yarışı dar pencere (düşük) | ADR "bilinen açıklar"; güvenli yönde |
| 9 | `canonicalize` Date/Map/Set/sınıfı `{}` yapıp çakıştırır (düşük) | Düz olmayan nesne **reddedilir**; test eklendi |
| 10 | Bayrak açıkken LLM aynı girdiyi üretmezse yeni onay döngüsü (olası) | ADR "bilinen açıklar": bayrak varsayılan kapalı, kademeli açılış |
| 11 | `approval-bypass` test başlığı yanlış iddia; runner-seviyesi `checkGovernance` testi yok | Başlık düzeltildi; sıralı runner testi **yapılmadı** (`NOT_TESTED`) |
| 12 | Migration yalnız ekler, backfill güvenli (olumlu); indeksler `CONCURRENTLY` değil | Not edildi, değişmedi |
| — | `decide` (A onayı, B PENDING iken RUNNING) kapsam dışı açık | ADR "bilinen açıklar", sonraki bilet adayı |
| 13 | **Önceden var olan, 02c-1 getirmedi (orta):** `GET /runs/:id` (`include: { pipeline: { include: { company: true } } }`), `GET /companies*` ham `Company.config` döndürür; template-kurulumda `config.webhookSecret` açık metin (`webhook/router.ts` ~353-359). Aynı kiracının doğrulanmış her üyesi webhook gizlisini okuyabilir (çapraz kiracı ifşa yok). | **Açık, ayrı bilet adayı:** `company` için `select` ya da `config`ten gizli temizleme; sözleşme testi iç içe `include`ı da kilitlesin. Bu PR'da değişmedi |

Doğrulananlar: CAS skaler tek UPDATE (ilişki filtresi sızması yok); hash/nonce/tenant/run/süre kontrolleri bayrak açıkken atlanamaz; `/resume`+`/continue` korumaları yan etkiden önce, sorgu hatası `next(err)`; `/rerun` koşuyu RUNNING yapmaz. 

**Tur 2 (`cac2c86` deltası): BLOKE EDEN YOK.** Tur 1'in iki bloke bulgusu doğru kapanmış (hiyerarşik FAILED yolu, HANDOFF dışlaması, `canonicalize`); `runGovernanceChecks` davranışı refaktörde değişmedi. Yeni bulgular ve karşılığı:

| # | Bulgu (önem) | Karşılık |
|---|---|---|
| 1 | `/continue` bekleyen HANDOFF onayını açık bırakır, sonradan `decide` çalışan koşuyu FAILED yapabilir (orta; önceden var, belgelenmemiş) | ADR "bilinen açıklar" + önerilen sonraki iş; kapsam dışı |
| 2 | Yöneticinin kendi maliyeti/tokenı hiyerarşik bütçeye geç girer (orta) — güvenlik taraması da aynı noktayı işaretledi | Kodla hafifletildi: döngü sonrası **nihai toplam** `strict` (yalnız aşım) denetlenir, aşıldıysa FAILED (`runJobBudgetCheck(..., { finalCheck: true })`, 2 yeni test); döngü içinde anlık kesme yok, ADR'de açık |
| 3 | Paralel `delegate` (5'e kadar) aynı sayacı görüp kontrolü geçer (orta) | ADR "bilinen açıklar" |
| 4 | Hiyerarşik `maxSteps` yalnız COMPLETED devirleri sayar (düşük) | ADR "bilinen açıklar" |
| 5 | Bütçe FAILED yolunda `run.hierarchical_failed` yok, tekrar eden ret bildirim tekrarı (düşük) | ADR "bilinen açıklar" |
| 6 | "reaching the limit" testi limite yaklaşmıyordu (düşük, test) | Test yeniden yazıldı (limit = nihai toplam → başarı) + aşım testi + yönetici çöküşü testi |
| 7 | HANDOFF dışlaması yalnız `findFirst` argüman şekliyle sınanıyor (düşük, test) | Kabul: sorgu şekli tek kanıt (DB'siz); `/continue` + PENDING HANDOFF davranış testi `NOT_TESTED` |
| 8 | STATUS/ADR kapsam ve "tur 2 yapılmadı" güncel değil (düşük, belge) | Düzeltildi (bu bölüm, kapsam satırı, ADR karar 1) |

Tur 3 yapılmadı (devir notu: reviewer turları iki ile sınırlı); tsc 0 hata, tam paket **171 dosya, 2777 test geçti**, 0 başarısız.

## Maliyet, veri, izin
- 05+08: yeni ücretli kaynak **0 USD**, yeni veri akışı yok, yeni izin/sır yok; deploy/migration yok.
- 02a: Yeni ücretli kaynak: **0 USD**. Yeni veri akışı: yok. Yeni izin/sır: yok.
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
| 5 | Düz `/resume` bekleyen onayı atlayabilir (mevcut açık) (orta) | Niyet ayrımıyla yalnız düz `/resume` yolu kapandı; `/handoff`+`/continue` yolu (PENDING onay açıkken RUNNING) bugünkü gibi açık, BRA-P0-05'e/02c'ye kaldı (tur 3 #1); uygulama BRA-P0-05 ile birlikte (ADR'de yazılı) |
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

