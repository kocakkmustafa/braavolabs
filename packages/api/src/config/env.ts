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
  // ── DB transaction wrapper budget (RLS-real) ──
  // The RLS binding wraps every model op in an interactive transaction. Prisma's
  // interactive-tx DEFAULTS (timeout 5s / maxWait 2s) are far tighter than the
  // pre-RLS world, where a plain query had no app-side wall-clock ceiling and
  // waited up to pool_timeout for a connection. Left at the defaults, a slow
  // analytics/report query would newly throw P2028 → 500 (a regression that
  // fires even before the STAGE 2 role switch). These generous defaults keep
  // STAGE 1 behavior-preserving; tune per-deployment via env.
  DB_TX_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  // Aligned with the compose pool_timeout (15s) so contention QUEUES for a
  // connection rather than fast-failing with P2028.
  DB_TX_MAXWAIT_MS: z.coerce.number().int().positive().default(15_000),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().default("1h"),
  JWT_REFRESH_EXPIRES_IN: z.string().default("7d"),
  // ── Web auth cookie mode (D-007 / E9) ──
  // When "true", the email/password login + register + refresh responses
  // ALSO deposit the access/refresh JWTs into httpOnly+Secure+SameSite=Strict
  // cookies, and authMiddleware accepts the access cookie when no
  // Authorization: Bearer header is present (bearer keeps priority). Default
  // "false" → byte-for-byte the pre-existing bearer-only behavior. Same
  // explicit string→bool transform as BYPASS_BILLING so ONLY the literal
  // "true" flips it on. Flipping this on in prod is a separate, user-gated
  // step that lands with the UI migration — see .env.example.
  AUTH_COOKIE_MODE: z.string().optional().default("false").transform((v) => v === "true"),
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
  STRIPE_ENTERPRISE_YEARLY_PRICE_ID: z.string().optional(),
  // Number of trusted reverse-proxy hops between the client and Express.
  //   0 → no proxy (dev)
  //   1 → nginx only (prod default)
  //   2 → Cloudflare + nginx (set on the same deploy as the DNS cutover)
  // See packages/api/src/index.ts for the full risk discussion.
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),
  APP_URL: z.string().default("http://localhost:3001"),
  // Public origin where THIS API is reachable from the internet. Used to
  // build links that must hit API routes directly (e.g. the one-click
  // GET /api/v1/auth/verify-email in verification emails — pointing those
  // at APP_URL 404s because the UI has no such page). Optional: when unset
  // it is resolved below — production → APP_URL (nginx serves /api/v1 on
  // the same origin), dev → http://localhost:<API_PORT>.
  API_PUBLIC_URL: z.preprocess((v) => (v === "" ? undefined : v), z.string().url().optional()),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  // Empty-string-tolerant URL validators. docker-compose's
  // `${VAR:-}` substitution sets an empty string when the value is
  // missing in .env, which `z.string().url()` rejects ("Invalid url").
  // Preprocessing maps "" → undefined so the optional() chain accepts it.
  GOOGLE_REDIRECT_URI: z.preprocess((v) => (v === "" ? undefined : v), z.string().url().optional()),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  GITHUB_REDIRECT_URI: z.preprocess((v) => (v === "" ? undefined : v), z.string().url().optional()),

  // ── Mobile OAuth (separate clients from the web flow) ──
  // Mobile uses its own OAuth client IDs because the redirect URI
  // schemes differ:
  //   - Web GitHub callback   = https://braavolabs.com/auth/callback
  //   - Mobile GitHub callback = braavolabs://oauth/github/callback
  // Apple Sign-In has no client_secret — verification is JWS-based
  // against appleid.apple.com JWKS, using the iOS bundle id as `aud`.
  GOOGLE_IOS_CLIENT_ID: z.string().optional(),
  GOOGLE_ANDROID_CLIENT_ID: z.string().optional(),
  GITHUB_MOBILE_CLIENT_ID: z.string().optional(),
  GITHUB_MOBILE_CLIENT_SECRET: z.string().optional(),
  // The iOS bundle identifier registered in App Store Connect. Used
  // as the `aud` claim for Apple Sign-In verification.
  APPLE_SIWA_BUNDLE_ID: z.string().optional(),

  // Apple Sign-In Web (Service ID) — separate from the iOS bundle
  // because Apple treats web SIWA as a distinct OAuth client. Create
  // a Services ID at developer.apple.com (e.g. `com.braavolabs.signin`)
  // and link it to the primary App ID so the user's Apple `sub` is
  // shared across web + mobile sign-ins.
  APPLE_WEB_SERVICE_ID: z.string().optional(),
  // Full callback URL that Apple POSTs back to (form_post). Must
  // match the "Return URLs" list configured on the Service ID exactly.
  // e.g. https://api.braavolabs.com/api/v1/auth/apple/callback
  APPLE_WEB_REDIRECT_URI: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().url().optional(),
  ),

  SENDGRID_API_KEY: z.string().optional(),
  SENDGRID_FROM_EMAIL: z.string().optional(),
  // BYPASS_BILLING: z.coerce.boolean() coerces ANY non-empty string to true
  // (Boolean("false") === true in JavaScript). Use an explicit string→bool
  // transform so only the literal "true" enables bypass — every other value
  // (including "false", "0", empty, missing) keeps billing enforcement on.
  BYPASS_BILLING: z.string().optional().default("false").transform((v) => v === "true"),
  // TENANT_CONTEXT_FAIL_CLOSED (BR-P0-004): when on, a Prisma model op from a
  // path that declared NEITHER runWithTenant nor runWithoutTenant throws
  // instead of querying with app.tenant_id NULL (which disables RLS for that
  // query). Defaults ON. Same explicit string transform as BYPASS_BILLING —
  // z.coerce.boolean() would make "false" true. Set the literal "false" to
  // restore the old fail-open behavior without a rollback.
  TENANT_CONTEXT_FAIL_CLOSED: z
    .string()
    .optional()
    .default("true")
    .transform((v) => v !== "false"),
  // AUDIT_RETENTION_ENABLED / AUDIT_RETENTION_DRY_RUN (BR-P1-005 #4).
  //
  // The per-plan audit window has been enforced by nothing:
  // `auditRetentionDays` was read by no production code and there was not one
  // activityLog delete in the API. This turns it on, and DEFAULTS OFF because
  // it DELETES production audit rows.
  //
  // 🚪 FOUNDER GATE — two published statements contradict, and it is legal.
  //   - ui/app/gdpr/page.tsx tells a supervisory authority "Audit logs and run
  //     history are kept for 12 months", flat, for everyone.
  //   - the roadmap plan table says Free 7 / Creator 90 / Pro 365 / Business
  //     730. Those tiers are rendered NOWHERE in the product — the pricing
  //     page shows "full audit trail" identically on every tier.
  // Both directions are a problem, not just one: undercutting the 12-month
  // line is a truthfulness issue, and keeping BUSINESS 730 days or ENTERPRISE
  // forever is a storage-limitation issue under GDPR Art. 5(1)(e). Until it
  // is decided, retention.ts applies max(plan window, 365).
  //
  // NOT a prerequisite, contrary to what this comment said before: the
  // collapse design in lib/audit-writer.ts. An earlier version claimed a
  // flood of denial rows would "roll real events out of the window". That is
  // FALSE — a time-anchored window is not a ring buffer, rows die by AGE and
  // never by count or table pressure. The real hazard is plan DOWNGRADE (a
  // Business tenant whose card fails is revoked to FREE), which the 365-day
  // floor bounds but does not eliminate.
  //
  // DRY_RUN defaults ON, so the first thing an operator gets is a count of
  // what WOULD go. Same explicit string transform as
  // TENANT_CONTEXT_FAIL_CLOSED — z.coerce.boolean() makes "false" true.
  AUDIT_RETENTION_ENABLED: z
    .string()
    .optional()
    .default("false")
    .transform((v) => v === "true"),
  AUDIT_RETENTION_DRY_RUN: z
    .string()
    .optional()
    .default("true")
    .transform((v) => v !== "false"),
  ENCRYPTION_KEY: z.string().min(32),
  // Sentry — leave unset in dev, set in prod. The SDK no-ops when missing.
  // Empty string tolerated (docker-compose default substitution).
  SENTRY_DSN: z.preprocess((v) => (v === "" ? undefined : v), z.string().url().optional()),
  SENTRY_RELEASE: z.string().optional(),
  SENTRY_TRACES_SAMPLE_RATE: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.coerce.number().min(0).max(1).optional(),
  ),
  // Off-site backup destination (S3-compatible URL) for postgres-backup
  // service. Empty = no off-site sync (acceptable for dev/staging).
  BACKUP_S3_BUCKET: z.string().optional(),
  BACKUP_S3_PREFIX: z.string().optional(),
  BACKUP_S3_REGION: z.string().optional(),
  // Trial LLM (Groq) — when set, new tenants on FREE plan get N pipeline
  // runs routed through the holding-owned key before they must BYOK.
  // Empty = trial system off (older tenants or self-hosted deployments
  // where the operator doesn't want to pay for LLM trials).
  GROQ_API_KEY: z.string().optional(),
  GROQ_TRIAL_MODEL: z.string().default("llama-3.3-70b-versatile"),
  CEREBRAS_API_KEY: z.string().optional(),
  ZHIPU_API_KEY: z.string().optional(),
  // ── Forge onboarding trial-credit cap (FAZ1-1C) ──
  // Separate from GROQ_TRIAL_MODEL / trialRunsLimit above (that gate is a
  // per-tenant RUN COUNT for the main pipeline runner's Groq fallback). This
  // one is a USD SPEND ceiling, tenant-wide + lifetime (not periodic), that
  // bounds how much of Braavolabs' own held free-tier keys (Cerebras / Groq /
  // Zhipu — see modules/billing/trial-credit.service.ts) the Forge onboarding
  // wizard's "try before you BYOK" flow may spend on a tenant's behalf.
  // Default 0 = the trial-credit gate is CLOSED — every trial-funded call is
  // refused fail-closed until an operator explicitly sets a positive cap.
  // Plain USD (e.g. "0.50"), NOT micro-usd — trial-credit.service.ts is the
  // only place that converts to the micro-usd integer units usage_meters
  // stores its `value` column as.
  FORGE_TRIAL_CREDIT_USD_CAP: z.coerce.number().nonnegative().default(0),
  // Pipeline export DRM. LICENSE_JWT_SECRET signs offline license tokens;
  // empty here means the /license/* endpoints return 503. TTL controls how
  // many days the token is valid before requiring an online re-verify.
  LICENSE_JWT_SECRET: z.string().optional(),
  LICENSE_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(7),
  LICENSE_MACHINE_CHANGES_PER_MONTH: z.coerce.number().int().min(0).max(100).default(1),
  // ── Mobile In-App Purchase verification ──
  // Apple App Store Server API (StoreKit 2 path):
  APPLE_ISSUER_ID: z.string().optional(),
  APPLE_KEY_ID: z.string().optional(),
  // PEM-formatted ES256 private key downloaded from App Store Connect.
  // Docker `.env` files cannot store actual newlines, so we accept the PEM
  // as a single-line value with `\n` (literal backslash-n) as the line
  // separator and unescape here. If the value is already multi-line
  // (e.g. via a secrets-mount that preserves newlines), the replace is a
  // no-op.
  APPLE_PRIVATE_KEY: z.string().optional().transform((v) => (v ? v.replace(/\\n/g, "\n") : v)),
  APPLE_BUNDLE_ID: z.string().optional(),
  // Legacy verifyReceipt fallback (pre-StoreKit 2 builds):
  APPLE_SHARED_SECRET: z.string().optional(),
  // Google Play Developer API:
  GOOGLE_PLAY_PACKAGE_NAME: z.string().optional(),
  // Base64-encoded service account JSON. Decode + parse on first use.
  GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: z.string().optional(),
  // Google Play RTDN Pub/Sub push authentication (FINDINGS C1). The push
  // subscription must be configured with an OIDC service-account token;
  // the /billing/iap/google/notify endpoint verifies it. Audience is the
  // value set on the push subscription (typically the notify URL). Email,
  // if set, is asserted against the verified token's `email` claim.
  GOOGLE_PUBSUB_AUDIENCE: z.string().optional(),
  GOOGLE_PUBSUB_SA_EMAIL: z.string().optional(),
  // RevenueCat (optional unified path covering both stores):
  REVENUECAT_WEBHOOK_SECRET: z.string().optional(),
  // Vapi voice webhook HMAC secret — used to verify inbound Vapi callbacks.
  VAPI_WEBHOOK_SECRET: z.string().optional(),
  // ── Air-gap / offline mode ──
  // When true, the LLM router refuses every non-local provider, the
  // export DRM enforces machine binding (already on), and outbound
  // SaaS integrations (HubSpot, SendGrid, Stripe webhooks, etc.) skip
  // network calls. Designed for self-hosted air-gapped deployments —
  // operator pairs this with Ollama or LM Studio as the LLM provider.
  OFFLINE_MODE: z.string().optional().default("false").transform((v) => v === "true"),
  // ── Native tool-use kill-switch (E2/T3) ──
  // Comma-separated allowlist of providers permitted to use NATIVE
  // function-calling (OpenAI `tools`, Gemini `functionDeclarations`).
  // Unset = all non-Anthropic providers enabled (see
  // DEFAULT_NATIVE_TOOLUSE_PROVIDERS in services/ai-client.ts). Removing a
  // provider instantly restores the legacy prompt-embedding behavior for it
  // — the rollback lever for the tool-use translation layer. ANTHROPIC is
  // never gated (SDK-native path predates this layer).
  NATIVE_TOOLUSE_PROVIDERS: z.string().optional(),
  // ── Scheduled-pipeline timezone pin (E4) ──
  // BullMQ JobScheduler evaluates cron patterns against this IANA timezone.
  // The prod container ships no TZ env and node:20-alpine carries no tzdata,
  // so the *old* in-process node-cron effectively fired against UTC. We pin
  // the default to "UTC" to reproduce that firing behavior byte-for-byte on
  // cutover (deterministic, no silent wall-clock shift). Operators who want
  // schedules interpreted in local time set e.g. SCHEDULER_TZ="Europe/Istanbul"
  // — but that is an intentional behavior change, never an accidental drift.
  SCHEDULER_TZ: z.string().default("UTC"),
});

export type Env = z.infer<typeof envShape>;

const parsed = envShape.parse(process.env);

// Safety: BYPASS_BILLING must never be true in production
if (parsed.NODE_ENV === "production" && parsed.BYPASS_BILLING) {
  throw new Error("BYPASS_BILLING cannot be true in production");
}

// Safety: APP_URL must be an explicit https:// URL in production. The Zod
// default ("http://localhost:3001") is dev-only — leaking it into prod would
// leak OAuth tokens / redirects to localhost from the user's browser.
if (parsed.NODE_ENV === "production") {
  const isDefault = parsed.APP_URL === "http://localhost:3001";
  const isHttps = parsed.APP_URL.startsWith("https://");
  if (isDefault || !isHttps) {
    throw new Error(
      `APP_URL must be set to an explicit https:// URL in production. Got: "${parsed.APP_URL}"`,
    );
  }
}

// Safety: JWT_SECRET should be cryptographically strong in production
if (parsed.NODE_ENV === "production" && parsed.JWT_SECRET.length < 64) {
  console.warn("WARNING: JWT_SECRET is shorter than 64 characters. Use a strong random secret in production.");
}

// Safety: refuse well-known placeholders for *every* signing secret so a
// half-configured deployment can't go live with a publicly-known key
// inherited from .env.example. The placeholders here match the exact
// strings shipped in .env.example; rolling either secret means swapping
// the literal too. JWT_SECRET protects every session; LICENSE_JWT_SECRET
// protects the offline DRM tokens that gate paid exports.
if (parsed.NODE_ENV === "production") {
  const secretPlaceholders = ["change-me", "your-32-character", "please_generate", "replace_me"];
  for (const placeholder of secretPlaceholders) {
    if (parsed.JWT_SECRET.toLowerCase().includes(placeholder)) {
      throw new Error(
        `JWT_SECRET appears to be a placeholder ("${placeholder}" detected). ` +
          "Generate a real secret with: openssl rand -hex 32",
      );
    }
    if (
      parsed.LICENSE_JWT_SECRET &&
      parsed.LICENSE_JWT_SECRET.toLowerCase().includes(placeholder)
    ) {
      throw new Error(
        `LICENSE_JWT_SECRET appears to be a placeholder ("${placeholder}" detected). ` +
          "Generate a real secret with: openssl rand -hex 32",
      );
    }
  }
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

// Safety: if Google Play IAP is configured (service account present) in
// production, the unauthenticated /billing/iap/google/notify endpoint becomes
// live — and verifyPubSubPushToken only meaningfully authenticates the Pub/Sub
// sender when GOOGLE_PUBSUB_AUDIENCE or GOOGLE_PUBSUB_SA_EMAIL is set. Without
// either, the floor is "any Google-signed OIDC token", which is too weak to
// gate plan mutations. Fail fast so a prod deploy can't silently run open.
if (
  parsed.NODE_ENV === "production" &&
  parsed.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON &&
  !parsed.GOOGLE_PUBSUB_AUDIENCE &&
  !parsed.GOOGLE_PUBSUB_SA_EMAIL
) {
  throw new Error(
    "Google Play IAP is configured but GOOGLE_PUBSUB_AUDIENCE and GOOGLE_PUBSUB_SA_EMAIL are both unset. " +
      "Set at least one so /billing/iap/google/notify can authenticate the Pub/Sub push sender (FINDINGS C1).",
  );
}

// Resolve API_PUBLIC_URL when unset. In production the API is reachable on
// the APP_URL origin (nginx proxies /api/v1 → :8080 — live-verified); in
// dev/test the API serves directly on localhost:<API_PORT>. Trailing slashes
// are stripped so `${env.API_PUBLIC_URL}/api/v1/...` concatenation is safe.
parsed.API_PUBLIC_URL = (
  parsed.API_PUBLIC_URL ??
  (parsed.NODE_ENV === "production" ? parsed.APP_URL : `http://localhost:${parsed.API_PORT}`)
).replace(/\/+$/, "");

export const env: Env = parsed;
