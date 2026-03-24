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
import { errorHandler } from "./middleware/error";
import { companyRouter } from "./modules/company/router";
import { pipelineRouter } from "./modules/pipeline/router";
import { runRouter } from "./modules/run/router";
import { approvalRouter } from "./modules/approval/router";
import { memoryRouter } from "./modules/memory/router";
import { draftRouter } from "./modules/draft/router";
import { dashboardRouter } from "./modules/dashboard/router";
import { crmRouter } from "./modules/crm/router";
import { outreachRouter } from "./modules/outreach/router";
import { webhookRouter } from "./modules/webhook/router";
import { billingRouter, stripeWebhookRouter } from "./modules/billing/router";
import { governanceRouter } from "./modules/governance/router";
import { onboardingRouter } from "./modules/onboarding/router";
import { initPipelineRunner } from "./modules/pipeline/runner";

// Import tool registry to trigger tool registration on startup
import "./modules/agent/registry";

const app = express();

// Global middleware
app.use(helmet());
app.use(cors());
app.use(compression());
app.use(express.json({ limit: "10mb" }));
app.use(pinoHttp({ logger }));

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// API routes
const api = express.Router();
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
});

// Graceful shutdown
process.on("SIGTERM", async () => {
  logger.info("SIGTERM received — shutting down");
  await shutdownTelemetry();
  process.exit(0);
});

export default app;
