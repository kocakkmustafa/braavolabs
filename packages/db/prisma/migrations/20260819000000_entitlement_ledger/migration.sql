-- Append-only entitlement event ledger (BR-P0-003).
--
-- See packages/api/src/modules/billing/entitlement-reducer.ts for the pure
-- fold/combine/resolve logic this table feeds, and packages/db/prisma/schema.prisma
-- > model EntitlementEvent for field-by-field rationale.
--
-- Today, tenant.plan and mobile_subscriptions are written directly by 6
-- separate call sites (3 in billing/router.ts for Stripe, 3 in
-- billing/iap/router.ts for Apple+Google), each an unconditional UPDATE
-- with no ordering guard — a delayed webhook can silently overwrite a
-- newer one. This table is the fix: every entitlement-affecting event
-- from all 3 sources appends here first; tenant.plan / mobile_subscriptions
-- become read PROJECTIONS folded from this table's full history, so
-- "what's the current entitlement" is always recomputed from the complete
-- event set rather than trusted from whatever wrote last.
--
-- The unique (source, source_event_id) constraint is what actually
-- prevents double-processing a redelivered webhook — mirrors
-- stripe_webhook_events.stripe_event_id's already-proven pattern
-- (20260429_stripe_webhook_events). That table is UNCHANGED by this
-- migration: it keeps recording Stripe's raw payload for audit; this
-- table records the normalized fact the reducer actually needs, from
-- all 3 sources alike.
--
-- Purely ADDITIVE: one new table, one new FK. Safe to run on a live
-- database — no backfill, no lock-heavy rewrite, no existing table
-- touched.

CREATE TABLE IF NOT EXISTS "entitlement_events" (
  "id"               TEXT PRIMARY KEY,
  "tenant_id"        TEXT NOT NULL,
  "source"           TEXT NOT NULL,
  "stream_id"        TEXT NOT NULL,
  "source_event_id"  TEXT NOT NULL,
  "source_timestamp" TIMESTAMP NOT NULL,
  "type"             TEXT NOT NULL,
  "plan_tier"        TEXT,
  "expires_at"       TIMESTAMP,
  "auto_renew"       BOOLEAN NOT NULL DEFAULT true,
  "created_at"       TIMESTAMP NOT NULL DEFAULT NOW()
);

ALTER TABLE "entitlement_events"
  ADD CONSTRAINT "entitlement_events_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The actual idempotency guard: a redelivered webhook (same source +
-- same source_event_id) can never append a second row.
CREATE UNIQUE INDEX IF NOT EXISTS "entitlement_events_source_source_event_id_key"
  ON "entitlement_events"("source", "source_event_id");

-- foldStream()'s natural access pattern: "give me every event for this
-- one subscription stream" (then sorted + folded in application code).
CREATE INDEX IF NOT EXISTS "entitlement_events_tenant_id_stream_id_idx"
  ON "entitlement_events"("tenant_id", "stream_id");
