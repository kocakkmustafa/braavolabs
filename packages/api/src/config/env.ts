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
  JWT_EXPIRES_IN: z.string().default("1h"),
  JWT_REFRESH_EXPIRES_IN: z.string().default("7d"),
  LLM_PROVIDER: z.enum(["local", "api"]).default("api"),
  ANTHROPIC_API_KEY: z.string().optional(),
  // Default to Sonnet 4.5 (best price/perf for typical agent workloads). Override
  // via env for callers that need Opus 4 or Haiku 4.5. Validate against the
  // PROVIDER_MODELS list in services/ai-client.ts before changing the default.
  CLAUDE_MODEL: z.string().default("claude-sonnet-4-5-20250929"),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_CREATOR_PRICE_ID: z.string().optional(),
  STRIPE_CREATOR_YEARLY_PRICE_ID: z.string().optional(),
  STRIPE_PRO_PRICE_ID: z.string().optional(),
  STRIPE_PRO_YEARLY_PRICE_ID: z.string().optional(),
  STRIPE_BUSINESS_PRICE_ID: z.string().optional(),
  STRIPE_BUSINESS_YEARLY_PRICE_ID: z.string().optional(),
  STRIPE_ENTERPRISE_PRICE_ID: z.string().optional(),
  APP_URL: z.string().default("http://localhost:3001"),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().url().optional(),
  SENDGRID_API_KEY: z.string().optional(),
  SENDGRID_FROM_EMAIL: z.string().optional(),
  BYPASS_BILLING: z.coerce.boolean().default(false),
  ENCRYPTION_KEY: z.string().min(32),
  // Sentry — leave unset in dev, set in prod. The SDK no-ops when missing.
  SENTRY_DSN: z.string().url().optional(),
  SENTRY_RELEASE: z.string().optional(),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).optional(),
  // Off-site backup destination (S3-compatible URL) for postgres-backup
  // service. Empty = no off-site sync (acceptable for dev/staging).
  BACKUP_S3_BUCKET: z.string().optional(),
  BACKUP_S3_PREFIX: z.string().optional(),
  BACKUP_S3_REGION: z.string().optional(),
});

export type Env = z.infer<typeof envShape>;

const parsed = envShape.parse(process.env);

// Safety: BYPASS_BILLING must never be true in production
if (parsed.NODE_ENV === "production" && parsed.BYPASS_BILLING) {
  throw new Error("BYPASS_BILLING cannot be true in production");
}

// Safety: JWT_SECRET should be cryptographically strong in production
if (parsed.NODE_ENV === "production" && parsed.JWT_SECRET.length < 64) {
  console.warn("WARNING: JWT_SECRET is shorter than 64 characters. Use a strong random secret in production.");
}

// Safety: ENCRYPTION_KEY must not be a placeholder in production (ISS-008).
// A leaked DB dump + a placeholder key = trivial decryption of every customer's
// HubSpot / Stripe / Claude API key. Real keys are generated with
// `openssl rand -hex 32`. The encryption module also enforces this at
// derive-time, but we fail fast at boot to avoid a deceptively-healthy
// process that explodes the moment the first credential is decrypted.
if (parsed.NODE_ENV === "production") {
  const lower = parsed.ENCRYPTION_KEY.toLowerCase();
  const placeholders = ["change-me", "your-32-character", "please_generate", "replace_me"];
  for (const placeholder of placeholders) {
    if (lower.includes(placeholder)) {
      throw new Error(
        `ENCRYPTION_KEY appears to be a placeholder ("${placeholder}" detected). ` +
          "Generate a real key with: openssl rand -hex 32",
      );
    }
  }
}

export const env: Env = parsed;
