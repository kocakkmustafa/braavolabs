-- BRA-P1-06-N2 — Job owner + insan onaylı teslim alanı (runs).
-- ADDITIVE ONLY: nullable ADD COLUMN (DEFAULT yok; metadata-only, tablo yeniden yazılmaz)
-- + bir indeks. DROP / ALTER TYPE yok. Bu PR ile hiçbir ortama UYGULANMAZ;
-- canlıya yalnız `v*` sürümüyle gider.

-- AlterTable
ALTER TABLE "runs" ADD COLUMN     "owner_user_id" TEXT,
ADD COLUMN     "delivery_approved_by_id" TEXT,
ADD COLUMN     "delivery_approved_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "runs_tenant_id_owner_user_id_idx" ON "runs"("tenant_id", "owner_user_id");
