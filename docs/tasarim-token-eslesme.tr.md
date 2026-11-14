# Braavolabs tasarım token eşlemesi (web / masaüstü / mobil)

Bilet: CORE-BRA-01 · Tarih: 2026-11-14 · Bağlam: vault notu "CORE-P1-01 — Ortak tasarım tokenları (2026-11-08)".
Kapsam: yalnız doküman ve test. **Hiçbir renk değeri değişmedi** (CSS/JSON diff'i 0). Paket yok; her yüzey kendi değerini taşır.

Kaynaklar (salt-okunur):
- Web: `packages/ui/app/globals.css` (`:root` koyu, `html.light` açık)
- Masaüstü: `desktop/src/styles.css` (`:root` koyu, `:root[data-theme="light"]` açık)
- Mobil: `mobile/lib/palette-primitives.json`, anlamsal eşleme `mobile/lib/palette.ts`

## Üç mavi uyuşmazlığı envanteri

| Yüzey | Token | Koyu | Açık | Not |
|---|---|---|---|---|
| Web | `--color-primary-container` / `--color-primary-fixed-dim` | `#3B82F6` | `#93C5FD` (yalnız container) | Birincil dolgu mavisi; koyu birincil metin `#60A5FA`, açık birincil `#006880` (turkuaz) |
| Web | `--color-surface-tint` | `#3B82F6` | `#006880` | Açıkta turkuaz, mavi değil |
| Web | `--color-secondary-container` | `#2563EB` | `#f2daff` (mor) | Açık temada mavi değil |
| Web | `--color-inverse-primary` | `#2563EB` | - (yalnız koyu blokta tanımlı) | `#2563eb` web'de ikincil/ters birincil rolünde de var |
| Masaüstü | `--arc-blue` | `#2563eb` | `#1d4ed8` | Parlak ton `--arc-blue-lit`: `#60a5fa` / `#1d4ed8` |
| Mobil | `accent` | `#a3b6d9` | `#4e6793` | Gri-mavi; mobilde `primary`, `success`, `info` hepsi `accent`'e düşer |

Gözlem: `#3B82F6` (web) ile `#2563eb` (masaüstü) aynı mavi ailesinde ama farklı ton; masaüstü `#2563eb` web'de `secondary` rolünde. Mobil `#4e6793` ayrı, sakin bir gri-mavi (birleştirme kurucu kararı bekler; bu bilet birleştirmez).

## Eşleme tablosu: primary / success / warning / danger

Koyu / açık değerler. "-" = o yüzeyde ayrılmış token yok.

| Rol | Web (`--color-*`) | Masaüstü | Mobil (`palette.ts` ← JSON) |
|---|---|---|---|
| primary | `primary` `#60A5FA` / `#006880`; dolgu `primary-container` `#3B82F6` / `#93C5FD` | `--arc-blue` `#2563eb` / `#1d4ed8`; `--arc-blue-lit` `#60a5fa` / `#1d4ed8` | `primary` ← `accent` `#a3b6d9` / `#4e6793` |
| success | `success` `#6EE7B7` / `#146A3F` | `--arc-blue-lit` `#60a5fa` / `#1d4ed8` (fiili success: `.conn.online`, `.audit-outcome`, `.cp-live.on`); `.chat-presence[data-state="success"]` `#a3b6d9` sabit | `success` ← `accent` `#a3b6d9` / `#4e6793` |
| warning | `warning` `#FBBF24` / `#855500` | `--ember` `#f97316` / `#a14409` ("çalışıyor/uçuşta" rolü; uyarı sayılır). `.chip.warn::before` ember değil `--molten` kullanır | `warning` ← `warm` `#d7ac8e` / `#8f5a3b` |
| danger | `error` `#FF8A8A` / `#ba1a1a` | `--molten` `#ff4d4d` / `#b91c1c`; dolgu `--danger-fill` `#b91c1c` | `danger` `#f1a4a0` / `#ab3535` |

Açıklar (bulgu, değişiklik değil):
1. Masaüstünde ayrı `success` ve `warning` tokenı yok; eşleme fiili kullanıma göre kuruldu (success = `--arc-blue-lit`, warning = ember; `.chip.warn` ise molten).
2. Mobilde `success` ve `primary` aynı değere (`accent`) düşer; durum rengi olarak ayrışmaz.
3. Web açık temada `primary` (`#006880`) turkuaz, mavi değil; mavi dolgu `primary-container` içinde.

## Denetim

`packages/ui/lib/designTokens.test.ts`: web koyu/açık için primary/success/warning/error metin renklerinin `--color-background` üstündeki WCAG kontrastını (>= 4.5) ve eşleme tablosunda ilgili rol satırının Web sütununda `globals.css`'teki koyu/açık hex değerinin yazılı olduğunu doğrular. Yalnız bu dört rolün web hex'ini kapsar; envanter tablosu, masaüstü ve mobil sütunları denetlenmez. Masaüstü ve mobil değerleri bu repoda olmadığından yalnız belgede kayıtlıdır; değişirlerse tablo elle güncellenir.
