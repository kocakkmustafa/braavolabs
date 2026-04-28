-- Add local-LLM providers (Ollama, LM Studio, Custom OpenAI-compatible) to
-- the AIProvider enum. These point at user-supplied base URLs and let
-- tenants run agents against their own self-hosted models (Gemma 2/3,
-- Llama 3, Qwen, DeepSeek, etc) for $0 inference cost and full data
-- privacy. The new `base_url` column on user_ai_configs is the override
-- for the per-provider default endpoint (Ollama default:
-- http://localhost:11434/v1).

ALTER TYPE "AIProvider" ADD VALUE IF NOT EXISTS 'OLLAMA';
ALTER TYPE "AIProvider" ADD VALUE IF NOT EXISTS 'LMSTUDIO';
ALTER TYPE "AIProvider" ADD VALUE IF NOT EXISTS 'CUSTOM';

ALTER TABLE "user_ai_configs" ADD COLUMN IF NOT EXISTS "base_url" TEXT;
