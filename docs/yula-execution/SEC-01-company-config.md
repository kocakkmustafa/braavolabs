# BRA-SEC-01 — Company.config gizlileri yanıtlardan çıkarıldı

## Sorun
`Company.config` (Json) içinde sunucu tarafından yazılan `webhookSecret` açık metin duruyordu ve Company döndüren rotalar ham config'i yanıta koyuyordu. Aynı kiracının her doğrulanmış üyesi webhook gizlisini okuyabiliyordu (çapraz kiracı ifşa yok).

## Ne değişti
Tek ortak yardımcı: `packages/api/src/modules/company/redact.ts` (`redactCompanyConfig`, `toPublicCompany`).

- İzin listesi (üst düzey): niche, targetAudience, channels, companyType, brand_voice, icp, kpi, budget, work_mode, use_cases (PATCH yazma izin listesiyle aynı) + startedFromTemplate, templateOutcome, postingFrequency (sunucu yazar). Listede olmayan anahtar yanıttan düşer.
- İzin verilen değerlerin içinde (iç içe nesne ve dizi dahil) gizli adlı anahtar `"***"` olur. Ad camelCase/snake/kebab parçalarına bölünüp parça bazlı eşlenir (`isSecretKeyName`): secret, token, password, passwd, pwd, credential, auth/oauth/authorization, bearer, cookie, dsn, jwt, apiKey/privateKey/signingKey/accessKey/secretKey/x-api-key varyantları, sessionId/sessionToken, tek başına `key`. `keywords`, `keyMessages`, `monkey`, `tokenizer_model` gibi zararsız adlar maskelenmez. Belirsizde güvenli yön maskelemedir (örn. `maxTokens`).
- Gizli varsa `webhookSecretSet: true` döner; değer asla dönmez.
- null/undefined/dizi/ilkel config `{}` olur. Girdi değiştirilmez.
- Webhook HMAC doğrulaması (`webhook/router.ts`) ham DB satırını okumaya devam eder; yardımcıdan geçmez.

## Etkilenen rotalar
- GET /companies, GET /companies/:id, POST /companies (oluşturma yankısı) — `company/router.ts`
- GET /runs/:id (`pipeline.company`) — `run/router.ts` (yalnız GET /:id; kiracı denetimi ham satırla yapılır)
- GET /pipelines/:id (`company`) — `pipeline/router.ts`
- GET /export/:companyId/bundle (`company.config`) ve `generateClaudeMd` (GET claude-md ve bundle içindeki CLAUDE.md metni config'i JSON olarak basıyordu) — `export/router.ts`
- POST /license/download, paketsiz (tüm kiracı) paket: `companies[].config` — `license/license.router.ts`
- GET /approvals (`run.pipeline.company`, ham Company ve config'i dönüyordu) — `approval/router.ts:~87`
- POST /onboarding/hero-company (ham company; config sırsız ama tutarlılık için) — `onboarding/router.ts:~216`

Bilerek dokunulmayanlar: `POST /webhooks/templates/:id/install` yanıtındaki `webhookSecret` (yeni üretilen gizli, kurulumu yapan kişiye bir kez gösterilir; ürün gereği). Dahili `include: { company: true }` kullanımları (governance, draft, voice, pipeline yazma rotaları) yanıta Company koymuyor.

## UI etkisi
`packages/ui` içinde Company config yanıttan okunmuyor; kırılan alan yok. Approvals sayfası yalnız `run.pipeline.company.name` okuyor (`app/approvals/page.tsx:148`), korunuyor.

Ölü kod notu (kod değiştirilmedi): `app/webhooks/page.tsx:222` `c.webhookSecret` değerini Company üst düzeyinden okuyor; API Company üst düzeyinde böyle bir alan hiç döndürmedi, yani bu dal zaten çalışmıyordu. `lib/api.ts:765` `installWebhookTemplate` var ama hiçbir sayfa çağırmıyor. Yani UI gizliyi bugün hiçbir yoldan göstermiyor; kurulum yanıtındaki `webhookSecret` yalnız doğrudan API istemcileri için. `webhookSecretSet` bayrağı ileride "kurulu" göstergesi için hazır.

## Taranan rotalar
| Dosya:satır | Karar |
|---|---|
| company/router.ts:71,83,112 | Düzeltildi (`toPublicCompany`) |
| run/router.ts:86-94 (GET /:id) | Düzeltildi |
| pipeline/router.ts:560-565 (GET /:id) | Düzeltildi |
| approval/router.ts:84-87 (GET /) | Düzeltildi (UI yalnız company.name okur) |
| export/router.ts:128,159 | Düzeltildi (bundle + CLAUDE.md metni) |
| license/license.router.ts:336 | Düzeltildi (tenant bundle) |
| onboarding/router.ts:~216 | Düzeltildi (tutarlılık) |
| webhook/router.ts:122 (HMAC), :353 (yazma) | Ham satır gerekli, yanıta gitmez |
| webhook/router.ts:391 (install yanıtı) | Bilerek: yeni üretilen gizli, çağırana bir kez |
| run/router.ts:227,260,289,745,776 (stop/pause/resume/rollback/rerun) | Güvenli: Company yalnız tenant denetimi için; yanıt `{success,status}` ya da step sonucu |
| approval/router.ts:127 (POST decide) | Güvenli: yanıt `{success,decision}` |
| pipeline/router.ts:417,507,574,645,700,777 | Güvenli: dahili okuma; yanıtlar estimate/run/updated/revisions/success |
| draft/router.ts:204,242 | Güvenli: yanıt draft satırı (`updated`), company yok |
| governance/router.ts:59, engine.ts:40,133 | Güvenli: yalnız id/tenantId kullanılır; yanıt `{success,...}` |
| governance/router.ts:106, dashboard/router.ts:90,205 | Güvenli: dar `select` (id,name) |
| voice/voice.service.ts:84,133 | Güvenli: Company yalnız tenantId için; dönen `{callId,...}` / VoiceCall |
| outreach/router.ts:86,179,199, sequence-runner.ts:69 | Güvenli: yanıtlar enrollment/success, company yok |
| agent/context-builder.ts:33-70 | Güvenli: LLM bağlamına yalnız brand_voice, icp, channels, work_mode, kpi, budget; HTTP yanıtı değil |
| agent/registry.ts:246,532,1620 | Güvenli: Company yalnız çözümleme; araç çıktısına gitmez |
| agent/tool-executor.ts:52 | Güvenli: kimlik doğrulama amaçlı çözümleme |
| run SSE (`run/router.ts:582+`), `lib/runEvents.ts` publishRunEvent çağrıları (runner/executor/claude/tool-executor/handoff) | Güvenli: payload'larda company/config yok (incelendi: yalnız status, costUsd, stepId, error) |
| collaboration/router.ts:66,275, relay/router.ts:238 | Güvenli: katılımcı/relay olayları, company satırı yok |
| logger çağrıları | Güvenli: `logger.*({...company/config})` kalıbı yok; yalnız `companyId` loglanıyor |
| dışa giden webhook/fetch gövdeleri | Güvenli: company/config içeren gövde bulunmadı |
| research, crm, memory, integration, ab-test, templates.service, starter, marketplace, growth, voice.router | Güvenli: Company yalnız sahiplik denetimi için okunur; yanıtlar kendi varlıkları (templates.service config'i dışa açmaz, başlangıç config'i sırsız) |
| core, integrations, memory, connector-sdk paketleri | Güvenli: Company satırı/config'i yanıt, olay ya da log olarak dışa vermez (grep: eşleşme yok) |

## Testler
- `company/__tests__/redact.test.ts` (birim + davranış sözleşmesi)
- `company/__tests__/company-config-secrets.test.ts` (rota başına negatif test)
- `run/__tests__/run-detail-contract.test.ts` (iç içe `pipeline.company` anahtar kümesi + include kilidi eklendi)
- `company-config-secrets.test.ts` ayrıca GET /approvals ve POST /onboarding/hero-company'yi kapsar; `redact.test.ts` kapsanan/kapsanmayan anahtar adı listelerini kilitler

## Açık soru (kurucu)
Bu değişiklik yalnız ifşayı keser. Zaten ifşa olmuş mevcut `webhookSecret` değerleri döndürülmedi. **Karar (kurucu, 2026-11-08, Project orchestration oturumunda kendi sözü): "Yenileme gerekmez"** — rotate yapılmayacak, soru kapandı. Açık kalan (kararsız) soru: gizli ileride config yerine şifreli ayrı alana taşınsın mı?
