-- Add config JSONB column to pipelines table.
-- Code in webhook/router.ts + related modules already references pipeline.config;
-- migration closes the schema drift.
ALTER TABLE "pipelines" ADD COLUMN IF NOT EXISTS "config" JSONB NOT NULL DEFAULT '{}';
