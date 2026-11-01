# Şirket paneli: üç yüzeyde ortak plan (PLAN 2.5–2.7)

Kurucu kararı (2026-11-01): yüzeyler paralel ilerler. Desktop (2.5), CLI (2.6) ve mobil (2.7) aynı paneli aynı veri sözleşmesinden besler. Bu belge o sözleşmeyi, yüzey başına görünümleri ve dilimleri tanımlar. Bu belge yetki üretmez: merge, yayın ve mağaza adımları kurucu onayıyla yapılır.

Bölüm adı K1'e göre "Şirket / Company"; ajanlar K2'deki 7 şablondan gelir. Modeller K3'e göre yalnız kullanıcının anahtarı ya da yerel modeliyle çalışır.

## 1. Bugün var olan

| Parça | Yer | Durum |
|---|---|---|
| Daemon API: şirket, ajan (org), rutin, koşu defteri, run-now, SSE olayları | CLI `feat/daemon` | Var |
| Sohbet API'si (çok turlu, akışlı, arama, içe aktarma) + relay sohbeti | CLI `feat/chat`, `docs/DAEMON-CHAT.md` | Var |
| 7 ajan şablonu, `hireFromTemplates`, `suggestModel` | platform `feat/braavo-core` (CLI'de `src/core/` aynası) | Var |
| Görev, onay, bütçe tabloları | Daemon şeması (`task`; onay ve bütçe alanları) | Kısmen: tablo var, uç yok |
| Desktop sohbeti daemon'a bağlı | desktop `feat/daemon-chat` | Yapılıyor (1.3) |
| Mobil sohbet relay üzerinden | mobile `feat/relay-chat` | Yapılıyor (1.4) |

## 2. Ortak veri sözleşmesi (daemon `/v1`, üç yüzey aynı uçları okur)

| Uç | İçerik | Gereken iş |
|---|---|---|
| `GET /companies/:id/panel` | Tek çağrıda panel özeti: org ağacı (düğüm = ad, rol, sağlayıcı/model, efor, durum, bu ayki harcama/bütçe), bekleyen onay sayısı, son 20 etkinlik, sıradaki 5 rutin, ay toplam token/harcama | Yeni uç; mevcut sorguların birleşimi |
| `POST /companies/:id/hire` | `{ templates?, urls? }` → `hireFromTemplates`; yanıtta `needsSetup` ve `needsUrls` | Yeni uç; şablonlar CLI aynasında hazır |
| `PATCH /agents/:id` | Model, efor, bütçe, yönetici, durum (duraklat/sürdür) | Yeni uç; org doğrulaması `validateOrg` ile |
| `GET /companies/:id/approvals`, `POST /approvals/:id/decide` | Para ve dış gönderim onayları (insan karar verir; ajan veremez) | Yeni tablo + uç (2.3) |
| `GET /companies/:id/tasks`, `POST /tasks` | Görev listesi, atama, durum | Mevcut `task` tablosuna uç (2.2) |
| `GET /companies/:id/costs?month=` | Ajan başına token ve USD, bütçe yüzdesi (%80 uyarı, %100 duraklatma) | Uç + model fiyat tablosu |
| `GET /companies/:id/inbox` | Rutin teslimleri ("Scheduled" gelen kutusu), okunmamış sayısı | Uç; `delivery` alanı zaten var |
| Ajanla sohbet | `POST /conversations` + `agentId` (ajanın sistem promptu ve şirket bağlamıyla) | Sohbet API'sine `agentId` desteği |
| Olaylar (`GET /events`) | `agent.status`, `company.changed`, `routine.executed`, `conversation.changed`, yeni: `approval.requested`, `budget.threshold` | Olay türleri eklenir |

Tüm uçlar `companyId` ile şirket yalıtımına uyar. Para hareketi ve dış gönderim her zaman insan onayından geçer; ajanlar arası mesaj onay sayılmaz.

## 3. Yüzeyler

**Desktop (2.5).** Panel, K9'a göre React 19 + Vite + zustand ile yeni bir ekran olarak yazılır; mevcut framework'süz arayüz yalnız giriş noktası olur. Ekran öğeleri:
- org şeması (düğüme tıklayınca ajan kartı: model/efor seçici, bütçe çubuğu, son koşular, ajanla sohbet);
- onay kuyruğu;
- aylık harcama;
- etkinlik akışı;
- Scheduled gelen kutusu;
- işe alma sihirbazı: şablon seçimi; `needsSetup` için anahtar ya da yerel model kurulumu; `needsUrls` için rakip ve sürüm URL'leri.

Daemon'a Rust tarafından erişilir (1.3'te kurulan köprü).

**CLI (2.6).** Komutlar:
- `braavo company [init|show|hire]`;
- `braavo agents --tree`;
- `braavo agents set <id> --model P/m --effort e --budget n`;
- `braavo tasks`;
- `braavo approvals`;
- `braavo schedule`;
- `braavo costs`.

Hepsi `--json` verir. `company init` şablonlardan işe alır ve eksik kurulumu adım adım söyler.

**Mobil (2.7).** Mevcut Companies, Approvals ve Companion ekranlarının genişlemesi. Telefon daemon'a doğrudan bağlanmaz, relay kullanır:
- **Bugünkü protokolle yapılabilen:** onaylar (`approval-request` olayı + `approve`/`reject` komutları zaten var), ajanla sohbet (1.4'teki sohbet oturumu deseni, ajan başına bir oturum), durum ve rutin bildirimleri (`agent-turn` / `audit` özetleri, push).
- **Protokol değişikliği gerektiren:** panel özetini (org ağacı, harcama) telefona taşımak. Bugünkü olaylar yalnız redakte edilmiş metin özetleri. Bunun için relay'e `snapshot` olayı (sınırlı JSON, şema doğrulamalı, redaksiyonlu) ya da `query` komutu eklenmesi gerekir. Bu değişiklik platform relay'inde yapılır ve deploy ister; **kurucu kararı gerekir**. Karar gelene kadar mobil panel onay, sohbet ve bildirimlerle başlar.

## 4. Dilimler (paralel; her repo kendi dalında)

| Dilim | CLI / daemon | Desktop | Mobil |
|---|---|---|---|
| D1: işe alma | `POST /hire`, `braavo company init/hire`, `agents --tree` | İşe alma sihirbazı + org şeması (salt okuma) | — |
| D2: ajan yönetimi | `PATCH /agents/:id`, `agents set` | Ajan kartı: model/efor/bütçe, duraklat | Ajan durum listesi (özet olaylarıyla) |
| D3: onaylar | Onay tablosu + uçlar, `approvals` | Onay kuyruğu | Onaylar relay üzerinden (bugünkü protokol) |
| D4: harcama ve bütçe | Fiyat tablosu, `costs`, %80/%100 kuralı | Harcama ekranı | Bütçe uyarı bildirimi |
| D5: gelen kutusu ve ajanla sohbet | `inbox`, sohbette `agentId` | Scheduled kutusu, ajan sohbeti | Ajanla sohbet (sohbet oturumu deseni) |
| D6: mobil panel özeti | `snapshot` üretimi | — | Org/harcama görünümü (**relay protokol kararı sonrası**) |

Önce D1, çünkü panelin geri kalanı işe alınmış ajanlara dayanır. D1'in daemon ucu desktop ve CLI'nin ön koşuludur ve önce o yazılır. Sonra yüzeyler aynı anda ilerler.

## 5. Açık karar

- **Relay protokolüne panel özeti eklenmesi** (D6): platform relay değişikliği + deploy.
