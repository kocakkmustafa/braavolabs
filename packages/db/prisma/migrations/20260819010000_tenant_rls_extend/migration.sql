-- Migration: tenant_rls_extend (BR-P0-004)
--
-- 20260616000000_tenant_rls covers 8 tables; three later migrations each
-- separately added the same pattern ad-hoc when they created a new
-- tenant table (20260702_multi_provider_keys_media_assets: media_assets;
-- 20260703_handoff_ledger: handoff_ledger; 20260716_media_orchestration:
-- media_provider_keys, media_generations) — 12 tables covered in total,
-- confirmed by a full grep across every migration before writing this
-- one (an EARLIER draft of this migration duplicated all 4 of those and
-- was caught by `prisma migrate deploy` itself failing with "policy
-- already exists" against a fresh empty DB — exactly the empty-DB
-- validation step this task requires, doing its job).
--
-- This migration extends the SAME defense-in-depth RLS layer (see the
-- 20260616 migration's own header for the full mechanism explanation —
-- current_tenant_id(), the app-layer WHERE-clause as primary isolation,
-- RLS as the enforced DB-level second layer) to every REMAINING
-- tenant-scoped table: 11 with a direct tenant_id column, 7 reachable
-- via one hop through companies, and 7 reachable via two-to-four hops
-- (runs -> pipelines -> companies, and deeper) — 25 tables total.
--
-- Purely ADDITIVE — no existing policy touched, no data mutated. Safe on
-- a live database: RLS is currently a no-op in production regardless
-- (the runtime role is still the table-owning superuser pending the
-- separately-tracked, founder-gated STAGE 2 activation — see
-- ventures/braavolabs/workspace/RLS-STAGE2-RUNBOOK.md), so this migration
-- has ZERO observable effect until that activation happens; it simply
-- means STAGE 2, whenever activated, protects the WHOLE schema instead
-- of only the original 8 tables.
--
-- current_tenant_id() IS NULL OR ... on every policy: unauthenticated
-- routes, background workers (BullMQ jobs, which run without ambient
-- tenant context by design and scope themselves via explicit
-- WHERE tenantId per job), and Prisma migrations all pass through
-- unaffected — identical carve-out to the original migration.

-- ── Direct tenant_id column (11 tables) ──────────────────────────────

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rls ON users
  USING (current_tenant_id() IS NULL OR tenant_id = current_tenant_id());

ALTER TABLE mobile_subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rls ON mobile_subscriptions
  USING (current_tenant_id() IS NULL OR tenant_id = current_tenant_id());

ALTER TABLE pipeline_licenses ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rls ON pipeline_licenses
  USING (current_tenant_id() IS NULL OR tenant_id = current_tenant_id());

ALTER TABLE template_ratings ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rls ON template_ratings
  USING (current_tenant_id() IS NULL OR tenant_id = current_tenant_id());

ALTER TABLE template_installs ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rls ON template_installs
  USING (current_tenant_id() IS NULL OR tenant_id = current_tenant_id());

ALTER TABLE tenant_connectors ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rls ON tenant_connectors
  USING (current_tenant_id() IS NULL OR tenant_id = current_tenant_id());

ALTER TABLE web_research_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rls ON web_research_sessions
  USING (current_tenant_id() IS NULL OR tenant_id = current_tenant_id());

ALTER TABLE voice_calls ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rls ON voice_calls
  USING (current_tenant_id() IS NULL OR tenant_id = current_tenant_id());

ALTER TABLE oidc_connections ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rls ON oidc_connections
  USING (current_tenant_id() IS NULL OR tenant_id = current_tenant_id());

-- BR-P0-003's own table — added here rather than in that migration
-- because tenant_rls_extend didn't exist yet when it was written.
ALTER TABLE entitlement_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rls ON entitlement_events
  USING (current_tenant_id() IS NULL OR tenant_id = current_tenant_id());

ALTER TABLE ab_tests ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rls ON ab_tests
  USING (current_tenant_id() IS NULL OR tenant_id = current_tenant_id());

-- ── One hop via company_id -> companies.tenant_id (7 tables) ────────
-- Same EXISTS-subquery shape as the original migration's agents/
-- pipelines/integrations policies, so the planner can use the
-- companies primary-key index.

ALTER TABLE memory_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rls ON memory_items
  USING (
    current_tenant_id() IS NULL
    OR EXISTS (SELECT 1 FROM companies c WHERE c.id = company_id AND c.tenant_id = current_tenant_id())
  );

ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rls ON contacts
  USING (
    current_tenant_id() IS NULL
    OR EXISTS (SELECT 1 FROM companies c WHERE c.id = company_id AND c.tenant_id = current_tenant_id())
  );

ALTER TABLE deals ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rls ON deals
  USING (
    current_tenant_id() IS NULL
    OR EXISTS (SELECT 1 FROM companies c WHERE c.id = company_id AND c.tenant_id = current_tenant_id())
  );

ALTER TABLE outreach_sequences ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rls ON outreach_sequences
  USING (
    current_tenant_id() IS NULL
    OR EXISTS (SELECT 1 FROM companies c WHERE c.id = company_id AND c.tenant_id = current_tenant_id())
  );

ALTER TABLE eval_results ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rls ON eval_results
  USING (
    current_tenant_id() IS NULL
    OR EXISTS (SELECT 1 FROM companies c WHERE c.id = company_id AND c.tenant_id = current_tenant_id())
  );

ALTER TABLE voice_agents ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rls ON voice_agents
  USING (
    current_tenant_id() IS NULL
    OR EXISTS (SELECT 1 FROM companies c WHERE c.id = company_id AND c.tenant_id = current_tenant_id())
  );

ALTER TABLE drafts ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rls ON drafts
  USING (
    current_tenant_id() IS NULL
    OR EXISTS (SELECT 1 FROM companies c WHERE c.id = company_id AND c.tenant_id = current_tenant_id())
  );

-- ── Multi-hop chains (6 tables) ───────────────────────────────────────
-- runs -> pipelines -> companies (2 hops); run_steps and approvals build
-- on runs (3 hops); tool_calls builds on run_steps (4 hops). Each policy
-- writes its OWN full join chain down to companies.tenant_id rather than
-- relying on an intermediate table's RLS to "already handle it" — a
-- policy should be correct read in isolation, not depend on another
-- table's policy configuration.

ALTER TABLE runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rls ON runs
  USING (
    current_tenant_id() IS NULL
    OR EXISTS (
      SELECT 1 FROM pipelines p
      JOIN companies c ON c.id = p.company_id
      WHERE p.id = pipeline_id AND c.tenant_id = current_tenant_id()
    )
  );

ALTER TABLE run_steps ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rls ON run_steps
  USING (
    current_tenant_id() IS NULL
    OR EXISTS (
      SELECT 1 FROM runs r
      JOIN pipelines p ON p.id = r.pipeline_id
      JOIN companies c ON c.id = p.company_id
      WHERE r.id = run_id AND c.tenant_id = current_tenant_id()
    )
  );

ALTER TABLE approvals ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rls ON approvals
  USING (
    current_tenant_id() IS NULL
    OR EXISTS (
      SELECT 1 FROM runs r
      JOIN pipelines p ON p.id = r.pipeline_id
      JOIN companies c ON c.id = p.company_id
      WHERE r.id = run_id AND c.tenant_id = current_tenant_id()
    )
  );

ALTER TABLE tool_calls ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rls ON tool_calls
  USING (
    current_tenant_id() IS NULL
    OR EXISTS (
      SELECT 1 FROM run_steps rs
      JOIN runs r ON r.id = rs.run_id
      JOIN pipelines p ON p.id = r.pipeline_id
      JOIN companies c ON c.id = p.company_id
      WHERE rs.id = run_step_id AND c.tenant_id = current_tenant_id()
    )
  );

ALTER TABLE memory_embeddings ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rls ON memory_embeddings
  USING (
    current_tenant_id() IS NULL
    OR EXISTS (
      SELECT 1 FROM memory_items mi
      JOIN companies c ON c.id = mi.company_id
      WHERE mi.id = memory_item_id AND c.tenant_id = current_tenant_id()
    )
  );

-- Checks only the `from` endpoint's company — edges are constructed
-- exclusively within a single company's memory graph (never linked
-- across companies by any application code path), so the two endpoints
-- always agree in practice. Documented assumption, not re-verified here.
ALTER TABLE memory_edges ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rls ON memory_edges
  USING (
    current_tenant_id() IS NULL
    OR EXISTS (
      SELECT 1 FROM memory_items mi
      JOIN companies c ON c.id = mi.company_id
      WHERE mi.id = from_id AND c.tenant_id = current_tenant_id()
    )
  );

ALTER TABLE outreach_enrollments ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rls ON outreach_enrollments
  USING (
    current_tenant_id() IS NULL
    OR EXISTS (
      SELECT 1 FROM outreach_sequences os
      JOIN companies c ON c.id = os.company_id
      WHERE os.id = sequence_id AND c.tenant_id = current_tenant_id()
    )
  );
