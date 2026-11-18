# BRA-P0-02c-6 — CI önerisi (UYGULANDI: Project orchestration onayı 2026-11-08, "a, ekle")

Onay: Project orchestration (teknik karar; yeni servis/ücretli kaynak yok, mevcut `db-migration-check` job'una adım). Koşul: `ci.yml` değişikliği bu PR'ın içinde; DB testleri CI'da gerçekten koşmadan (atlanmış hâlde) merge edilmez, kanıt = CI log'unda DB test adımının test sayısı. Aşağıdaki fark `.github/workflows/ci.yml`'e uygulandı. Durum (öneri zamanı):

- `test` job'u servis kabı taşımıyor (yalnız yer tutucu env); `pnpm -r --if-present test` DB'li testleri
  `TEST_DATABASE_URL` yokken ATLAR (yeşil, "skipped"). Yani bu PR tek başına CI'da DB testlerini koşturmaz.
- `db-migration-check` job'u pgvector pg16 servisi taşıyor ve `prisma migrate deploy` ile TÜM migration'ları
  (RLS politikaları dahil) uyguluyor; kullanıcı `aicos` Postgres süper kullanıcısı (RLS testi ona ihtiyaç duyar).
  (`e2e` job'u `db push` kullanır: RLS politikalarını uygulamaz, bu yüzden oraya konmaz.)

Önerilen minimal değişiklik: `db-migration-check` job'unda "Validate schema" adımından SONRA şu adımları ekle
(yeni servis yok, yeni job yok):

```diff
       - name: Validate schema
         env:
           DATABASE_URL: postgresql://aicos:aicos_ci@localhost:5432/aicos_ci?schema=public
         run: pnpm --filter @ai-company-os/db exec prisma validate
+
+      # BRA-P0-02c-6: real-Postgres tests (CAS races, RLS, A/B write-skew) against the
+      # SAME throwaway database the migrations were just applied to.
+      - name: Generate Prisma Client
+        run: pnpm --filter @ai-company-os/db exec prisma generate
+      - name: Build deps for DB tests
+        run: |
+          pnpm --filter @ai-company-os/core build
+          pnpm --filter @ai-company-os/memory build
+          pnpm --filter @ai-company-os/integrations build
+          pnpm --filter @ai-company-os/connector-sdk build
+      - name: DB-backed tests (CAS race, consumeGrant race, RLS, A/B write-skew)
+        env:
+          TEST_DATABASE_URL: postgresql://aicos:aicos_ci@localhost:5432/aicos_ci?schema=public
+          REQUIRE_DB_TESTS: "1"
+          DATABASE_URL: postgresql://aicos:aicos_ci@localhost:5432/aicos_ci?schema=public
+          REDIS_URL: "redis://localhost:6379"
+          JWT_SECRET: "ci-test-jwt-secret-must-be-at-least-32-characters-long-xx"
+          ENCRYPTION_KEY: "ci-test-encryption-key-32-chars-minimum-aabbccddeeff00"
+          NODE_ENV: "test"
+        run: pnpm --filter @ai-company-os/api test:db
```

Notlar:
- `REQUIRE_DB_TESTS=1`, TEST_DATABASE_URL unutulursa "sessiz atlama = yeşil" tuzağını kırar (cross-tenant matrisindeki
  REQUIRE_XTENANT_MATRIX ile aynı kalıp).
- Redis servisi gerekmez: testler Redis'e bağlanmaz (env yalnız `env.ts` doğrulaması için şekil taşır).
- `needs: lint-and-typecheck` aynı kalır. Job süresi tahmini +1-2 dk (build adımları).
- Yerel kanıt: pg18 + pgvector, geçici küme, `prisma migrate deploy` ile tüm migration'lar uygulandı; 23 DB'li test + 5 DB'siz tamlık testi + 1 kapı testi
  = 29 test geçti (A/B düzeltmesinden sonra). CI kanıtı bu öneri onaylanıp uygulanınca gelir.
