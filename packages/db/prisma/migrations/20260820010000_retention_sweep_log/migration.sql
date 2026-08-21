-- BR-P1-005 #4: the retention sweep's own log.
--
-- Deliberately NOT a row in activity_log. The sweep is system-wide and has no
-- legitimate tenant, and anchoring it to an arbitrary one broke three things:
-- the tenant FK rejected a "system" placeholder on an install with no tenants
-- (so no baseline was ever laid, and the failure was swallowed by a .catch),
-- ON DELETE CASCADE meant removing whichever tenant it landed on wiped the
-- baseline, and the row appeared inside that customer's audit export claiming
-- they had run a sweep, carrying an install-wide deletion count.
--
-- No tenant FK by design. Nothing cascades into it.
CREATE TABLE IF NOT EXISTS "retention_sweep" (
  "id"            TEXT NOT NULL,
  "result"        TEXT NOT NULL,
  "reason"        TEXT,
  "deleted"       INTEGER NOT NULL DEFAULT 0,
  "would_delete"  INTEGER NOT NULL DEFAULT 0,
  "skipped_count" INTEGER NOT NULL DEFAULT 0,
  "failed_count"  INTEGER NOT NULL DEFAULT 0,
  "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "retention_sweep_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "retention_sweep_created_at_idx"
  ON "retention_sweep" ("created_at" DESC);
