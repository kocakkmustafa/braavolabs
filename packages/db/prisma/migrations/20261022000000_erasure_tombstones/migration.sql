-- Short retention profile: tombstones let a restore re-apply account erasures.
-- Only sha256(id) of erased users/tenants is stored (no personal data, no FK,
-- no RLS: rows must survive the tenant they describe).
CREATE TABLE "erasure_tombstones" (
    "subject_kind" TEXT NOT NULL,
    "subject_hash" TEXT NOT NULL,
    "erased_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "erasure_tombstones_pkey" PRIMARY KEY ("subject_kind","subject_hash"),
    CONSTRAINT "erasure_tombstones_kind_check" CHECK ("subject_kind" IN ('user', 'tenant')),
    CONSTRAINT "erasure_tombstones_hash_check" CHECK ("subject_hash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "erasure_tombstones_expiry_check" CHECK ("expires_at" >= "erased_at")
);

CREATE INDEX "erasure_tombstones_expires_at_idx" ON "erasure_tombstones"("expires_at");
