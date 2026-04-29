-- Durable Stripe webhook idempotency log.
--
-- See packages/db/prisma/schema.prisma > model StripeWebhookEvent for
-- the rationale. The unique constraint on stripe_event_id is what
-- actually prevents double-processing — a duplicate INSERT raises
-- ON CONFLICT and the handler skips. The processed_at + result_summary
-- columns are operational ergonomics for "what did we do with that
-- event?" debugging.

CREATE TABLE IF NOT EXISTS "stripe_webhook_events" (
  "id"               TEXT PRIMARY KEY,
  "stripe_event_id"  TEXT NOT NULL UNIQUE,
  "type"             TEXT NOT NULL,
  "livemode"         BOOLEAN NOT NULL DEFAULT false,
  "raw_payload"      JSONB NOT NULL,
  "processed_at"     TIMESTAMP,
  "result_summary"   JSONB,
  "created_at"       TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Type filter for ops queries ("show me all checkout.session.completed
-- events from the last week").
CREATE INDEX IF NOT EXISTS "stripe_webhook_events_type_idx"
  ON "stripe_webhook_events"("type");

-- Time-series queries + retention pruning.
CREATE INDEX IF NOT EXISTS "stripe_webhook_events_created_at_idx"
  ON "stripe_webhook_events"("created_at");
