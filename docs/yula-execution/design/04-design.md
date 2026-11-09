# 04 — Braavolabs web arayüzü tasarımı (BRA-UX-03, Aşama 4–5)

Durum: Kabul edildi (ADR-0004), PR #131. Karar: ADR-0004 (`docs/yula-execution/DECISIONS.md`). Girdiler: `01-audit.md`, `02-mental-model.md`, `03-concepts.md` (§5 "UX-03'e girdi" ve matris). Talimat: vault `40 Referanslar/📑 Dört Ürün Arayüz ve Deneyim Talimatı (2026-11-09).md` §4.2 (A–J, `:228`), §4.3 (`:361`), §4.4 (`:372`), Aşama 5 (14 teslimat).

Kapsam: yalnız belge ve karar. Kod, rota, bayrak, migration yok. Kullanıcıya dönük marka: "YULA Lab" / "Braavolabs". Renk ve marka kimliği korunur; yeni renk önerilmez (token adları mevcut `globals.css` ve Tailwind kimliğinden gelir). Çalıştırılmadı; atıflar statik okumadır (bkz. §0).

## 0. Seçilen yön ve atıf notu

**Seçim (ADR-0004): "Niyet Çubuğu + İş Gelen Kutusu" birleşik yönü.** Omurga K3 (İş/Gelen Kutusu: ADR-0003 kovaları, `/runs`, `/approvals`, Receipt), giriş yüzeyi K1 (Niyet Çubuğu: tek tarif satırı), K2'den yalnız **iş sayfasında kip morfu** (Özet/Çıktı/Kaputu Aç; ileride kod kipi). K2'nin ortak "çalışma kaydı" varlığı ve sohbet/çalışma migration'ı bu fazda alınmaz (`03-concepts.md` §4 puanları: K1 20, K2 18, K3 23; mühendislik maliyeti K2 = 1).

Atıf biçimi `yol:satır`; yol repo köküne göredir. `packages/ui`, `packages/api`, `packages/core` atıfları bu tabanda (`6f90242`) açılarak doğrulandı (§14 sonu). `mobile/` ayrı çalışma dizinindedir (platform deposunda yok); `mobile/lib/api.ts:997,1243,1286` ana dizinde `sed -n` ile açılıp doğrulandı, diğer mobil/desktop/CLI atıfları `03-concepts.md` §6 doğrulamasına dayanır.

## 1. Tasarım vizyonu ve etkileşim felsefesi

1. **Önce niyet.** Açılışta tek bir "Ne yapmak istiyorsun?" satırı ve yanında "benden beklenen" (onay/takıldı sayısı) durur. Kullanıcı sohbet mi, iş mi, ajan mı istediğini bilmek zorunda değildir; sınıflama ürünün işidir, kullanıcıya iki satırlık "şunu anladım" önizlemesiyle gösterilir ve düzeltilebilir.
2. **Yüzey işe göre belirir.** Sohbet = tek sütun konuşma; iş = plan kartı → ilerleme; onay = ayrıntılı karar katmanı; ajan = yarım sayfa taslak (bkz. §5). Aynı dashboard şablonu her işe uygulanmaz (talimat §2.2, `:39`).
3. **Tek iş verisi, iki yoğunluk.** Sade ve profesyonel görünüm aynı `Run`/`Job`/`Approval` kaydını okur; fark yalnız yoğunluk ve sunumdur (§2.4, §6.5). İki ayrı sistem yok (talimat §4.2-D, `:267`; aynı-veri cümlesi `:283`).
4. **Gizleme yok, derinleştirme var.** Risk, yetki kapsamı, maliyet ve doğrulama durumu hiçbir yoğunlukta saklanmaz (`02-mental-model.md` §9 madde 3); yalnız vurgu değişir.
5. **Dürüst güvenilirlik.** `VERIFIED/UNVERIFIED` (`packages/core/src/types/job.ts:24`) ve eksik veri ("henüz yok") olduğu gibi gösterilir; heartbeat yazıcısı kapalıyken "takıldı" kovası eksik görünür ve arayüz bunu söyler (`DECISIONS.md:178-198`).
6. **Glass işlevseldir.** Cam yalnız odak katmanında (çekmece, onay katmanı, niyet çubuğu açılımı); liste satırları düz yüzeydir (§6).
7. **Mobil birincil amaçlar için tasarlanır**, masaüstü küçültmesi değildir (§4).

## 2. Bilgi mimarisi ve gezinme haritası

### 2.1 Bugün ve hedef

Bugünkü yan menü 13+ doğrudan öğe (`packages/ui/components/Sidebar.tsx:15-29`), komut paleti `Cmd/Ctrl+K` (`packages/ui/components/CommandPalette.tsx:72`). Hedef: 4 ana hedef (Başla · İşler · Şirketler · Yönet çekmecesi; Kaput ayrı hedef değil, iş sayfasının en derin kipidir); eski rotalar silinmez, çekmece ve palette altında kalır (uzman bulunabilirliği, §4.3 "uzman yeteneği gizleme" kuralı).

| Kat | Öğe | İçerik | Kaynak yüzey |
|---|---|---|---|
| Ana | **Başla** (`/`, girişliyken) | Niyet çubuğu + "benden beklenen" + son işler | yeni; `StarterPicker.tsx`, `OnboardingChecklist.tsx` yeniden kullanılır |
| Ana | **İşler** (`/inbox`) | 4 kova: Onayını bekliyor · Çalışıyor · Takıldı · Bitti; iş çekmecesi | `packages/ui/app/inbox/page.tsx`, `components/inbox/InboxParts.tsx` |
| Ana | **Şirketler** (`/companies`) | Şirket durumu, ekip, ajanlar, harcama, entegrasyonlar | `app/companies/**`, `app/dashboard` |
| Kip | **Kaput** (iş sayfasının derin kipi, `/runs/[id]`; ana gezinme öğesi değil) | Adımlar, araç çağrıları, model, yetki, maliyet, günlük | `packages/ui/app/runs/[id]/page.tsx` |
| Ana (4.) | **Yönet** (çekmece) | Ajanlar, Modeller ve bağlantılar, Entegrasyonlar, Webhook, Faturalama, Ayarlar, Riskler, A/B, Analitik | mevcut rotalar |
| Ses | **Niyet çubuğu** | her sayfanın üstünde (`Cmd/Ctrl+K` ile odak) | `CommandPalette.tsx` genişletilir |

### 2.2 Kavram ayrımı (§4.3 "kavramları karıştırma")

- **Şirket** = kiracı çalışma kapsamı (`companyId`). **Ajan** = şirkete bağlı kalıcı iş arkadaşı (`/companies/:id/agents`, `packages/ui/lib/api.ts:633`). **İş** = bir niyetin kayıtlı yürütmesi (Job/Run, ADR-0001). **Proje** = ayrı varlık değildir; bu fazda iş etiketi olarak gösterilir (yeni model yok).
- İş satırı her zaman "hangi şirket · hangi ajan" ikilisini taşır; sohbet geçmişi iş sayfasının bir kipidir, ayrı kutu değildir.

### 2.3 Navigasyon haritası

```
Başla ──niyet──► sohbet | plan kartı | ajan taslağı
  │                │            │            │
  ▼                ▼            ▼            ▼
İşler (kova) ─► İş çekmecesi ─► Özet ─► Çıktı ─► Kaput
  ▲                                              │
  └── bildirim / mobil rozet ◄── Onay katmanı ◄──┘
Şirketler ─► şirket durumu ─► (ajanlar, harcama, entegrasyonlar)
Yönet (çekmece) ─► Ajanlar · Modeller · Bağlantılar · Ayarlar …
```

### 2.4 Sade / profesyonel yoğunluk kuralı

Tek anahtar "Ayrıntı: Sade · Tam" (kullanıcı tercihi, `localStorage` + hesap ayarı, varsayılan Sade). **Aynı alanlar** iki kipte de okunur: durum, kova, şirket, ajan, maliyet, risk, doğrulama, onay ayrıntısı. Sade: tek satır özet + tek rakam maliyet. Tam: aynı alanlar + model adı, adım sayısı, heartbeat zamanı, araç listesi, Receipt'in ham alanları. Test (§13 T7): aynı iş iki kipte açılır, her alan değeri birebir aynıdır; yalnız etiket yoğunluğu değişir.

## 3. Ekran listesi

| # | Ekran | Rota (hedef) | Mevcut karşılık | Not |
|---|---|---|---|---|
| E1 | Niyet / Başla | `/` (girişli) | yok (`app/page.tsx` pazarlama) | yeni; ayrı rota bayrağı UX-04 |
| E2 | Sohbet | iş sayfası kipi | yok (`ls packages/api/src/modules` içinde `chat` yok, `03-concepts.md` §1) | **bağımlılık: sohbet ucu (L)** |
| E3 | İş tarifi + plan kartı | E1 içinde panel | `POST /jobs/plan` `packages/api/src/modules/jobs/router.ts:53` | API hazır |
| E4 | Çalıştır | plan kartından | `POST /jobs/start` `jobs/router.ts:121` | API hazır |
| E5 | İşler (gelen kutusu) | `/inbox` | `packages/ui/app/inbox/page.tsx` | main'de (#127) |
| E6 | İş çekmecesi (Özet/Çıktı) | `/inbox?run=<id>` | `ReceiptPanel` `InboxParts.tsx:162`; `GET /runs/:id/receipt` `run/router.ts:1178` | |
| E7 | Kaputu Aç | `/runs/[id]` | `packages/ui/app/runs/[id]/page.tsx:671`, `:730` | yeniden düzenleme |
| E8 | Onay katmanı | `/inbox` içinde sheet; `/approvals` yedek | `app/approvals/page.tsx`, `ApprovalGroups` `InboxParts.tsx:135` | |
| E9 | Ajan oluştur | `/companies/:id/agents/new` | `composeAgent` `packages/ui/lib/api.ts:640-650` | doğal dilden taslak hazır |
| E10 | Şirket durumu | `/companies/:id` | `app/companies/**`, `SpendForecastCard.tsx`, `PresenceBar.tsx` | |
| E11 | Modeller ve bağlantılar | `/settings/models` (Yönet) | `app/connections`, `app/integrations`, `ComparePanel.tsx` | **model başına maliyet API yok** |
| E12 | Yönet çekmecesi | her yerden | `Sidebar.tsx:15-29` kalan öğeler | |
| E13 | Bildirim zili | üst çubuk | `packages/ui/components/NotificationBell.tsx` | `/settings` çakışma hatası (01 §10) düzeltilir |
| E14 | Kod kipi | sonraki faz | yok; `desktop/src/pty.ts` | bu faz: yalnız inceleme-kabul |

## 4. Mobil / masaüstü stratejisi

Mobil birincil amaçlar (talimat §4.2-J, `:347`): iş başlat, durum, onay/red, çıktı incele, ajan duraklat, kısa yönlendirme, model/şirket değiştir. Web (bu belge) **mobil tarayıcıda da bu yedi amacı karşılar**; yerel mobil uygulama (`mobile/`) aynı kova/kart sözleşmesini paylaşır.

| Amaç | Mobil web / uygulama | Masaüstü | Durum (kanıt) |
|---|---|---|---|
| İş başlat (**kurucu kararına bağlı**; varsayılan: mobilde kapalı) | Alt sabit niyet çubuğu; ses (`mobile/lib/voice.ts`, bkz. `03-concepts.md` §3.c) | Üst çubuk + `Cmd+K` | web: API hazır; uygulamada `/jobs` çağrısı yok (`mobile/lib/api.ts`) |
| Durum | İşler = ana ekran, kova sekmeleri | Kova + çekmece yan yana | var (kova) |
| Onay/red | Alt sheet, büyük düğmeler, tehlikeli işte ikinci adım | Onay katmanı | var (`mobile/lib/api.ts:1286`; alan uyumsuzluğu `:997-1008`) |
| Çıktı incele | Çekmece tam ekran | Çekmece sağ | web var (Receipt), mobil UI yok |
| Ajan duraklat | İş satırından `pause` (`run/router.ts:331`) | aynı | ajan düzeyi uç yok |
| Kısa yönlendirme | "Yönlendir" tek satır (`run/router.ts:817`, `mobile/lib/api.ts:1243`) | aynı | var |
| Model/şirket değiştir | Üst şirket seçici; model Yönet'te | Çubuk + Yönet | kısmi |

Kırılma noktaları: ≤640 px tek sütun + alt gezinme (Başla · İşler · Şirketler · Yönet); 641–1023 px liste + tam ekran çekmece; ≥1024 px liste + yan çekmece. Derin kod düzenleme mobilde sunulmaz; mobilde yalnız **değişikliği incele ve kabul et** (diff özeti, test sonucu, Kabul/Reddet) tasarlanır; düzenleme masaüstü/CLI'de kalır. **Masaüstü (Tauri) ve CLI rolü:** masaüstü uygulaması yerel çalıştırma ve kod geliştirme yüzeyidir (`desktop/src/pty.ts`, yerel onay ledger'ı `desktop/src/governance.ts`, 01 §3) ve bu faz web tasarımına dokunmaz; aynı kova/kart dilini benimsemesi ileride ayrı biletle istenir. Masaüstü platform Job/Run/Approval sözleşmesini bugün kullanmaz (01 §3); bu belge ona yeni uç dayatmaz. CLI niyet çubuğunun metin karşılığıdır: `braavo runs`, `approve`, `pause`, `steer`, `stop` kova/iş komutlarıdır (`cli/src/braavo.ts:1325`, `:2518`, `:2544`), `--json` otomasyon içindir (`cli/src/forge/output.ts:56`); `braavo runs --bucket` yeni istemci işidir (API hazır). Derin kod ve uzun otomasyon CLI/masaüstünde, onay ve izleme her yüzeyde yapılır. (CLI atıfları `:1325`, `:2518`, `:2544` 03-concepts/01-audit'ten devralındı; CLI main'inde doğrulanmalı.)

**Mobil konumlama uyarısı:** `mobile/CLAUDE.md` mobili "Read + approve, don't build" diye konumlar; talimat §4.2-J ise iş başlatmayı birincil amaç sayar (`03-concepts.md:19`). Bu belge mobilde iş BAŞLATMAYI **kurucu kararına bağlı** sayar; UX-05j varsayımı: mobil yalnız oku + onayla + duraklat + yönlendir. Dokunma hedefi ≥44 px; alt çubuk güvenli alanı (`env(safe-area-inset-bottom)`) kullanır.

## 5. Wireframe'ler (ASCII)

Gösterim: Sade kip. Köşeli `[ ]` düğme, `( )` seçili, `▓` cam katman, `░` düz yüzey. Örnek sayılar gösterimdir. Alan kaynağı: **(API ister)** = bugün yok, yeni API kalemi (§14 önkoşullar); **(örnek)** = kaynak alanı doğrulanmamış gösterim metni; etiketsiz alan API'de hazırdır.

### 5.1 Niyet / sohbet başlat (E1, E2) — test 4.4-1

```
┌ Braavolabs ▾ Şirket: Atölye    🔔2 ┐
│ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ │
│ ▓ Ne yapmak istiyorsun?        🎤  ▓ │
│ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ │
│  Anladığım: ( Sohbet ) İş  Ajan     │  ← sınıflayıcı önizlemesi, değiştirilebilir
│  ░ Benden beklenen ░░░░░░░░░░░░░░░  │
│  ░ 2 onay · 1 takıldı     [Aç]  ░  │
│  Son işler                          │
│  ● Rapor taslağı   çalışıyor  0,42$ │
│  ✓ Fatura özeti    bitti ✔doğrul.   │
└──────────────────────────────────────┘
```
"Sohbet" seçiliyken Enter tek sütun konuşmaya geçer (iş kaydı sohbet türü olarak açılır; E2 bağımlılığı). Sınıflayıcı güveni düşükse varsayılan **sohbet**, tarif yalnız "İş" seçilince plana gider.

### 5.2 İş tarif et → plan kartı → çalıştır (E3, E4) — test 4.4-2

Birinci örnek **onaysız (düşük risk, geri alınabilir)** iştir; `STEP_APPROVAL_GATE` kapalıyken de başlatılır:

```
┌ ▓ "Müşteri e-postalarını özetle ve ▓┐
│ ▓  taslak olarak kaydet"      [Planla]▓│
├──────────────────────────────────────┤
│ ░ PLAN (3 adım, örnek)  risk: düşük  ░│
│ ░ 1 Talebi netleştir, kaynak topla  araç: read      ░│
│ ░ 2 Taslak çıktıyı hazırla          araç: draft     ░│
│ ░ 3 Sonucu özetle ve sun            araç: summarize ░│
│ ░ Tahmini maliyet: 0,02–0,06 $ (örnek aralık)│  ← estimate.costUsd aralığı
│ ░ [Düzenle]  [Çalıştır ▸]            ░│
└──────────────────────────────────────┘
```
Plan kartı `POST /jobs/plan`'ın döndüğü adım, araç, risk ve `estimate.costUsd` aralığını gösterir (`packages/api/src/modules/jobs/router.ts:36-48`, `:53`; `packages/api/src/modules/jobs/plan.ts:29`); "Çalıştır" `POST /jobs/start` çağırır (`jobs/router.ts:121`). Adım başına model satırı bu sürümde YOK (API ister).

**Bayrak açıkken (`STEP_APPROVAL_GATE=true`) onaylı iş** (T2'de değil; ayrı doğrulama): plan, onay gerektiren adımı `risk:"high"`, `needsApproval:true` ile işaretler (`plan.ts:308`):

```
│ ░ 3 Slack'e gönder (onay gerekli)  ⚠ yüksek risk ░│
```
Bayrak KAPALIYKEN bu kart `/jobs/start`'ta 422 `high_risk_start_unsupported` döner (`DECISIONS.md:178`); arayüz bunu "Bu iş şu an otomatik başlatılamaz; sebep: …" diye açık gösterir, düğmeyi gizlemez, sessiz düşmez. Bayrağı açmak kurucu kararıdır (OPERASYON KURALI, `DECISIONS.md:178`). Bu yüzden UX test T2 onaysız örnekle yapılır.

### 5.3 Devam eden iş (E5, E6) — test 4.4-3

```
┌ İşler        [Onay 2] Çalışıyor 3  Takıldı 1  Bitti ┐
│ ░ Bu hafta harcama: 3,10$ (örnek; haftalık toplam alanı yok)│
│ ▲ Onayını bekliyor (yüksek katman, sabit)           │
│ ░ Slack'e gönder · Atölye · ⚠ orta (örnek; API ister: risk alanı) [İncele] │
│ ● Çalışıyor                                         │
│ ░ Rapor taslağı · adım 2/3 · 0,42$ · 14 sn önce     │
│   ┌─ çekmece ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓┐        │
│   │ Özet | Çıktı | Kaput        [Duraklat]  │        │
│   │ Şimdi: "Özetle" çalışıyor               │        │
│   │ [Yönlendir…]                            │        │
│   └─────────────────────────────────────────┘        │
└──────────────────────────────────────────────────────┘
```
Kovalar `GET /runs?bucket=` ve `GET /approvals?groupBy=run` (`packages/ui/lib/api.ts:402-404`); kova hesabı `jobBucket` (`packages/core/src/types/job.ts:129`). "Takıldı" bayat heartbeat'i yalnız `JOB_STATE_DUAL_WRITE` açıkken kapsar; kapalıyken şerit altında "Bazı takılmalar henüz görünmüyor" notu çıkar (`DECISIONS.md:178-198`).

### 5.4 Onay anlama (E8) — test 4.4-4, §4.2-I

```
┌ ▓ ONAY: Slack'e mesaj gönder ⚠ orta (API ister: risk alanı) ▓┐
│ ▓ Ne yapacak: #genel kanalına 1 mesaj ▓│
│ ▓ Araç: slack.post                     ▓│
│ ▓ Yetki: yazma (API ister)             ▓│
│ ▓ Aktarılan veri: … (API ister)        ▓│
│ ▓ Tutar: —                             ▓│
│ ▓ Geri alma: … (API ister)             ▓│
│ ▓ Taslak:  "Bu hafta 14 e-posta…"      ▓│
│ ▓ [Reddet]            [Onayla]         ▓│
└────────────────────────────────────────┘
tehlikeli (geri alınamaz/para): ikinci adım
 "Gönderimi onaylıyorum" yazın + sebep alanı
```
Hazır alanlar: `description`, `amountUsd`, `metadata.toolName`, tür, süre (`packages/ui/components/inbox/InboxParts.tsx:111-114` bugün araç adı ve tutarı gösterir), exact-action damgası (ADR-0002, `DECISIONS.md:95`); karar `POST /approvals/:id/decide` (`packages/api/src/modules/approval/router.ts:247`). **API ister:** liste ucu `metadata`'yı yalnız `toolName`'e indirir (`packages/api/src/modules/approval/list-select.ts:9-11`, `:42-51`; `approval/router.ts:121`); "yetki kapsamı", "aktarılan veri", "geri alma yolu" alanları API'de YOK (`03-concepts.md:65`, `:344`). Wireframe'deki bu üç satır **(API ister)** etiketlidir; veri gelmezse "bilgi yok" yazılır, uydurulmaz. **Uyarı (toplu onay):** "düşük risk, geri alınabilir toplu onay" yalnız risk/geri alma alanı gerçekten dolu olduğunda önerilebilir; 03b(b) notu gereği işaretsiz adımdaki yan etkili araç yalnız araç meta'sı + autonomy'ye kalır (`DECISIONS.md:177`), yani "düşük risk" etiketi bugün tam güvenilir değildir. Bu alan API'ye gelene kadar toplu onay **kapalıdır**; her onay tek tek kararlanır (ADR-0002 exact-action hakkı korunur).

### 5.5 Ajan oluştur (E9) — test 4.4-5

```
┌ Yeni ajan                              ┐
│ ▓ Nasıl bir iş arkadaşı istiyorsun?   ▓│
│ ▓ "Her sabah satış e-postalarını       ▓│
│ ▓  özetle"                   [Taslak] ▓│
│ ░ Ad: Satış Özetçisi  Rol: analist    ░│
│ ░ Araçlar: gmail ✓  slack ✓           ░│
│ ░ Çıkarılan araç: (bağlı değil) 1     ░│
│ ░ Yetki: onay iste ▾ (örnek; kaynak alan doğrulanmadı)│
│ ░ Bütçe: 5$/gün (örnek; kaynak alan doğrulanmadı)│
│ ░ ▸ Gelişmiş (model, kurallar, akış)  ░│
│ ░ [Oluştur]                           ░│
└──────────────────────────────────────┘
```
`composeAgent` taslak üretir ve bağlı olmayan araçları `droppedTools` ile bildirir (`packages/ui/lib/api.ts:640-650`); arayüz bu listeyi saklamaz. Güvenilirlik bölümü ajan sayfasında: son N işin sonucu (`VERIFIED/UNVERIFIED` sayısı), gerçek veriden; yoksa "henüz iş yok".

### 5.6 Şirket durumu (E10) — test 4.4-6

```
┌ Atölye ▾          1 onay · 0 takıldı ┐
│ ░ Çalışan 2 · Bitti (7g) 11 · 3,10$ (örnek)░│  ← tek satır özet, KPI kartı yığını yok
│ ░ Ajanlar   Satış Özetçisi ● boşta    ░│
│ ░ Ekip      3 kişi · 1 yönetici       ░│
│ ░ Risk      1 açık (orta)             ░│
│ ░ Entegrasyon gmail ✓ slack ✓         ░│
│ ░ Geçmiş ▸                            ░│
└────────────────────────────────────────┘
```
Tek ekran, tek satır özet; bölümler açılır. KPI kart yığını yoktur (§4.3 madde 1). Kovanın şirket süzgeci `companyId` ile (`03-concepts.md` §3.f F).

### 5.7 Kaputu Aç (E7) — test 4.4-7, §4.2-D

```
┌ Rapor taslağı · Atölye · ✔ doğrulandı │
│ [Özet] [Çıktı] (Kaput)    Ayrıntı:Tam │
│ ░ Model/yönlendirme/yetki dökümü: API ister (sonraki sürüm)
│ ░ Adımlar (3)   ▸ 1 oku  ▸ 2 özetle  ▸ 3 gönder
│ ░ Araç çağrıları  gmail.list 120ms ✓ …
│ ░ Maliyet: 0,42$ (toplam)
│ ░ El değiştirme (handoff) · Günlük · Hatalar
│ ░ [Yeniden çalıştır] [Adımı yeniden çalıştır]
└────────────────────────────────────────┘
```
Aynı `Run` kaydı: araç çağrıları `runs/[id]/page.tsx:671`, `:730`, maliyet `:471`, handoff `:411-416`. İlk sürüm = adım + araç + maliyet + handoff; model, yönlendirme kararı ve yetki dökümü yeni API ister (`03-concepts.md:71`). Adım yeniden çalıştırma `run/router.ts:1065` (`/steps/:id/rerun`), adım rollback `:1034`, tüm koşu yeniden denemesi `:432` (`/retry`, ADR-0003 04d notu). Kaput, üç kipin en derinidir; Receipt `GET /runs/:id/receipt` (`run/router.ts:1178`).

### 5.8 Model maliyeti ve erişim yetkisi (E11) — test 4.4-8, §4.2-H

```
┌ Modeller ve bağlantılar               ┐
│ ░ Otomatik seçim  (açık)              ░│
│ ░ claude-…   sağlayıcı: Anthropic     ░│
│ ░   Erişim: bu şirket · okuma/yazma   ░│
│ ░   Maliyet: bu ay —  (veri yok)      ░│
│ ░ Kendi API anahtarım  [Ekle]         ░│
│ ░ Yerel model          [Bağla]        ░│
│ ░ Karşılaştır ▸ (ComparePanel)        ░│
└────────────────────────────────────────┘
```
**Bilinen boşluk:** model başına maliyet toplamı için API yok (`03-concepts.md` §3.f H; `02-mental-model.md` §4.4 #8). Bu yüzden test 8 ancak bu API (M) eklenince tam geçer; o zamana kadar iş başına yalnız toplam maliyet Kaput'ta gösterilir (`runs/[id]/page.tsx:471`; orada model alanı yoktur) ve model ekranı "veri yok" der. Model adı, yönlendirme kararı ve yetki dökümü de **API ister**.

### 5.9 Gelen kutusu — mobil (E5, E8) — §4.2-J

```
┌ İşler          Atölye ▾  ┐
│ [Onay 2] Çalışıyor 3 …   │
│ ▓ Slack'e gönder ⚠ (API ister: risk alanı) ▓│
│   [Reddet]  [Onayla]     │
│ ░ Rapor taslağı 0,42$    │
│   adım 2/3   [⏸] [↦]     │
├──────────────────────────┤
│ ▓ Ne yapmak istiyorsun? ▓│  ← alt sabit çubuk
│ Başla İşler Şirket Yönet │
└──────────────────────────┘
```

### 5.10 Yönet çekmecesi (E12)

```
┌ Yönet                       ✕ ┐
│ ░ Ajanlar          ›          ░│
│ ░ Modeller ve bağlantılar ›   ░│
│ ░ Entegrasyonlar   ›          ░│
│ ░ Webhook · Faturalama ›      ░│
│ ░ Riskler · Analitik · A/B ›  ░│
│ ░ Ayarlar          ›          ░│
│ ░ Ara… (Cmd+K ile her sayfa)  ░│
└────────────────────────────────┘
```
Eski rotalar (`Sidebar.tsx:15-29`) korunur; çekmece yalnız gruplar.

### 5.11 Bildirim zili (E13)

```
┌ 🔔 2 ▾ ┐
│ ▓ Onay: Slack'e gönder   2 dk ▓│
│ ▓ Takıldı: Rapor taslağı 9 dk ▓│
│ ▓ [Tümü → İşler]              ▓│
└────────────────────────────────┘
```
Kaynak `packages/ui/components/NotificationBell.tsx`; öğe tıklanınca ilgili iş çekmecesi açılır. Masaüstünde "Çıkış" ile çakışma (01 §10) düzeltilir.

### 5.12 Kod değişikliğini incele ve kabul et (E14, yalnız inceleme)

```
┌ Değişiklik: login hatası düzeltmesi    ┐
│ ░ Dosyalar (3)  ▸ auth.ts +12 −4       ░│
│ ░ Testler: 41 geçti · 0 kaldı          ░│
│ ░ [Reddet]            [Kabul et]       ░│
└─────────────────────────────────────────┘
```
Düzenleme yok. Kod iş türü ve diff/test çıktı alanı **API ister** (bugün yok); satırlar gösterimdir. Mobilde aynı kart.

### 5.13 Durum çizimleri (§9)

```
Yükleme:    ░░░░░░░░░░ (sabit iskelet) "İşler yükleniyor…"
Hata:       ┌ İşler yüklenemedi: sunucu yanıt vermedi ┐  [Yeniden dene]
Çevrimdışı: ═ Çevrimdışısın · son bilinen durum 14:02 ═  (Onayla/Reddet kapalı)
403:        ┌ Bu işlem için yetkin yok (approval:decide). Yönetici: … ┐
Boş:        "Henüz iş yok. Tarif et: …" [Niyet çubuğuna git]
Onay bekliyor: ▲ üst kova, rozet 2
```

## 6. Glass bileşen ve davranış kuralları

### 6.1 İlke
Cam = **odak katmanı**. Üç katman: arka plan (düz yüzey: liste), orta (seçili iş), ön (onay/sheet/niyet çubuğu açılımı). Aynı anda en çok **bir** ön cam katmanı. Liste satırı ve kartlar cam olmaz (performans + okunabilirlik).

### 6.2 Bugünkü tokenlar
`.glass-panel`: `blur(24px) saturate(1.2)`, `rgba(15,18,25,0.75)` (`packages/ui/app/globals.css:222-226`); `.glass-card`: `blur(20px)` (`:233-236`); açık tema override `:124-134`; üçüncü bir `blur(20px)` tanımı `:875`. Yeni renk eklenmez; opaklık ve bulanıklık bu tokenlardan türer.

### 6.3 Bileşen kuralları

| Bileşen | Katman | Cam? | Kural |
|---|---|---|---|
| Niyet çubuğu | ön (kapalıyken düz) | odaklanınca | Kapalı: düz yüzey; odakta `glass-panel` açılım (≤1 yüzey) |
| Kova listesi | arka | hayır | düz, kontrast ≥ AA |
| İş çekmecesi | orta | evet | yalnız seçilince; liste bağlamı görünür |
| Onay katmanı | ön | evet | tehlikeli işte arka plan karartması + odak tuzağı |
| Plan kartı | orta | hafif | blur ≤12px; metin arkası opak şerit |
| Toast (`Toast.tsx`) | ön | hayır | düz, `role="status"` |
| Kaput panelleri | orta | hayır | yoğun veri = düz |

### 6.4 Davranış
- Blur yarıçapı üst sınırı 24px; çekmece ve onay katmanı dışında `backdrop-filter` yok.
- `@supports not (backdrop-filter)` ya da `prefers-reduced-transparency` ya da pil tasarrufu: katman **opak** yüzeye düşer (metin kontrastı korunur).
- Işık/yansıma: `glass-card::before` degrade (`globals.css:243`) yalnız hover'da ve yalnız çekmece/onay katmanında; sürekli animasyon yok.
- Odak: odak halkası cam üstünde bile 3:1; Esc katmanı kapatır.

### 6.5 Sade / Tam
Cam kuralı iki yoğunlukta aynı; Tam kipte yalnız bilgi satırı çoğalır (§2.4).

## 7. Ekranlar arası geçişler ve animasyon

| Geçiş | Davranış | Süre/eğri | Azaltılmış hareket |
|---|---|---|---|
| Niyet → plan kartı | çubuk üstte kalır, kart altından büyür | 220 ms ease-out | anında |
| Plan → Çalıştır → iş satırı | kart satıra "uçar" (paylaşılan öğe) | 280 ms | anında, satır vurgusu |
| Satır → çekmece | sağdan/alttan kayma | 240 ms | anında |
| Özet → Çıktı → Kaput | kip morfu: aynı başlık, içerik çapraz solma | 180 ms | kesme |
| Onay sheet | alttan açılır, arka karartma | 200 ms | anında |

Yalnız `transform`/`opacity` animasyonu; `width/height/top` yok. `prefers-reduced-motion: reduce` altında tüm geçişler anında (`globals.css:1375`, `:1421`, `:1451` mevcut kalıp). Süre >300 ms olmaz; yükleme iskeleti pulse yerine sabit.

## 8. Boş durum ve gerçek veri kuralları

1. **Uydurma sayı yok.** Veri gelmediyse "henüz yok", sıfır değil. Mock yalnız `?preview` bayrağıyla ve her sayfada görünür "ÖRNEK VERİ" şeridi (yeni kural; 01 §10 yalnız denetim çekimlerinin `-mock` adlandırmasını tarif eder).
2. **Boş ≠ hata.** `/approvals` 500'de "Her şey temiz!" gösterilmez; hata durumu ayrı bileşendir (`ApprovalsLoadError` `packages/ui/components/approvals/ApprovalsStatus.tsx:7`, boş `:30`; `/approvals` hata yutma düzeltmesi #128).
3. **Boş durum eylem önerir:** İşler boşsa "Tarif et: …" örnek niyet (gerçek şirket araçlarından türetilir; araç yoksa "Önce bir entegrasyon bağla").
4. **Yeni kullanıcı:** Şirket yoksa Başla, şirket sihirbazını önerir (`packages/ui/app/companies/new/page.tsx:361`).
5. **Sayılar:** maliyet `money()` (`InboxParts.tsx:24`); veri null → "—" ve nedeni.
6. **Doğrulama:** `UNVERIFIED` sonuç "doğrulanmadı" olarak sarı değil nötr; `VERIFIED` yalnız Receipt `resultStatus` ise.

## 9. Yükleme, çevrimdışı, hata, izin reddi ve onay durumları

| Durum | Gösterim | Eylem | Kaynak |
|---|---|---|---|
| Yükleme | sabit iskelet + `role="status"` metni | — | `app/inbox/page.tsx:134`, `:167` |
| Çevrimdışı | üst şerit "Çevrimdışısın; son bilinen durum" + eylem düğmeleri kapalı, onay yazılmaz | kuyruğa onay YOK (güvenlik) | mobil çevrimdışı yönlendirme (`01-audit.md:119`) |
| API hatası | kutu: ne oldu + [Yeniden dene] | tek tık | `ErrorBox` `InboxParts.tsx:69` |
| İzin reddi 403 | "Bu işlem için yetkin yok: `approval:decide`" + kimden isteneceği | — | `approval/router.ts:247` (`requirePermission`) |
| Onay bekliyor | iş satırı üstte, yüksek katman, rozet | İncele | ADR-0003 `needs_approval` |
| Onay reddedildi | satır "reddedildi · iptal" | Yeniden tarifle | `DECISIONS.md:178` (red koşuyu iptal eder) |
| Onay süresi doldu | `EXPIRED` ayrı etiket | Yeniden iste | `approval/router.ts:80`, `:91` (durum listesi); gerçek süre dolumu `:264-265` (409 "Approval expired") |
| Yarış/409 | `retry_*` kodları insan metnine eşlenir | — | ADR-0003 04d tablosu |
| 429 | "Çok hızlı; N sn sonra" | otomatik geri sayım | `planLimiter` `jobs/router.ts:53` |
| Takıldı | kova + heartbeat yaşı | Yeniden dene / Durdur | `run/router.ts:432` (`/retry`), `:289` |

Her hata metni iki parçadır: ne oldu, kullanıcı ne yapabilir; teknik kod yalnız Tam kipte/Kaput'ta görünür.

## 10. Erişilebilirlik ve performans

**Erişilebilirlik:** WCAG 2.2 AA hedefi. Klavye: `Cmd/Ctrl+K` niyet odağı (`CommandPalette.tsx:72`), kovalar ok tuşlu sekme (`BucketTabs` `InboxParts.tsx:38`), çekmece Esc. `aria-modal` paleti (`CommandPalette.tsx:165-166`). Tek canlı bölge (`aria-live="polite"`) ilerleme/hata duyurusu; onay katmanında `role="alertdialog"` ve odak tuzağı. Renk tek başına anlam taşımaz (kova etiketi + simge). Atlama bağlantısı (`packages/ui/app/layout.tsx:276`). RTL `ar` aynalama (`layout.tsx:259`; borç: 01 §1.8). 14 dilde uzun etiketler için `min-width` yok, kırpma yok (test T10).

**Performans:** QA-UX-01 §5 maddeleri bu belgeye bağlanır: (a) en çok 1 ön cam katmanı; (b) liste sanal kaydırma ≥200 satırda (şimdi sayfalama `limit=25`, `lib/api.ts:402`); (c) animasyon yalnız compositor özellikleri; (d) ilk anlamlı içerik bütçesi: mobil 4G'de kova sayıları ≤2,5 sn; (e) bulanıklık maliyeti düşük donanımda opak yedek (§6.4); (f) niyet sınıflayıcı çağrısı debounce 400 ms ve iptal edilebilir (`signal` kalıbı `lib/api.ts:402`). İstisna: sınıflayıcı (sunucu) gecikmesi ölçülmeden bütçe yazılmaz; UX-04 ölçer.

## 11. Bileşen eşleme (mevcut → yeni)

| Mevcut (dosya:satır) | Yeni rol | Değişiklik |
|---|---|---|
| `packages/ui/components/Sidebar.tsx:15-29` | 4 ana hedef + Yönet çekmecesi | öğe kümesi azalır; eski rotalar çekmece/palette |
| `packages/ui/components/CommandPalette.tsx:72`, `:165` | Niyet çubuğu girişi | tarif satırı + sınıflayıcı önizlemesi eklenir |
| `packages/ui/components/inbox/InboxParts.tsx:38` `BucketTabs` | Kova şeridi | yatay kaydırma, mobil alt sekme |
| `InboxParts.tsx:195` `RunRow` | İş satırı | risk + şirket·ajan alanı eklenir |
| `InboxParts.tsx:162` `ReceiptPanel` | Çekmece "Özet" | aynı |
| `InboxParts.tsx:135` `ApprovalGroups`, `:85` `ArtifactView` | Onay katmanı gövdesi | araç/yetki/veri alanı |
| `InboxParts.tsx:69` `ErrorBox`, `:81` `EmptyBox` | durum bileşenleri | yeniden kullanım |
| `packages/ui/components/approvals/ApprovalsStatus.tsx:7`, `:30` | durum | yeniden kullanım |
| `packages/ui/app/runs/[id]/page.tsx:671`, `:730`, `:471` | Kaput | bölümler üç kipe taşınır |
| `packages/ui/components/ComparePanel.tsx` | Model karşılaştırma | E11'e taşınır |
| `packages/ui/components/RunStepHeatmap.tsx`, `PipelineCanvas.tsx` | Kaput grafiği (salt-okur) | motordan kopuk düzenleme YOK (§4.3) |
| `packages/ui/components/StarterPicker.tsx`, `OnboardingChecklist.tsx` | Başla ilk-kullanım | yeniden kullanım |
| `packages/ui/components/SpendForecastCard.tsx`, `PresenceBar.tsx` | Şirket durumu | tek satır özet |
| `packages/ui/components/NotificationBell.tsx` | Zil + mobil rozet | `/settings` çakışma düzeltmesi |
| `packages/ui/components/Toast.tsx`, `SkipLink.tsx` | aynı | aynı |
| `packages/ui/app/globals.css:222`, `:233`, `:875` | Glass tokenlar | tek tanım + opak yedek |
| `packages/ui/lib/api.ts:393-408` | istemci | `jobs.plan/start` eklenir (UX-05a) |

Yeni bileşenler: `IntentBar`, `PlanCard`, `JobDrawer`, `ApprovalSheet`, `DensityToggle`, `StatusStrip`, `AgentDraft`, `ModelCostRow`.

## 12. Geçiş planı

1. **UX-04 prototip:** ayrı rota `/lab/ux` (bayrak: `NEXT_PUBLIC_UX_LAB`, varsayılan KAPALI), bugünkü ekranlara dokunmaz; 8 yolculuk gerçek API'yle (veri yoksa "henüz yok").
2. **UX-05a–05j alt biletleri (taslak):**

| Bilet | İçerik | Bağımlılık |
|---|---|---|
| 05a Başlangıç/Niyet | `IntentBar`, plan kartı, `jobs.plan/start` istemcisi | UX-04 |
| 05b Birleşik çalışma alanı | iş sayfası kip morfu (Özet/Çıktı/Kaput); sohbet kipi ayrı | 05a, sohbet ucu |
| 05c İşler | satır alanları (risk, şirket·ajan, maliyet), çekmece | 05a |
| 05d Kaputu Aç | `runs/[id]` yeniden düzeni | 05c |
| 05e Kod ortamı | yalnız inceleme-kabul (diff/test); düzenleme sonraya | 05d |
| 05f Şirketler/ekip | tek satır özet, şirket süzgeci | 05c |
| 05g Ajanlar | `AgentDraft`, güvenilirlik | 05f |
| 05h Model/bağlantı | `ModelCostRow`; **model başına maliyet API (M)** önkoşul | API işi |
| 05i Onay ve güvenlik merkezi | `ApprovalSheet`, tehlikeli ikinci adım; toplu önizleme yalnız risk/geri alma alanı API'den gelince; mobil alan uyumu | 05c, onay ayrıntı API'si |
| 05j Mobil | alt gezinme, alt sheet, ses | 05c, 05i, mobil `Approval` eşleme |

3. **Eski ekranlar:** UX-05 sonunda eski rota yönlendirir, silinmez; geri alma bayrak kapatma.
4. **Veri/migration:** bu yön migration gerektirmez; K2'nin çalışma kaydı varlığı erteleme.

## 13. UX test senaryoları

Katılımcı: rehbersiz yeni kullanıcı (en az 5) + 2 profesyonel. Başarı: görevi ≤ süre içinde, yardımsız.

| ID | Senaryo (talimat §4.4) | Başarı ölçütü |
|---|---|---|
| T1 | Normal sohbet başlat | ≤30 sn, ≤2 tıklama; sohbet seçilmeden "İş" planına düşmez |
| T2 | İş tarif et (onaysız, düşük riskli örnek), planı oku, çalıştır | ≤90 sn; risk ve tahmini maliyet aralığını sözle söyler. Onaylı örnek ayrı, `STEP_APPROVAL_GATE` açıkken |
| T3 | Devam eden işi bul | ≤20 sn; doğru kova |
| T4 | Onay isteyen işlemi anla | "ne yapacak/hangi araç/tutar" 3/3 doğru (hazır alanlar); yetki/veri/geri alma soruları alanlar API'ye gelince eklenir |
| T5 | Ajan oluştur | ≤3 dk; `droppedTools` uyarısını fark eder |
| T6 | Şirket durumunu incele | tek ekranda onay/takıldı/harcama sayılarını söyler |
| T7 | Gelişmiş görünümü aç | Kaput'a ≤2 tıkta; adım, araç çağrısı ve maliyeti bulur; Sade/Tam aynı değerler (model/yetki dökümü API gelince eklenir) |
| T8 | Modelin maliyeti ve erişim yetkisi | maliyet verisi yoksa "veri yok" der; yetkiyi doğru okur |
| T9 | Profesyonel: kod incele, model seç, otomasyon yönet | Yönet çekmecesi/palette ile ≤3 tık |
| T10 | Erişilebilirlik: yalnız klavye + ekran okuyucu + `ar` + reduced-motion | 8 görevin hepsi tamamlanır, odak kaybı yok |

## 13b. Bağımlılıklar ve riskler

| Konu | Durum | Etki |
|---|---|---|
| 03b(b) düşük-risk yan etki açığı | `config.needsApproval` yürütücüde zorlanmaz; işaretsiz adımdaki yan etkili araç yalnız araç meta'sı + autonomy'ye kalır (`DECISIONS.md:177`) | "Düşük risk" etiketi tam güvence değildir; toplu onay kapalı (§5.4) |
| 03d `STEP_APPROVAL_GATE` | varsayılan KAPALI; açmak kurucu kararı (`DECISIONS.md:178`) | Onaylı iş örneği bayrak açıkken; kapalıyken 422 açıkça gösterilir (§5.2) |
| Mobil konumlama | `mobile/CLAUDE.md` "Read + approve, don't build" ↔ talimat §4.2-J iş başlatma (`03-concepts.md:19`) | Mobilde iş BAŞLATMA kurucu kararı gerektirir; UX-05j varsayımı: oku + onayla + duraklat + yönlendir |
| Heartbeat bayrağı | kapalıyken "takıldı" eksik (`DECISIONS.md:178-198`) | arayüz söyler |
| Yeni API kalemleri | bkz. §14 önkoşullar | ölçülemeyen testler işaretli (§14.3) |

## 14. Backlog ve kabul ölçütleri

Backlog = §12 tablosu (05a–05j) + önkoşullar: (a) sohbet ucu (L), (b) niyet sınıflayıcı (M), (c) model başına maliyet API (M), (d) mobil `Approval` alan eşleme (M, `mobile/lib/api.ts:997-1008`), (e) satır alanları risk/ilerleme/öngörülen maliyet (`run/router.ts:107-121`'de yok); (f) **onay ayrıntı API'si**: yetki kapsamı, aktarılan veri, geri alma yolu (liste ucu `metadata`'yı `toolName`'e indirir: `approval/list-select.ts:9-11,42-51`); bilet adayı `BRA-UX-API-01`; (g) **model + yönlendirme + yetki dökümü API'si** (Kaput sonraki sürüm); bilet adayı `BRA-UX-API-02`; (h) kod iş türü diff/test çıktı alanı (E14); (i) mobilde iş başlatma için kurucu kararı (§13b).

**Genel kabul (her alt bilet):** (1) mevcut işlev kaybolmaz (rota listesi regresyon testi); (2) Job/Run/Approval sözleşmesi değişmez (sözleşme testleri yeşil); (3) QA-UX-01 §5'in ilgili A11Y/PERF maddeleri kanıtla işaretli ya da ADR-0004'te istisna; (4) çalıştırılmış ekran görüntüsü (masaüstü 1440×900, mobil 390×844, koyu/açık) ve CI 3/3; (5) sahte veri yok.

### 14.1 §4.2 A–J eşlemesi

| Harf | Alan | Bu belgede | Wireframe/Kural |
|---|---|---|---|
| A | Başlangıç/Niyet | §1, §2.1, §5.1 | 5.1 |
| B | Birleşik çalışma alanı | §2.1, §5.7, §7 | kip morfu (Özet/Çıktı/Kaput); sohbet bağımlılığı §3 E2 |
| C | İşler/görev yönetimi | §5.3, §9 | 5.3 |
| D | Kaputu Aç | §2.4, §5.7 | 5.7 |
| E | Kod ortamı | §3 E14, §4, §12 05e | inceleme-kabul fazı; düzenleme ertelendi |
| F | Şirketler/ekip | §5.6 | 5.6 |
| G | AI ajanları | §5.5 | 5.5 |
| H | Model/bağlantı | §5.8 | 5.8 |
| I | Onay/güvenlik merkezi | §5.4, §9 | 5.4 |
| J | Mobil | §4, §5.9 | 5.9 |

### 14.2 §4.3 "istenmeyenler" kontrol listesi

| # | İstenmeyen | ✔ | Kanıt bölümü |
|---|---|---|---|
| 1 | Çok KPI kartlı klasik dashboard | ✔ | §5.6 tek satır özet; kova şeridinde tek toplam harcama |
| 2 | Her şeyi sohbet kutusuna hapsetme | ✔ | §5.1 (sınıflayıcı önizlemesi, sohbet yalnız bir kip), §2.1 dört ana hedef |
| 3 | Ajan/şirket/görev/proje karışıklığı | ✔ | §2.2 |
| 4 | Teknik olmayana API/workflow zorunluluğu | ✔ | §5.5 "Gelişmiş" katlı, §2.4 Sade varsayılan |
| 5 | Uzman yeteneğini gizleme | ✔ | §2.1 Yönet çekmecesi + palette, §5.7 Kaput, `ComparePanel` §11 |
| 6 | Görsel akışı motordan koparma | ✔ | §11 (`PipelineCanvas` salt-okur; düzenleme motorsuz yok) |
| 7 | Onay ayrıntısını gizleme | ✔ | §5.4 (alanlar, "bilgi yok" açıkça) |
| 8 | Model/araç durumunu olduğundan güvenilir gösterme | ✔ | §1.5, §8 madde 1 ve 6, §5.8 "veri yok" |

### 14.3 §4.4 testin 8 maddesi — ölçüm yöntemi ve eşik

| # | Madde | Ölçüm yöntemi | Eşik | Bilinen engel |
|---|---|---|---|---|
| 1 | Normal sohbet | rehbersiz gözlemli test (T1), görev süresi/tık | ≥4/5 başarılı, ≤30 sn | sohbet ucu (L) yoksa **ölçülemez** |
| 2 | İş tarif et ve çalıştır | T2, plan kartı anlama sorusu | ≥4/5 başarılı, ≤90 sn | `/jobs/*` hazır |
| 3 | Devam eden iş | T3 | ≥4/5, ≤20 sn | kova hazır |
| 4 | Onay anlama | T4, 3 soru | ≥90% doğru | yetki/veri/geri alma alanları API'de yok (API ister) |
| 5 | Ajan oluştur | T5 | ≥4/5, ≤3 dk | `composeAgent` hazır |
| 6 | Şirket durumu | T6 | ≥4/5, tek ekran | — |
| 7 | Gelişmiş görünüm | T7, Sade/Tam eşitlik betiği (alan karşılaştırma testi) | ≥4/5; alan eşitliği %100 | model/yönlendirme/yetki dökümü API'si yok; ilk sürüm adım+araç+maliyet |
| 8 | Model maliyeti/yetkisi | T8 | ≥4/5 | model başına maliyet API (M) **yok** |

Atıf doğrulama: `sed -n` ile açılan örnekler `packages/ui/lib/api.ts:393-408`, `packages/ui/components/inbox/InboxParts.tsx:38-195`, `packages/ui/app/globals.css:222-236`, `packages/api/src/modules/jobs/router.ts:53,121`, `packages/api/src/modules/approval/router.ts:247`, `packages/api/src/modules/run/router.ts:289,331,432,817,1178`, `packages/core/src/types/job.ts:24,129`; hepsi `6f90242` ağacında mevcut.
