-- Additive Google Play purchase-chain ownership ledger.
--
-- SECURITY CONTRACT
-- - token_digest and canonical_root_identity are one-way SHA-256 identities;
--   raw purchase tokens are never copied into this table.
-- - active aliases bind one global digest to one tenant, Google subscription,
--   and canonical root through a deferred composite foreign key.
-- - legacy_blocked rows intentionally bind no owner. They stop a pre-cutover
--   raw identity from being claimed until a separately approved reconciliation.
-- - this migration does not delete, rewrite, or claim historical raw rows.

CREATE UNIQUE INDEX "mobile_subscriptions_alias_owner_key"
  ON "mobile_subscriptions"("id", "tenant_id", "provider", "original_transaction_id");

CREATE TABLE "google_purchase_aliases" (
  "token_digest" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'active',
  "tenant_id" TEXT,
  "mobile_subscription_id" TEXT,
  "provider" TEXT,
  "canonical_root_identity" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "google_purchase_aliases_pkey" PRIMARY KEY ("token_digest"),
  CONSTRAINT "google_purchase_aliases_token_digest_check"
    CHECK ("token_digest" ~ '^google:[0-9a-f]{64}$'),
  CONSTRAINT "google_purchase_aliases_state_check"
    CHECK (
      (
        "state" = 'active'
        AND "tenant_id" IS NOT NULL
        AND "mobile_subscription_id" IS NOT NULL
        AND "provider" = 'google'
        AND "canonical_root_identity" ~ '^google:[0-9a-f]{64}$'
      )
      OR
      (
        "state" = 'legacy_blocked'
        AND "tenant_id" IS NULL
        AND "mobile_subscription_id" IS NULL
        AND "provider" IS NULL
        AND "canonical_root_identity" IS NULL
      )
    ),
  CONSTRAINT "google_purchase_aliases_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "google_purchase_aliases_subscription_owner_fkey"
    FOREIGN KEY (
      "mobile_subscription_id",
      "tenant_id",
      "provider",
      "canonical_root_identity"
    )
    REFERENCES "mobile_subscriptions"(
      "id",
      "tenant_id",
      "provider",
      "original_transaction_id"
    )
    ON DELETE CASCADE ON UPDATE CASCADE
    DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX "google_purchase_aliases_tenant_id_idx"
  ON "google_purchase_aliases"("tenant_id");
CREATE INDEX "google_purchase_aliases_mobile_subscription_id_idx"
  ON "google_purchase_aliases"("mobile_subscription_id");
CREATE INDEX "google_purchase_aliases_canonical_root_identity_idx"
  ON "google_purchase_aliases"("canonical_root_identity");

-- Already-hashed Google rows are already protected by the existing global
-- original_transaction_id unique key, so they can be represented faithfully.
INSERT INTO "google_purchase_aliases" (
  "token_digest",
  "state",
  "tenant_id",
  "mobile_subscription_id",
  "provider",
  "canonical_root_identity"
)
SELECT
  "original_transaction_id",
  'active',
  "tenant_id",
  "id",
  'google',
  "original_transaction_id"
FROM "mobile_subscriptions"
WHERE "provider" = 'google'
  AND "original_transaction_id" ~ '^google:[0-9a-f]{64}$'
ON CONFLICT ("token_digest") DO NOTHING;

-- Historical raw identities are hashed in-query and become ownerless blockers.
-- The plaintext expression is never selected into a persisted/logged column.
INSERT INTO "google_purchase_aliases" ("token_digest", "state")
SELECT
  'google:' || encode(sha256(convert_to("original_transaction_id", 'UTF8')), 'hex'),
  'legacy_blocked'
FROM "mobile_subscriptions"
WHERE "provider" = 'google'
  AND "original_transaction_id" !~ '^google:[0-9a-f]{64}$'
ON CONFLICT ("token_digest") DO NOTHING;

-- Preserve historical bytes but reject every future Google write/update that
-- would keep or introduce a raw ownership identity. NOT VALID avoids claiming
-- that old rows were reconciled; PostgreSQL still enforces it for new changes.
ALTER TABLE "mobile_subscriptions"
  ADD CONSTRAINT "mobile_subscriptions_google_identity_format_check"
  CHECK (
    "provider" <> 'google'
    OR "original_transaction_id" ~ '^google:[0-9a-f]{64}$'
  ) NOT VALID;

ALTER TABLE "google_purchase_aliases" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_rls" ON "google_purchase_aliases"
  USING (
    current_tenant_id() IS NULL
    OR "tenant_id" = current_tenant_id()
  )
  WITH CHECK (
    current_tenant_id() IS NULL
    OR "tenant_id" = current_tenant_id()
  );
