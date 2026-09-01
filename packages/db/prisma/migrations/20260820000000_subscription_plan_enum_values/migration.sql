-- PostgreSQL makes newly added enum values usable only after the transaction
-- that introduced them commits. Keep these additions in their own migration
-- so the following subscription projection migration can use them safely.

ALTER TYPE "Plan" ADD VALUE IF NOT EXISTS 'INDIVIDUAL';
ALTER TYPE "Plan" ADD VALUE IF NOT EXISTS 'TEAM';
ALTER TYPE "Plan" ADD VALUE IF NOT EXISTS 'MANUAL_REVIEW';
