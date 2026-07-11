-- Persist real per-call token counts on run_steps (Forge P1 — honest
-- "tokens saved" metric). run_steps previously only kept cost_usd; the
-- promptTokens/completionTokens split that produced that cost was computed
-- transiently at the call site (modules/pipeline/executor.ts,
-- modules/pipeline/hierarchical-runner.ts, from the provider's real
-- usage.input_tokens / usage.output_tokens) and then discarded.
--
-- Additive, non-destructive: all three columns are nullable. Existing rows
-- are left NULL — savings.service.ts falls back to its cost-based
-- reconstruction for those, and switches to these real columns once
-- populated by new runs. cached_input_tokens is reserved for prompt-cache
-- accounting (e.g. Anthropic cache_read_input_tokens); no call site
-- populates it yet, but the column is added now so it doesn't need a
-- second migration when caching lands.
--
-- Apply is USER-approval-gated (do NOT auto-apply): matches the E-series
-- "migration file ready, apply deferred" discipline.

-- AlterTable
ALTER TABLE "run_steps" ADD COLUMN "prompt_tokens" INTEGER;
ALTER TABLE "run_steps" ADD COLUMN "completion_tokens" INTEGER;
ALTER TABLE "run_steps" ADD COLUMN "cached_input_tokens" INTEGER;
