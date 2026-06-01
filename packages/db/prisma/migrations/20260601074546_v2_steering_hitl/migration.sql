-- CreateEnum
CREATE TYPE "SteeringKind" AS ENUM ('INPUT', 'STEER');

-- AlterEnum
ALTER TYPE "ApprovalType" ADD VALUE 'INPUT';

-- AlterTable
ALTER TABLE "runs" ADD COLUMN     "resume_cursor" INTEGER;

-- CreateTable
CREATE TABLE "steering_messages" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "target_agent_id" TEXT,
    "kind" "SteeringKind" NOT NULL,
    "content" TEXT NOT NULL,
    "created_by" TEXT,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "steering_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "steering_messages_run_id_consumed_at_idx" ON "steering_messages"("run_id", "consumed_at");

-- AddForeignKey
ALTER TABLE "steering_messages" ADD CONSTRAINT "steering_messages_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
