-- Agent-approval gate for the external-automation control plane.
-- Adds an EXTERNAL_CONTROL approval type: when an agent wants to trigger /
-- pause / resume a connected automation, the executor opens an approval of
-- this type (intent in Approval.metadata) and pauses the run; on APPROVE the
-- decide handler runs the action and resumes the agent with the outcome.
-- Additive enum value — safe, no backfill. (Postgres 12+ allows ADD VALUE in a
-- transaction, which Prisma's migrate runner uses.)

ALTER TYPE "ApprovalType" ADD VALUE IF NOT EXISTS 'EXTERNAL_CONTROL';
