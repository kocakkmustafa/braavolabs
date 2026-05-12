-- Public agent-quality benchmark (Feature 10).
--
-- Read-only public surface at /bench: every supported LLM provider
-- ran against fixed task suites, scored, ranked. Same play as
-- Devin's SWE-bench leaderboard.

CREATE TYPE "BenchProvider" AS ENUM (
  'ANTHROPIC', 'OPENAI', 'GOOGLE', 'MISTRAL', 'GROQ', 'OPENROUTER',
  'DEEPSEEK', 'KIMI', 'QWEN', 'OLLAMA', 'LMSTUDIO'
);

CREATE TABLE "bench_suites" (
  "id"                   TEXT PRIMARY KEY,
  "slug"                 TEXT NOT NULL UNIQUE,
  "name"                 TEXT NOT NULL,
  "description"          TEXT NOT NULL,
  "tasks"                JSONB NOT NULL,
  "max_score_per_task"   INTEGER NOT NULL DEFAULT 10,
  "is_public"            BOOLEAN NOT NULL DEFAULT true,
  "created_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"           TIMESTAMP(3) NOT NULL
);

CREATE TABLE "bench_runs" (
  "id"               TEXT PRIMARY KEY,
  "suite_id"         TEXT NOT NULL,
  "provider"         "BenchProvider" NOT NULL,
  "model"            TEXT NOT NULL,
  "scores_by_task"   JSONB NOT NULL,
  "score_normalised" DOUBLE PRECISION NOT NULL,
  "cost_usd"         DECIMAL(10, 4) NOT NULL,
  "duration_ms"      INTEGER NOT NULL,
  "notes"            TEXT,
  "ran_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "bench_runs_suite_id_fkey"
    FOREIGN KEY ("suite_id") REFERENCES "bench_suites"("id") ON DELETE CASCADE
);
CREATE INDEX "bench_runs_suite_id_score_idx"
  ON "bench_runs"("suite_id", "score_normalised" DESC);
CREATE INDEX "bench_runs_provider_model_ran_at_idx"
  ON "bench_runs"("provider", "model", "ran_at" DESC);
