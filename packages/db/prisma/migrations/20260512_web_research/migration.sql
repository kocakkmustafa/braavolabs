-- Autonomous web research primitive (Feature 7).
--
-- Stores every research session + every source the loop visited, so
-- the audit trail captures both the synthesised findings and the
-- raw evidence behind every claim.

CREATE TYPE "WebResearchStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

CREATE TABLE "web_research_sessions" (
  "id"                       TEXT PRIMARY KEY,
  "tenant_id"                TEXT NOT NULL,
  "company_id"               TEXT NOT NULL,
  "initiated_by_run_step_id" TEXT,
  "query"                    TEXT NOT NULL,
  "max_rounds"               INTEGER NOT NULL DEFAULT 3,
  "max_sources"              INTEGER NOT NULL DEFAULT 20,
  "max_cost_usd"             DECIMAL(10, 4) NOT NULL DEFAULT 1.00,
  "status"                   "WebResearchStatus" NOT NULL DEFAULT 'PENDING',
  "findings"                 JSONB,
  "cost_usd"                 DECIMAL(10, 4),
  "error"                    TEXT,
  "started_at"               TIMESTAMP(3),
  "completed_at"             TIMESTAMP(3),
  "created_at"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"               TIMESTAMP(3) NOT NULL
);
CREATE INDEX "web_research_sessions_tenant_id_created_at_idx"
  ON "web_research_sessions"("tenant_id", "created_at" DESC);
CREATE INDEX "web_research_sessions_company_id_created_at_idx"
  ON "web_research_sessions"("company_id", "created_at" DESC);

CREATE TABLE "web_research_sources" (
  "id"           TEXT PRIMARY KEY,
  "session_id"   TEXT NOT NULL,
  "url"          TEXT NOT NULL,
  "title"        TEXT,
  "content"      TEXT NOT NULL DEFAULT '',
  "content_hash" TEXT NOT NULL,
  "relevance"    DOUBLE PRECISION NOT NULL DEFAULT 0,
  "fetched_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "web_research_sources_session_id_fkey"
    FOREIGN KEY ("session_id") REFERENCES "web_research_sessions"("id") ON DELETE CASCADE,
  CONSTRAINT "web_research_sources_session_content_hash_unique"
    UNIQUE ("session_id", "content_hash")
);
CREATE INDEX "web_research_sources_session_id_idx" ON "web_research_sources"("session_id");
