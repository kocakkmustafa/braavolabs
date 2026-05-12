-- Enterprise SSO via generic OIDC (Feature 3).
--
-- One connection per tenant. Plan-gated at the router (BUSINESS+);
-- the table itself imposes no plan constraint so the data model
-- stays clean if a future SKU restructure changes the gate.

CREATE TABLE "oidc_connections" (
  "id"                     TEXT PRIMARY KEY,
  "tenant_id"              TEXT NOT NULL UNIQUE,
  "issuer"                 TEXT NOT NULL,
  "client_id"              TEXT NOT NULL,
  "encrypted_secret"       TEXT NOT NULL,
  "redirect_uri"           TEXT NOT NULL,
  "scopes"                 TEXT NOT NULL DEFAULT 'openid email profile',
  "domains"                TEXT NOT NULL DEFAULT '',
  "discovery_url"          TEXT,
  "authorization_endpoint" TEXT,
  "token_endpoint"         TEXT,
  "jwks_uri"               TEXT,
  "discovered_at"          TIMESTAMP(3),
  "is_active"              BOOLEAN NOT NULL DEFAULT true,
  "created_at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"             TIMESTAMP(3) NOT NULL,

  CONSTRAINT "oidc_connections_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE
);

-- Per-tenant OIDC subject column on users. Composite-unique with
-- tenant_id so the same `sub` from two different IdP namespaces
-- doesn't collide.
ALTER TABLE "users" ADD COLUMN "oidc_subject" TEXT;

CREATE UNIQUE INDEX "users_tenant_oidc_subject_unique"
  ON "users" ("tenant_id", "oidc_subject")
  WHERE "oidc_subject" IS NOT NULL;

