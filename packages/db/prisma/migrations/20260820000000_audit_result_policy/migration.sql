-- BR-P1-005: give the audit trail a concept of OUTCOME.
--
-- Until now every one of the 130 activity_log writers sat on a success path,
-- so a denied privileged attempt produced no row at all — the moment a
-- control most needs to leave evidence. `result` records what happened
-- ('allowed' | 'denied' | 'error'); `policy` records the privileged action
-- that governed it (e.g. 'company:delete').
--
-- Both nullable, no backfill. Historical rows were never evaluated against a
-- policy, and inventing a value for them would put a manufactured answer into
-- the record an auditor is supposed to trust. An honest NULL says "not known";
-- a default would say something false about millions of rows.
--
-- Additive and non-breaking: existing writers keep working unchanged.
ALTER TABLE "activity_log" ADD COLUMN IF NOT EXISTS "result" TEXT;
ALTER TABLE "activity_log" ADD COLUMN IF NOT EXISTS "policy" TEXT;
