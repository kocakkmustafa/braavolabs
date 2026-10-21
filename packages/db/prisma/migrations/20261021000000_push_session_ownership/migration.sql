-- FILE ONLY in the F02 local repair. No live migration/grant was executed.
-- Deploy this schema before the matching API. Legacy Device rows are retained
-- for erasure/cleanup but are ineligible for new push fan-out.
CREATE TABLE push_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  login_order BIGSERIAL NOT NULL UNIQUE,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  token_hash TEXT,
  expires_at TIMESTAMP(3) NOT NULL
);
CREATE INDEX push_sessions_user_id_tenant_id_idx ON push_sessions(user_id, tenant_id);
CREATE INDEX push_sessions_expires_at_idx ON push_sessions(expires_at);
ALTER TABLE push_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rls ON push_sessions
  USING (current_tenant_id() IS NULL OR tenant_id = current_tenant_id())
  WITH CHECK (current_tenant_id() IS NULL OR tenant_id = current_tenant_id());

-- This is an opaque global serialization fence, not tenant content. Feature
-- code reaches it only through tenantTx after a signed, tenant-owned session
-- check. No raw push token, user/tenant identity, or notification payload.
CREATE TABLE push_token_fences (
  token_hash TEXT PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  login_order BIGINT NOT NULL DEFAULT 0 CHECK (login_order >= 0),
  session_id TEXT,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0)
);

ALTER TABLE devices ADD COLUMN push_session_id TEXT REFERENCES push_sessions(id) ON DELETE CASCADE;
ALTER TABLE devices ADD COLUMN push_revision INTEGER;
ALTER TABLE devices ADD COLUMN push_token_hash TEXT;
ALTER TABLE devices ADD COLUMN push_payload_hash TEXT;
ALTER TABLE devices ADD CONSTRAINT devices_push_ownership_tuple CHECK (
  (push_session_id IS NULL AND push_revision IS NULL AND push_token_hash IS NULL AND push_payload_hash IS NULL)
  OR
  (push_session_id IS NOT NULL AND push_revision IS NOT NULL AND push_revision > 0
    AND push_token_hash IS NOT NULL AND push_token_hash ~ '^[a-f0-9]{64}$'
    AND push_payload_hash IS NOT NULL AND push_payload_hash ~ '^[a-f0-9]{64}$')
);
-- B writes only B's tenant row. Existing Device RLS is unchanged; no definer
-- function, bypass role, cross-tenant update or clearing tenant context.
DROP INDEX devices_push_token_key;
CREATE UNIQUE INDEX devices_push_token_hash_push_session_id_key ON devices(push_token_hash, push_session_id);
CREATE INDEX devices_push_session_id_idx ON devices(push_session_id);
