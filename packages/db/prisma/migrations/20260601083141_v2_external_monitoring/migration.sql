-- CreateEnum
CREATE TYPE "ExternalPlatform" AS ENUM ('N8N', 'MAKE', 'ZAPIER', 'GENERIC');

-- CreateEnum
CREATE TYPE "ExternalConnectionStatus" AS ENUM ('PENDING', 'ACTIVE', 'ERROR', 'DISABLED');

-- CreateTable
CREATE TABLE "external_connections" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "company_id" TEXT,
    "platform" "ExternalPlatform" NOT NULL,
    "label" TEXT NOT NULL,
    "base_url" TEXT NOT NULL,
    "encrypted_credentials" TEXT NOT NULL,
    "poll_interval_sec" INTEGER NOT NULL DEFAULT 60,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "status" "ExternalConnectionStatus" NOT NULL DEFAULT 'PENDING',
    "last_polled_at" TIMESTAMP(3),
    "last_error" TEXT,
    "cursor" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "external_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "external_runs" (
    "id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "workflow_name" TEXT,
    "status" TEXT NOT NULL,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "raw" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "external_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "external_connections_tenant_id_idx" ON "external_connections"("tenant_id");

-- CreateIndex
CREATE INDEX "external_connections_enabled_status_idx" ON "external_connections"("enabled", "status");

-- CreateIndex
CREATE INDEX "external_runs_connection_id_started_at_idx" ON "external_runs"("connection_id", "started_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "external_runs_connection_id_external_id_key" ON "external_runs"("connection_id", "external_id");

-- AddForeignKey
ALTER TABLE "external_connections" ADD CONSTRAINT "external_connections_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_runs" ADD CONSTRAINT "external_runs_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "external_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

