# BRA-UX-04 — etkileşimli prototip (`/lab/ux`)

Kaynak: `04-design.md` §5, §12.1, §13 (T1–T10) ve `DECISIONS.md` ADR-0004 (İşler omurga + Niyet Çubuğu + kip morfu).
Kapsam: ayrı rota arkasında prototip; **mevcut ekranlara, API sözleşmelerine, migration'a dokunmaz**. Yeni API ucu yok.

## Açma / kapama
- Bayrak: `NEXT_PUBLIC_UX_LAB=1|true`, varsayılan KAPALI. Sunucuda **istek anında** okunur (`lib/ux-lab/flag.ts`: `process.env` nesnesi
  bütün olarak geçirilir; sabit `process.env.NEXT_PUBLIC_…` erişimi derleme anında gömülürdü). Sonuç: aynı derleme iki kipte sunulabilir; geri alma = bayrağı kapat.
- Kapalıyken `/lab/ux` 404 döner; başka hiçbir rota bayrağa bakmaz (`e2e/ux-lab.spec.ts` bayrak kapalı/açık iki sunucuda 8 mevcut rotanın durum kodu, başlık ve yönlendirmesini karşılaştırır).
- `?mode=sample` ya da oturum yoksa **ÖRNEK** kip (bellek içi, her yerde "ÖRNEK VERİ" rozeti, sunucuya hiçbir şey gitmez); oturum varsa **CANLI** kip (var olan uçlar).

## Yolculuk → veri kaynağı
| Test | Akış | Canlı kip (var olan uç) | Örnek kip / boşluk |
|---|---|---|---|
| T1 sohbet başlat | Niyet Çubuğu, "Anladığım" önizlemesi, düşük güven = sohbet | yok | Sohbet ucu YOK (§14-a): yanıt ÖRNEK, iş kaydı oluşmaz. Sınıflayıcı yerel kural (§14-b) |
| T2 iş tarif et/çalıştır | plan kartı → çalıştır | `POST /jobs/plan`, `POST /jobs/start` (`planFlow` durum makinesi yeniden kullanıldı) | Onaylı örnek bayrak kapalıyken 422 `high_risk_start_unsupported`'ı açıkça gösterir |
| T3 devam eden iş | kovalar: onay / çalışıyor / takıldı / bitti | `GET /runs?bucket=` (4 kova), `GET /approvals?groupBy=run` | Haftalık harcama alanı yok: "yalnız listelenen işler" yazılır |
| T4 onay anlama | ne yapacak/araç/yetki/veri/tutar/geri alma/taslak | `POST /approvals/:id/decide`; PR #133 `details` alanları | Kaynak yoksa "bilgi yok"; tehlikeli (para>0, yüksek risk, geri alınamaz) ikinci adım + sebep; toplu onay KAPALI |
| T5 ajan oluştur | açıklama → ajan, `droppedTools` uyarısı | `POST /companies/:id/agents/compose` | **Bulgu:** compose ajanı HEMEN kaydeder (taslak ucu yok); canlı kipte bu açıkça yazılır, "Taslak → Oluştur" iki adımı yalnız yeni uçla mümkün |
| T6 şirket durumu | tek satır özet + açılır bölümler | `GET /companies`, `/agents`, `/integrations` + kova sayıları | Ekip/yönetici sayısı: API ister |
| T7 Kaputu Aç | Özet / Çıktı / Kaput morfu, Sade/Tam | `GET /runs/:id`, `GET /runs/:id/handoffs`, pause/resume/stop | Model, yönlendirme, yetki dökümü: API ister (BRA-UX-API-02); çıktı gövdesi alanı yok |
| T8 model maliyeti | "veri yok" | yok | Model başına maliyet API'si yok (§14-c): uydurulmaz |
| T9 yönet | eski rotalara bağlantılar | — | rota listesi regresyonu `ManageView` testinde |

## Bilinçli sınırlar
- Metinler tek yerde Türkçe (prototip); next-intl 15 dil geçişi UX-05a'dadır. Renk/marka mevcut token'lardan; yeni renk yok.
- Yönlendir (`steer`) ve yeniden dene (`retry`) bu prototipte yok; ses (mikrofon) ve mobil alt-sheet yerleşimi UX-05j.
- Mobilde iş başlatma kurucu kararı gerektirir (§13b); prototip yalnız ekran davranışını gösterir.

## Çalıştırma
```bash
NEXT_PUBLIC_UX_LAB=1 pnpm --filter @ai-company-os/ui dev      # http://localhost:3000/lab/ux?mode=sample
pnpm --filter @ai-company-os/ui test -- lib/ux-lab              # birim testleri
pnpm exec playwright test e2e/ux-lab.spec.ts                    # iki UI sunucusu playwright.config.ts'te
UX_LAB_SCREEN_DIR=<klasör> pnpm exec playwright test e2e/ux-lab.spec.ts   # + ekran görüntüleri (1440/390 × açık/koyu)
```
