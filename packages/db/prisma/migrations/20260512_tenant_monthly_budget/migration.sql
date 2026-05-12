-- Per-tenant monthly LLM + integration budget cap (Feature 1: spend forecast).
-- NULL = no cap (current behaviour). Dashboard reads this against
-- projected month-end spend to render a budget bar + warning banner;
-- the pipeline runner reads it to gate new spend-approval actions
-- once projection > cap × 1.0.

ALTER TABLE "tenants"
  ADD COLUMN "monthly_budget_usd" DECIMAL(10, 2);
