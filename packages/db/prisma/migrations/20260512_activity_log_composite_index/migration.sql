-- activity_log composite + resource indexes (INFRA-005, SEC-019 follow-up)
--
-- Why this migration exists:
--
-- 1. (tenant_id, created_at DESC): every dashboard + per-resource timeline
--    query filters by tenant_id and sorts by created_at DESC. Without the
--    composite, the planner uses the single-column (tenant_id) index, fetches
--    millions of rows, then sorts them. At ~180M rows/year (10k DAU ×
--    ~50 actions/day) that's a multi-second query; with the composite the
--    planner walks the btree in reverse and stops at LIMIT, sub-100ms.
--
-- 2. (resource_id): after SEC-019 dropped the OR'd JSONB path-equality
--    branch on details.companyId, the per-company timeline relies on
--    `WHERE tenant_id = $1 AND resource_id = $2`. Without an index on
--    resource_id Postgres falls back to the tenant_id index + filter,
--    which is fine for small tenants but degrades on the largest ones
--    (whose timelines are the most viewed). A standalone resource_id
--    index keeps that query path snappy.
--
-- Plain CREATE INDEX (NOT CONCURRENTLY) so Prisma's migration
-- transaction wrapper doesn't reject this DDL — Postgres refuses
-- CONCURRENTLY inside a transaction block (SQLSTATE 25001).
--
-- On a hot prod table this would be ACCESS EXCLUSIVE; the operator
-- runbook for production deployments (docs/deployment-github-actions.md)
-- recommends building these indexes via psql ahead of the migrate
-- step with `CREATE INDEX CONCURRENTLY` to avoid downtime. The
-- migration here is a no-op when the operator pre-built them
-- (`IF NOT EXISTS` guards), and acceptably-fast on fresh installs
-- where the table is empty.

CREATE INDEX IF NOT EXISTS "activity_log_tenant_id_created_at_idx"
  ON "activity_log" ("tenant_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "activity_log_resource_id_idx"
  ON "activity_log" ("resource_id");
