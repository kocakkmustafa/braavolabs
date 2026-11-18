-- BRA-P1-03-N1 — tenant repository allowlist (salt-okur niyet; token/anahtar SAKLANMAZ).
-- ADDITIVE ONLY: CREATE TYPE + CREATE TABLE + indeks + FK + RLS. DROP / ALTER TYPE / mevcut tabloda değişiklik yok.
-- Bu PR ile hiçbir ortama UYGULANMAZ; canlıya yalnız `v*` sürümüyle gider (kurucu).

-- CreateEnum
CREATE TYPE "RepoProvider" AS ENUM ('GITHUB');

-- CreateTable
CREATE TABLE "tenant_repositories" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "provider" "RepoProvider" NOT NULL DEFAULT 'GITHUB',
    "owner" TEXT NOT NULL,
    "repo" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "installation_id" TEXT,
    "default_branch" TEXT,
    "created_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_repositories_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tenant_repositories_tenant_id_idx" ON "tenant_repositories"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_repositories_tenant_id_provider_full_name_key" ON "tenant_repositories"("tenant_id", "provider", "full_name");

-- AddForeignKey
ALTER TABLE "tenant_repositories" ADD CONSTRAINT "tenant_repositories_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Defense in depth, same pattern as the other tenant_id tables (see 20260616000000_tenant_rls).
ALTER TABLE "tenant_repositories" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rls ON "tenant_repositories"
  USING (current_tenant_id() IS NULL OR tenant_id = current_tenant_id());
