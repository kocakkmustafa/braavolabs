-- Multi-key BYOK + media assets (E2 — plan §2.3 / T6 + T9 schema leg).
--
-- 1. user_ai_configs goes from ONE row per tenant (tenant_id UNIQUE) to ONE
--    row PER (tenant, provider). New columns:
--      is_default            — exactly one row per tenant is the active config
--                              (getTenantAIConfig resolves to it).
--      fallback_order        — position in the tenant's cross-provider
--                              failover chain (T7); NULL = not in the chain.
--      allow_system_fallback — opt-in (default FALSE): may a run fall back to
--                              trial-Groq / system Anthropic once the tenant's
--                              own chain is exhausted? Read from the default
--                              row. Default false preserves the BYOK trust
--                              contract (plan §2.2).
--    Additive + backfill: every existing row (at most one per tenant thanks to
--    the old unique) becomes the tenant's default. No data is lost.
--
-- 2. media_assets — binary outputs of agent media tools (T9): BYTEA payload,
--    10MB cap enforced at write time, tenant-scoped serving, 30-day retention
--    via the expires_at default + hourly sweep (approval-expiry cron pattern).
--
-- Safe to run on a live database: column adds have defaults, the backfill
-- UPDATE touches only pre-existing rows, and the unique-index swap widens
-- (never narrows) what the table accepts.

-- ── 1a. user_ai_configs: new columns ─────────────────────────────────────────

ALTER TABLE "user_ai_configs" ADD COLUMN IF NOT EXISTS "is_default" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "user_ai_configs" ADD COLUMN IF NOT EXISTS "fallback_order" INTEGER;
ALTER TABLE "user_ai_configs" ADD COLUMN IF NOT EXISTS "allow_system_fallback" BOOLEAN NOT NULL DEFAULT false;

-- ── 1b. Backfill: the existing single row per tenant IS that tenant's default ─
-- (Old unique guarantees at most one row per tenant, so this cannot create
-- two defaults for the same tenant.)

UPDATE "user_ai_configs" SET "is_default" = true WHERE "is_default" = false;

-- ── 1c. Unique swap: tenant_id UNIQUE → (tenant_id, provider) UNIQUE ─────────
-- The old unique index also served as the tenant lookup index, so a plain
-- index on tenant_id is recreated alongside the composite unique.

DROP INDEX IF EXISTS "user_ai_configs_tenant_id_key";

CREATE UNIQUE INDEX "user_ai_configs_tenant_id_provider_key" ON "user_ai_configs"("tenant_id", "provider");

CREATE INDEX "user_ai_configs_tenant_id_idx" ON "user_ai_configs"("tenant_id");

-- ── 1d. DB-level invariant: at most ONE default row per tenant ───────────────
-- Partial unique index (not representable in schema.prisma — same
-- "SQL-beyond-Prisma" precedent as the 20260616 RLS migration). App code
-- (saveTenantAIConfig) demotes siblings before promoting a row, so this
-- only fires if a future code path forgets the invariant.

CREATE UNIQUE INDEX "user_ai_configs_tenant_default_key" ON "user_ai_configs"("tenant_id") WHERE "is_default";

-- ── 2. media_assets (T9) ──────────────────────────────────────────────────────

CREATE TABLE "media_assets" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "tool_call_id" TEXT,
    "mime" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "bytes" BYTEA NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP + interval '30 days'),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_assets_pkey" PRIMARY KEY ("id")
);

-- Tenant-scoped serving (GET /media/:id) and the hourly retention sweep.
CREATE INDEX "media_assets_tenant_id_idx" ON "media_assets"("tenant_id");
CREATE INDEX "media_assets_expires_at_idx" ON "media_assets"("expires_at");

ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-Level Security — same defense-in-depth pattern as 20260616_tenant_rls
-- (current_tenant_id() helper already exists from that migration).
ALTER TABLE "media_assets" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rls ON "media_assets"
  USING (current_tenant_id() IS NULL OR "tenant_id" = current_tenant_id());
