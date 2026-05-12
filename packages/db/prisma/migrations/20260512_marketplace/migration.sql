-- Connector marketplace + MCP runtime (Feature 8).
--
-- Two tables: catalog entries (Connector) and per-tenant installs
-- with encrypted credentials (TenantConnector). Tool registration
-- is dynamic at runtime — no schema entry for the registered tool
-- names because they're computed from connector_slug × tool_name.

CREATE TYPE "ConnectorAuthMethod" AS ENUM ('NONE', 'API_KEY', 'OAUTH2', 'BASIC', 'CUSTOM');
CREATE TYPE "ConnectorVisibility" AS ENUM ('PUBLIC', 'UNLISTED', 'PRIVATE');

CREATE TABLE "connectors" (
  "id"                  TEXT PRIMARY KEY,
  "slug"                TEXT NOT NULL UNIQUE,
  "name"                TEXT NOT NULL,
  "version"             TEXT NOT NULL DEFAULT '1.0.0',
  "vendor"              TEXT NOT NULL,
  "description"         TEXT NOT NULL,
  "icon_url"            TEXT,
  "documentation_url"   TEXT,
  "mcp_server_url"      TEXT NOT NULL,
  "auth_method"         "ConnectorAuthMethod" NOT NULL DEFAULT 'NONE',
  "auth_schema"         JSONB NOT NULL DEFAULT '{}',
  "tools_manifest"      JSONB NOT NULL DEFAULT '[]',
  "visibility"          "ConnectorVisibility" NOT NULL DEFAULT 'PRIVATE',
  "is_approved"         BOOLEAN NOT NULL DEFAULT false,
  "publisher_tenant_id" TEXT,
  "install_count"       INTEGER NOT NULL DEFAULT 0,
  "manifest_signature"  TEXT,
  "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"          TIMESTAMP(3) NOT NULL
);
CREATE INDEX "connectors_visibility_is_approved_idx"
  ON "connectors"("visibility", "is_approved");

CREATE TABLE "tenant_connectors" (
  "id"                     TEXT PRIMARY KEY,
  "tenant_id"              TEXT NOT NULL,
  "connector_id"           TEXT NOT NULL,
  "encrypted_credentials"  TEXT NOT NULL,
  "cached_tools_manifest"  JSONB NOT NULL DEFAULT '[]',
  "cached_at"              TIMESTAMP(3),
  "is_enabled"             BOOLEAN NOT NULL DEFAULT true,
  "spend_cap_usd"          DECIMAL(10, 2),
  "spend_usd"              DECIMAL(10, 2) NOT NULL DEFAULT 0,
  "created_at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"             TIMESTAMP(3) NOT NULL,

  CONSTRAINT "tenant_connectors_connector_id_fkey"
    FOREIGN KEY ("connector_id") REFERENCES "connectors"("id") ON DELETE CASCADE,
  CONSTRAINT "tenant_connectors_tenant_id_connector_id_unique"
    UNIQUE ("tenant_id", "connector_id")
);
CREATE INDEX "tenant_connectors_tenant_id_idx" ON "tenant_connectors"("tenant_id");
