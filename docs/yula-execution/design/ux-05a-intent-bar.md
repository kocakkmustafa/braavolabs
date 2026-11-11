# BRA-UX-05a — Başlangıç / Niyet Çubuğu (gerçek `/start`)

Kaynak: `04-design.md` §5.1–5.2, §11–12 ve `DECISIONS.md` ADR-0004. Prototip: `ux-04-prototype.md` (`IntentBar`, `PlanPanel`).
Kapsam: `/start` ekranında bayrak arkasında Niyet Çubuğu + plan kartı + ajan isteği. **Yeni API ucu, migration, sözleşme değişikliği yok.**

## Açma / kapama
- Bayrak: `NEXT_PUBLIC_UX_INTENT=1|true`, varsayılan **KAPALI**; UX-04 prototip bayrağından (`NEXT_PUBLIC_UX_LAB`) bağımsızdır.
- Sunucuda **istek anında** okunur (`lib/ux-intent/flag.ts`; `app/start/page.tsx` `force-dynamic`). Derleme anında gömülmez: aynı derleme iki kipte sunulabilir. Geri alma = bayrağı kapat.
- Kapalıyken `/start` **eski ekrandır** (`components/start/StartLegacy.tsx` = önceki `app/start/page.tsx`; içerik değişmedi, yalnız yer/ad).
- Eşitlik kanıtı: `e2e/golden/start-legacy.json`, UX-05a öncesi derlemeden (main `04d9dc0`) alınmış normalize `<main>` HTML'idir (boşta + plan kartı); `e2e/ux-intent.spec.ts` kapalı sunucuyu bununla birebir karşılaştırır. Altını yenilemek (`UX_INTENT_UPDATE_GOLDEN=1`) yalnız eski ekranı bilerek değiştiren bilet işidir.

## Akışlar ve kullanılan uçlar
| Niyet | Akış | Uç |
|---|---|---|
| İş | Planla → plan kartı → Çalıştır → `/inbox` | `POST /jobs/plan`, `POST /jobs/start` (`planFlow` durum makinesi, olduğu gibi) |
| Sohbet | **Sohbet ucu YOK** (`04-design.md` §14-a): dürüst bilgi kartı, istek yok, iş kaydı yok; "İş olarak planla" isteğe bağlı | — |
| Ajan | Onay kartı → "Ajanı hemen oluştur" | `POST /companies/:id/agents/compose` |
| Şirketler | tek şirkette seçim yok; çoklu şirkette seçim zorunlu | `GET /companies` |

## Bilinçli sınırlar
- **Tek adım (ajan):** `compose` ajanı HEMEN kaydeder; tasarımdaki "Taslak → Oluştur" iki adımı yeni uç ister → Backlog `BRA-UX-API-03` (compose taslak ucu, BACKLOG). Arayüz bunu kartta açıkça yazar; çubuğa Enter/"Ajan iste" ajanı **kaydetmez**, yalnız onay kartındaki düğme kaydeder (testle kilitli: `api.composeAgent(` tek çağrı yeri).
- **Sınıflayıcı** yerel, kural tabanlı bir ipucudur (sunucuda niyet sınıflayıcı yok, §14-b); düşük güven = sohbet; kullanıcı değiştirebilir (radiogroup, roving tabindex, ok tuşları).
- Adım başına model satırı yok (API ister, UX-05h/`BRA-UX-API-02`): ekranda "henüz yok" yazar, uydurulmaz.
- Ses (mikrofon) ve mobil alt-sheet yerleşimi UX-05j. Metinler `app.intent.*` (15 dil dosyası); plan/hata metinleri mevcut `app.plan.*` / `surface.error.*` anahtarlarını yeniden kullanır.
- Mobilde iş başlatma kurucu kararı gerektirir (§13b): bu bilet web'dir.

## Testler
```bash
pnpm --filter @ai-company-os/ui test -- lib/ux-intent                       # birim (bayrak, anahtar kapsamı 15 dil, bileşenler)
node --test scripts/public-claims.test.mjs                                    # sürüm sözleşmesi (playwright.config.ts kilidi)
# e2e (API/Postgres gerekmez; derleme NEXT_PUBLIC_API_URL=https://api.operator.example/api/v1 ile alınmalı, CI öyle yapar)
pnpm exec playwright test e2e/ux-intent.spec.ts
UX_INTENT_SCREEN_DIR=<klasör> pnpm exec playwright test e2e/ux-intent.spec.ts   # + ekranlar (1440/390 × açık/koyu)
```
