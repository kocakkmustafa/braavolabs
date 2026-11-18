-- BRA-P0-02b — Job lifecycle (ADR-0001, docs/yula-execution/DECISIONS.md).
-- ADDITIVE ONLY: new enums, new nullable/defaulted columns on "runs", one new
-- table. No existing column, enum value or row semantics change; the 7-value
-- "RunStatus" stays the compatibility projection shipped clients read.
-- Rollback = ignore the new columns (nothing reads them while
-- JOB_STATE_DUAL_WRITE is off). NOT applied to any environment by this PR.
--
-- Deliberately NOT backfilled here: "runs"."state". Legacy writers still update
-- only "status", so a one-off state backfill would go stale immediately;
-- transitionRun derives the current state from "status" and fills "state" on
-- its first dual write. tenant_id / workspace_id are stable, so they are
-- backfilled below (idempotent: WHERE tenant_id IS NULL, safe to re-run).
-- Runs created after this migration keep NULL until the creators set them
-- (follow-up); the later NOT NULL step needs that first.

-- CreateEnum
CREATE TYPE "JobState" AS ENUM ('DRAFT', 'PLANNED', 'READY', 'RUNNING', 'NEEDS_APPROVAL', 'RESUMING', 'PAUSED', 'FAILED', 'CANCELLED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "ResultStatus" AS ENUM ('VERIFIED', 'UNVERIFIED');

-- AlterTable
ALTER TABLE "runs" ADD COLUMN     "deadline" TIMESTAMP(3),
ADD COLUMN     "evidence_ref" TEXT,
ADD COLUMN     "heartbeat_at" TIMESTAMP(3),
ADD COLUMN     "idempotency_key" TEXT,
ADD COLUMN     "plan_version" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "result_status" "ResultStatus",
ADD COLUMN     "retry_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "state" "JobState",
ADD COLUMN     "tenant_id" TEXT,
ADD COLUMN     "workspace_id" TEXT;

-- CreateTable
CREATE TABLE "job_receipts" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "outcome" "JobState" NOT NULL,
    "result_status" "ResultStatus",
    "cost_usd" DECIMAL(10,6),
    "evidence" JSONB NOT NULL DEFAULT '[]',
    "approval_ids" TEXT[],
    "content_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "job_receipts_run_id_idx" ON "job_receipts"("run_id");

-- CreateIndex
CREATE INDEX "job_receipts_tenant_id_created_at_idx" ON "job_receipts"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "runs_tenant_id_state_idx" ON "runs"("tenant_id", "state");

-- CreateIndex
CREATE UNIQUE INDEX "runs_tenant_id_idempotency_key_key" ON "runs"("tenant_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "job_receipts" ADD CONSTRAINT "job_receipts_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Defense in depth, same pattern as the other tenant_id tables (see
-- 20260616000000_tenant_rls): fail-open when no tenant is bound, enforced when
-- the app runs as a non-superuser role with app.tenant_id set.
ALTER TABLE "job_receipts" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rls ON "job_receipts"
  USING (current_tenant_id() IS NULL OR tenant_id = current_tenant_id());

-- Backfill the denormalised owner: Run -> Pipeline -> Company -> Tenant.
UPDATE "runs" r
SET "tenant_id" = c."tenant_id",
    "workspace_id" = p."company_id"
FROM "pipelines" p
JOIN "companies" c ON c."id" = p."company_id"
WHERE p."id" = r."pipeline_id"
  AND r."tenant_id" IS NULL;
