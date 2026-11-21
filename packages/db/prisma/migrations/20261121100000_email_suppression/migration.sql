-- Email suppression list (outbound opt-out). ADDITIVE ONLY, one table + one index.
-- Written to pass the deploy gate's GENERIC rule (scripts/deploy-platform.sh
-- migration_is_eligible): unquoted identifiers, CREATE TABLE IF NOT EXISTS /
-- CREATE INDEX IF NOT EXISTS only (no CREATE TYPE, no standalone UNIQUE INDEX,
-- no ALTER, no RLS). Uniqueness, the FK and the reason CHECK are table
-- constraints inside the CREATE TABLE; the unique constraint carries the name
-- Prisma expects for @@unique([tenantId, email]).
-- RLS is intentionally NOT added: ENABLE ROW LEVEL SECURITY / CREATE POLICY are
-- rejected by the generic rule (EXIT 68). Tenant isolation is the application
-- where-clause; RLS for this table is a follow-up under a reviewed delta.
-- Not applied to any database by this change.

CREATE TABLE IF NOT EXISTS email_suppressions (
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  email TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT 'UNSUBSCRIBE',
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT email_suppressions_pkey PRIMARY KEY (id),
  CONSTRAINT email_suppressions_tenant_id_email_key UNIQUE (tenant_id, email),
  CONSTRAINT email_suppressions_reason_check CHECK (reason IN ('UNSUBSCRIBE', 'BOUNCE', 'COMPLAINT', 'MANUAL')),
  CONSTRAINT email_suppressions_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS email_suppressions_tenant_id_idx ON email_suppressions (tenant_id);
