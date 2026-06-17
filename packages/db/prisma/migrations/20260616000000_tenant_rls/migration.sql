-- Migration: tenant_rls
-- Adds PostgreSQL Row-Level Security on tenant-owned tables as a defense-in-depth
-- layer on top of the application-layer `tenantId` WHERE clause filters.
--
-- How it works:
--   1. `authMiddleware` calls `set_config('app.tenant_id', tenantId, false)` on
--      every authenticated request, making the current tenant's ID available to
--      all Postgres functions within that session.
--   2. RLS policies read `current_setting('app.tenant_id', true)` and block rows
--      that don't belong to the active tenant.
--   3. When `app.tenant_id` is empty or not set (unauthenticated routes, health
--      checks, Prisma migrations) the policies allow the query through — the
--      application layer already ensures those routes never touch tenant data.
--
-- IMPORTANT: RLS is bypassed for PostgreSQL SUPERUSER roles. For RLS to be
-- effective in production, the DATABASE_URL must use a non-superuser role:
--
--   CREATE ROLE braavolabs_app LOGIN PASSWORD '...';
--   GRANT CONNECT ON DATABASE braavolabs TO braavolabs_app;
--   GRANT USAGE ON SCHEMA public TO braavolabs_app;
--   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO braavolabs_app;
--   GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO braavolabs_app;
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO braavolabs_app;
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO braavolabs_app;
--
-- Then set DATABASE_URL=postgresql://braavolabs_app:...@host/braavolabs in .env.
-- Migrations (run by the owner role) are unaffected because they run as owner.

-- Helper function: returns tenant_id from session, or NULL when not set / empty.
CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS TEXT LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '');
$$;

-- ── Tables with a direct tenant_id column ────────────────────────────────────

ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rls ON companies
  USING (current_tenant_id() IS NULL OR tenant_id = current_tenant_id());

ALTER TABLE user_ai_configs ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rls ON user_ai_configs
  USING (current_tenant_id() IS NULL OR tenant_id = current_tenant_id());

ALTER TABLE usage_meters ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rls ON usage_meters
  USING (current_tenant_id() IS NULL OR tenant_id = current_tenant_id());

ALTER TABLE activity_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rls ON activity_log
  USING (current_tenant_id() IS NULL OR tenant_id = current_tenant_id());

ALTER TABLE external_connections ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rls ON external_connections
  USING (current_tenant_id() IS NULL OR tenant_id = current_tenant_id());

-- ── Tables linked to companies (company_id → companies.tenant_id) ─────────────
-- Policy uses an EXISTS subquery so the planner can use the companies index.

ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rls ON agents
  USING (
    current_tenant_id() IS NULL
    OR EXISTS (
      SELECT 1 FROM companies c
      WHERE c.id = company_id AND c.tenant_id = current_tenant_id()
    )
  );

ALTER TABLE pipelines ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rls ON pipelines
  USING (
    current_tenant_id() IS NULL
    OR EXISTS (
      SELECT 1 FROM companies c
      WHERE c.id = company_id AND c.tenant_id = current_tenant_id()
    )
  );

ALTER TABLE integrations ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rls ON integrations
  USING (
    current_tenant_id() IS NULL
    OR EXISTS (
      SELECT 1 FROM companies c
      WHERE c.id = company_id AND c.tenant_id = current_tenant_id()
    )
  );
