-- Presentation preference per device. Existing clients retain English.
-- Source-only change: apply through the normal reviewed deployment workflow.
ALTER TABLE "devices" ADD COLUMN "locale" TEXT NOT NULL DEFAULT 'en';
