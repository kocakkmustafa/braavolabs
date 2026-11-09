# BRA-UX-02 · 03 — Braavolabs tasarım konseptleri ve karar matrisi (Aşama 3)

Tarih: 2026-11-09 · Kapsam: yalnız konsept ve değerlendirme. Konsept SEÇİLMEZ (BRA-UX-03 ADR'si seçer). Renk, font, token değeri, marka önerisi yoktur; mevcut kimlik aynen korunur (talimat §1). Kod yazılmadı.

Atıf biçimi: `packages/...:satır` platform deposu (`origin/main` `e3e83d6`, bu dalın tabanı); `desktop/...`, `cli/...`, `mobile/...` ilgili depoların `origin/main` kaynağı (01 §0); `01 §n` = `01-audit.md` bölümü, `02 §n` = `02-mental-model.md` bölümü. Bu belgede kullanılan her `dosya:satır` atfı yazılmadan önce dosya açılıp doğrulandı. Doğrulanamayan her şey "doğrulanamadı".

## 0. Ortak zemin (üç konseptin de dayandığı gerçekler)

Üç konsept aynı veri üzerinde durur; fark gezinme ve kullanım mantığındadır. Ortak gerçekler:

- **Bugünkü durum:** girişli kullanıcıya 13 öğeli yan menü (`packages/ui/components/Sidebar.tsx:15-28`), ilk ekran 4 KPI'lı dashboard (`packages/ui/app/dashboard/page.tsx:215`), sohbet ve genel iş girişi yok (01 §1.1), `/runs` menüde yok (`packages/ui/app/dashboard/page.tsx:434` ile erişilir; 02 §4). Bu, talimat §4.3 ilk maddesinin ("çok KPI'lı dashboard") bugün VAR olduğu anlamına gelir (02 §4.3).
- **İş sözleşmesi hazır:** `POST /jobs/plan` (`packages/api/src/modules/jobs/router.ts:53`; sohbet ise `{intent:"chat"}`), `POST /jobs/start` (`:121`, bu tabanda main'dedir; 01'deki "#123 açık" notu artık eskidir), `GET /runs?bucket=` (`packages/api/src/modules/run/router.ts:84-89`), `GET /approvals` (`packages/api/src/modules/approval/router.ts:88`), `POST /approvals/:id/decide` (`:247`), `GET /runs/:id/receipt` (`packages/api/src/modules/run/router.ts:1145`). Kova tek kaynak `packages/core/src/types/job.ts:62`, `:129` (ADR-0003, `docs/yula-execution/DECISIONS.md:161-176`). Web bunların HİÇBİRİNİ tüketmez (01 §1.4).
- **Sınır (yüksek riskli başlatma kapalı):** `risk:"high"` ya da `needsApproval` adımlı kart `/jobs/start`ta 422 ile reddedilir; adım-düzeyi onay kapısı 03d bileti (`docs/yula-execution/DECISIONS.md:177`). Hiçbir konsept bu sınırı "çözülmüş" varsayamaz; "tehlikeli işlem" yolu 03d'ye bağlıdır.
- **Yok olan, yeni API gerekenler (bu belgede "yeni API gerekir" diye işaretlenir):** sohbet yürütme ucu (`jobs/plan` yalnız sınıflar; sohbet rotası yok, 01 §5.1), bağlam/iş parçacığı birleşik kaydı, model başına fiyat/erişim özeti (02 §4.4 #8), iş-başına birleşik "teknik görünüm" (araç çağrısı + yönlendirme kararı + yetki sınırı tek yanıtta).
- **Korunacaklar:** `Run.status` 7 değer donmuş (ADR-0001, `docs/yula-execution/DECISIONS.md:7`); onay hakkı ADR-0002 (`:95`); Job/Run/Approval/Receipt sözleşmeleri değişmez.
- **Ortak erişilebilirlik tabanı (her konseptte geçerli, konseptlere özgü ayrıntı ilgili bölümde):** odak halkası zaten global (`packages/ui/app/globals.css:716`), reduced-motion medya sorguları var (`packages/ui/app/globals.css:1375`), skip-link hedefi var (`packages/ui/components/SkipLink.tsx:7`), `dir` `ar` için RTL (`packages/ui/app/layout.tsx:259`), 14 dil `packages/ui/i18n/locales.ts:2`. Ama 18 dosyada fiziksel yön sınıfları var (01 §1.8): RTL için mantıksal özellik geçişi her konseptin işidir.

Kısaltmalar: S = 1-3 gün · M = 1-2 hafta · L = 3+ hafta (tek mühendis, kaba; web+mobil birlikte sayılırsa ~1,5×).

---

## KONSEPT 1 — «Niyet Çubuğu» (niyet merkezli başlangıç; yüzey niyete göre belirir)

### 1.a Fikir ve gezinme mantığı

Uygulamanın tek kalıcı öğesi altta/üstte duran bir **niyet çubuğudur**; menü yoktur. Kullanıcı yazar, söyler ya da yapıştırır; sistem niyeti sınıflar (sohbet, araştırma, iş/otomasyon, kod, yönetim) ve **yüzey ona göre belirir**: soruya konuşma yüzeyi, işe plan kartı, "şirketimin durumu" ya da "onaylarım" diyene durum yüzeyi (talimat §2.2). Gezinme "nereye gideyim" değil "ne yapmak istiyorum"dur; geri dönüş, çubuğun hemen üstündeki **son niyetler şeridiyle** olur. Sınıflama API'de kısmen hazırdır: `POST /jobs/plan` mesajı `chat` ya da iş olarak ayırır (`packages/api/src/modules/jobs/router.ts:53`, `classifyIntentRule` `:65-66`), iş ise plan kartı döner (`packages/api/src/modules/jobs/plan.ts:29` adım başı `needsApproval`/`risk`).

```
 [ son niyetler şeridi: "Q4 raporu" · "müşteri e-postaları" · "onay bekleyen 2" ]
 ┌─────────────────────────── YÜZEY (niyete göre belirir) ─────────────────────────┐
 │  sohbet │ plan kartı │ durum/onay │ karşılaştırma │ (kod → masaüstü/CLI)          │
 └───────────────────────────────────────────────────────────────────────────────────┘
 [ ➤ Ne yapmak istiyorsun?  ·  /komut  ·  @şirket  ·  ⌘K ]   ← tek kalıcı öğe
        │ "Kaputu Aç" (her yüzeyde bir düğme) → aynı iş, teknik katman
        └ ayarlar/hesap: çubuğun yanındaki profil menüsü (dil, tema, anahtar, fatura)
```

### 1.b Basit sorudan şirket yönetimine ilerleyiş

1. **Normal sohbet:** "Bu sözleşmeyi özetle" → çubuk `chat` sınıfı → sohbet yüzeyi. *Yeni API gerekir* (sohbet yürütme; `jobs/plan` yalnız `{intent:"chat"}` döner, `jobs/router.ts:65-66`, 01 §5.1).
2. **İş tarif et ve çalıştır:** "Her pazartesi satış e-postalarını özetle ve bana gönder" → plan kartı (adımlar, tahmini maliyet bandı, risk) → "Başlat" → `POST /jobs/start` (`packages/api/src/modules/jobs/router.ts:121`; `planHash`+`idempotencyKey` zorunlu).
3. **Devam eden iş:** çubuğa "devam eden işlerim" ya da şeritteki rozet → kova yüzeyi (`GET /runs?bucket=working`, `packages/api/src/modules/run/router.ts:84-89`); duraklat/yönlendir tek dokunuş (`:330`, `:816`).
4. **Onay anlama:** işin kartında "Onay bekliyor" belirir; dokununca onay yüzeyi açılır (ne yapacak, neye erişecek, hangi veri, tutar; bölüm 1.d). `GET /approvals` satırı `run→pipeline→company` taşır (`packages/api/src/modules/approval/router.ts:88`, 01 §5.1); araç/risk alanları bugün ekranda yok (`packages/ui/app/approvals/page.tsx:161-197`).
5. **Ajan / şirket yönetimi:** "Satış için bir iş arkadaşı oluştur" → ajan yüzeyi; mevcut doğal dil kurma akışı (`packages/ui/app/companies/[id]/page.tsx:195-227`, `api.composeAgent`, `packages/ui/lib/api.ts:623`) çubuğun hedefi olur. "Şirketimin durumu" → şirket durum yüzeyi (kova sayıları, bekleyen onay, harcama; KPI kartı yığını değil, bir cümlelik özet + dokunulabilir satırlar).
6. **Kaputu Aç:** bir işin yüzeyinde düğme → bölüm 1.e.

### 1.c Dört yüzeyin rolü

| Yüzey | Rol |
|---|---|
| Web | Tam çubuk + tüm yüzeyler; birincil "iş tarif et" yeri. Şirket ve ajan yüzeyleri burada derin. |
| Desktop | Aynı çubuk; ek olarak yerel araçlar ve **kod**: niyet "kod" ise yüzey dosya/diff/önizleme çalışma kipine geçer (`desktop/src/ui.ts:505` çalışma alanı + inspector `:967`, `desktop/src/pty.ts`). Yerel eylem kapısı `desktop/src/ui.ts:2279` korunur. |
| Mobil | Çubuk = ses/dikte + kısa metin (`mobile/lib/voice.ts` (origin/main `5e60a75`:77), 01 §4); birincil amaçlar §4.2-J: iş başlat, durum, onay/red, çıktı incele, ajan duraklat, kısa yönlendirme. Kod yüzeyi YOK; "kod" niyeti "masaüstünde/CLI'da devam et" bağlantısına düşer. Mevcut sohbet ekranı `mobile/app/chat/index.tsx` ve onay sekmesi `mobile/app/(tabs)/approvals.tsx` hazır çekirdek. |
| CLI | Çubuğun metin karşılığı: `braavo ask`, `braavo runs`, `braavo approve` (`cli/src/braavo.ts:1325`, `:2518`); `--json` otomasyon için (`cli/src/forge/output.ts:56`); kod geliştirme CLI'da birinci sınıf. |

### 1.d Onay, maliyet ve risk görünürlüğü

- **Nerede/ne zaman:** plan kartında ÖNCE (başlatmadan; adım başına `risk`/`needsApproval` `packages/api/src/modules/jobs/plan.ts:29`, maliyet bandı `packages/api/src/modules/jobs/router.ts:36-48`'deki taban); çalışırken yalnız eşik/onay olunca belirir; bittiğinde Receipt özeti (`packages/api/src/modules/run/router.ts:1145`).
- **Yoğunluk ayrımı (§4.2-I):** *geri alınabilir/düşük risk* adımlar kartta tek satır ve toplu "Başlat" ile geçer (onay isteği yok); *yan etkisi olan/para/dış veri* adımlar ayrı, genişleyen "Onay gerekir" bloğudur: işin ne yapacağı, hangi araç/entegrasyona eriştiği, hangi veri çıkacağı, tutar (bugün yalnız açıklama+tutar var: `packages/ui/app/approvals/page.tsx:161-175`). *Tehlikeli/geri alınamaz* adımlarda tek dokunuşluk onay yerine açık ikinci adım ve etkiyi yazılı göstermek; sunucu zorlaması 03d'ye bağlı olduğundan **o gelene kadar yüksek riskli iş başlatılamaz** (422, `docs/yula-execution/DECISIONS.md:177`) ve arayüz bunu dürüstçe söyler ("otomatik başlatma şimdilik kapalı").
- **Güvenlik gerçek yetkilendirmeyle:** düğme `approval:decide` iznine bağlı (`packages/api/src/modules/approval/router.ts:247`); görsel ipucu güvenliğin yerine geçmez (§4.2-I).
- **Hata gizlenmez:** bugünkü "hatayı yut" kalıbı (`packages/ui/app/approvals/page.tsx:36`) yerine "yüklenemedi, yeniden dene" durumu (02 §9 madde 4).

### 1.e «Kaputu Aç»

Her yüzeyin köşesinde tek düğme; basıldığında yüzey **aynı koşu kaydının** teknik katmanına genişler (yeni sayfa değil, yerinde katman): adımlar ve araç çağrıları (`packages/ui/app/runs/[id]/page.tsx:671`, `:730`), maliyet (`:471`), model/yönlendirme, yetki sınırı, günlük. Veri aynı `GET /runs/:id` ham koşu + adımlar + onaylar (`packages/api/src/modules/run/router.ts:142-153`; 01 §5.1), canlı akış `GET /runs/:id/stream` (`:867`, web `streamRun` `packages/ui/app/runs/[id]/page.tsx:26`). İki ayrı sistem yoktur: basit görünüm bu kaydın özetidir, teknik görünüm aynı kaydın ham halidir (§4.2-D). Model yönlendirme kararı ve tek-yanıtta birleşik araç/yetki dökümü için *yeni API gerekir*; mevcut alanlarla ilk sürüm adım+araç+maliyetle sınırlıdır.

### 1.f A–J alanlarının yeri

| Alan | Bu konseptteki yeri |
|---|---|
| A Başlangıç | Çubuğun kendisi; boş sohbet+düğme değil, son niyet şeridi ve bağlama göre öneriler. |
| B Birleşik çalışma alanı | Niyete göre değişen tek yüzey alanı; geçişte önceki niyet şeritte kalır (bağlam kaybı yok). *Yeni API gerekir* (bağlam kaydı). |
| C İşler | Kova yüzeyi; çubuktan ("işlerim") ya da rozetten. `GET /runs?bucket=` hazır. |
| D Kaputu Aç | Her yüzeyde düğme (1.e). |
| E Kod geliştirme | Çubuk "kod" niyetini masaüstü/CLI kod kipine devreder; web/mobil yalnız inceleme ve onay. |
| F Şirketler | `@şirket` bağlam seçimi + "şirketimin durumu" yüzeyi (`packages/ui/app/companies/[id]/page.tsx:26` sekmeleri yeniden kullanılır). |
| G Ajanlar | "ajan oluştur" niyeti → `composeAgent` akışı (`:195-227`); klasik CRUD API'de hazır, UI'sı yok (`packages/ui/lib/api.ts:617-622`). |
| H Model/bağlantı | Çubuktaki model rozeti: "otomatik" varsayılan, dokununca seçim (`packages/ui/app/settings/page.tsx:408`; otomatik yönlendirme bugün bulunamadı, 01 §5.3). Karşılaştırma yüzeyi `ComparePanel` (`packages/ui/components/ComparePanel.tsx:58`). |
| I Onay merkezi | Onay yüzeyi + rozet; "onaylarım" niyeti (1.d). |
| J Mobil | Çubuk=ses/metin; kova ve onay yüzeyleri birincil (1.c). |

### 1.g Glass'ın işlevsel rolü

- **Katman = odak hiyerarşisi:** en altta bağlam (son iş/arka plan durumu), ortada çalışan yüzey, en üstte çubuk ve onay katmanı. Bir üst katman açıldığında alttaki katman geri çekilir ve etkileşime kapanır; kapanınca odak çubuğa döner. Bu hiyerarşi bugünkü `bv-glass` panelinin (`packages/ui/app/globals.css:875`) "her şey aynı cam" kullanımını katman rolüne ayırır.
- **Ne zaman beliren yüzey:** onay katmanı yalnız iş onay beklerken; Kaputu Aç katmanı yalnız istenince; maliyet eşiği uyarısı yalnız eşik aşılınca.
- **Erişilebilirlik/performans:** katmanlar bulanıklığa değil yapıya (z-sıra, odak tuzağı, `aria-modal`; palet örneği `packages/ui/components/CommandPalette.tsx:165-166`) dayanır. `prefers-reduced-motion` altında belirme animasyonu anında geçişe düşer (`packages/ui/app/globals.css:1375`); düşük donanımda bulanıklık kapanır, opaklık+sınır ayrımıyla aynı hiyerarşi korunur. Mobilde zaten bulanıklık yok (`BlurView` kullanılmıyor, 01 §4); hiyerarşi gölge/yükseklik ile verilir.

### 1.h Mevcut ekranlardan yeniden kullanım

| Öğe | Durum | Maliyet |
|---|---|---|
| Plan→başlat API | HAZIR (`jobs/router.ts:53`, `:121`) | S (web istemci) |
| Kova listesi API | HAZIR, web tüketmez (01 §1.2: `packages/ui/lib/api.ts:509` `listRuns` yalnız `status`) | S |
| Receipt | HAZIR API, web yok (`run/router.ts:1145`) | S-M |
| Sohbet yüzeyi | YOK web'de; mobilde var (`mobile/app/chat/index.tsx`); sunucu *yeni API gerekir* | L |
| Şirket/ajan yüzeyleri | VAR (`companies/[id]/page.tsx:26`, `:195-227`) | S (yeniden barındırma) |
| Niyet sınıflama (çok sınıflı) | Kural tabanlı chat/iş ayrımı var; kod/yönetim/ajan sınıfları *yeni API gerekir* | M |
| Komut paleti çubuğa temel | VAR (`packages/ui/components/CommandPalette.tsx:8-30`) | S |
| Menü kaldırma + rota köprüleri | Bozuk `/agents` bağlantısı onarılmalı (`packages/ui/app/pipelines/[id]/page.tsx:422`) | S |

Toplam kaba mühendislik maliyeti: **M-L** (sohbet ucu ve çok-sınıflı niyet belirleyici; geri kalanı tüketim işi).

### 1.i Riskler ve §4.3 çakışma kontrolü

| §4.3 maddesi | Durum |
|---|---|
| Çok KPI'lı dashboard | ÇAKIŞMAZ; dashboard kalkar (bugün var: `dashboard/page.tsx:215`). |
| Her şeyi sohbet kutusuna hapsetmek | **RİSK YÜKSEK:** çubuk sohbet kutusuna benzer; önlem: niyet yüzeyleri sohbetten bağımsız yapısal yüzeylerdir (kova listesi, plan kartı, onay katmanı sohbet balonu değildir). |
| Ajan/şirket/görev/proje karışması | Orta risk: `@şirket` ve "iş arkadaşı" dili ayrı tutulmalı (bugünkü `workspaceId=companyId` karışıklığı, 02 §4.3 madde 3). |
| P1'e API/workflow zorunlu göstermek | ÇAKIŞMAZ (menü yok, ayar derinde). |
| Uzman yeteneği gizlemek | **RİSK:** menü olmayınca webhook/pipeline/A-B bulunabilirliği düşer; önlem: ⌘K + `/komut` + Kaputu Aç; erişilebilirlik testi gerekli. |
| Görsel iş akışını motordan koparmak | ÇAKIŞMAZ (iş akışı Kaputu Aç'ta gerçek koşu verisinden). |
| Onay ayrıntısını gizlemek | ÇAKIŞMAZ (1.d). |
| Güvenilirlik şişirmek | Önlem: `UNVERIFIED` sonuç ve `stuck` kovası görünür (`packages/core/src/types/job.ts:24`, `:129`). |

Ek riskler: niyet yanlış sınıflanırsa kullanıcı yanlış yüzeye düşer (önlem: yüzeyin üstünde "bunu istemedim" geri dönüşü); klavye ve ekran okuyucu için çubuk tek kontrol noktası olduğundan etiketli durum duyuruları (`aria-live`) zorunlu; `ar` RTL'de çubuk eylemleri ve komut paleti kısayollarının yön uyumu.

---

## KONSEPT 2 — «Dönüşen Tuval» (birleşik çalışma alanı; bağlam iş parçacığı boyunca taşınır)

### 2.a Fikir ve gezinme mantığı

Kullanıcı bir **tuvale** girer; tuval bir "çalışma"dır (bir şirket içinde bir iş parçacığı). İçeriği, o çalışmanın yaptığı iş değiştikçe **yerinde dönüşür**: soru → sohbet; araştırma → kaynaklı rapor; çoklu model → yan yana karşılaştırma; otomasyon → iş akışı; ajan çalıştırma → görev durumu ve çıktılar; kod → dosyalar/test/önizleme (talimat §4.2-B). Gezinme sayfadan sayfaya değil **tek çalışma içinde kipler arası** dönüşümdür; sol kenarda çalışmalar listesi (bir "çalışma" = bağlam birimi), üstte şirket seçici. Bir kipten ötekine geçerken önceki işin çıktısı **bağlam olarak** sonraki kipe taşınır (ör. araştırma çıktısı → iş akışının girdisi). Bu mantık, bugünkü "her şey ayrı sayfa+form" yapısının (02 §7) tersidir.

```
 [şirket ▾]  Çalışmalar        ┌──────────────── TUVAL (tek çalışma, dönüşebilir) ─────────────────┐
 ─────────────────             │ kip ipucu: sohbet ⇄ araştırma ⇄ karşılaştırma ⇄ iş akışı ⇄ kod     │
 ▸ Q4 raporu       ●çalışıyor  │ ┌ ana içerik ────────────────────────┐ ┌ yan katman (belirir) ────────┐ │
 ▸ Müşteri yanıt…  ◐onay       │ │ (çalışmanın şu anki kipi)          │ │ iş/onay/maliyet/kaynaklar    │ │
 ▸ Site kodu       ✓bitti      │ └────────────────────────────────────┘ └──────────────────────────────┘ │
 + yeni çalışma                │ [ komut/ses satırı ]   ⌥ Kaputu Aç (aynı çalışmanın teknik kipi)        │
                               └───────────────────────────────────────────────────────────────────────────┘
```

### 2.b Basit sorudan şirket yönetimine ilerleyiş

1. **Normal sohbet:** "yeni çalışma" → tuval sohbet kipinde açılır. *Yeni API gerekir* (sohbet yürütme + çalışma/bağlam kaydı).
2. **İş tarif et:** aynı tuvalde "bunu her hafta yap" → tuval **plan kartına** dönüşür (`POST /jobs/plan`, `packages/api/src/modules/jobs/router.ts:53`); "Başlat" → `POST /jobs/start` (`:121`); koşu aynı çalışmaya bağlanır.
3. **Devam eden iş:** çalışmalar listesindeki durum işareti (kova: `packages/core/src/types/job.ts:62`); tuvalde görev durumu ve çıktı kipi; canlı akış `GET /runs/:id/stream` (`packages/api/src/modules/run/router.ts:867`), yönlendirme `SteerDock` (`packages/ui/app/runs/[id]/page.tsx:1285`).
4. **Onay anlama:** onay **tuvalin yan katmanında**, işin bağlamında belirir (işin bu adıma nasıl geldiği, çıktı taslağı, tutar). Taslak içerik bugün `ArtifactCard` ile gösteriliyor (`packages/ui/app/approvals/page.tsx:197`); araç/veri aktarımı eksik (02 §9 madde 1).
5. **Ajan/şirket yönetimi:** tuvalde "bir iş arkadaşı oluştur" → ajan kipi (`composeAgent`, `packages/ui/app/companies/[id]/page.tsx:195-227`); şirket seçici ve "şirket özeti" kipi tüm çalışmaların durumunu bir yerde gösterir.
6. **Kaputu Aç:** çalışmanın aynı tuvali "teknik kip"e döner (2.e).

### 2.c Dört yüzeyin rolü

| Yüzey | Rol |
|---|---|
| Web | Tam tuval, tüm kipler; çok bölmeli (ana içerik+yan katman); araştırma/karşılaştırma/iş akışı kipleri burada en zengin. |
| Desktop | Tuvalin **kod kipi evi**: dosya ağacı, diff, test, önizleme; terminal (`desktop/src/pty.ts`), inspector (`desktop/src/ui.ts:967`), yerel eylem kapısı (`:2279`). Mevcut çalışma alanı iskeleti `desktop/src/ui.ts:505` tuvale en yakın mevcut yapıdır. |
| Mobil | Tuvalin **tek sütunlu, ince kipi**: çalışma listesi + durum + onay + çıktı + kısa yönlendirme (§4.2-J); iş akışı grafiği ve kod düzenleme YOK (yalnız özet ve inceleme). Mevcut `mobile/app/runs/[id].tsx`, `(tabs)/approvals.tsx` çekirdek. |
| CLI | Tuvalin metin kipi: `braavo ask` sohbet/araştırma, `runs`/`steer`/`approve` (`cli/src/braavo.ts:1325`, `:1351`, `:2518`); çalışma kimliğiyle bağlam sürdürme *yeni API gerekir*; kod kipi CLI'da birinci sınıf (`cli/src/forge/local.ts:4-8` yerel model). |

### 2.d Onay, maliyet ve risk görünürlüğü

- **Nerede:** onay ve maliyet, tuvalin **yan katmanı**dır; yalnızca çalışmada onay gerektiren olay ya da maliyet eşiği varsa belirir (kalıcı panel değil). Maliyet kalıcı olarak yalnız çalışma başlığında tek küçük sayı (harcanan/öngörülen).
- **Ayrım (§4.2-I):** düşük risk adımlar tuval akışında "tamamlandı" satırı olarak sessizce geçer; yan etkili adımlar akışı **durdurur** ve yan katmanı açar (ne yapacak/erişim/veri/tutar); tehlikeli adım için açık ikinci adım. Zorlama 03d'ye bağlı (`docs/yula-execution/DECISIONS.md:177`); o güne dek yüksek riskli başlatma 422 (`packages/api/src/modules/jobs/router.ts:121`).
- **Bütçe sınırı görünürlüğü:** `job_budget` önce çalışır (`packages/api/src/modules/governance/engine.ts:52`), eşik ADR-0002'de 0.8 (`docs/yula-execution/DECISIONS.md:112`); tuval başlığı eşik yaklaştığında (yalnız o zaman) uyarı üretir.
- **Çoklu kip bağlam sızıntısı riski:** bir kipten diğerine veri taşınırken "hangi veri bir sonraki adıma gidiyor" açıkça listelenir (veri aktarımı onayın parçası, §4.2-I).

### 2.e «Kaputu Aç»

Tuvalde kip değiştirme zaten mümkün olduğundan "teknik kip" **ek bir kip**tir ve **aynı çalışmanın aynı koşu kaydıdır**: adım grafiği (gerçek koşudan çizilir, tasarlanmış resim değil: `packages/ui/components/PipelineCanvas.tsx:1-12` ReactFlow tabanı yeniden kullanılır, `RunStepHeatmap.tsx` mevcut), araç çağrıları (`packages/ui/app/runs/[id]/page.tsx:671`, `:730`), maliyet (`:471`), model/yönlendirme, yetki, günlük. Basit kip ile teknik kip **aynı bileşen ağacının iki yoğunluğudur**; ayrı veri kaynağı yoktur (§4.2-D). Receipt (`packages/api/src/modules/run/router.ts:1145`) teknik kipin özet başlığıdır. İş akışı grafiğinin motordan kopmaması için grafiğin düzenlenmesi yalnız gerçek pipeline sözleşmesine yazılır (§4.3 madde 6; mevcut `PipelineCanvas` ile gerçek yürütücü ilişkisi 02 §4.3 madde 6'da doğrulanamadı, UX-03 öncesi okunmalı).

### 2.f A–J alanlarının yeri

| Alan | Bu konseptteki yeri |
|---|---|
| A Başlangıç | "Yeni çalışma": tuval boş değil, "şu çalışmayı sürdür" + tarif satırı; ilk kipi niyet belirler. |
| B Birleşik çalışma alanı | KONSEPTİN ÖZÜ; tek tuval, dönüşen kipler, taşınan bağlam. |
| C İşler | Çalışmalar listesi = iş listesi; kova işareti satırda; "tüm işler" süzgeci kovaları açar (`GET /runs?bucket=`). |
| D Kaputu Aç | Tuvalin teknik kipi (2.e). |
| E Kod | Kod kipi = tuvalin masaüstü/CLI'ya özgü dönüşümü; diff/test/önizleme/kabul. |
| F Şirketler | Şirket seçici + "şirket özeti" kipi; çalışmalar şirket altında gruplanır. |
| G Ajanlar | Ajan kipi (oluştur/çalıştır/duraklat); "ajan çalıştır" tuvalde görev durumu kipidir. |
| H Model/bağlantı | Tuval başlığında model rozeti, kip ayarı olarak yan katmanda; `ComparePanel` karşılaştırma kipinin çekirdeği (`packages/ui/components/ComparePanel.tsx:128`). |
| I Onay merkezi | Yan katman; ayrıca "tüm onaylar" tuvali (şirket genelinde). |
| J Mobil | İnce kip (2.c). |

### 2.g Glass'ın işlevsel rolü

- **Katman = odak hiyerarşisi:** tuvalin ana içeriği en az saydam/en sabit katmandır; yan katman (onay/maliyet/kaynak) bir **üst katman** olarak ana içeriğin üzerine biner ve bu sırada ana içerik odağını yan katmana bırakır. Kip dönüşümünde eski içerik bir katman geriye çekilir (geçmiş), yenisi öne gelir; bu, "bağlam kaybolmadı" hissini yapısal olarak verir.
- **Ne zaman beliren:** yan katman olay-güdümlüdür (onay, eşik, kaynak). Kip dönüşüm geçişi (ör. sohbet→plan) bir **morf** olarak tek elemanın yeniden düzenlenmesidir.
- **Erişilebilirlik/performans:** çok katman = çok bulanıklık riski; kural: aynı anda yalnız bir katmanda bulanıklık, diğerleri opak. `prefers-reduced-motion` altında morf yerine anında değişim + "kip: plan" duyurusu (`aria-live`). Düşük donanımda katmanlar opak+sınırla ayrılır.

### 2.h Mevcut ekranlardan yeniden kullanım

| Öğe | Durum | Maliyet |
|---|---|---|
| Plan kartı/başlat | HAZIR API (`jobs/router.ts:53`, `:121`) | S |
| Sohbet kipi | YOK web; sunucu *yeni API gerekir* | L |
| Çalışma/bağlam kaydı (iş parçacığı, kipler arası taşıma) | YOK; *yeni API gerekir* (yeni tablo/uç; şema + migration kurucu onayı ister, `docs/yula-execution/STATUS.md:205`) | L |
| Karşılaştırma kipi | VAR (`ComparePanel.tsx:58`, `:128`); şirket sekmesinden tuvale taşınır | M |
| İş akışı kipi | VAR (`PipelineCanvas.tsx`, `packages/ui/app/pipelines/[id]/page.tsx:346`); düzenleme-yürütme bağı doğrulanmalı | M |
| Görev durumu/çıktı kipi | VAR (`packages/ui/app/runs/[id]/page.tsx:54`, `:671`, `SteerDock :1285`, `HandoffPanel :943`) | M |
| Kod kipi | Desktop'ta kısmi (`desktop/src/pty.ts`, `desktop/src/changes.ts`); web/mobil yok | L |
| Yan katman bileşeni | YOK (yeni bileşen) | M |

Toplam kaba mühendislik maliyeti: **L** (çalışma kaydı + kip yöneticisi + sohbet; ürünün en pahalı konsepti).

### 2.i Riskler ve §4.3 çakışma kontrolü

| §4.3 maddesi | Durum |
|---|---|
| Çok KPI'lı dashboard | ÇAKIŞMAZ. |
| Her şeyi sohbet kutusuna hapsetmek | Düşük risk (sohbet yalnız bir kip). |
| Ajan/şirket/görev/proje karışması | **RİSK:** "çalışma" kavramı yeni bir isim ekler; Company/Workspace/Pipeline/Run adlarıyla dördüncü bir terim doğurur (bugünkü karışıklık: 02 §4.3 madde 3). Önlem: "çalışma" yalnız arayüz sözü olur, veri modeli ADR-0001'deki Job/Run'a eşlenir. |
| P1'e API/workflow zorunlu göstermek | Orta: iş akışı kipi P1'e açık olmamalı (yalnız Kaputu Aç'ta). |
| Uzman yeteneği gizlemek | Düşük (kip kısayolları + teknik kip). |
| Görsel iş akışını motordan koparmak | **RİSK:** tuvalde iş akışı düzenlenebilirse gerçek çalışma motoruyla bağı koparsa §4.3'e düşer; önlem 2.e. |
| Onay ayrıntısını gizlemek | ÇAKIŞMAZ (yan katman ayrıntılı). |
| Güvenilirlik şişirmek | Kip dönüşümünde "çalışıyor/doğrulanmadı" ayrımı korunmalı (`packages/core/src/types/job.ts:24`). |

Ek riskler: dönüşen yüzey ekran okuyucuda "sayfa değişti" bilgisi verilmezse yönelim kaybı (önlem: kip değişiminde odak ve duyuru yönetimi); klavye ile kipler arası geçişin tutarlı kısayolları; RTL'de iki bölmeli yerleşimin aynalanması; mobilde ince kipin tuvalle tutarlılığı.

---

## KONSEPT 3 — «İş Akışı / Gelen Kutusu» (iş ve onay merkezli; zaman ve durum ekseni)

### 3.a Fikir ve gezinme mantığı

Uygulama bir **işler gelen kutusudur**: ana eksen ADR-0003'ün dört kovasıdır — **Çalışıyor · Onayını bekliyor · Bitti · Takıldı** (`packages/core/src/types/job.ts:62`; ADR-0003 tablosu `docs/yula-execution/DECISIONS.md:161-176`). Kullanıcı her gün açtığında "benden ne bekleniyor" sorusunun cevabını görür; yeni iş, kutunun başındaki tek tarif satırıyla başlar; sohbet, bir işin içinde ya da başında bir **iş türüdür** (gelen kutusunun ayrı yüzeyi değil). Gezinme: (1) kova → (2) iş → (3) iş içi katman (özet / çıktı / teknik). Bu mantık "durum ekseni" (zaman ve olay merkezli); Konsept 1 niyet eksenli, Konsept 2 bağlam/kip eksenlidir.

```
 [ tarif satırı: "yeni iş…" ]                                [şirket ▾] [profil]
 ┌ Onayını bekliyor (2) ──── ÖNE ÇIKAR (odak) ───────────────────────────────────────┐
 │  ◐ "Müşteriye teklif gönder" — gönderim · $4.20 · kaynak: CRM      [İncele] [Red]  │
 └──────────────────────────────────────────────────────────────────────────────────────┘
 Çalışıyor (3)   │   Takıldı (1)   │   Bitti (bugün 12)         ← kova şeridi (klavye: 1-4)
   iş satırı → dokun → iş sayfası: [ Özet │ Çıktı │ Maliyet │ Kaputu Aç ]
 Şirketler · Ajanlar · Bağlantılar: tek "Yönet" çekmecesi (günlük akışın dışında)
```

### 3.b Basit sorudan şirket yönetimine ilerleyiş

1. **Normal sohbet:** tarif satırına soru; plan sınıflama `chat` dönerse **sohbet türü iş** olarak açılır (kendi satırı, geçmişi) ve gelen kutusunda "Bitti" altında kalır. Sohbet yürütme *yeni API gerekir* (`packages/api/src/modules/jobs/router.ts:53` yalnız sınıflar).
2. **İş tarif et ve çalıştır:** tarif satırı → plan kartı (adım+bant+risk, `packages/api/src/modules/jobs/plan.ts:29`) → "Başlat" → `/jobs/start` (`packages/api/src/modules/jobs/router.ts:121`) → iş "Çalışıyor"da görünür.
3. **Devam eden iş:** "Çalışıyor" kovası `GET /runs?bucket=working` (`packages/api/src/modules/run/router.ts:84-89`); satırda ilerleme/maliyet; yönlendirme/duraklat satırdan (`:816`, `:330`). Bugünkü "devam eden işi bulma" hatası (02 §4: `/runs` menüde yok) burada **birincil ekrandır**.
4. **Onay anlama:** "Onayını bekliyor" kovası sayfanın en üstünde, işin ayrıntılı kartıyla (3.d). Web'de bugünkü `/approvals` listesi (`packages/ui/app/approvals/page.tsx`) bu kovanın ilk sürümüdür.
5. **Ajan/şirket yönetimi:** "Yönet" çekmecesi → şirketler (`packages/ui/app/companies/[id]/page.tsx:26` sekmeleri), ajanlar (`:195-227` doğal dille kurma), bağlantılar/model (`packages/ui/app/settings/page.tsx:408`). Şirket durumu: şirket süzgeci kovaların filtresidir ("bu şirkette 3 iş, 1 onay").
6. **Kaputu Aç:** iş sayfasının dördüncü katmanı (3.e).

### 3.c Dört yüzeyin rolü

| Yüzey | Rol |
|---|---|
| Web | Tam gelen kutusu + iş sayfaları + Yönet çekmecesi; geniş ekranda üç sütun (kova/iş/ayrıntı). |
| Desktop | Gelen kutusu + yerel işler (yerel eylem kapısı `desktop/src/ui.ts:2279` onayları aynı kovada "Onayını bekliyor" olarak görünür; bugün desktop platform onay sözleşmesini kullanmıyor: 01 §2 → bu konsept eşlemeyi zorunlu kılar). Kod işi: iş sayfasının "kod" katmanı (dosyalar/diff/test/önizleme; `desktop/src/changes.ts`, `pty.ts`). |
| Mobil | **Bu konseptin en doğal yüzeyi:** gelen kutusu = ana ekran; onay/red, durum, çıktı, ajan duraklat, kısa yönlendirme (§4.2-J birebir); iş başlatma tarif satırı (ses dahil, `mobile/lib/voice.ts` (origin/main `5e60a75`:77)). Mevcut sekmeler `(tabs)/approvals.tsx`, `workflows.tsx`, `index.tsx` (`mobile/app/_layout.tsx:259-300`) bu yapıya en yakın. Kod düzenleme yok. |
| CLI | `braavo runs`, `approve`, `pause`, `steer`, `stop` zaten kova/iş komutlarıdır (`cli/src/braavo.ts:1325`, `:1351`, `:2518`, `:2544`, `:2554`); `braavo runs --bucket` *yeni istemci işi* (API hazır). Çıktı `--json` (`cli/src/forge/output.ts:56`). |

### 3.d Onay, maliyet ve risk görünürlüğü

- **Nerede/ne zaman:** onay, sayfanın **en üstünde sabit kova**dır; bildirim ve mobil rozetle bütünleşir (`packages/ui/components/NotificationBell.tsx`). Maliyet her iş satırında tek rakam (harcanan; öngörülen varsa), kova şeridinde toplam harcama tek satırda (KPI kartı yığını DEĞİL). Risk iş satırında yalnız yüksek ise işaret.
- **Ayrım (§4.2-I):** düşük risk geri alınabilir onaylar **toplu** ("hepsini onayla", yalnız aynı şirket/aynı eylem türü; önce ayrıntı özetini gösterir) ve gelen kutusunda tek satırdır; yan etkili işlerde işin **kartı genişler** (ne yapacak, hangi araç/entegrasyon, hangi veri, tutar, geri alma yolu varsa); tehlikeli işte ikinci adım + sebep metni. Zorlama 03d'ye bağlı (`docs/yula-execution/DECISIONS.md:177`); kart "otomatik başlatma kapalı" durumunu dürüstçe gösterir.
- **Veri uyumsuzluğu:** mobil `Approval` alan adları API ile eşleşmez (`mobile/lib/api.ts:997-1008` `reason/costUsd/payload` ↔ API `description/amountUsd/metadata`, 01 §4); bu konsept onay kartını ortak bir veri biçimine (`GET /approvals`, `packages/api/src/modules/approval/router.ts:88`) zorunlu bağlar; ön koşul mobil eşleme düzeltmesidir (M).
- **Hata/takılı iş:** "Takıldı" kovası bayat heartbeat'i gösterir (`packages/core/src/types/job.ts:129`); heartbeat yazarı bayrak kapalıyken çalışmaz (`docs/yula-execution/DECISIONS.md:178-198`), bu yüzden kova yalnız `status`tan hesaplanan kısmı gösterir; arayüz bunu "bazı takılmalar henüz görünmüyor" diye saklamaz.

### 3.e «Kaputu Aç»

İş sayfasında üç katman aynı koşu kaydının farklı yoğunluklarıdır: **Özet** (Receipt: `packages/api/src/modules/run/router.ts:1145`, sonuç `VERIFIED/UNVERIFIED` `packages/core/src/types/job.ts:24`) → **Çıktı** → **Kaputu Aç** (adımlar, araç çağrıları `packages/ui/app/runs/[id]/page.tsx:671`, `:730`; maliyet `:471`; handoff `:411-416`; model ve yetki). Bu, bugünkü `runs/[id]` sayfasının yeniden düzenlenmiş halidir; ayrı sistem yok (§4.2-D). Yeniden çalıştırma ve adım rollback API'de hazır (`packages/api/src/modules/run/router.ts:1033`, `:1064`); retry bayrağa bağlı (`docs/yula-execution/DECISIONS.md:189-198`).

### 3.f A–J alanlarının yeri

| Alan | Bu konseptteki yeri |
|---|---|
| A Başlangıç | Tarif satırı + o günün "benden beklenen" özeti (onay/takıldı sayısı) — niyet girişinin yanında durum. |
| B Birleşik çalışma alanı | Zayıf: iş sayfası kipi değiştirir (özet/çıktı/teknik/kod) ama kipler arası bağlam taşıma sınırlı. |
| C İşler | KONSEPTİN ÖZÜ (4 kova, geçmiş, yeniden çalıştır, plan-gerçek karşılaştırması iş sayfasında). |
| D Kaputu Aç | İş sayfası katmanı (3.e). |
| E Kod | İş türü "kod"; web/mobil inceleme-kabul, masaüstü/CLI geliştirme. |
| F Şirketler | Şirket süzgeci + Yönet çekmecesi; her şirket "kova sayıları" ile özetlenir. |
| G Ajanlar | Yönet çekmecesi; ajanın işleri kovalarda süzülür ("bu ajanın bitirdikleri" güvenilirlik görünürlüğü). |
| H Model/bağlantı | Yönet çekmecesi; iş satırında kullanılan model; model başına maliyet özeti *yeni API gerekir* (02 §4.4 #8). |
| I Onay merkezi | "Onayını bekliyor" kovası (3.d). |
| J Mobil | Gelen kutusu ana ekranı (3.c). |

### 3.g Glass'ın işlevsel rolü

- **Katman = odak hiyerarşisi:** üç katman: arka plan (kova listesi), orta (seçili iş sayfası), ön (onay kartı/sheet). "Onayını bekliyor" kovası sayfa üstünde **yüksek katmanda** (en çok odak) durur; çalışan işler arka planda sakin. Seçili işin ayrıntısı listenin üzerine **çekmece katmanı** olarak biner (sayfa değiştirmez; liste bağlamı görünür kalır).
- **Ne zaman beliren:** onay sheet'i yalnız onay seçilince; Kaputu Aç katmanı yalnız istenince; "takıldı" uyarısı yalnız `stuck` varsa.
- **Erişilebilirlik/performans:** liste satırları cam değil düz yüzeydir; cam yalnız çekmece ve onay katmanında (az yüzey = az bulanıklık maliyeti). `prefers-reduced-motion` altında çekmece anında açılır; odak çekmeceye taşınır, kapanınca satıra döner (`aria-modal`+odak tuzağı). Düşük donanımda bulanıklık kapanır, kenarlık ve yükseklik farkı kalır.

### 3.h Mevcut ekranlardan yeniden kullanım

| Öğe | Durum | Maliyet |
|---|---|---|
| Kova API | HAZIR (`run/router.ts:84-89`, `approval/router.ts:88`) | S |
| Gelen kutusu ekranı | YOK (web `/runs` yalnız `status` süzer: `packages/ui/app/runs/page.tsx:188`; `/inbox` ayrı PR #127'de incelemede, bu belgenin tabanında yok) | M |
| Onay kartı | VAR, eksik: araç/risk/veri aktarımı yok (`packages/ui/app/approvals/page.tsx:161-197`); API satırı alan taşır (`approval/router.ts:100-121`, 02 §9) | M |
| İş sayfası katmanları | VAR parçalar (`packages/ui/app/runs/[id]/page.tsx:54`, `:411-416`, `:1285`), yeniden düzenleme | M |
| Receipt özeti | API HAZIR, UI yok | S-M |
| Yönet çekmecesi | Parçalar VAR (şirket, ajan, ayar) | M |
| Sohbet türü iş | YOK; *yeni API gerekir* | L |
| Mobil onay veri eşlemesi | Düzeltme gerekir (`mobile/lib/api.ts:997-1008`) | M |
| Desktop'ı platform onayına bağlama | YOK (`desktop/src/client.ts` içinde `/approvals` yok, 01 §2) | M-L |
| Menü sadeleştirme | `Sidebar.tsx:15-28` küçülür | S |

Toplam kaba mühendislik maliyeti: **M** (API büyük ölçüde hazır; asıl iş web/mobil/desktop tüketimi ve onay kartı).

### 3.i Riskler ve §4.3 çakışma kontrolü

| §4.3 maddesi | Durum |
|---|---|
| Çok KPI'lı dashboard | **RİSK:** gelen kutusu sayaçları KPI kartına dönüşebilir; önlem: sayaç yalnız kova etiketidir, kart yığını yok. |
| Her şeyi sohbet kutusuna hapsetmek | ÇAKIŞMAZ. |
| Ajan/şirket/görev/proje karışması | Düşük: "iş" = Job/Run (ADR-0001 söz dağarcığı, `docs/yula-execution/DECISIONS.md:20-21`) tek terim; şirket yalnız süzgeç. |
| P1'e API/workflow zorunlu göstermek | ÇAKIŞMAZ. |
| Uzman yeteneği gizlemek | **RİSK:** ürün "iş dolabı"na dönüşürse pipeline/A-B/webhook/analiz keşfi zayıflar; önlem: Yönet çekmecesi + komut paleti + Kaputu Aç. |
| Görsel iş akışını motordan koparmak | ÇAKIŞMAZ. |
| Onay ayrıntısını gizlemek | ÇAKIŞMAZ ve bu konseptin en güçlü yanı (onay kartı genişler). |
| Güvenilirlik şişirmek | `UNVERIFIED` ve `stuck` açık işaret; heartbeat bayrağı kapalıyken eksik tespit dürüstçe gösterilir. |

Ek riskler: "gelen kutusu" bildirim yorgunluğu doğurabilir (toplu onay yoğunluk dengesi); yalnız iş merkezliyse keşif/yaratma hissi (özgünlük) zayıf kalır; ekran okuyucu için kova değişiminde `aria-live` bildirimi ve iş sayısı değişince odak kaybı; RTL'de üç sütunun aynalanması; 14 dilde uzun etiketlerin kova şeridine sığması.

---

## 4. Karar matrisi (1 = zayıf, 5 = güçlü; mühendislik maliyetinde 5 = en ucuz)

Gerekçelerdeki atıflar `01 §`/`02 §` ve koddur. Puanlar yalnız konseptin **mevcut kodla ve sözleşmelerle** ilişkisine dayanır; beğeni değildir.

| Ölçüt | K1 Niyet Çubuğu | K2 Dönüşen Tuval | K3 İş/Gelen Kutusu |
|---|---|---|---|
| **Kullanım kolaylığı** | **5** — Tek giriş, menü yok; "ilk 5 saniyede ne yapabilirim" cevabı verir (bugün verilmiyor: 02 §3, `dashboard/page.tsx:215`). | **3** — Kip dönüşümleri güçlü ama "çalışma/kip" kavramı öğrenme ister; yön kaybı riski. | **4** — "Benden ne bekleniyor" evrensel anlaşılır; yeni iş başlatma tek satır. Bugünkü başarısız "devam eden işi bul" testi (02 §4.4 #3) düzelir. |
| **Özgünlük** | **3** — Komut/niyet çubuğu bilinen bir kalıp; fark, yüzeyin niyete göre belirmesi ve glass katmanlarıdır (§2.4 riski: sohbet kutusuna benzer). | **5** — Bağlam taşıyan dönüşen tuval ve kip morfu bilinen SaaS iskeletlerinden belirgin ayrışır. | **3** — Gelen kutusu kalıbı tanıdık; farkı onay-merkezli kart ve işler/şirketler ayrımıdır. |
| **Erişilebilirlik** | **4** — Tek kontrol noktası klavye/ekran okuyucuda kolay (palet zaten `aria-modal`: `CommandPalette.tsx:165-166`); ama dinamik yüzey duyurusu şart ve `ar` RTL aynalama borcu (01 §1.8). | **3** — Dönüşen yüzey ve çok bölmeli düzen odak/duyuru yönetimini zorlaştırır; reduced-motion'da morf düşürülmeli (`globals.css:1375`). | **4** — Liste/kova yapısı doğrusal ve klavye-dostu; azaltılmış hareket etkisi küçük; mobil için en doğal. 14 dil uzun etiket ve RTL borcu aynı. |
| **Profesyonel derinlik** | **3** — Uzman yetenekler menüsüz kalır; bulunabilirlik palete ve Kaputu Aç'a yüklenir (01 §1.1: uzman yetenekleri zaten dağınık). | **5** — Kod, karşılaştırma, iş akışı, ajan aynı tuvalde kip olarak; en çok profesyonel yetenek barındırır (`ComparePanel`, `PipelineCanvas`, `desktop/src/pty.ts`). | **4** — İş sayfası katmanları (Receipt/adım/araç/maliyet/handoff) derin; ama kod ve çok-model karşılaştırma iş türü olarak sınırlı. |
| **Mühendislik maliyeti** | **3** — Plan/başlat/kova API hazır (`jobs/router.ts:53`, `:121`); sohbet ucu ve çok sınıflı niyet yeni (`01 §5.1`). Orta-yüksek (M-L). | **1** — Çalışma/bağlam kaydı, kip yöneticisi, sohbet, yan katman: hepsi yeni; migration kurucu onayı ister (`STATUS.md:205`). L. | **4** — API büyük ölçüde hazır ve web tüketmiyor (01 §1.4); iş yüzeye taşımak. M. Mobil/desktop onay eşlemesi ek maliyet (01 §6). |
| **Mevcut ürünle uyum** | **3** — Şirket sihirbazı ve komut paleti temel olur (`companies/new/page.tsx:361`); ama tek-çubuk menü bugünkü 13 öğeli yapıyı büyük ölçüde değiştirir. | **2** — Bugünkü sayfa+form yapısından en uzak (02 §7); dört yüzeyde tuvalin ortak veri modeli yok (01 §6). | **5** — ADR-0003 kovaları, `/runs`, `/approvals`, mobil onay sekmesi, CLI `runs/approve` doğrudan bu yapıdadır (`mobile/app/_layout.tsx:259-300`, `cli/src/braavo.ts:1325`, `:2518`). |
| **TOPLAM** | **21 / 30** | **19 / 30** | **24 / 30** |
| **Yorum** | Başlangıç sorununu (A) en iyi çözer; uzman bulunabilirliği ve "sohbet kutusuna hapsetme" (§4.3) zayıf nokta. | Talimatın B alanını en tam karşılar ama en pahalı ve en az mevcut ürüne uyumlu; ürün sınırı (model) riskli. | En düşük risk, en yüksek yeniden kullanım; C/I/J güçlü, A/B zayıf; özgünlük için tamamlayıcı katman gerekir. |

Toplamlar yalnız bilgi amaçlıdır: ölçütler eşit ağırlıklı varsayıldı, ağırlık seçimi UX-03'ündür. Puan duyarlılığı: mühendislik maliyetine çift ağırlık verilirse K3 ile K1 farkı açılır, özgünlüğe çift ağırlık verilirse K2 öne geçer.

## 5. UX-03'e girdi (karar önerisi DEĞİL, yalnız girdi)

**K1** en güçlü yanıyla Aşama 4 tasarım testinin 1-2. adımlarını (sohbet, iş tarif et) ve başlangıç alanını (A) en doğal çözer; en riskli yanı "her şeyi sohbet kutusuna hapsetme" (§4.3) ve uzman yeteneklerin menüsüz kalıp keşfedilememesidir. **K2** en güçlü yanıyla talimatın B ve E alanlarını (bağlam kaybetmeyen birleşik çalışma, kod kipi) en tam karşılar; en riskli yanı en yüksek mühendislik maliyeti (sohbet + çalışma kaydı + migration), "çalışma" teriminin kavram karışıklığı ve dört yüzeyde ortak veri modelinin bugün olmamasıdır. **K3** en güçlü yanıyla C, I ve J alanlarını (iş/onay/mobil) mevcut ADR-0003/Job/Run/Approval/Receipt sözleşmeleriyle en ucuz ve en güvenli çözer, bugünkü başarısız testleri (#3 devam eden işi bulma, #4 onay anlama) doğrudan kapatır; en riskli yanı başlangıç/özgünlük açığı (A, B) ve "iş dolabı"na dönüşüp uzman keşfinin zayıflamasıdır. **Birleştirme olasılığı:** üçü birbirinin yerine değil katman olarak birleşebilir: K3'ün kova/onay/iş sayfası omurgası (düşük risk, hazır API), üstüne K1'in tek niyet satırı (tarif satırı + son niyetler) ve K2'nin yalnız iş sayfası içindeki **kip dönüşümü** (özet → çıktı → teknik → kod); böylece maliyetli çalışma kaydı (K2'nin L'lik kısmı) ertelenebilir. Bu birleşimde bile sohbet yürütme ucu, model/yönlendirme özetleri, onay kartındaki araç/veri alanları ve 03d adım-düzeyi onay kapısı "yeni API/iş gerekir" kalır; UX-03 bu bağımlılıkları ADR'ye açıkça yazmalıdır.

## 6. Atıf ve doğrulama notu

- Bu belge `packages/ui`, `packages/api`, `packages/core`, `docs/yula-execution/DECISIONS.md` atıflarını `e3e83d6` ağacından satır satır doğruladı; desktop/CLI/mobil atıfları `origin/main` kaynaklarından (`desktop/src/ui.ts:505`, `:967`, `:2279`; `cli/src/braavo.ts:1325`, `:2518`; `cli/src/forge/output.ts:56`; `mobile/app/_layout.tsx:259-300`; `mobile/lib/api.ts:997-1008`) açılarak doğrulandı.
- 01 §5.1'deki "#123 açık / `jobs/start` yok" notu bu tabanda eskidir (`/jobs/start` `packages/api/src/modules/jobs/router.ts:121`). `/inbox` ekranı main'de yoktur (PR #127 incelemede); bu belge ona dayanmaz.
- Çalıştırılmadı, ekran görüntüsü alınmadı; bütün değerlendirme statik okumadır (01 §10).
