-- CreateEnum
CREATE TYPE "HoldingRiskClass" AS ENUM ('R0', 'R1', 'R2', 'R3', 'R4', 'R5');

-- CreateEnum
CREATE TYPE "HoldingTrustLevel" AS ENUM ('TRUSTED', 'UNTRUSTED');

-- CreateEnum
CREATE TYPE "HoldingRunStatus" AS ENUM ('PENDING', 'RUNNING', 'WAITING_APPROVAL', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "HoldingStepStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "HoldingApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "HoldingSeverity" AS ENUM ('SEV0', 'SEV1', 'SEV2', 'SEV3', 'INFO');

-- CreateEnum
CREATE TYPE "HoldingEventStatus" AS ENUM ('NEW', 'CLASSIFIED', 'ESCALATED', 'CLOSED');

-- CreateEnum
CREATE TYPE "HoldingFindingType" AS ENUM ('HATA', 'GOREV', 'GELISTIRME', 'RISK');

-- CreateEnum
CREATE TYPE "HoldingFindingSeverity" AS ENUM ('P0', 'P1', 'P2');

-- CreateEnum
CREATE TYPE "HoldingFindingStatus" AS ENUM ('ACIK', 'CALISILIYOR', 'KAPANDI');

-- CreateTable
CREATE TABLE "holding_workflow_definitions" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "risk_class" "HoldingRiskClass" NOT NULL,
    "autonomy_level" INTEGER NOT NULL DEFAULT 2,
    "steps" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "holding_workflow_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "holding_workflow_runs" (
    "id" TEXT NOT NULL,
    "definition_id" TEXT NOT NULL,
    "status" "HoldingRunStatus" NOT NULL DEFAULT 'PENDING',
    "charter" JSONB NOT NULL,
    "charter_hash" TEXT NOT NULL,
    "trust_level" "HoldingTrustLevel" NOT NULL DEFAULT 'TRUSTED',
    "risk_class" "HoldingRiskClass" NOT NULL,
    "venture" TEXT NOT NULL,
    "trigger" TEXT NOT NULL DEFAULT 'manual',
    "input" JSONB NOT NULL DEFAULT '{}',
    "output" JSONB,
    "error" TEXT,
    "cost_usd" DECIMAL(10,6),
    "resume_cursor" INTEGER,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "holding_workflow_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "holding_step_runs" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "step_index" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "status" "HoldingStepStatus" NOT NULL DEFAULT 'PENDING',
    "reasoning" TEXT NOT NULL,
    "input" JSONB NOT NULL DEFAULT '{}',
    "output" JSONB,
    "error" TEXT,
    "cost_usd" DECIMAL(10,6),
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "holding_step_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "holding_approvals" (
    "id" TEXT NOT NULL,
    "run_id" TEXT,
    "step_index" INTEGER,
    "risk_class" "HoldingRiskClass" NOT NULL,
    "status" "HoldingApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "description" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "decided_by" TEXT,
    "decided_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "telegram_message_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "holding_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "holding_sentinel_events" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "severity" "HoldingSeverity" NOT NULL,
    "trust_level" "HoldingTrustLevel" NOT NULL DEFAULT 'UNTRUSTED',
    "payload" JSONB NOT NULL DEFAULT '{}',
    "fingerprint" TEXT NOT NULL,
    "status" "HoldingEventStatus" NOT NULL DEFAULT 'NEW',
    "dedup_count" INTEGER NOT NULL DEFAULT 1,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "holding_sentinel_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "holding_heartbeats" (
    "id" TEXT NOT NULL,
    "sensor_id" TEXT NOT NULL,
    "interval_seconds" INTEGER NOT NULL,
    "last_beat_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "holding_heartbeats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "holding_findings" (
    "id" TEXT NOT NULL,
    "code" TEXT,
    "type" "HoldingFindingType" NOT NULL,
    "severity" "HoldingFindingSeverity" NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "venture" TEXT,
    "status" "HoldingFindingStatus" NOT NULL DEFAULT 'ACIK',
    "closure_evidence" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "holding_findings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "holding_audit_logs" (
    "id" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity" TEXT,
    "entity_id" TEXT,
    "run_id" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "holding_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "holding_workflow_definitions_key_key" ON "holding_workflow_definitions"("key");

-- CreateIndex
CREATE INDEX "holding_workflow_runs_definition_id_idx" ON "holding_workflow_runs"("definition_id");

-- CreateIndex
CREATE INDEX "holding_workflow_runs_status_idx" ON "holding_workflow_runs"("status");

-- CreateIndex
CREATE INDEX "holding_step_runs_run_id_idx" ON "holding_step_runs"("run_id");

-- CreateIndex
CREATE INDEX "holding_approvals_status_idx" ON "holding_approvals"("status");

-- CreateIndex
CREATE INDEX "holding_sentinel_events_fingerprint_idx" ON "holding_sentinel_events"("fingerprint");

-- CreateIndex
CREATE INDEX "holding_sentinel_events_status_severity_idx" ON "holding_sentinel_events"("status", "severity");

-- CreateIndex
CREATE UNIQUE INDEX "holding_heartbeats_sensor_id_key" ON "holding_heartbeats"("sensor_id");

-- CreateIndex
CREATE UNIQUE INDEX "holding_findings_code_key" ON "holding_findings"("code");

-- CreateIndex
CREATE INDEX "holding_findings_status_severity_idx" ON "holding_findings"("status", "severity");

-- CreateIndex
CREATE INDEX "holding_audit_logs_ts_idx" ON "holding_audit_logs"("ts");

-- CreateIndex
CREATE INDEX "holding_audit_logs_entity_entity_id_idx" ON "holding_audit_logs"("entity", "entity_id");

-- AddForeignKey
ALTER TABLE "holding_workflow_runs" ADD CONSTRAINT "holding_workflow_runs_definition_id_fkey" FOREIGN KEY ("definition_id") REFERENCES "holding_workflow_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "holding_step_runs" ADD CONSTRAINT "holding_step_runs_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "holding_workflow_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "holding_approvals" ADD CONSTRAINT "holding_approvals_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "holding_workflow_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── Hand-authored governance hardening (not expressible in Prisma DSL) ──

-- holding_audit_logs is APPEND-ONLY (FABLE_PLAN §3: audit İLK fazda kurulur,
-- sonraki tüm denetim buna dayanır). A BEFORE trigger blocks UPDATE/DELETE
-- for EVERY role (superusers can only bypass by disabling the trigger, which
-- is itself a loud, auditable act). Role-level REVOKEs below are the second
-- belt for the known app roles when they exist.
CREATE OR REPLACE FUNCTION holding_audit_logs_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'holding_audit_logs is append-only (% blocked)', TG_OP;
END $$;

CREATE TRIGGER holding_audit_logs_append_only
BEFORE UPDATE OR DELETE ON "holding_audit_logs"
FOR EACH ROW EXECUTE FUNCTION holding_audit_logs_append_only();

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'braavolabs_app') THEN
    REVOKE UPDATE, DELETE ON "holding_audit_logs" FROM braavolabs_app;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'aicos_app') THEN
    REVOKE UPDATE, DELETE ON "holding_audit_logs" FROM aicos_app;
  END IF;
END $$;

-- §5C: a finding cannot be closed without closure evidence — DB-level twin
-- of the service-layer rule ("kapanış kanıtsız olmaz").
ALTER TABLE "holding_findings" ADD CONSTRAINT "holding_findings_closure_evidence_required"
  CHECK ("status" <> 'KAPANDI' OR "closure_evidence" IS NOT NULL);
