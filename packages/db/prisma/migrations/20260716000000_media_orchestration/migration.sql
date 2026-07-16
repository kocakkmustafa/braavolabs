-- Media orchestration (FAZ E) — BYOK-only image + TTS generation.
--
-- Two new tables, additive to the existing media_assets (T9) binary-storage
-- table (20260702000000_multi_provider_keys_media_assets) — neither table
-- here stores a binary column:
--
--   media_provider_keys — one encrypted API key per (tenant, provider).
--     Ciphertext only (encryptForTenant); the app never writes plaintext.
--
--   media_generations — append-only ledger row per generation attempt
--     (SUCCEEDED or FAILED). result_url is a provider-CDN link only
--     (image generations); TTS audio is returned inline to the caller and
--     never persisted, so result_url is NULL for TTS rows. params_json
--     never contains the API key or an Authorization header value.
--
-- RLS follows the same defense-in-depth pattern as 20260616000000_tenant_rls
-- (current_tenant_id() helper already exists from that migration).

-- ── Enums ─────────────────────────────────────────────────────────────────

CREATE TYPE "MediaProvider" AS ENUM ('FAL', 'ELEVENLABS', 'GOOGLE_TTS');
CREATE TYPE "MediaGenerationKind" AS ENUM ('IMAGE', 'TTS');
CREATE TYPE "MediaGenerationStatus" AS ENUM ('SUCCEEDED', 'FAILED');

-- ── media_provider_keys ──────────────────────────────────────────────────

CREATE TABLE "media_provider_keys" (
    "id"                TEXT NOT NULL,
    "tenant_id"         TEXT NOT NULL,
    "provider"          "MediaProvider" NOT NULL,
    "encrypted_api_key" TEXT NOT NULL,
    "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"        TIMESTAMP(3) NOT NULL,

    CONSTRAINT "media_provider_keys_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "media_provider_keys_tenant_id_provider_key" ON "media_provider_keys"("tenant_id", "provider");
CREATE INDEX "media_provider_keys_tenant_id_idx" ON "media_provider_keys"("tenant_id");

ALTER TABLE "media_provider_keys" ADD CONSTRAINT "media_provider_keys_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "media_provider_keys" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rls ON "media_provider_keys"
  USING (current_tenant_id() IS NULL OR "tenant_id" = current_tenant_id());

-- ── media_generations ────────────────────────────────────────────────────

CREATE TABLE "media_generations" (
    "id"                  TEXT NOT NULL,
    "tenant_id"           TEXT NOT NULL,
    "kind"                "MediaGenerationKind" NOT NULL,
    "provider"            "MediaProvider" NOT NULL,
    "model"               TEXT NOT NULL,
    "prompt_preview"      VARCHAR(300) NOT NULL,
    "params_json"         JSONB NOT NULL,
    "estimated_cost_usd"  DECIMAL(10, 6) NOT NULL,
    "status"              "MediaGenerationStatus" NOT NULL,
    "error_message"       VARCHAR(500),
    "result_url"          TEXT,
    "result_meta"         JSONB,
    "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_generations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "media_generations_tenant_id_created_at_idx" ON "media_generations"("tenant_id", "created_at");

ALTER TABLE "media_generations" ADD CONSTRAINT "media_generations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "media_generations" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rls ON "media_generations"
  USING (current_tenant_id() IS NULL OR "tenant_id" = current_tenant_id());
