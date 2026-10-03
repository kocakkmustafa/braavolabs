-- LOCAL DRAFT ONLY: no database application authorized.
-- Add evidence without deriving ordering from roots, ownership or timestamps.
-- Legacy rows remain UNKNOWN. Rollback disables GOOGLE_PURCHASE_LINEAGE_ENABLED;
-- it does not delete these columns or retained provider evidence.
ALTER TABLE "google_purchase_aliases"
  ADD COLUMN "lineage_state" TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN "lineage_predecessor_digest" TEXT,
  ADD COLUMN "lineage_verified_at" TIMESTAMP(3),
  ADD COLUMN "lineage_evidence_source" TEXT;

ALTER TABLE "google_purchase_aliases"
  ADD CONSTRAINT "google_purchase_aliases_lineage_shape_check" CHECK (
    ("lineage_state" = 'unknown'
      AND "lineage_predecessor_digest" IS NULL
      AND "lineage_verified_at" IS NULL
      AND "lineage_evidence_source" IS NULL)
    OR
    ("state" = 'active'
      AND "tenant_id" IS NOT NULL
      AND "mobile_subscription_id" IS NOT NULL
      AND "provider" IS NOT NULL AND "provider" = 'google'
      AND "canonical_root_identity" IS NOT NULL
      AND "canonical_root_identity" ~ '^google:[0-9a-f]{64}$'
      AND "lineage_verified_at" IS NOT NULL
      AND "lineage_evidence_source" IS NOT NULL
      AND "lineage_evidence_source" = 'play-subscriptionsv2-v1'
      AND (
        ("lineage_state" = 'root'
          AND "lineage_predecessor_digest" IS NULL
          AND "token_digest" = "canonical_root_identity")
        OR
        ("lineage_state" = 'edge'
          AND "lineage_predecessor_digest" IS NOT NULL
          AND "lineage_predecessor_digest" ~ '^google:[0-9a-f]{64}$'
          AND "lineage_predecessor_digest" <> "token_digest")
      ))
  );
-- Deliberately no UPDATE/INSERT/backfill, no predecessor FK requiring guessed
-- legacy rows, and no entitlement/subscription changes. Existing RLS applies.
