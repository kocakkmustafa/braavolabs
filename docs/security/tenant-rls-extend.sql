-- ============================================================================
-- tenant-rls-extend.sql  (FINDINGS H8 — operator-applied, NOT a Prisma migration)
-- ============================================================================
-- This was deliberately kept OUT of packages/db/prisma/migrations so the CI
-- `prisma migrate deploy` step does NOT auto-apply it. RLS is INERT until the
-- prerequisites below are in place, so there is no benefit to auto-applying it
-- and a real risk of blocking a deploy if any object name drifts.
--
-- PREREQUISITES (without these RLS does nothing — app-layer `where tenantId`
-- remains the primary, verified isolation guarantee):
--   1. DATABASE_URL must use a NON-SUPERUSER role (see the role setup in
--      migrations/20260616000000_tenant_rls/migration.sql). RLS is bypassed
--      for the table owner / superuser.
--   2. app.tenant_id must be set TRANSACTION-LOCALLY on the same connection as
--      the query (set_config(..., true) inside the query's transaction) — the
--      current authMiddleware sets it session-scoped (false) which is lost
--      across Prisma's connection pool. Implement via AsyncLocalStorage +
--      a Prisma $extends query hook that wraps each op in a transaction.
--
-- HOW TO APPLY (after prerequisites, against a STAGING db first):
--   psql "$DATABASE_URL" -f docs/security/tenant-rls-extend.sql
-- It is idempotent (DROP POLICY IF EXISTS before each CREATE) and fail-open,
-- so re-running it is safe.
-- ============================================================================

-- Migration: tenant_rls_extend  (FINDINGS H8)
-- Extends Row-Level Security from the original 8 tables (20260616000000)
-- to the remaining tenant-owned tables, so RLS coverage is consistent
-- across the schema rather than partial.
--
-- SAFETY / REGRESSION NOTES — this migration is intentionally inert under
-- the current runtime and changes NO behaviour when applied:
--   * Policies are FAIL-OPEN: when `app.tenant_id` is unset/empty
--     (current_tenant_id() IS NULL) every row is allowed — exactly like the
--     original migration. Unauthenticated routes, health checks, crons and
--     Prisma migrations are unaffected.
--   * RLS is BYPASSED for the table owner / a SUPERUSER role. It only takes
--     effect when DATABASE_URL uses a non-superuser role (see the role setup
--     in 20260616000000_tenant_rls/migration.sql).
--   * Each ENABLE is paired with a permissive policy immediately, so no
--     table is ever left in deny-all state. Policies use USING only; with no
--     WITH CHECK, Postgres reuses USING for INSERT/UPDATE checks — an insert
--     whose tenant/company matches the session (or with the GUC unset)
--     passes, matching the original migration's semantics.
--
-- KNOWN LIMITATION (documented, not fixed here): the app sets app.tenant_id
-- via `set_config(..., false)` (session-scoped) in authMiddleware. With
-- Prisma's connection pool the middleware statement and the route's queries
-- can land on DIFFERENT pooled connections, so current_tenant_id() is often
-- NULL on the query connection and RLS falls back to fail-open. To make RLS
-- actually enforcing, set the GUC TRANSACTION-LOCALLY on the same connection
-- as the query — e.g. an AsyncLocalStorage carrying tenantId + a Prisma
-- $extends `query` hook that wraps each op in
--   prisma.$transaction([$executeRaw`SELECT set_config('app.tenant_id', $t, true)`, op])
-- (note `true` = local), AND run the app as a non-superuser role. Until then
-- the APPLICATION-LAYER `where tenantId` clauses remain the primary (and
-- verified) isolation guarantee; this migration only raises the ceiling.

-- ── Direct tenant_id column ──────────────────────────────────────────────
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_rls ON users;
CREATE POLICY tenant_rls ON users
  USING (current_tenant_id() IS NULL OR tenant_id = current_tenant_id());

ALTER TABLE mobile_subscriptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_rls ON mobile_subscriptions;
CREATE POLICY tenant_rls ON mobile_subscriptions
  USING (current_tenant_id() IS NULL OR tenant_id = current_tenant_id());

ALTER TABLE pipeline_licenses ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_rls ON pipeline_licenses;
CREATE POLICY tenant_rls ON pipeline_licenses
  USING (current_tenant_id() IS NULL OR tenant_id = current_tenant_id());

ALTER TABLE template_ratings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_rls ON template_ratings;
CREATE POLICY tenant_rls ON template_ratings
  USING (current_tenant_id() IS NULL OR tenant_id = current_tenant_id());

ALTER TABLE template_installs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_rls ON template_installs;
CREATE POLICY tenant_rls ON template_installs
  USING (current_tenant_id() IS NULL OR tenant_id = current_tenant_id());

ALTER TABLE tenant_connectors ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_rls ON tenant_connectors;
CREATE POLICY tenant_rls ON tenant_connectors
  USING (current_tenant_id() IS NULL OR tenant_id = current_tenant_id());

ALTER TABLE web_research_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_rls ON web_research_sessions;
CREATE POLICY tenant_rls ON web_research_sessions
  USING (current_tenant_id() IS NULL OR tenant_id = current_tenant_id());

ALTER TABLE voice_calls ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_rls ON voice_calls;
CREATE POLICY tenant_rls ON voice_calls
  USING (current_tenant_id() IS NULL OR tenant_id = current_tenant_id());

ALTER TABLE oidc_connections ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_rls ON oidc_connections;
CREATE POLICY tenant_rls ON oidc_connections
  USING (current_tenant_id() IS NULL OR tenant_id = current_tenant_id());

ALTER TABLE ab_tests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_rls ON ab_tests;
CREATE POLICY tenant_rls ON ab_tests
  USING (current_tenant_id() IS NULL OR tenant_id = current_tenant_id());

-- ── One hop: company_id → companies.tenant_id ────────────────────────────
ALTER TABLE memory_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_rls ON memory_items;
CREATE POLICY tenant_rls ON memory_items
  USING (current_tenant_id() IS NULL OR EXISTS (
    SELECT 1 FROM companies c WHERE c.id = company_id AND c.tenant_id = current_tenant_id()));

ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_rls ON contacts;
CREATE POLICY tenant_rls ON contacts
  USING (current_tenant_id() IS NULL OR EXISTS (
    SELECT 1 FROM companies c WHERE c.id = company_id AND c.tenant_id = current_tenant_id()));

ALTER TABLE deals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_rls ON deals;
CREATE POLICY tenant_rls ON deals
  USING (current_tenant_id() IS NULL OR EXISTS (
    SELECT 1 FROM companies c WHERE c.id = company_id AND c.tenant_id = current_tenant_id()));

ALTER TABLE outreach_sequences ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_rls ON outreach_sequences;
CREATE POLICY tenant_rls ON outreach_sequences
  USING (current_tenant_id() IS NULL OR EXISTS (
    SELECT 1 FROM companies c WHERE c.id = company_id AND c.tenant_id = current_tenant_id()));

ALTER TABLE drafts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_rls ON drafts;
CREATE POLICY tenant_rls ON drafts
  USING (current_tenant_id() IS NULL OR EXISTS (
    SELECT 1 FROM companies c WHERE c.id = company_id AND c.tenant_id = current_tenant_id()));

ALTER TABLE eval_results ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_rls ON eval_results;
CREATE POLICY tenant_rls ON eval_results
  USING (current_tenant_id() IS NULL OR EXISTS (
    SELECT 1 FROM companies c WHERE c.id = company_id AND c.tenant_id = current_tenant_id()));

ALTER TABLE voice_agents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_rls ON voice_agents;
CREATE POLICY tenant_rls ON voice_agents
  USING (current_tenant_id() IS NULL OR EXISTS (
    SELECT 1 FROM companies c WHERE c.id = company_id AND c.tenant_id = current_tenant_id()));

-- ── user_id → users.tenant_id ────────────────────────────────────────────
ALTER TABLE devices ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_rls ON devices;
CREATE POLICY tenant_rls ON devices
  USING (current_tenant_id() IS NULL OR EXISTS (
    SELECT 1 FROM users u WHERE u.id = user_id AND u.tenant_id = current_tenant_id()));

ALTER TABLE notification_prefs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_rls ON notification_prefs;
CREATE POLICY tenant_rls ON notification_prefs
  USING (current_tenant_id() IS NULL OR EXISTS (
    SELECT 1 FROM users u WHERE u.id = user_id AND u.tenant_id = current_tenant_id()));

-- ── Deeper chains (EXISTS joins to companies.tenant_id) ──────────────────
ALTER TABLE agent_versions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_rls ON agent_versions;
CREATE POLICY tenant_rls ON agent_versions
  USING (current_tenant_id() IS NULL OR EXISTS (
    SELECT 1 FROM agents a JOIN companies c ON c.id = a.company_id
    WHERE a.id = agent_id AND c.tenant_id = current_tenant_id()));

ALTER TABLE runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_rls ON runs;
CREATE POLICY tenant_rls ON runs
  USING (current_tenant_id() IS NULL OR EXISTS (
    SELECT 1 FROM pipelines p JOIN companies c ON c.id = p.company_id
    WHERE p.id = pipeline_id AND c.tenant_id = current_tenant_id()));

ALTER TABLE run_steps ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_rls ON run_steps;
CREATE POLICY tenant_rls ON run_steps
  USING (current_tenant_id() IS NULL OR EXISTS (
    SELECT 1 FROM runs r JOIN pipelines p ON p.id = r.pipeline_id JOIN companies c ON c.id = p.company_id
    WHERE r.id = run_id AND c.tenant_id = current_tenant_id()));

ALTER TABLE tool_calls ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_rls ON tool_calls;
CREATE POLICY tenant_rls ON tool_calls
  USING (current_tenant_id() IS NULL OR EXISTS (
    SELECT 1 FROM run_steps rs JOIN runs r ON r.id = rs.run_id JOIN pipelines p ON p.id = r.pipeline_id
      JOIN companies c ON c.id = p.company_id
    WHERE rs.id = run_step_id AND c.tenant_id = current_tenant_id()));

ALTER TABLE approvals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_rls ON approvals;
CREATE POLICY tenant_rls ON approvals
  USING (current_tenant_id() IS NULL OR EXISTS (
    SELECT 1 FROM runs r JOIN pipelines p ON p.id = r.pipeline_id JOIN companies c ON c.id = p.company_id
    WHERE r.id = run_id AND c.tenant_id = current_tenant_id()));

ALTER TABLE steering_messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_rls ON steering_messages;
CREATE POLICY tenant_rls ON steering_messages
  USING (current_tenant_id() IS NULL OR EXISTS (
    SELECT 1 FROM runs r JOIN pipelines p ON p.id = r.pipeline_id JOIN companies c ON c.id = p.company_id
    WHERE r.id = run_id AND c.tenant_id = current_tenant_id()));

ALTER TABLE memory_embeddings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_rls ON memory_embeddings;
CREATE POLICY tenant_rls ON memory_embeddings
  USING (current_tenant_id() IS NULL OR EXISTS (
    SELECT 1 FROM memory_items mi JOIN companies c ON c.id = mi.company_id
    WHERE mi.id = memory_item_id AND c.tenant_id = current_tenant_id()));

ALTER TABLE outreach_enrollments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_rls ON outreach_enrollments;
CREATE POLICY tenant_rls ON outreach_enrollments
  USING (current_tenant_id() IS NULL OR EXISTS (
    SELECT 1 FROM outreach_sequences os JOIN companies c ON c.id = os.company_id
    WHERE os.id = sequence_id AND c.tenant_id = current_tenant_id()));

ALTER TABLE external_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_rls ON external_runs;
CREATE POLICY tenant_rls ON external_runs
  USING (current_tenant_id() IS NULL OR EXISTS (
    SELECT 1 FROM external_connections ec
    WHERE ec.id = connection_id AND ec.tenant_id = current_tenant_id()));

-- ── Remaining tenant-data leaf tables (second-pass coverage completion) ──
-- These derive tenant via deeper chains; included so coverage is genuinely
-- consistent (the second-pass review flagged them as the only tenant-DATA
-- tables left uncovered).

ALTER TABLE memory_edges ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_rls ON memory_edges;
CREATE POLICY tenant_rls ON memory_edges
  USING (current_tenant_id() IS NULL OR EXISTS (
    SELECT 1 FROM memory_items mi JOIN companies c ON c.id = mi.company_id
    WHERE mi.id = from_id AND c.tenant_id = current_tenant_id()));

ALTER TABLE web_research_sources ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_rls ON web_research_sources;
CREATE POLICY tenant_rls ON web_research_sources
  USING (current_tenant_id() IS NULL OR EXISTS (
    SELECT 1 FROM web_research_sessions s
    WHERE s.id = session_id AND s.tenant_id = current_tenant_id()));

ALTER TABLE ab_test_variants ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_rls ON ab_test_variants;
CREATE POLICY tenant_rls ON ab_test_variants
  USING (current_tenant_id() IS NULL OR EXISTS (
    SELECT 1 FROM ab_tests t
    WHERE t.id = test_id AND t.tenant_id = current_tenant_id()));

ALTER TABLE ab_test_metrics ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_rls ON ab_test_metrics;
CREATE POLICY tenant_rls ON ab_test_metrics
  USING (current_tenant_id() IS NULL OR EXISTS (
    SELECT 1 FROM ab_test_variants v JOIN ab_tests t ON t.id = v.test_id
    WHERE v.id = variant_id AND t.tenant_id = current_tenant_id()));

-- ── INTENTIONALLY NOT given RLS (global / non-tenant tables) ─────────────
-- These have no single owning tenant and are excluded by design:
--   tenants               — the tenant root anchor itself
--   connectors            — public marketplace connector catalog (nullable publisher_tenant_id)
--   company_templates     — public marketplace template catalog (nullable publisher_tenant_id)
--   bench_suites          — public benchmark definitions (leaderboard)
--   bench_runs            — public benchmark results (leaderboard, admin-gated writes)
--   stripe_webhook_events — global Stripe idempotency log (no tenant column)
--   referrals             — links TWO tenants (referrer_tenant_id / referred_tenant_id),
--                           no single tenant_id; see FINDINGS M7 (missing FK relations).
