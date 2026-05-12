-- Hierarchical pipeline topology (Feature 4).
--
-- SEQUENTIAL is the existing behaviour; HIERARCHICAL adds a "manager"
-- agent that receives the run input, plans, and delegates to worker
-- agents via the runtime's `delegate` tool call. The default keeps
-- every existing pipeline behaving exactly as it does today.

CREATE TYPE "PipelineType" AS ENUM ('SEQUENTIAL', 'HIERARCHICAL');

ALTER TABLE "pipelines"
  ADD COLUMN "pipeline_type" "PipelineType" NOT NULL DEFAULT 'SEQUENTIAL',
  ADD COLUMN "manager_agent_id" TEXT,
  ADD COLUMN "max_delegation_depth" INTEGER NOT NULL DEFAULT 3;
