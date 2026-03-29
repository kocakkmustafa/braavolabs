-- CreateEnum
CREATE TYPE "IntegrationProvider" AS ENUM ('TIKTOK', 'INSTAGRAM', 'LINKEDIN', 'YOUTUBE', 'TWITTER', 'OPENAI', 'RUNWAY', 'ELEVENLABS', 'MIDJOURNEY', 'FLUX', 'PIKA', 'HUBSPOT', 'STRIPE', 'SENDGRID');

-- CreateEnum
CREATE TYPE "IntegrationStatus" AS ENUM ('PENDING', 'ACTIVE', 'ERROR', 'EXPIRED');

-- CreateTable
CREATE TABLE "integrations" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "provider" "IntegrationProvider" NOT NULL,
    "status" "IntegrationStatus" NOT NULL DEFAULT 'PENDING',
    "credentials" TEXT NOT NULL,
    "label" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "last_tested_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integrations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "integrations_company_id_idx" ON "integrations"("company_id");

-- CreateIndex
CREATE UNIQUE INDEX "integrations_company_id_provider_key" ON "integrations"("company_id", "provider");

-- AddForeignKey
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
