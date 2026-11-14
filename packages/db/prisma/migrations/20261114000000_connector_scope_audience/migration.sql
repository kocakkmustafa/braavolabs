-- SEC-BRA-03 — connector scope / audience / revoke.
-- ADDITIVE ONLY: ADD COLUMN on "tenant_connectors" (array defaults to empty =
-- unrestricted legacy behaviour; audience/revoked_at nullable). No existing
-- column or row changes. NOT applied to any environment by this PR.

-- AlterTable
ALTER TABLE "tenant_connectors" ADD COLUMN     "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "audience" TEXT,
ADD COLUMN     "revoked_at" TIMESTAMP(3);
