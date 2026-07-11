-- Add two OpenAI-compatible cloud providers to the AIProvider enum (Forge FAZ 1 / Dilim 1A).
-- Cerebras (free tier ~1M tok/day, gpt-oss-120b + GLM-4.7) and Zhipu GLM (Flash tiers
-- permanently free). Additive, non-destructive. Apply is USER-approval-gated (do NOT
-- auto-apply): matches the E-series "migration file ready, apply deferred" discipline.

-- AlterEnum
ALTER TYPE "AIProvider" ADD VALUE 'CEREBRAS';
ALTER TYPE "AIProvider" ADD VALUE 'ZHIPU';
