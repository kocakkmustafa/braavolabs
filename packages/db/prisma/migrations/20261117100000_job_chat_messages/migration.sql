-- BRA-UX-API-05 — İş sohbeti (job_messages).
-- ADDITIVE ONLY: CREATE TYPE + CREATE TABLE + indeks + FK + RLS. DROP / ALTER TYPE /
-- mevcut tabloda değişiklik yok. Bu PR ile hiçbir ortama UYGULANMAZ; canlıya yalnız `v*` sürümüyle gider.

-- CreateEnum
CREATE TYPE "JobMessageRole" AS ENUM ('USER', 'ASSISTANT', 'SYSTEM');

-- CreateTable
CREATE TABLE "job_messages" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "role" "JobMessageRole" NOT NULL,
    "content" TEXT NOT NULL,
    "author_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "job_messages_tenant_id_run_id_created_at_id_idx" ON "job_messages"("tenant_id", "run_id", "created_at" DESC, "id" DESC);

-- AddForeignKey
ALTER TABLE "job_messages" ADD CONSTRAINT "job_messages_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Defense in depth, same pattern as the other tenant_id tables (see 20260616000000_tenant_rls).
ALTER TABLE "job_messages" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rls ON "job_messages"
  USING (current_tenant_id() IS NULL OR tenant_id = current_tenant_id());
