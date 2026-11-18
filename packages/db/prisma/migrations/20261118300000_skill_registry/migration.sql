-- Community skill registry (2026-11-02): publishers, packages, immutable signed
-- versions, reports and the public revocation list. Additive only: new types,
-- tables and indexes; no existing table is touched.

-- CreateEnum
CREATE TYPE "SkillTrust" AS ENUM ('OFFICIAL', 'VERIFIED', 'COMMUNITY', 'UNREVIEWED');

-- CreateEnum
CREATE TYPE "SkillVersionState" AS ENUM ('NEEDS_REVIEW', 'APPROVED', 'REJECTED', 'REVOKED');

-- CreateEnum
CREATE TYPE "SkillPublisherStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "SkillReportSeverity" AS ENUM ('LOW', 'HIGH');

-- CreateEnum
CREATE TYPE "SkillReportStatus" AS ENUM ('OPEN', 'DISMISSED', 'ACTIONED');

-- CreateTable
CREATE TABLE "skill_publishers" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "official" BOOLEAN NOT NULL DEFAULT false,
    "status" "SkillPublisherStatus" NOT NULL DEFAULT 'ACTIVE',
    "strikes" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "skill_publishers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skill_packages" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "publisher_id" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "trust" "SkillTrust" NOT NULL DEFAULT 'UNREVIEWED',
    "downloads" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "skill_packages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skill_versions" (
    "id" TEXT NOT NULL,
    "package_id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "source_repo" TEXT NOT NULL,
    "source_ref" TEXT NOT NULL,
    "bundle" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "skill_md" TEXT NOT NULL,
    "files" JSONB NOT NULL DEFAULT '[]',
    "findings" JSONB NOT NULL DEFAULT '[]',
    "state" "SkillVersionState" NOT NULL DEFAULT 'NEEDS_REVIEW',
    "signed_manifest" TEXT,
    "signature" TEXT,
    "reviewed_by" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "skill_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skill_reports" (
    "id" TEXT NOT NULL,
    "version_id" TEXT NOT NULL,
    "reporter_user_id" TEXT NOT NULL,
    "severity" "SkillReportSeverity" NOT NULL DEFAULT 'LOW',
    "reason" TEXT NOT NULL,
    "details" TEXT NOT NULL DEFAULT '',
    "status" "SkillReportStatus" NOT NULL DEFAULT 'OPEN',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "skill_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skill_revocations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "skill_revocations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "skill_publishers_user_id_key" ON "skill_publishers"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "skill_publishers_handle_key" ON "skill_publishers"("handle");

-- CreateIndex
CREATE UNIQUE INDEX "skill_packages_name_key" ON "skill_packages"("name");

-- CreateIndex
CREATE INDEX "skill_packages_publisher_id_idx" ON "skill_packages"("publisher_id");

-- CreateIndex
CREATE INDEX "skill_versions_state_created_at_idx" ON "skill_versions"("state", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "skill_versions_package_id_version_key" ON "skill_versions"("package_id", "version");

-- CreateIndex
CREATE INDEX "skill_reports_status_created_at_idx" ON "skill_reports"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "skill_revocations_name_version_key" ON "skill_revocations"("name", "version");

-- AddForeignKey
ALTER TABLE "skill_packages" ADD CONSTRAINT "skill_packages_publisher_id_fkey" FOREIGN KEY ("publisher_id") REFERENCES "skill_publishers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_versions" ADD CONSTRAINT "skill_versions_package_id_fkey" FOREIGN KEY ("package_id") REFERENCES "skill_packages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_reports" ADD CONSTRAINT "skill_reports_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "skill_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

