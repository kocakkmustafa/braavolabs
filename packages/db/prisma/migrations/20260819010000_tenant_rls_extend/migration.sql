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
-- RLS as the enforced DB-level second layer) to every remaining
-- tenant-scoped table: 11 with a direct tenant_id column, 7 reachable
-- via one hop through companies, 7 reachable via two-to-four hops
-- through companies (runs -> pipelines -> companies, and deeper), and
-- 8 reachable via one-to-three hops through a DIFFERENT already-covered
-- parent (users / web_research_sessions / external_connections /
-- ab_tests / ab_test_variants / agents / runs) — 33 tables total.
--
-- R2 review (2026-08-19) caught that an earlier draft's "every
-- REMAINING tenant-scoped table" claim was false — it independently
-- cross-checked all 52 @@map'd tables in schema.prisma against the
-- covered set and found 8 real, unambiguous gaps matching the exact
-- pattern of tables already here (devices/notification_prefs one hop
-- via users; agent_versions two hops via agents; steering_messages
-- three hops via runs, identical depth to run_steps/approvals;
-- web_research_sources/external_runs/ab_test_variants one hop via
-- their already-covered parent; ab_test_metrics two hops via
-- ab_test_variants). Added below, closing the gap the review flagged
-- rather than opening a fast-follow for a same-pattern, same-review-pass
-- addition. Four OTHER tables the review flagged are deliberately still
-- NOT here — tenants (would need a structurally different `id =
-- current_tenant_id()` pattern, not this migration's shape), referrals
-- (dual tenant ownership, doesn't fit either pattern), company_templates
-- and connectors (public marketplace catalogs with a nullable owning
-- tenant — what "tenant-scoped" even means for a public row here is a
-- product question, not a mechanical gap) — left for a deliberate,
-- separate pass rather than forced into patterns that don't actually fit.
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

-- R2 review (2026-08-19) caught that the ORIGINAL version of this
-- policy (checking only `from_id`'s company) was based on a false
-- premise: `packages/api/src/modules/memory/router.ts`'s real
-- POST /api/v1/memory/edges validates both endpoints belong to the
-- caller's TENANT, not the same COMPANY — a same-tenant,
-- cross-company edge is a real, reachable state through the actual
-- app, not merely theoretical. That still doesn't cross a tenant
-- boundary today (both endpoints ARE tenant-checked at the one real
-- write path), but the review also built a local canary and proved
-- that if a cross-TENANT edge ever existed (e.g. a future bug, a
-- different write path, direct DB access) THIS policy's single-ended
-- check would expose it asymmetrically — tenant A visible via
-- `from_id`, tenant B's own copy invisible via `to_id`. Cheap to close
-- properly rather than leave as a documented gap: check both ends.
ALTER TABLE memory_edges ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rls ON memory_edges
  USING (
    current_tenant_id() IS NULL
    OR (
      EXISTS (
        SELECT 1 FROM memory_items mi
        JOIN companies c ON c.id = mi.company_id
        WHERE mi.id = from_id AND c.tenant_id = current_tenant_id()
      )
      AND EXISTS (
        SELECT 1 FROM memory_items mi
        JOIN companies c ON c.id = mi.company_id
        WHERE mi.id = to_id AND c.tenant_id = current_tenant_id()
      )
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

-- ── R2-review-found gap (8 tables) — one-to-three hops through a
-- DIFFERENT already-covered parent (not companies directly) ──────────

ALTER TABLE devices ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rls ON devices
  USING (
    current_tenant_id() IS NULL
    OR EXISTS (SELECT 1 FROM users u WHERE u.id = user_id AND u.tenant_id = current_tenant_id())
  );

ALTER TABLE notification_prefs ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rls ON notification_prefs
  USING (
    current_tenant_id() IS NULL
    OR EXISTS (SELECT 1 FROM users u WHERE u.id = user_id AND u.tenant_id = current_tenant_id())
  );

ALTER TABLE web_research_sources ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rls ON web_research_sources
  USING (
    current_tenant_id() IS NULL
    OR EXISTS (SELECT 1 FROM web_research_sessions s WHERE s.id = session_id AND s.tenant_id = current_tenant_id())
  );

ALTER TABLE external_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rls ON external_runs
  USING (
    current_tenant_id() IS NULL
    OR EXISTS (SELECT 1 FROM external_connections ec WHERE ec.id = connection_id AND ec.tenant_id = current_tenant_id())
  );

ALTER TABLE ab_test_variants ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rls ON ab_test_variants
  USING (
    current_tenant_id() IS NULL
    OR EXISTS (SELECT 1 FROM ab_tests t WHERE t.id = test_id AND t.tenant_id = current_tenant_id())
  );

ALTER TABLE agent_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rls ON agent_versions
  USING (
    current_tenant_id() IS NULL
    OR EXISTS (
      SELECT 1 FROM agents a
      JOIN companies c ON c.id = a.company_id
      WHERE a.id = agent_id AND c.tenant_id = current_tenant_id()
    )
  );

ALTER TABLE ab_test_metrics ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rls ON ab_test_metrics
  USING (
    current_tenant_id() IS NULL
    OR EXISTS (
      SELECT 1 FROM ab_test_variants v
      JOIN ab_tests t ON t.id = v.test_id
      WHERE v.id = variant_id AND t.tenant_id = current_tenant_id()
    )
  );

-- Same depth/shape as run_steps and approvals above — steering_messages
-- hangs off runs the same way.
ALTER TABLE steering_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rls ON steering_messages
  USING (
    current_tenant_id() IS NULL
    OR EXISTS (
      SELECT 1 FROM runs r
      JOIN pipelines p ON p.id = r.pipeline_id
      JOIN companies c ON c.id = p.company_id
      WHERE r.id = run_id AND c.tenant_id = current_tenant_id()
    )
  );
