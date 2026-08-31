-- BR-P0-002-D: additive subscription-only plan migration.
-- There is intentionally no destructive down migration. Historical enum
-- values remain readable for one compatibility release and every original
-- tenant plan is copied to legacy_plan before the projection changes.

ALTER TYPE "Plan" ADD VALUE IF NOT EXISTS 'INDIVIDUAL';
ALTER TYPE "Plan" ADD VALUE IF NOT EXISTS 'TEAM';
ALTER TYPE "Plan" ADD VALUE IF NOT EXISTS 'MANUAL_REVIEW';

ALTER TABLE "tenants"
  ADD COLUMN IF NOT EXISTS "legacy_plan" TEXT,
  ADD COLUMN IF NOT EXISTS "subscription_migration_state" TEXT NOT NULL DEFAULT 'pending';

UPDATE "tenants"
SET "legacy_plan" = "plan"::TEXT
WHERE "legacy_plan" IS NULL
  AND "plan"::TEXT IN ('FREE', 'CREATOR', 'PRO', 'BUSINESS', 'ENTERPRISE');

UPDATE "tenants"
SET
  "plan" = CASE "legacy_plan"
    WHEN 'CREATOR' THEN 'INDIVIDUAL'::"Plan"
    WHEN 'PRO' THEN 'TEAM'::"Plan"
    ELSE 'MANUAL_REVIEW'::"Plan"
  END,
  "subscription_migration_state" = CASE "legacy_plan"
    WHEN 'CREATOR' THEN 'mapped'
    WHEN 'PRO' THEN 'mapped'
    ELSE 'manual_review'
  END
WHERE "legacy_plan" IS NOT NULL
  AND "subscription_migration_state" = 'pending';

UPDATE "tenants"
SET "subscription_migration_state" = 'mapped'
WHERE "legacy_plan" IS NULL
  AND "plan"::TEXT IN ('INDIVIDUAL', 'TEAM')
  AND "subscription_migration_state" = 'pending';

ALTER TABLE "tenants" ALTER COLUMN "plan" SET DEFAULT 'MANUAL_REVIEW'::"Plan";
