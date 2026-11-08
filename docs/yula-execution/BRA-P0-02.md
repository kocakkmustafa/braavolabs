# BRA-P0-02 — Job/Run/Approval/Receipt şeması + durum makinesi + geri uyum ADR

Biçim: ana talimat §4 "iş birimi formatı". Karar: [ADR-0001](DECISIONS.md). Durum: [STATUS.md](STATUS.md).

```yaml
id: BRA-P0-02
product: braavolabs
phase: P0
owner_role: ARCH+BRA            # uygulayan: Braavolabs oturumu (Sonnet)
review_role: SEC                # bağımsız denetçi: reviewer alt ajanı
priority_reason: "BRA-P0-03/04/05/07/08/09/11 buna bağlı; durum geçişinin tek sahibi yok, onay içeriğe bağlı değil (AUDIT-01 §2 A1, B)."
user_outcome: "Bir iş yarım kalsa, onay iki kez gelse ya da iptal edilse tutarlı kalır; kanıtsız iş 'doğrulanmış başarı' sayılmaz."
depends_on: [AUDIT-01, BRA-P0-01]
repo: "kocakkmustafa/braavolabs"
entry_files:
  - packages/db/prisma/schema.prisma                  # Run:545, Approval:639, RunStatus:1728
  - packages/api/src/modules/pipeline/runner.ts       # resume/planResume, durum yazımları
  - packages/api/src/modules/pipeline/executor.ts     # planResume:130
  - packages/api/src/modules/pipeline/hierarchical-runner.ts
  - packages/api/src/modules/agent/tool-executor.ts   # WAITING_APPROVAL yazımları
  - packages/api/src/modules/run/router.ts            # pause/resume/cancel/handoff
  - packages/api/src/modules/approval/router.ts       # /decide
  - packages/api/src/modules/approval/expiry-cron.ts  # :94 CANCELLED yazımı
  - packages/api/src/lib/queue.ts
  - packages/braavo-core/src/relay-protocol.ts
scope_in:
  # 02a — bu PR
  - "ADR-0001 (yaşam döngüsü, projeksiyon, geçiş planı, geri alma)"
  - "Saf durum makinesi modülü job-state.ts + birim testleri (DB yok, hiçbir yazara bağlı değil)"
  - "docs/yula-execution/ STATUS + DECISIONS + bu bilet"
  # 02b — sonraki PR (BACKLOG)
  - "Yalnız-ekleyen migration (runs/approvals sütunları, job_receipts), idempotent geri dolgu"
  - "transitionRun tek yazar + 20+ yazım noktasının taşınması (küçük PR'lara bölünür)"
  - "JOB_STATE_DUAL_WRITE bayrağı (varsayılan kapalı), API yanıtına state/resultStatus (üst küme)"
scope_out:
  - "RunStatus enum'una değer eklemek, tablo yeniden adlandırma, yeniden yazım"
  - "Approval nonce/actionHash mantığı (BRA-P0-05), bütçe alanları (BRA-P0-08), UI (BRA-P0-03/04)"
  - "Deploy, migration'ın canlıya uygulanması, etiket, merge (kurucu onayı)"
acceptance_tests:
  - "02a: durum makinesi testleri geçer — projeksiyon toplam ve geri dolgu gidiş-dönüş, geçiş tablosu, tekrarlanan approve = tek start, iptal, çökme kurtarma sınırlı, kanıt → resultStatus"
  - "02a: api paketinde typecheck 0 hata, tüm vitest CI ortamında yeşil (regresyon yok)"
  - "02b: status yüzeyi tam 7 değer (sözleşme anlık görüntüsü); yanıt eski alanların üst kümesi"
  - "02b: DB'li entegrasyon — çökmüş koşu tamamlanmış RunStep kayıtlarından devam eder (planResume), tamamlanan adım yeniden çalışmaz, yeniden deneme tavanında FAILED; aynı approve 3× = 1 yan etki; iptal edilmiş işe geç approve geçmez"
  - "02b: tutarlılık sorgusu status ≠ projection(state) = 0 satır (staging)"
negative_tests:
  - "COMPLETED/CANCELLED'dan geçiş yok; FAILED yalnız RESUMING ile çıkar"
  - "DRAFT doğrudan RUNNING olamaz; READY doğrudan COMPLETED olamaz"
  - "Yeniden deneme tavanında FAILED(retries_exhausted); sonsuz döngü yok; bozuk sayaç (negatif/kesirli/sonsuz) hak vermez"
  - "Düz /resume bekleyen onayı atlayamaz; FAILED yalnız retry niyetiyle (açık devir) başlar; manuel devir akışı (RUNNING → /handoff → PAUSED → /continue) kırılmaz"
  - "Kanıt yok, kanıt eksik, test kırık ya da test ok bilgisi yok → VERIFIED değil (fail-closed)"
  - "Bilinmeyen yeni enum değeri eski istemciye sızmaz (status her zaman 7 değerden biri)"
telemetry:
  - "transitionRun: from→to, noop, ret nedeni sayaçları (PII yok)"
security_impact: "Run/Approval tenant sınırı sağlamlaşır (tenant_id doğrudan). Yeni sır yok. Company-arası izolasyon iddiası yok (BRA-P0-07)."
cost_effect_usd_per_month: "yeni ücretli servis yok (0 USD)"
rollback: "02a: commit revert (modül hiçbir yere bağlı değil). 02b: JOB_STATE_DUAL_WRITE kapat + önceki yapı; sütunlar eklemeli, status hep güncel."
evidence_required:
  - commit SHA
  - PR linki
  - CI (Lint&Type, Test, Build, DB Migration Check, E2E)
  - "yerel test çıktısı: dosya ve test sayısı"
  - bağımsız denetçi raporu
status: IN_REVIEW   # 02a PR #108 denetimde; 02b BACKLOG
```
