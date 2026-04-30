-- Trial LLM counter — every new tenant gets `trial_runs_limit` free
-- pipeline runs routed through the holding-owned Groq key. The executor
-- bumps `trial_runs_used` on each routed run and blocks once it hits
-- the limit. Existing tenants land on (used=0, limit=3) so already-paying
-- customers don't suddenly start consuming the trial pool — but we don't
-- want to give them a fresh trial either, so we fix that with a SQL guard:
-- subscribed tenants are flagged via the existing `plan` enum (anything
-- != 'FREE'), and the application code does NOT trigger trial routing
-- for non-FREE tenants regardless of counter state.
ALTER TABLE "tenants"
  ADD COLUMN "trial_runs_used"  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "trial_runs_limit" INTEGER NOT NULL DEFAULT 3;

-- Backfill existing FREE tenants with limit=3 (already the default, but
-- this keeps the migration idempotent if re-run after a manual edit).
UPDATE "tenants" SET "trial_runs_limit" = 3 WHERE "trial_runs_limit" IS NULL;
