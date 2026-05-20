-- Add appleId column for Sign in with Apple integration.
-- Apple's `sub` claim is the stable identifier; nullable because most
-- existing users were registered via email or Google/GitHub OAuth.
ALTER TABLE "users" ADD COLUMN "apple_id" TEXT;

CREATE UNIQUE INDEX "users_apple_id_key" ON "users"("apple_id");
