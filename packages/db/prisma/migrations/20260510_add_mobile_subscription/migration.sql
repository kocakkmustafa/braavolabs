-- Mobile in-app subscriptions (Apple App Store / Google Play / RevenueCat).
-- One row per durable subscription chain (originalTransactionId is the
-- identifier that survives renewals). Powers the entitlement read at login
-- when a user purchases on mobile and signs in on the web.

CREATE TABLE IF NOT EXISTS "mobile_subscriptions" (
  "id"                      TEXT        NOT NULL,
  "tenant_id"               TEXT        NOT NULL,
  "provider"                TEXT        NOT NULL,
  "product_id"              TEXT        NOT NULL,
  "original_transaction_id" TEXT        NOT NULL,
  "latest_receipt"          TEXT,
  "status"                  TEXT        NOT NULL,
  "plan_tier"               TEXT        NOT NULL,
  "started_at"              TIMESTAMP(3) NOT NULL,
  "expires_at"              TIMESTAMP(3) NOT NULL,
  "auto_renew"              BOOLEAN     NOT NULL DEFAULT true,
  "last_verified_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"              TIMESTAMP(3) NOT NULL,

  CONSTRAINT "mobile_subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "mobile_subscriptions_original_transaction_id_key"
  ON "mobile_subscriptions" ("original_transaction_id");

CREATE INDEX IF NOT EXISTS "mobile_subscriptions_tenant_id_status_idx"
  ON "mobile_subscriptions" ("tenant_id", "status");

CREATE INDEX IF NOT EXISTS "mobile_subscriptions_expires_at_idx"
  ON "mobile_subscriptions" ("expires_at");

ALTER TABLE "mobile_subscriptions"
  ADD CONSTRAINT "mobile_subscriptions_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
