-- BRA-P1-06-N1 — company_members: sirket duzeyi uyelik (OWNER/MEMBER).
-- ADDITIVE ONLY: yeni enum + yeni tablo + indeks + FK. Mevcut tablolara
-- DROP/ALTER YOK; mevcut satirlar ve uc davranisi degismez. Bu dilimde hicbir
-- erisim kontrolu uyeliga bakmaz (bilgilendirici/temel model).
-- Hicbir ortama bu PR ile UYGULANMAZ; canliya yalniz `v*` surumuyle gider.

-- CreateEnum
CREATE TYPE "CompanyMemberRole" AS ENUM ('OWNER', 'MEMBER');

-- CreateTable
CREATE TABLE "company_members" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" "CompanyMemberRole" NOT NULL DEFAULT 'MEMBER',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" TEXT,

    CONSTRAINT "company_members_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "company_members_tenant_id_company_id_idx" ON "company_members"("tenant_id", "company_id");

-- CreateIndex
CREATE INDEX "company_members_user_id_idx" ON "company_members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "company_members_company_id_user_id_key" ON "company_members"("company_id", "user_id");

-- AddForeignKey
ALTER TABLE "company_members" ADD CONSTRAINT "company_members_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_members" ADD CONSTRAINT "company_members_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_members" ADD CONSTRAINT "company_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Defense in depth, ayni kalip (bkz. 20260616000000_tenant_rls / 20261108000000_job_lifecycle):
-- tenant baglanmamissa fail-open, kiraci baglandiysa zorunlu.
ALTER TABLE "company_members" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rls ON "company_members"
  USING (current_tenant_id() IS NULL OR tenant_id = current_tenant_id());
