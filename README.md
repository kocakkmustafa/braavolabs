# AI Company OS

Kullanıcıların serbest metinle AI şirketi kurup çalıştırabildiği, izlenebilir, düzenlenebilir, kendini geliştiren otonom şirket oluşturma platformu.

## Hızlı Başlangıç

```bash
# 1. Bağımlılıkları kur
pnpm install

# 2. Servisleri başlat (Postgres + Redis)
cd ENV && docker compose up -d

# 3. Veritabanı migration
pnpm db:migrate

# 4. Seed data
pnpm db:seed

# 5. API sunucusu (port 8080)
cd packages/api && pnpm dev

# 6. Dashboard (port 3000)
cd packages/ui && pnpm dev
```

## Monorepo Yapısı

| Paket | Açıklama |
|-------|----------|
| `packages/db` | Prisma schema + migrations |
| `packages/core` | Shared types, utils, constants |
| `packages/api` | Backend API (Express) |
| `packages/ui` | Next.js Dashboard |
| `packages/memory` | Memory engine |
| `packages/integrations` | HubSpot, Stripe, Email, Social adapters |

## Lisans

Proprietary — All rights reserved.
