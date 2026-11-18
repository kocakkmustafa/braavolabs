-- BRA-P2-02c: ApprovalType += SANDBOX_ESCAPE (sandbox-escape approval kind).
-- Additive and non-destructive; no table rewrite, no data change.
-- Rollback: Postgres cannot DROP an enum value. Leaving the unused value is
-- harmless (old code never writes it); do not attempt a down-migration.
-- ADD VALUE IF NOT EXISTS is idempotent and, on PG >= 12, may run inside the
-- migration transaction (the new value is not USED in this migration).
-- Production apply: ONLY via a v* tag release (never by hand / branch push).

-- AlterEnum
ALTER TYPE "ApprovalType" ADD VALUE IF NOT EXISTS 'SANDBOX_ESCAPE';
