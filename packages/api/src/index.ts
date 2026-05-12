// Sentry + OpenTelemetry must be initialized before other imports — both
// patch the http/express modules at load time. Sentry first so unhandled
// errors during telemetry init are captured too.
import { initSentry, sentryRequestHandler, sentryErrorHandler, captureException } from "./lib/sentry";
initSentry();

import { initTelemetry, shutdownTelemetry } from "./lib/telemetry";
initTelemetry();

import crypto from "node:crypto";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import pinoHttp from "pino-http";
import { env } from "./config/env";
import { logger } from "./lib/logger";
import { prisma } from "./lib/db";
import { redis } from "./lib/redis";
import { errorHandler } from "./middleware/error";
import { securityHeaders } from "./middleware/security";
import { requestId } from "./middleware/requestId";
import { companyRouter } from "./modules/company/router";
import { pipelineRouter } from "./modules/pipeline/router";
import { runRouter } from "./modules/run/router";
import { approvalRouter } from "./modules/approval/router";
import { memoryRouter } from "./modules/memory/router";
import { draftRouter } from "./modules/draft/router";
import { dashboardRouter } from "./modules/dashboard/router";
import { crmRouter } from "./modules/crm/router";
import { outreachRouter } from "./modules/outreach/router";
import { webhookRouter, webhookTemplateRouter } from "./modules/webhook/router";
import { billingRouter, stripeWebhookRouter } from "./modules/billing/router";
import { iapRouter } from "./modules/billing/iap/router";
import { automationImporterRouter } from "./modules/automation-importer/router";
import { governanceRouter } from "./modules/governance/router";
import { onboardingRouter } from "./modules/onboarding/router";
import { growthRouter } from "./modules/growth/router";
import { authRouter } from "./modules/auth/auth.router";
import { userRouter } from "./modules/user/user.router";
import { deviceRouter } from "./modules/device/router";
import { exportRouter } from "./modules/export/router";
import { licenseRouter } from "./modules/license/license.router";
import { starterRouter } from "./modules/starter/starter.router";
import { integrationRouter } from "./modules/integration/router";
import { settingsRouter } from "./modules/settings/router";
import { agentVersionRouter } from "./modules/agent/version-router";
import { collaborationRouter } from "./modules/collaboration/router";
import { abTestRouter } from "./modules/ab-test/router";
import { initPipelineRunner, initScheduledPipelines, stopScheduledPipelines } from "./modules/pipeline/runner";
import { initOutreachWorker } from "./modules/outreach/sequence-runner";
import { initConsolidationCron, stopConsolidationCron } from "./modules/memory/consolidation-cron";
import { initApprovalExpiryCron, stopApprovalExpiryCron } from "./modules/approval/expiry-cron";

// Import tool registry to trigger tool registration on startup
import "./modules/agent/registry";

const app = express();

// Trust N reverse proxies so that req.ip resolves to the true client IP
// rather than the proxy's IP — critical for rate limiting (otherwise
// all traffic shares one bucket) and audit log accuracy.
//
//   dev (no proxy):                TRUST_PROXY_HOPS=0
//   prod with nginx only:          TRUST_PROXY_HOPS=1
//   prod with Cloudflare + nginx:  TRUST_PROXY_HOPS=2
//
// MISCONFIGURATION RISK: setting hops higher than reality lets a client
// inject arbitrary X-Forwarded-For headers and spoof their IP. Setting
// it lower than reality collapses the rate-limit bucket onto the proxy
// IP. Both fail open in different directions; the env knob makes the
// cutover atomic with the DNS swap to Cloudflare.
const trustProxyHops = env.NODE_ENV === "production" ? env.TRUST_PROXY_HOPS : 0;
app.set("trust proxy", trustProxyHops);

// Global middleware
app.use(requestId);
// Sentry request scope — sets requestId/path tags so captured exceptions
// downstream can be filtered. No-op when SENTRY_DSN unset.
app.use(sentryRequestHandler);
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'", env.APP_URL],
        // MED-3 fix: explicit frame-ancestors. X-Frame-Options DENY is
        // already set by securityHeaders middleware, but modern browsers
        // honor frame-ancestors over X-Frame-Options when both are
        // present. "none" forbids any embedding — defense against
        // clickjacking on the API origin.
        frameAncestors: ["'none'"],
      },
    },
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  }),
);
app.use(securityHeaders);
// CORS allowlist — APP_URL plus any extra origins listed in
// ALLOWED_ORIGINS (comma-separated). Lets the user add `app.braavolabs.com`
// or `staging.braavolabs.com` without a code change when the custom-
// domain split lands. Dev mode keeps localhost:3000/:3001 unconditionally.
const extraOrigins = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const corsOrigins = env.NODE_ENV === "production"
  ? [env.APP_URL, ...extraOrigins]
  : [env.APP_URL, "http://localhost:3000", "http://localhost:3001", ...extraOrigins];
app.use(
  cors({
    origin: corsOrigins,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    maxAge: 86400, // Cache preflight for 24 hours
  }),
);
app.use(compression());
app.use(pinoHttp({
  logger,
  // Redact sensitive fields from request/response logs (defense-in-depth).
  // Covers credentials (auth headers, passwords, API keys, tokens) AND
  // PII (email, name, phone) — pino-http logs full request bodies on
  // errors and 4xx responses, so an unsanitized log stream would leak
  // both auth material and personal data into Loki/Cloudwatch (a GDPR/
  // KVKK problem on its own, even before the auth-leak risk).
  redact: {
    paths: [
      // Headers — both names + array-indexed access for the proxy paths
      // pino-http sometimes uses.
      "req.headers.authorization",
      "req.headers.cookie",
      "req.headers['x-api-key']",
      "req.headers['x-health-probe-key']",
      "req.headers['stripe-signature']",
      "req.headers['x-webhook-signature']",
      "res.headers['set-cookie']",
      // Direct secret-carrying body fields.
      "req.body.password",
      "req.body.passwordHash",
      "req.body.token",
      "req.body.refreshToken",
      "req.body.accessToken",
      "req.body.apiKey",
      "req.body.encryptedApiKey",
      "req.body.receipt",
      // Wildcard-style globs catch *any* nested field whose key encodes
      // a secret — pino's redact accepts the `*` glob inside paths. The
      // earlier hand-rolled allowlist (req.body.user.email, contact.email
      // …) drifted out of sync every time a new endpoint added a sub-
      // object; the wildcards stay correct as the surface grows.
      "req.body.*.password",
      "req.body.*.passwordHash",
      "req.body.*.token",
      "req.body.*.refreshToken",
      "req.body.*.apiKey",
      "req.body.*.encryptedApiKey",
      "req.body.*.receipt",
      "req.body.*.email",
      "req.body.*.name",
      "req.body.*.phone",
      // Credentials JSON blobs from integration save / settings save.
      "req.body.credentials",
      "req.body.credentials.*",
      "req.body.config",
      "req.body.config.*",
      // PII at the top level.
      "req.body.email",
      "req.body.name",
      "req.body.phone",
      // Query strings can carry secrets (one-time tokens, OAuth state /
      // exchange codes, reset tokens). Redact wholesale rather than
      // allowlist — easier to keep tight as routes grow.
      "req.query.token",
      "req.query.code",
      "req.query.state",
      "req.query.refreshToken",
      "req.query.accessToken",
      "req.query.apiKey",
    ],
    censor: "[REDACTED]",
  },
}));

// Webhook routers MUST be mounted BEFORE the global JSON parser. They sign
// the raw request bytes; once express.json() consumes the stream, route-
// level express.raw() can no longer recover it and signature verification
// fails. pinoHttp is mounted above so HTTP access logs still cover them.
app.use("/hooks", stripeWebhookRouter);
// Generic external webhook router — uses raw body + per-company HMAC for
// signature verification (key/whitespace mutations on a parsed body would
// otherwise allow an attacker to mutate a captured signed payload).
app.use("/hooks", webhookRouter);

// JSON body limit tightened to 1mb — typical API payloads are <100KB.
// Larger-than-necessary limit is a DoS vector (memory exhaustion via oversized POSTs).
app.use(express.json({ limit: "1mb" }));

// Health check — exposed at BOTH /health (Docker healthcheck, k8s liveness)
// and /api/v1/health (UptimeRobot, BetterStack, anything that probes the
// canonical API path). Same handler, two routes — cheap to ship, expensive
// to forget when an external monitor expects /api/v1/health and silently
// false-pages.
async function healthHandler(req: express.Request, res: express.Response) {
  const checks: Record<string, string> = {};

  // Check database
  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = "ok";
  } catch {
    checks.database = "error";
  }

  // Check Redis
  try {
    await redis.ping();
    checks.redis = "ok";
  } catch {
    checks.redis = "error";
  }

  const healthy = Object.values(checks).every((v) => v === "ok");

  // Don't leak per-dependency state to unauthenticated callers. The
  // monitoring system (UptimeRobot, BetterStack, k8s liveness) only
  // needs the rollup; an attacker probing /health to figure out which
  // backing service is broken should see the same thing as the
  // monitoring system does. An operator with a probe header drilled in
  // via env (HEALTH_PROBE_KEY) sees the full breakdown.
  const probeKey = process.env.HEALTH_PROBE_KEY;
  const presentedKey = req.headers["x-health-probe-key"];
  const trusted =
    !!probeKey &&
    typeof presentedKey === "string" &&
    presentedKey.length === probeKey.length &&
    crypto.timingSafeEqual(Buffer.from(presentedKey), Buffer.from(probeKey));

  res.status(healthy ? 200 : 503).json({
    status: healthy ? "ok" : "degraded",
    ...(trusted ? { checks } : {}),
    timestamp: new Date().toISOString(),
    version: "0.1.0",
  });
}

app.get("/health", healthHandler);

// API routes
const api = express.Router();
// /api/v1/health alias (same handler as /health) for external probes.
api.get("/health", healthHandler);
api.use("/auth", authRouter);
api.use("/users", userRouter);
api.use("/devices", deviceRouter);
api.use("/companies", companyRouter);
api.use("/pipelines", pipelineRouter);
api.use("/runs", runRouter);
api.use("/approvals", approvalRouter);
api.use("/memory", memoryRouter);
api.use("/drafts", draftRouter);
api.use("/dashboard", dashboardRouter);
api.use("/crm", crmRouter);
api.use("/outreach", outreachRouter);
api.use("/billing", billingRouter);
// Mobile IAP entitlement bridge — mounted under /billing/iap so the path
// stays clearly under "billing" but lives in its own module to avoid
// piling Apple/Google verification logic into the Stripe-centric router.
api.use("/billing/iap", iapRouter);
api.use("/governance", governanceRouter);
api.use("/onboarding", onboardingRouter);
api.use("/growth", growthRouter);
api.use("/export", exportRouter);
api.use("/license", licenseRouter);
api.use("/starters", starterRouter);
api.use("/integrations", integrationRouter);
api.use("/settings", settingsRouter);
api.use("/agents", agentVersionRouter);
api.use("/ab-tests", abTestRouter);
api.use("/collaboration", collaborationRouter);
api.use("/webhooks", webhookTemplateRouter);
api.use("/automation-imports", automationImporterRouter);

app.use("/api/v1", api);

// Error handler (must be last)
// Sentry error handler runs BEFORE the app's error handler so it captures
// the exception with full request context. The app's handler still owns
// the response shape sent to the client.
app.use(sentryErrorHandler);
app.use(errorHandler);

app.listen(env.API_PORT, env.API_HOST, () => {
  logger.info(`Braavolabs API running on ${env.API_HOST}:${env.API_PORT}`);

  // Initialize pipeline runner (BullMQ worker)
  initPipelineRunner();

  // Initialize scheduled pipeline crons
  initScheduledPipelines();

  // Initialize outreach sequence worker
  initOutreachWorker();

  // Initialize memory consolidation cron (daily)
  initConsolidationCron();

  // Initialize approval expiry cron (hourly, 24h TTL — auto-rejects
  // forgotten pending approvals so their runs don't permanently hold
  // a slot in the tenant's monthly quota)
  initApprovalExpiryCron();
});

// Process-wide error handlers — Sentry's express middleware only catches
// errors that flow through the request pipeline; BullMQ workers, cron
// callbacks, and bare `setInterval` tasks throw outside that path. These
// handlers ensure those errors land in Sentry too. uncaughtException is
// a "process is in a bad state" signal — log it and exit so the container
// orchestrator restarts us into a clean process.
process.on("unhandledRejection", (reason: unknown) => {
  logger.error({ err: reason }, "Unhandled promise rejection");
  try { captureException(reason, { source: "unhandledRejection" }); } catch { /* swallow */ }
});

process.on("uncaughtException", (err: Error) => {
  logger.fatal({ err }, "Uncaught exception — exiting");
  try { captureException(err, { source: "uncaughtException" }); } catch { /* swallow */ }
  // Give Sentry/Pino a brief window to flush before the kernel kills us.
  setTimeout(() => process.exit(1), 1000).unref();
});

// Graceful shutdown
process.on("SIGTERM", async () => {
  logger.info("SIGTERM received — shutting down gracefully");

  // Force exit after 30s if graceful shutdown hangs
  const forceTimeout = setTimeout(() => {
    logger.error("Forced shutdown after 30 seconds");
    process.exit(1);
  }, 30_000);
  forceTimeout.unref();

  stopScheduledPipelines();
  stopConsolidationCron();
  stopApprovalExpiryCron();

  // Close Redis
  try { await redis.quit(); } catch (e) { logger.warn({ err: e }, "Redis close failed during shutdown"); }

  // Disconnect Prisma
  try { await prisma.$disconnect(); } catch (e) { logger.warn({ err: e }, "Prisma disconnect failed during shutdown"); }

  await shutdownTelemetry();
  process.exit(0);
});

process.on("SIGINT", async () => {
  logger.info("SIGINT received — shutting down");
  process.emit("SIGTERM" as any);
});

export default app;
