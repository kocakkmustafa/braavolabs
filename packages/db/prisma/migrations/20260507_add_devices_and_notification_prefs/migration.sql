-- Push notification support for the mobile companion app
-- (Apps/Braavo). One Device row per user × installed app instance,
-- one NotificationPref row per user (defaults: approvals + risks on,
-- runs + drafts off). Both cascade on user delete so GDPR Article 17
-- erasure (see packages/api/src/modules/user/user.router.ts) cleanly
-- removes them.

CREATE TABLE "devices" (
  "id"           TEXT         NOT NULL,
  "user_id"      TEXT         NOT NULL,
  "push_token"   TEXT         NOT NULL,
  "platform"     TEXT         NOT NULL,
  "device_name"  TEXT,
  "os_version"   TEXT,
  "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"   TIMESTAMP(3) NOT NULL,

  CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "devices_push_token_key" ON "devices"("push_token");
CREATE INDEX        "devices_user_id_idx"   ON "devices"("user_id");

ALTER TABLE "devices"
  ADD CONSTRAINT "devices_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "notification_prefs" (
  "id"         TEXT         NOT NULL,
  "user_id"    TEXT         NOT NULL,
  "approvals"  BOOLEAN      NOT NULL DEFAULT true,
  "risks"      BOOLEAN      NOT NULL DEFAULT true,
  "runs"       BOOLEAN      NOT NULL DEFAULT false,
  "drafts"     BOOLEAN      NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "notification_prefs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "notification_prefs_user_id_key" ON "notification_prefs"("user_id");

ALTER TABLE "notification_prefs"
  ADD CONSTRAINT "notification_prefs_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
