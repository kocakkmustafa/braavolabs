-- Email verification (soft gate). Adds three nullable columns:
--   email_verified_at            — set when the user clicks the link
--   email_verify_token_hash      — sha256(token); compared on /verify-email GET
--   email_verify_token_expires_at — 7-day TTL
--
-- Existing users are left with NULL emailVerifiedAt; the UI surfaces
-- a banner asking them to verify on next visit. OAuth users get
-- emailVerifiedAt populated at sign-in (the provider has already
-- verified the address).
ALTER TABLE "users" ADD COLUMN "email_verified_at" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "email_verify_token_hash" TEXT;
ALTER TABLE "users" ADD COLUMN "email_verify_token_expires_at" TIMESTAMP(3);
