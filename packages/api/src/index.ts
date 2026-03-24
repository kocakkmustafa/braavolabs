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

app.use("/api/v1", api);

// Webhook routes (outside versioned API)
app.use("/hooks", webhookRouter);

// Error handler (must be last)
app.use(errorHandler);

app.listen(env.API_PORT, env.API_HOST, () => {
  logger.info(`AI Company OS API running on ${env.API_HOST}:${env.API_PORT}`);

  // Initialize pipeline runner (BullMQ worker)
  initPipelineRunner();
});

export default app;
