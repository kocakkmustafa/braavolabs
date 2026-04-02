import { config } from "dotenv";
import { resolve } from "path";
// Try loading .env from cwd first, then project root (../../)
const r1 = config({ path: resolve(process.cwd(), ".env") });
if (r1.error) {
  config({ path: resolve(process.cwd(), "../../.env") });
}

import { z } from "zod";

const envShape = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  API_PORT: z.coerce.number().default(8080),
  API_HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.string().default("debug"),
  DATABASE_URL: z.string(),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().default("7d"),
  LLM_PROVIDER: z.enum(["local", "api"]).default("api"),
  ANTHROPIC_API_KEY: z.string().optional(),
  CLAUDE_MODEL: z.string().default("claude-sonnet-4-20250514"),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PRO_PRICE_ID: z.string().optional(),
  STRIPE_ENTERPRISE_PRICE_ID: z.string().optional(),
  APP_URL: z.string().default("http://localhost:3001"),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().url().optional(),
  SENDGRID_API_KEY: z.string().optional(),
  SENDGRID_FROM_EMAIL: z.string().optional(),
  BYPASS_BILLING: z.coerce.boolean().default(false),
  ENCRYPTION_KEY: z.string().min(32),
});

export type Env = z.infer<typeof envShape>;

const parsed = envShape.parse(process.env);

// Safety: BYPASS_BILLING must never be true in production
if (parsed.NODE_ENV === "production" && parsed.BYPASS_BILLING) {
  throw new Error("BYPASS_BILLING cannot be true in production");
}

export const env: Env = parsed;
