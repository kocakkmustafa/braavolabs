# BRA-SEC-01 — Company.config gizlileri yanıtlardan çıkarıldı

## Sorun
`Company.config` (Json) içinde sunucu tarafından yazılan `webhookSecret` açık metin duruyordu ve Company döndüren rotalar ham config'i yanıta koyuyordu. Aynı kiracının her doğrulanmış üyesi webhook gizlisini okuyabiliyordu (çapraz kiracı ifşa yok).

## Ne değişti
Tek ortak yardımcı: `packages/api/src/modules/company/redact.ts` (`redactCompanyConfig`, `toPublicCompany`).

- İzin listesi (üst düzey): niche, targetAudience, channels, companyType, brand_voice, icp, kpi, budget, work_mode, use_cases (PATCH yazma izin listesiyle aynı) + startedFromTemplate, templateOutcome, postingFrequency (sunucu yazar). Listede olmayan anahtar yanıttan düşer.
- İzin verilen değerlerin içinde (iç içe nesne ve dizi dahil) `/secret|token|key|password|credential/i` eşleşen anahtar `"***"` olur.
- Gizli varsa `webhookSecretSet: true` döner; değer asla dönmez.
- null/undefined/dizi/ilkel config `{}` olur. Girdi değiştirilmez.
- Webhook HMAC doğrulaması (`webhook/router.ts`) ham DB satırını okumaya devam eder; yardımcıdan geçmez.

## Etkilenen rotalar
- GET /companies, GET /companies/:id, POST /companies (oluşturma yankısı) — `company/router.ts`
- GET /runs/:id (`pipeline.company`) — `run/router.ts` (yalnız GET /:id; kiracı denetimi ham satırla yapılır)
- GET /pipelines/:id (`company`) — `pipeline/router.ts`
- GET /export/:companyId/bundle (`company.config`) ve `generateClaudeMd` (GET claude-md ve bundle içindeki CLAUDE.md metni config'i JSON olarak basıyordu) — `export/router.ts`
- POST /license/download, paketsiz (tüm kiracı) paket: `companies[].config` — `license/license.router.ts`

Bilerek dokunulmayanlar: `POST /webhooks/templates/:id/install` yanıtındaki `webhookSecret` (yeni üretilen gizli, kurulumu yapan kişiye bir kez gösterilir; ürün gereği). Dahili `include: { company: true }` kullanımları (governance, draft, voice, pipeline yazma rotaları) yanıta Company koymuyor.

## UI etkisi
`packages/ui` içinde Company config alanı yanıttan okunmuyor (grep: yalnız oluşturma isteği gönderiliyor). Kırılan alan yok; kurulum ekranı gizliyi kurulum yanıtından alıyor. `webhookSecretSet` bayrağı ileride "kurulu" göstergesi için hazır.

## Testler
- `company/__tests__/redact.test.ts` (birim + davranış sözleşmesi)
- `company/__tests__/company-config-secrets.test.ts` (rota başına negatif test)
- `run/__tests__/run-detail-contract.test.ts` (iç içe `pipeline.company` anahtar kümesi + include kilidi eklendi)

## Açık soru (kurucu)
Bu değişiklik yalnız ifşayı keser. Zaten ifşa olmuş mevcut `webhookSecret` değerleri döndürülmedi (rotate prod işi). Sorular: mevcut gizliler rotate edilsin mi, ve gizli ileride config yerine şifreli ayrı alana taşınsın mı?
