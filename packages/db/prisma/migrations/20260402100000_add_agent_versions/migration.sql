-- CreateTable
CREATE TABLE "agent_versions" (
    "id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "label" TEXT,
    "snapshot" JSONB NOT NULL,
    "change_summary" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_versions_agent_id_idx" ON "agent_versions"("agent_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_versions_agent_id_version_key" ON "agent_versions"("agent_id", "version");

-- AddForeignKey
ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
