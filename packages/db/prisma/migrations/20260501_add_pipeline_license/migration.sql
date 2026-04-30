-- Pipeline export DRM — one row per tenant, tracks the bound machine
-- fingerprint + monthly switch quota. Created lazily by the /license/*
-- endpoints (no row until the user downloads their first encrypted
-- pipeline file). The unique constraint on tenant_id keeps this 1:1.
CREATE TABLE "pipeline_licenses" (
  "id"                              TEXT          NOT NULL,
  "tenant_id"                       TEXT          NOT NULL,
  "device_fingerprint"              TEXT,
  "last_bound_at"                   TIMESTAMP(3),
  "monthly_machine_changes_used"    INTEGER       NOT NULL DEFAULT 0,
  "monthly_change_period"           TEXT          NOT NULL DEFAULT '',
  "created_at"                      TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"                      TIMESTAMP(3)  NOT NULL,

  CONSTRAINT "pipeline_licenses_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "pipeline_licenses_tenant_id_key"
  ON "pipeline_licenses"("tenant_id");

ALTER TABLE "pipeline_licenses"
  ADD CONSTRAINT "pipeline_licenses_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
