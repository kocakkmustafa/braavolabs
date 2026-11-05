# YULAlab — yerel Codex girişi

Önce [ortak bağlam girişini](../../../AGENTS.md), ardından [bu reponun tek yerel ürün/güvenlik kaynağını](CLAUDE.md) oku. CLAUDE.md içindeki yerel bilgiler Codex ve Claude için aynıdır; teknik yöntemi model seçer, dosya işlem yetkisi üretmez.

Bu dosya Codex ve diğer kod ajanları içindir. Kısa tutulur; ayrıntı `CLAUDE.md`'dedir, çelişkide `CLAUDE.md` doğrudur.

## Yığın
- pnpm 9 workspaces + Turbo · Node 24.22.0 · API: Express + TypeScript + Prisma 5 · UI: Next.js 15 + Tailwind · Postgres 16 + Redis 7
- Kurulum: `pnpm install --frozen-lockfile` ve `pnpm --filter @ai-company-os/db exec prisma generate`
- Analizden önce paketleri derle: `pnpm --filter @ai-company-os/<core|memory|integrations|connector-sdk> build`
- Analiz (CI ile aynı): `pnpm --filter @ai-company-os/api exec tsc --noEmit` · `pnpm lint`
- Test (CI ile aynı): `pnpm -r --if-present test` · derleme: `pnpm build`

## Kurallar
- **Minimal diff:** yalnız istenen dosyalara dokun; biçimlendirme/yeniden adlandırma turu yapma.
- Yerelleştirme: `packages/ui/messages/<dil>.json` (next-intl); dil listesi `packages/ui/i18n/locales.ts`; doğrulama `packages/ui/i18n/locales.test.mjs`. Yeni anahtarı tüm dil dosyalarına ekle, çeviri yoksa İngilizce bırak.
- Testler: paket içinde `vitest run`, kökte `scripts/*.test.mjs` (`node --test`); yeni davranışa test ekle, mevcut testi silme ya da atlatma.
- Kiracı izolasyonu: her Prisma `where` `tenantId` içerir; `CLAUDE.md` "Non-negotiable rules" geçerlidir.
- Bitirmeden: analiz ve test temiz olmalı; çıktının son 5 satırını rapora koy.

## Dokunulmaz
- Prod deploy: `v*` etiketi ya da elle workflow_dispatch — yalnız kurucu onayıyla; etiket itme ve deploy tetikleme yok.
- Prisma göçleri (`packages/db`) ve RLS politikaları — yalnız açık talimatla.
- Sır dosyaları (`.env*`, anahtarlar, `~/.secrets`); fiyat/abonelik kimlikleri.
- Burun Farkı ve Iron Bank.
