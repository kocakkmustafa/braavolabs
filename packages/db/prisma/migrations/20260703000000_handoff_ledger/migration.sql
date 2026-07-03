-- Cross-model handoff ledger (E3 — plan §2.1/§2.2/§2.5, T1).
--
-- E2's turn-boundary failover is in-memory and single-process (provider-chain
-- circuits + pendingLinks die with the process). This migration makes takeover
-- state durable and cross-session:
--
-- 1. handoff_ledger — one row per handoff of a run from one provider/model to
--    another. Lifecycle: OPEN (checkpoint frozen once the live loop handles
--    the turn-boundary interrupt) → CLAIMED (target provider assigned, run
--    re-enqueued) → COMPLETED/FAILED; CANCELLED on operator cancel / rerun.
--      checkpoint  — frozen copy of the canonical transcript at handoff time
--                    { messages, turn, toolUseMode, costSoFarUsd, ... }.
--                    NULL until the live loop freezes it (§2.3a) — claim
--                    requires it non-NULL (double-execution lock).
--      git_state   — best-effort GitHub snapshot (PR/branch status) captured
--                    at handoff time; NULL when the tenant has no GITHUB
--                    integration (handoff still works).
--      run_step_id — the INTERRUPTED step's (old) row; the takeover opens a
--                    NEW RunStep row with the same step_index (B6.5), so this
--                    FK is SET NULL on step deletion, never a uniqueness key.
--
-- 2. run_steps.transcript — live turn-boundary checkpoint (§2.2): the agent
--    loop persists the canonical ChatMessage[] here at the END of every turn
--    on governed runs; crash-safe carrier ("token ran out / session died").
--    NULLed when the step COMPLETEs — the durable copy is ledger.checkpoint.
--
-- 3. ApprovalType.HANDOFF — automatic-trigger proposals (§2.5): created only
--    when the chain died with a MARKED failover-class error AND a viable
--    alternative provider exists; surfaces in the same approvals queue the
--    mobile app already renders (EXTERNAL_CONTROL precedent — zero mobile
--    code). Additive enum value — safe, no backfill (same pattern as
--    20260628_approval_external_control).
--
-- Purely ADDITIVE: new enums, one new table, one nullable column, one enum
-- value. Safe to run on a live database — no backfill, no lock-heavy rewrite
-- (nullable column add is metadata-only in Postgres).

-- ── 1. Enums ──────────────────────────────────────────────────────────────────

-- CreateEnum
CREATE TYPE "HandoffReason" AS ENUM ('MANUAL', 'PROVIDER_FAILOVER', 'PROVIDER_EXHAUSTED', 'SESSION_LOST');

-- CreateEnum
CREATE TYPE "HandoffStatus" AS ENUM ('OPEN', 'CLAIMED', 'COMPLETED', 'FAILED', 'CANCELLED');

-- AlterEnum (additive — Postgres 12+ allows ADD VALUE inside the migration
-- transaction; IF NOT EXISTS keeps it idempotent, 20260628 precedent)
ALTER TYPE "ApprovalType" ADD VALUE IF NOT EXISTS 'HANDOFF';

-- ── 2. run_steps: live turn-boundary checkpoint column ───────────────────────

-- AlterTable
ALTER TABLE "run_steps" ADD COLUMN IF NOT EXISTS "transcript" JSONB;

-- ── 3. handoff_ledger ─────────────────────────────────────────────────────────

-- CreateTable
CREATE TABLE "handoff_ledger" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "run_step_id" TEXT,
    "step_index" INTEGER NOT NULL,
    "from_provider" "AIProvider" NOT NULL,
    "from_model" TEXT NOT NULL,
    "to_provider" "AIProvider",
    "to_model" TEXT,
    "reason" "HandoffReason" NOT NULL,
    "status" "HandoffStatus" NOT NULL DEFAULT 'OPEN',
    "checkpoint" JSONB,
    "git_state" JSONB,
    "context_summary" TEXT,
    "created_by" TEXT,
    "claimed_by" TEXT,
    "claimed_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "handoff_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateIndex — tenant-wide OPEN-handoff listing (CLI `braavo handoffs`,
-- HandoffPanel) and per-run timeline.
CREATE INDEX "handoff_ledger_tenant_id_status_idx" ON "handoff_ledger"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "handoff_ledger_run_id_idx" ON "handoff_ledger"("run_id");

-- AddForeignKey
ALTER TABLE "handoff_ledger" ADD CONSTRAINT "handoff_ledger_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "handoff_ledger" ADD CONSTRAINT "handoff_ledger_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "handoff_ledger" ADD CONSTRAINT "handoff_ledger_run_step_id_fkey" FOREIGN KEY ("run_step_id") REFERENCES "run_steps"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── 4. Row-Level Security ─────────────────────────────────────────────────────
-- Same defense-in-depth pattern as 20260616_tenant_rls / 20260702 media_assets
-- (current_tenant_id() helper already exists from 20260616; checkpoint JSON
-- carries tenant conversation data, so the direct tenant_id policy applies).
ALTER TABLE "handoff_ledger" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rls ON "handoff_ledger"
  USING (current_tenant_id() IS NULL OR "tenant_id" = current_tenant_id());
