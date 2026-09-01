-- BR-P0-003-D: redacted, durable IAP webhook delivery admission and DLQ.
-- Additive and idempotent by construction; intentionally NOT applied here.
CREATE TABLE IF NOT EXISTS "iap_webhook_deliveries" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "delivery_id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "failure_code" TEXT,
    "processing_started_at" TIMESTAMP(3),
    "processed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "iap_webhook_deliveries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "iap_webhook_deliveries_provider_delivery_id_key"
    ON "iap_webhook_deliveries"("provider", "delivery_id");

CREATE INDEX IF NOT EXISTS "iap_webhook_deliveries_status_updated_at_idx"
    ON "iap_webhook_deliveries"("status", "updated_at");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'iap_webhook_deliveries_status_check'
  ) THEN
    ALTER TABLE "iap_webhook_deliveries"
      ADD CONSTRAINT "iap_webhook_deliveries_status_check"
      CHECK ("status" IN ('PROCESSING', 'RETRYABLE', 'SUCCEEDED', 'POISONED'));
  END IF;
END $$;
