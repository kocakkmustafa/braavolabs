# YULA icra test kanıtı — Braavolabs platform

Biçim: `STATUS.md` ile aynı (Komut | Sonuç tabloları, yerel ölçüm). `IMPLEMENTED ≠ DEPLOYED ≠ PRODUCTION_VERIFIED`; bu dosya yalnız yerel kanıtı tutar.

## QA-ALL-03b geri alma provası (yerel, 2026-11-14)

Kapsam yalnız yerel: önceki sürüm etiketini temiz worktree'de derleyip test ettik, sonra güncel main'e dönüp yeniden derledik. Deploy, Netlify, mağaza, Supabase prod, `v*` etiketi, sır: yok.

Ortam: macOS, Node v26.9.0, pnpm 9.15.4. Postgres/Redis yok; testler CI ile aynı yer tutucu env ile koşar (`.github/workflows/ci.yml` Test adımı).

Hedef: `v0.2.1` = `ca360258931bec08da72c6f5beab39a2f1f57678` (en yeni `v*` etiketi, main'in hemen gerisindeki sürüm; bir öncekisi `v0.2.0` = `b0d2672`, derlenmedi). Güncel main: `a6a33a7`.

Temiz worktree: `git worktree add ../wt-QA-ALL-03b v0.2.1` (kaldırılmadı).

### İleri: main → v0.2.1

| Komut | Süre | Sonuç |
|---|---|---|
| `pnpm install --frozen-lockfile` | 18 s | geçti |
| `pnpm db:generate` | 10 s | geçti |
| `pnpm build` (turbo, önbellek yok: 8 görevden 1'i önbellekli) | 4 dk 37 sn (turbo 4 dk 17 sn) | 8/8 başarılı |
| `pnpm -r --if-present test` (CI env) | 3 dk 13 sn | api: 3537 geçti, **3 düştü**, 71 atlandı (3611); ui 660/660; integrations 27/27 |
| `node --test scripts/auth-entry-contract.test.mjs scripts/bench-request-boundary.test.mjs scripts/public-message-manifest.test.mjs` | 49 sn | 195/195 |

3 düşen test: `compare-selection-http.test.ts` (2) ve `cascade-selection-http.test.ts` (1); üçü de `Test timed out` (5 sn/15 sn). Aynı iki dosya tek başına yeniden koşuldu: 99/99 geçti (18,6 sn). Yorum: tüm paketler paralel koşarken HTTP testlerinde zaman aşımı (yük kaynaklı); mantık hatası değil, ama tam paket koşusunda `v0.2.1` yerelde yeşil değil. Bu CI'da ayrıca doğrulanmadı.

### Geri: v0.2.1 → güncel main

| Komut | Süre | Sonuç |
|---|---|---|
| `git checkout --detach origin/main` + `pnpm install --frozen-lockfile` + `pnpm db:generate` + `pnpm build` | 3 dk 12 sn toplam (build: turbo 2 dk 25 sn, 8 görevden 6'sı önbellekli) | 8/8 başarılı, main `a6a33a7` |

İleri-geri toplamı (kurulum + üretim + derleme, test hariç): yaklaşık 8 dk 17 sn. Önbellekle dönüş daha hızlı; önbelleksiz üst sınır ileri yönün süresine yakındır.

### Betik ve runbook (yalnız okundu)

`scripts/deploy-platform.sh` ve `docs/runbooks/deploy-rollback.md` okundu, çalıştırılmadı. Anlatı: `BRAAVOLABS_PREVIOUS_GOOD_COMMIT` deposu değişkeni işe `PREVIOUS_RELEASE_COMMIT` olarak geçer; sunucudaki `previous-good.json` kaydının `release` alanına (ya da zaten aday çalışıyorsa `previousRelease` alanına) eşit olmalıdır, değilse betik 68 (`previous release drift`) ile durur. Aday sonrası otomatik geri alma `rollback_application` ile önceki api/ui sindirimlerine döner; şema/veri geri alınmaz, yalnız uygulama.

### NOT_TESTED

- Canlı Lightsail geri alma yapılmadı (SSH, `previous-good.json`, `docker image inspect`, `rollback_application`, çıkış kodları 66/68/71/72 doğrulanmadı).
- `BRAAVOLABS_PREVIOUS_GOOD_COMMIT` betiği kuru çalıştırılmadı; yalnız okundu.
- Geri alınan sürümün boot/HTTP duman testi (api/ui süreci kaldırılması) yapılmadı; yalnız derleme ve testler.
- Docker imajı derlemesi ve compose override ile geri alma yapılmadı.
- Veritabanı: migration'ların geri alınması yapılmadı (runbook: geri alma şemayı geri almaz).
- `v0.2.0` hedefi derlenmedi.
- Mobil (`../mobile`): yerelde `v*` sürüm etiketi yok (yalnız `archive/*` etiketleri), bu yüzden önceki sürüm hedefi tanımsız; mobil derleme/simülatör provası yapılmadı.
- Tam test koşusundaki 3 zaman aşımı CI'da yeniden doğrulanmadı.
