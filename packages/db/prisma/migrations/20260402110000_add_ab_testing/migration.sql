-- CreateEnum
CREATE TYPE "AbTestStatus" AS ENUM ('DRAFT', 'RUNNING', 'PAUSED', 'COMPLETED');

-- CreateTable
CREATE TABLE "ab_tests" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "AbTestStatus" NOT NULL DEFAULT 'DRAFT',
    "winner_variant_id" TEXT,
    "started_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ab_tests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ab_test_variants" (
    "id" TEXT NOT NULL,
    "test_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "weight" INTEGER NOT NULL DEFAULT 50,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ab_test_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ab_test_metrics" (
    "id" TEXT NOT NULL,
    "variant_id" TEXT NOT NULL,
    "run_id" TEXT,
    "metric" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ab_test_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ab_tests_tenant_id_idx" ON "ab_tests"("tenant_id");

-- CreateIndex
CREATE INDEX "ab_tests_company_id_idx" ON "ab_tests"("company_id");

-- CreateIndex
CREATE INDEX "ab_tests_agent_id_idx" ON "ab_tests"("agent_id");

-- CreateIndex
CREATE INDEX "ab_test_variants_test_id_idx" ON "ab_test_variants"("test_id");

-- CreateIndex
CREATE INDEX "ab_test_metrics_variant_id_idx" ON "ab_test_metrics"("variant_id");

-- AddForeignKey
ALTER TABLE "ab_tests" ADD CONSTRAINT "ab_tests_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ab_tests" ADD CONSTRAINT "ab_tests_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ab_tests" ADD CONSTRAINT "ab_tests_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ab_test_variants" ADD CONSTRAINT "ab_test_variants_test_id_fkey" FOREIGN KEY ("test_id") REFERENCES "ab_tests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ab_test_metrics" ADD CONSTRAINT "ab_test_metrics_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "ab_test_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
