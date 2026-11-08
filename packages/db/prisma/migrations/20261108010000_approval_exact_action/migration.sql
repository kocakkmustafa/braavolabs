-- BRA-P0-05 / BRA-P0-08 — Exact-action approval + job budget (ADR-0002,
-- docs/yula-execution/DECISIONS.md).
-- ADDITIVE ONLY: four nullable columns on "approvals", one nullable JSON column
-- on "runs", one unique index and one plain index. No existing column, enum
-- value or row semantics change. Rollback = ignore the new columns (nothing
-- reads them while EXACT_ACTION_APPROVAL is off and no run carries a
-- job_budget). NOT applied to any environment by this PR.
--
-- Deliberately NOT backfilled: approvals.nonce / action_hash. Legacy approvals
-- were never bound to an action and must never be consumable as an exact-action
-- grant. tenant_id is stable, so it IS backfilled below (idempotent:
-- WHERE tenant_id IS NULL, safe to re-run); it is audit/denormalisation only.

-- AlterTable
ALTER TABLE "approvals" ADD COLUMN     "action_hash" TEXT,
ADD COLUMN     "consumed_at" TIMESTAMP(3),
ADD COLUMN     "nonce" TEXT,
ADD COLUMN     "tenant_id" TEXT;

-- AlterTable
ALTER TABLE "runs" ADD COLUMN     "job_budget" JSONB;

-- CreateIndex
CREATE UNIQUE INDEX "approvals_nonce_key" ON "approvals"("nonce");

-- CreateIndex
CREATE INDEX "approvals_run_id_action_hash_idx" ON "approvals"("run_id", "action_hash");

-- Backfill the denormalised owner: Approval -> Run -> Pipeline -> Company -> Tenant.
UPDATE "approvals" a
SET "tenant_id" = c."tenant_id"
FROM "runs" r
JOIN "pipelines" p ON p."id" = r."pipeline_id"
JOIN "companies" c ON c."id" = p."company_id"
WHERE r."id" = a."run_id"
  AND a."tenant_id" IS NULL;
