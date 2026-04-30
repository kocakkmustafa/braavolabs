-- AlterEnum: add new cloud providers (OpenAI-compatible chat-completions wire format).
-- Each ALTER TYPE ... ADD VALUE is its own statement because Postgres
-- forbids running it inside a transaction. Prisma's migration runner
-- handles statement-by-statement.

ALTER TYPE "AIProvider" ADD VALUE IF NOT EXISTS 'DEEPSEEK';
ALTER TYPE "AIProvider" ADD VALUE IF NOT EXISTS 'KIMI';
ALTER TYPE "AIProvider" ADD VALUE IF NOT EXISTS 'QWEN';
