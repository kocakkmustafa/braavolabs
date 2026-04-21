// OpenTelemetry must be initialized before other imports
import { initTelemetry, shutdownTelemetry } from "./lib/telemetry";
initTelemetry();

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
import { governanceRouter } from "./modules/governance/router";
import { onboardingRouter } from "./modules/onboarding/router";
import { growthRouter } from "./modules/growth/router";
import { authRouter } from "./modules/auth/auth.router";
import { exportRouter } from "./modules/export/router";
import { integrationRouter } from "./modules/integration/router";
import { settingsRouter } from "./modules/settings/router";
import { agentVersionRouter } from "./modules/agent/version-router";
import { collaborationRouter } from "./modules/collaboration/router";
import { abTestRouter } from "./modules/ab-test/router";
import { initPipelineRunner, initScheduledPipelines, stopScheduledPipelines } from "./modules/pipeline/runner";
import { initOutreachWorker } from "./modules/outreach/sequence-runner";
import { initConsolidationCron, stopConsolidationCron } from "./modules/memory/consolidation-cron";

// Import tool registry to trigger tool registration on startup
import "./modules/agent/registry";

const app = express();

// Trust first proxy (Nginx / Cloudflare) so that req.ip returns the real
// client IP rather than the proxy's IP. Critical for rate limiting
// (otherwise all traffic shares one bucket) and audit log accuracy.
// Set to the number of trusted reverse proxies in front of this app.
// In dev: no proxy, trust nothing. In prod: 1 (Nginx). If using Cloudflare
// in front of Nginx, bump to 2.
app.set("trust proxy", env.NODE_ENV === "production" ? 1 : false);

// Global middleware
app.use(requestId);
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
      },
    },
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  }),
);
app.use(securityHeaders);
app.use(
  cors({
    origin: env.NODE_ENV === "production"
      ? [env.APP_URL]
      : [env.APP_URL, "http://localhost:3000", "http://localhost:3001"],
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    maxAge: 86400, // Cache preflight for 24 hours
  }),
);
app.use(compression());
// JSON body limit tightened to 1mb — typical API payloads are <100KB.
// Larger-than-necessary limit is a DoS vector (memory exhaustion via oversized POSTs).
// Webhook handlers that need raw body use their own `raw({ type: "application/json" })`
// BEFORE this global json parser (Stripe webhook mounted before authed routes).
app.use(express.json({ limit: "1mb" }));
app.use(pinoHttp({
  logger,
  // Redact sensitive fields from request/response logs (defense-in-depth).
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "req.headers['x-api-key']",
      "req.body.password",
      "req.body.passwordHash",
      "req.body.encryptedApiKey",
      "req.body.credentials",
      "req.body.apiKey",
    ],
    censor: "[REDACTED]",
  },
}));

// Health check
app.get("/health", async (_req, res) => {
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
  res.status(healthy ? 200 : 503).json({
    status: healthy ? "ok" : "degraded",
    checks,
    timestamp: new Date().toISOString(),
    version: "0.1.0",
  });
});

// API routes
const api = express.Router();
api.use("/auth", authRouter);
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
api.use("/governance", governanceRouter);
api.use("/onboarding", onboardingRouter);
api.use("/growth", growthRouter);
api.use("/export", exportRouter);
api.use("/integrations", integrationRouter);
api.use("/settings", settingsRouter);
api.use("/agents", agentVersionRouter);
api.use("/ab-tests", abTestRouter);
api.use("/collaboration", collaborationRouter);
api.use("/webhooks", webhookTemplateRouter);

app.use("/api/v1", api);

// Webhook routes (outside versioned API)
app.use("/hooks", webhookRouter);
app.use("/hooks", stripeWebhookRouter);

// Error handler (must be last)
app.use(errorHandler);

app.listen(env.API_PORT, env.API_HOST, () => {
  logger.info(`AI Company OS API running on ${env.API_HOST}:${env.API_PORT}`);

  // Initialize pipeline runner (BullMQ worker)
  initPipelineRunner();

  // Initialize scheduled pipeline crons
  initScheduledPipelines();

  // Initialize outreach sequence worker
  initOutreachWorker();

  // Initialize memory consolidation cron (daily)
  initConsolidationCron();
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
