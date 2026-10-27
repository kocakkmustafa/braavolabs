-- Data minimisation (owner decision 2026-10-27): the API no longer stores the
-- user-set device name, so clear the names older mobile builds sent.
-- Irreversible by design. The column stays: the 87290e0 API still writes it.
UPDATE "devices" SET "device_name" = NULL WHERE "device_name" IS NOT NULL;
