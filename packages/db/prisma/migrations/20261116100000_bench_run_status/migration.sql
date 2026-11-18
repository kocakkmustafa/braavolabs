-- BRA-P1-05-N2 — BenchRun status + errorCode for failed/skipped runs.
-- ADDITIVE ONLY: ADD COLUMN with a constant default (existing rows become
-- 'COMPLETED', metadata-only on PG11+, no table rewrite) and a nullable
-- column. No DROP / ALTER TYPE. NOT applied to any environment by this PR;
-- ships to production only with a `v*` release.

-- AlterTable
ALTER TABLE "bench_runs" ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'COMPLETED',
ADD COLUMN     "error_code" TEXT;
