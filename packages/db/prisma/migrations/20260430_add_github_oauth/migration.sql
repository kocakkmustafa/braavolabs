-- Add GitHub OAuth identity column to users table.
-- Mirrors the existing google_id column: nullable, unique, plain string
-- (GitHub returns numeric IDs but we store as text for symmetry with
-- google_id which is OIDC `sub`).

ALTER TABLE "users" ADD COLUMN "github_id" TEXT;
CREATE UNIQUE INDEX "users_github_id_key" ON "users"("github_id");
