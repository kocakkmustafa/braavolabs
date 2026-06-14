-- Graduated autonomy per agent (Feature D6 — Relevance's signature).
--
-- Controls how eager an agent is to pause for human approval on NON-money
-- tool calls:
--   SUPERVISED — pause on every side-effecting/spend action.
--   BALANCED   — pause on spend + tools flagged risky (high/medium risk).
--   AUTONOMOUS — only the five risk-stops gate it; no routine approval pauses.
--
-- The default is BALANCED, which reproduces today's behaviour exactly: before
-- this column existed, only tools declaring `requiresApproval` (spend + risky
-- actions) ever paused a run. Money-touching actions ALWAYS require approval
-- regardless of this setting (CLAUDE.md rule #3 is inviolable) — autonomy only
-- relaxes non-money pauses. Additive + safe: existing rows backfill to BALANCED.

CREATE TYPE "AgentAutonomy" AS ENUM ('SUPERVISED', 'BALANCED', 'AUTONOMOUS');

ALTER TABLE "agents"
  ADD COLUMN "autonomy" "AgentAutonomy" NOT NULL DEFAULT 'BALANCED';
