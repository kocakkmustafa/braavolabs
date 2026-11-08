# Kararlar (ADR) — YULA icra

Biçim: her karar değişmez numara alır; durum `Proposed → Accepted → Superseded`. Yeni karar eskisini silmez, onu `Superseded by` ile işaretler. Kaynak talimat: ana talimat §4, §6.2.A, §12 (vault: `40 Referanslar/📑 Dört Ürün Ana Talimatı (2026-11-08).md`). Kod gerçeği için: vault `40 Referanslar/📑 AUDIT-01 — Braavolabs (2026-11-08).md`.

---

## ADR-0001 — Job yaşam döngüsü ve geri uyumlu `RunStatus` projeksiyonu

- **Durum:** Proposed (BRA-P0-02, 2026-11-08). Bağımsız denetçi (reviewer alt ajanı) sonucu `docs/yula-execution/STATUS.md`'de.
- **Bilet:** `BRA-P0-02` (bkz. `BRA-P0-02.md`). Bağımlı biletler: `BRA-P0-05`, `-08`, `-03`, `-04`.

### Bağlam (kodda doğrulanmış)
- `Run.status` bugün 7 değerli `RunStatus`: `PENDING, RUNNING, PAUSED, WAITING_APPROVAL, COMPLETED, FAILED, CANCELLED` (`packages/db/prisma/schema.prisma:1728`).
- `Run.status` **20'den fazla yerde doğrudan yazılıyor** (bağımsız denetçi 23 saydı): `pipeline/runner.ts` (başlangıç `:106` ve final `:521` koşulsuz), `pipeline/hierarchical-runner.ts` (4: `:167,180,230,254`), `agent/tool-executor.ts` (3: `:258,352,449`), `governance/router.ts` (`:83`), `run/router.ts` (5: `:233,263,295,375,465`), `approval/router.ts` (`/decide` ve HANDOFF yolu) ve `approval/expiry-cron.ts:94` (süresi dolan HANDOFF-dışı onayda koşuyu CANCELLED yapar). Durum geçişlerinin tek sahibi yok; geçersiz geçiş koruması yok (örn. `/pause` durum denetlemez, runner koşulsuz yazar).
- `Run` doğrudan `tenantId` taşımaz (Pipeline → Company → Tenant). `idempotency_key`, `plan_version`, `max_steps`, `deadline`, `evidence_ref`, `result_status` yok.
- `Approval` içeriğe bağlı değil: `nonce` ve exact-action özeti yok (yalnız `expiresAt`, tek geçişli `updateMany where status=PENDING`).
- Mağazada satılan **iOS 1.1.0** ve Play'de canlı **Android 1.1.x**, masaüstü ve CLI `status` değerini bugünkü 7 değerle okur. İstemci ikilileri aynı gün güncellenemez; bilinmeyen yeni bir enum değeri kırılgan `switch`'leri bozar.

### Karar
1. **Tablo ve kimlik değişmez.** `runs` tablosu kalır, `Run.id` = `job_id`. "Job" bir söz dağarcığı ve API takma adıdır (`/api/v1/runs/:id` yolu değişmez).
2. **`Run.status` donmuş uyumluluk projeksiyonudur:** 7 değerli enum asla genişletilmez, değerleri anlam kaydırmaz. Yeni gerçek kaynak, yeni `Run.state` sütunudur (10 değerli `JobState`).
3. **Projeksiyon deterministik ve toplamdır** (`packages/api/src/modules/run/job-state.ts`, testle sabitlenmiş):

   | `JobState` (yeni) | `status` (eski, istemcinin gördüğü) |
   |---|---|
   | DRAFT, PLANNED, READY | PENDING |
   | RUNNING, RESUMING | RUNNING |
   | NEEDS_APPROVAL | WAITING_APPROVAL |
   | PAUSED | PAUSED |
   | COMPLETED / FAILED / CANCELLED | aynı ad |

   Mevcut satırlar için geri dolgu (backfill): `PENDING → READY` (eski koşular doğrudan kuyruğa girerdi), diğerleri aynı adla; `WAITING_APPROVAL → NEEDS_APPROVAL`. `RESUMING` eski okuyucuya `RUNNING` görünür (onaydan hemen sonra bugün de öyle görünüyor).
4. **Doğrulama durumu ayrı alandır:** `Run.resultStatus` (`VERIFIED | UNVERIFIED | NULL`), yaşam döngüsü durumu değildir. Fail-closed: `VERIFIED` yalnız `COMPLETED` + **en az bir gerçek kanıt** (boş/boşluk `ref` sayılmaz) + gerekli kanıt türlerinin hepsi + **tüm `test` kayıtları açıkça `ok=true`** (başarısız ya da `ok` bilgisi olmayan test, `ref`i boş olsa bile, vetodur) olduğunda; aksi `UNVERIFIED`; bitmemiş ya da göç öncesi geçmiş ⇒ `NULL`. (Talimat §6.4 #7: diff/test/PR yoksa "verified success" yok.)
5. **Geçişin tek yazarı:** `transitionRun(tx, runId, to, ctx)` (BRA-P0-02b). Karşılaştır-ve-yaz (`updateMany where state = from`), geçersiz geçişi reddeder, aynı duruma geçişi **idempotent no-op** sayar (yinelenen webhook/approve ikinci yan etki üretmez; yan etki yalnız `noop=false` iken çalışır). Mevcut 20+ doğrudan yazım noktası bu fonksiyona taşınır; `status` her zaman `toLegacyStatus(state)` olarak aynı işlemde yazılır.
6. **Çökmüş koşu:** `RUNNING/RESUMING` ve kalp atışı yok ⇒ kalan yeniden deneme hakkı varsa `RESUMING`, hak bitmişse `FAILED(retries_exhausted)`. Devam noktası **tamamlanmış `RunStep` kayıtlarıdır** (bugünkü `planResume`, `pipeline/executor.ts:130`, `runner.ts:205-223`); `Run.resumeCursor` şemada var ama `packages/api/src` içinde kullanılmıyor — bu ADR ona dokunmaz. Sayaç kaynağı yeni sütunlardır: `retryCount` (varsayılan 0), `heartbeatAt`; tavan `maxRetries` (bütçe alanı, ADR-0002). Koruma: RUNNING→RESUMING gerçek geçiş; RESUMING→RESUMING no-op olduğu için yan etki (yeniden kuyruğa alma) **`(state, retryCount)` üzerinde karşılaştır-ve-yaz** kazanılınca çalışır. Bozuk sayaç (negatif, kesirli, sonsuz) işi bitirir, hak vermez. Sonsuz yeniden deneme yok. **Not (02b):** onaydan sonra kuyrukta bekleyen `RESUMING` koşunun `heartbeatAt`'i henüz hiç ilerlemediği için bayat görünür; zamanlayıcı bunu çökmüş sayıp retry yakmasın diye `RESUMING` için ayrı bir kuyruk bekleme süresi (grace) şarttır, yoksa çift kuyruğa alma olur.
7. **Kimlik ve izolasyon alanları (eklenir, boş bırakılabilir → doldurulur):**
   - `tenantId` doğrudan `Run` üzerinde; geri dolgu `Pipeline → Company → Tenant`. Güvenlik sınırı **Tenant** (mevcut RLS ve `tenant-binding`); `workspaceId` = `Pipeline.companyId` (Company, tenant içi çalışma alanı). "Şirket A / Şirket B" ayrı Tenant mı aynı Tenant altında Company mi **doğrulanmadı** (AUDIT C): bu karar yalnız Tenant sınırını varsayar, Company-arası izolasyon `BRA-P0-07` negatif testiyle kanıtlanana kadar güvenlik iddiası sayılmaz.
   - `idempotencyKey` (tenant başına tekil, `NULL` serbest), `planVersion` (varsayılan 1; PLANNED→DRAFT yeniden planlamada artar), `deadline`, `evidenceRef` (Receipt kimliği), `retryCount`, `heartbeatAt`.
   - **Niyet ayrımı:** `resume` tek eylem değildir. `decideResume(state, intent)`: `approve` yalnız `NEEDS_APPROVAL`'ı, `unpause` yalnız `PAUSED`'ı başlatır; `retry` (OPEN devir kaydıyla: `/continue`, HANDOFF onayı) `FAILED`, `PAUSED` ve `NEEDS_APPROVAL`'dan başlatır — çünkü `/handoff` RUNNING/PAUSED/WAITING_APPROVAL/FAILED'dan açılır, RUNNING koşuyu PAUSED'a park eder ve manuel devir akışı (RUNNING → `/handoff` → PAUSED → `/continue`) çalışmaya devam etmelidir. Böylece düz `/resume` bekleyen onayı atlayamaz ve governance hard-stop ya da döngü korumasıyla FAILED olmuş koşu sıradan bir resume ile başlamaz. `retry` için OPEN devir kaydını doğrulamak çağıranın işidir; fonksiyon yalnız durumu denetler.
8. **Approval (BRA-P0-05'te ayrıntılanır, burada yalnız yer ayrılır). Not:** süresi dolan HANDOFF-dışı onay bugün `REJECTED` yazılır (`ApprovalStatus.EXPIRED` şemada var, `expiry-cron.ts:80` kullanmıyor); bu ADR bunu değiştirmez, `EXPIRED`e geçiş BRA-P0-05 kararıdır. `nonce` (128 bit rastgele, tekil), `actionHash` (alıcı/içerik/kapsam/sürüm/maliyet tavanının kanonik özeti, `tenantId` + `jobId` + `planVersion` bağlı), `consumedAt` (tek kullanımlık), `tenantId` doğrudan. `ApprovalStatus` değerleri (`PENDING/APPROVED/REJECTED/EXPIRED`) ve `ApprovalType` (`SPEND/INPUT/EXTERNAL_CONTROL/HANDOFF`) değişmez; mobil kuyruk aynı kalır.
9. **Receipt (yeni, yalnız-ekle):** `job_receipts` — `jobId`, `tenantId`, `outcome` (JobState), `resultStatus`, `costUsd`, `evidence[]` (`diff|test|pr|artifact|log` + `ref` + `ok`), `approvalIds[]`, `contentHash`, `createdAt`. Güncelleme/silme yok; düzeltme yeni satırdır.
10. **Bütçe sözleşmesi (ADR-0002, BRA-P0-08):** `JobBudget { maxUsd, maxTokens, maxSteps, timeoutMs, maxRetries, warnRatio=0.8 }`. CLI daemon bütçesi (`cli` PR #18: aylık USD, %80 uyarı, %100 durdurma) aynı `warnRatio`/durdur semantiğini kullanır; platform `Run.budgetUsd` = `maxUsd` takma adı olur (yeni sütun yok). Ayrıntı ve CLI kaynağıyla birebir uyum BRA-P0-08'de doğrulanır; bu ADR yalnız yer tutar.

### Geçiş planı (genişlet → çift yaz → sözleşmeyi daralt)
Sıra (talimat §4): **şema → sunucu → sözleşme testi → desktop/web → mobil → canary.**
1. **Şema (genişlet) — 02b'de yazıldı** (`packages/db/prisma/migrations/20261108000000_job_lifecycle`, hiçbir ortama uygulanmadı): yalnız ekleyen migration: `runs`'a nullable `state`, `tenant_id`, `workspace_id`, `idempotency_key`, `plan_version DEFAULT 1`, `result_status`, `deadline`, `evidence_ref`, `retry_count DEFAULT 0`, `heartbeat_at`; yeni enum `JobState`/`ResultStatus`; yeni yalnız-ekle `job_receipts` (+ aynı desende RLS politikası). Tekillik: `(tenant_id, idempotency_key)` düz tekil indeks — Postgres'te NULL'lar çakışmaz, yani kısmi indeksle aynı anlam; Prisma kısmi indeksi ifade edemez. **`approvals` sütunları (`nonce`, `action_hash`, `consumed_at`, `tenant_id`) bu migration'da yok:** tasarımı BRA-P0-05'e aittir, kendi migration'ında gelir. Mevcut sütun ve enum değerleri dokunulmaz.
2. **Geri dolgu:** `tenant_id`/`workspace_id` migration içinde tek, idempotent `UPDATE` (`WHERE tenant_id IS NULL`, tekrar koşulursa aynı sonuç); prod tablo boyutu bilinmiyor, büyükse kümeli ayrı betik gerekir (açık madde). **`state` bilinçli olarak geri doldurulmaz:** eski yazıcılar yalnız `status` günceller, tek seferlik bir `state` dolgusu hemen bayatlar; `transitionRun` mevcut durumu `status`tan türetir (saklı `state` yalnız hâlâ `status`a izdüşüyorsa kullanılır, değilse kendini onarır) ve `state`i ilk çift yazımda doldurur. Migration'dan sonra oluşturulan koşularda `tenant_id`/`workspace_id` NULL kalır; yaratıcılar bunları ayarlayana kadar (02c) `NOT NULL` adımı yapılamaz.
3. **Sunucu (çift yazım) — 02b'de yazıldı** (`packages/api/src/modules/run/transition.ts`; hiçbir mevcut yazıcıya bağlı değil): `JOB_STATE_DUAL_WRITE` bayrağı (varsayılan **kapalı**, yalnız literal `"true"`, çağrı anında okunur — `lib/outbound-gates.ts` ile aynı; `env.ts` şemasında bilerek yok). **Kapalıyken** `transitionRun` yeni sütunları seçmez ve yazmaz, yalnız `status`ı karşılaştır-ve-yaz ile günceller: migration hiçbir yerde uygulanmamış olsa bile güvenli. **Açıkken** `state` + `resultStatus` yazar, `status = toLegacyStatus(state)` aynı UPDATE'te. Mevcut 20+ yazım noktasının taşınması ve koşu yaratıcılarının `tenantId`/`workspaceId` ayarlaması **02c** (küçük PR'lar). Tutarlılık sorgusu `state IS NOT NULL AND status <> projection(state)`: 02c bitene kadar sıfır olması beklenmez (eski yazıcılar `state`i bayatlatır; `transitionRun` bunu kendi onarır), 02c sonrası sıfır olmalı.
4. **Sözleşme testi:** (a) `status` yüzeyi tam 7 değer (anlık görüntü), (b) API yanıtı eski alanların üst kümesi (`state`, `resultStatus` eklenir, hiçbiri kalkmaz), (c) `relay-protocol` eşlik testi bozulmaz.
5. **Desktop/web:** `state` varsa okur, yoksa `status`a düşer. **Mobil:** en son; mağaza sürümü gerekmeden çalışmalı (eski `status` okumaya devam eder).
6. **Canary:** staging'de bayrak açık, `status == toLegacyStatus(state)` tutarlılık sorgusu 0 satır; sonra tek tenant, sonra genel. Her adımda geri alma kaydı.
7. **Daraltma (ayrı ADR, bu karar kapsamı dışı):** `tenant_id NOT NULL` + `CHECK (status = projection(state))`. `status` **hiçbir zaman** kaldırılmaz.

### Geri alma
Sütunlar eklemelidir ve yok sayılabilir; `status` her zaman güncel tutulduğu için eski istemci ve eski sunucu kodu bozulmaz. Geri alma = `JOB_STATE_DUAL_WRITE` kapat + önceki yapı; veri kaybı yok. Migration geri alma provası `QA-BRA-02` kapsamındadır (kurucu onaylı, staging). Bu ADR'yi uygulayan PR'lar **deploy ve migration'ı kendisi başlatmaz** (platform `v*` etiketi = prod deploy = kurucu onayı).

### Bilinçli davranış değişiklikleri (02b'de, `JOB_STATE_DUAL_WRITE` açıkken; bayrak kapalıyken eski yollar aynen çalışır)
Bağımsız denetim (BRA-P0-02a) "mevcut davranışı bozmaz" iddiasını yanlışladı; fark dürüstçe şu:

| Bugün | Bayrak açıkken | Not |
|---|---|---|
| `/pause` durum denetlemez; COMPLETED/FAILED/CANCELLED koşu da PAUSED olabilir | terminal koşuda reddedilir (409) | düzeltme |
| `/stop` PENDING'i 400 ile reddeder | READY/DRAFT/PLANNED iptal edilebilir | iptal her bitmemiş durumda |
| `/resume` RUNNING'de 400 | `already` (idempotent) | **HTTP kodu bugünkü gibi 400 kalır** (istemci uyumu); `already` yalnız iç karar |
| `/resume` WAITING_APPROVAL'ı PENDING onay varken RUNNING yapar (`run/router.ts:291-297`, `approval:decide` izni gerekmeden) | reddedilir; yalnız `approve` niyeti başlatır (**devir kaydıyla `retry` hariç**, bir alttaki `/continue` satırı) | mevcut açığı kapatır; BRA-P0-05 ile birlikte indirilir |
| Runner başlangıç (`:106`) ve final (`:521`) yazımları koşulsuz; CANCELLED koşu RUNNING/COMPLETED'a dönebilir | karşılaştır-ve-yaz; CANCELLED kalır | düzeltme |
| `/continue` durum denetlemez, yalnız OPEN devir kaydı arar; PAUSED / WAITING_APPROVAL / FAILED'dan RUNNING yapar; kayıt bayat kalmışsa CANCELLED/COMPLETED koşuyu da RUNNING yapabilir | PAUSED/NEEDS_APPROVAL/FAILED'dan başlar (`retry`), terminal koşuya reddedilir (409) | akış değişmez; terminal koşuda düzeltme. WAITING_APPROVAL + açık devirde PENDING onay açık kalır (bugünkü davranış): BRA-P0-05'te ele alınır |
| `/continue` RUNNING koşuda ikinci kez kuyruğa alır (`enqueueRun`) | `already`, ikinci kuyruğa alma yok | idempotency düzeltmesi |

Bu satırların her biri 02b'nin kendi sözleşme testiyle sabitlenir; hiçbiri `status` değer kümesini genişletmez.

### Reddedilen seçenekler
- **`RunStatus` enum'una yeni değer eklemek:** eski ikililer bilinmeyen değerde bozulabilir; geri dönüşü yok (Postgres enum değeri kolayca silinmez).
- **`runs` → `jobs` tablo yeniden adlandırma:** her sorgu, RLS politikası, istemci yolu ve test kırılır; kazanç yalnız isim.
- **Yeniden yazım:** talimat §16 yasaklıyor; mevcut koşucu, onay ve resume mantığı korunur.

### Sonuçlar ve bilinenler
- **Pozitif:** tek yazar, geçersiz geçiş reddi, yinelenen onay/webhook'ta tek yan etki, sınırlı yeniden deneme, kanıtsız "başarı" yok.
- **Maliyet/risk:** 20+ yazım noktası taşınacak (küçük PR'lara bölünür); geri dolgu büyük tabloda süre alabilir (kümeli koşar); canlı platform sürümü hâlâ doğrulanmadı (AUDIT).
- **Yeni ücretli kaynak:** yok (0 USD). **Yeni veri akışı:** yok (aynı veritabanı).
- **Açık varsayımlar:** workspace = Company; Company-arası izolasyon `BRA-P0-07`ye kadar iddia edilmez; `maxRetries` varsayılanı ve `warnRatio` ADR-0002'de kesinleşir.
- **02b'de ele alınacak (denetçi tur 2):** (a) operatör çalışan adımın ortasında duraklatırsa (`runner.ts:282-284` yalnız adım grubu başında bakar) final yazımı `PAUSED→COMPLETED/NEEDS_APPROVAL` kenarı olmadığı için CAS'te reddedilebilir; `transitionRun` bu durumda yeniden okuyup uygun geçişi seçmeli ya da tabloya bilinçli kenar eklenmeli; (b) `RESUMING` bekleme süresi (karar 6 notu). (c) **onay atlama kalıntısı:** `/handoff` + `/continue` yolu `NEEDS_APPROVAL`'ı PENDING onay açıkken RUNNING yapabilir ve iki rotada da `approval:decide` izni aranmaz (`run/router.ts` yalnız `authMiddleware`); 02b/BRA-P0-05'te `/continue` ya `approval:decide` istemeli ya da bekleyen onayı CANCELLED yapmalı, aksi hâlde açık kalıcı olur; (d) `deriveResultStatus` girdisi (`ref` null/eksik) 02b'de JSON doğrulamasından geçmeli, aksi hâlde `trim()` TypeError atar.
