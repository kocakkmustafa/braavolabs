import { Router } from "express";
import { authMiddleware } from "../../middleware/auth";
import { prisma } from "../../lib/db";
import { AppError } from "../../middleware/error";
import { rateLimit } from "../../middleware/rateLimit";
import { logger } from "../../lib/logger";
import { redis } from "../../lib/redis";
import { runEventChannel, getBufferedRunEvents } from "../../lib/runEvents";
import { enqueueRun } from "../pipeline/runner";
import { chatCompletion, getTenantAIConfig, LOCAL_PROVIDERS, type AIProviderType } from "../../services/ai-client";
import { listTenantProviderLinks } from "../../services/provider-chain";
import { createHandoff, claimHandoff, HandoffClaimError, cancelOpenHandoffForRun } from "./handoff.service";
import { env } from "../../config/env";
import type { RunEvent } from "@ai-company-os/core";

export const runRouter = Router();
runRouter.use(authMiddleware);

// "Explain this failure" calls the tenant's own LLM — throttle per-tenant so a
// rage-click on the Explain button can't rack up provider cost.
const explainLimiter = rateLimit({ windowMs: 60_000, maxRequests: 10, keyPrefix: "rl:run:explain" });

// Handoff create/continue can enqueue a run — throttle per-tenant so a
// mis-scripted client can't stack ledgers/jobs (same shape as explainLimiter).
const handoffLimiter = rateLimit({ windowMs: 60_000, maxRequests: 30, keyPrefix: "rl:run:handoff" });

/**
 * Validate a takeover target (§2.5 — B4c). The requested provider must be one
 * the tenant CONFIGURED (a BYOK link) or a keyless-local provider (Ollama / LM
 * Studio / Custom). Enforces the prod baseUrl rule: in production (and not
 * OFFLINE_MODE) a keyless-local takeover MUST carry an explicit baseUrl —
 * PROVIDER_BASE_URLS' localhost default points at Lightsail's OWN localhost and
 * would break the orchestration-only invariant. Throws AppError(400) on any
 * violation; returns nothing on success.
 */
async function assertValidTakeoverTarget(
  tenantId: string,
  provider: AIProviderType,
  baseUrl: string | undefined,
): Promise<void> {
  const isLocal = LOCAL_PROVIDERS.has(provider);

  if (isLocal) {
    // B4c: prod keyless-local devir MUST carry a baseUrl — the localhost
    // default is Lightsail's own loopback (orchestration-only violation).
    const prodLike = env.NODE_ENV === "production" && env.OFFLINE_MODE !== true;
    if (prodLike && (!baseUrl || !baseUrl.trim())) {
      throw new AppError(
        400,
        "A base URL is required to hand off to a self-hosted provider in production (the server won't fall back to its own localhost).",
      );
    }
    return; // keyless-local is always a valid target shape
  }

  // Cloud provider: must be a link the tenant actually configured.
  const links = await listTenantProviderLinks(tenantId);
  if (!links.some((l) => l.provider === provider)) {
    throw new AppError(
      400,
      `Provider ${provider} is not configured for this workspace. Add it in Settings → AI Provider, or hand off to a self-hosted provider with a base URL.`,
    );
  }
}

// GET /api/v1/runs/:id — run detail with steps and tool calls
runRouter.get("/:id", async (req, res, next) => {
  try {
    const run = await prisma.run.findUnique({
      where: { id: req.params.id },
      include: {
        steps: {
          include: { toolCalls: true },
          orderBy: { stepIndex: "asc" },
        },
        pipeline: { include: { company: true } },
        approvals: true,
      },
    });
    if (!run || run.pipeline.company.tenantId !== req.auth!.tenantId) {
      throw new AppError(404, "Run not found");
    }
    res.json(run);
  } catch (err) { next(err); }
});

// POST /api/v1/runs/:id/explain — AI-generated plain-language explanation of a
// FAILED run. Calls the tenant's own configured LLM (their key, low risk —
// we're explaining an error, not routing customer data) and returns a short
// explanation + a one-line suggested fix.
//
// The UI labels the result as an "AI explanation" — it's a best-effort
// interpretation of the error string, not a guarantee.
runRouter.post("/:id/explain", explainLimiter, async (req, res, next) => {
  try {
    const runIdParam = req.params.id as string;
    // Tenant-scope via relation traversal (same lightweight pattern as the
    // /steer route). Kept include-free on purpose: a second rich-`include`
    // findUnique in this file pushes Prisma's generated overload union past
    // TS's complexity limit and collapses inference. The failed step is
    // fetched separately below.
    const run = await prisma.run.findFirst({
      where: { id: runIdParam, pipeline: { company: { tenantId: req.auth!.tenantId } } },
    });
    if (!run) {
      throw new AppError(404, "Run not found");
    }
    if (run.status !== "FAILED") {
      throw new AppError(400, "Only failed runs can be explained.");
    }

    // The error usually lives on the run; the failed step (if any) gives the
    // model extra context (which step, and why the agent was doing it).
    const failedStep = await prisma.runStep.findFirst({
      where: { runId: run.id, status: "FAILED" },
      orderBy: { stepIndex: "asc" },
    });
    const errorText = (run.error ?? failedStep?.error ?? "").trim();
    if (!errorText) {
      throw new AppError(400, "This run has no recorded error to explain.");
    }

    // Load the tenant's AI config. If none is configured (and no system key),
    // return a friendly 400 instead of a 500 — the feature is optional.
    let aiConfig;
    try {
      aiConfig = await getTenantAIConfig(req.auth!.tenantId);
    } catch {
      throw new AppError(
        400,
        "No AI provider configured. Add one in Settings → AI Provider to use AI explanations.",
      );
    }

    const systemPrompt =
      "You are a senior automation engineer helping a non-technical operator " +
      "understand why their AI workflow run failed. Be concise, calm, and plain-spoken. " +
      "Respond ONLY with a compact JSON object, no markdown, exactly this shape:\n" +
      '{ "explanation": "2-3 short sentences in plain language explaining what went wrong", ' +
      '"suggestedFix": "one short actionable sentence" }';

    const userMessage =
      `A workflow run failed.\n` +
      (failedStep?.name ? `Failed step: ${failedStep.name}\n` : "") +
      (failedStep?.reasoning ? `Step reasoning: ${failedStep.reasoning.slice(0, 800)}\n` : "") +
      `Error message:\n${errorText.slice(0, 1500)}\n\n` +
      `Explain this in plain language and suggest one fix.`;

    let result;
    try {
      result = await chatCompletion(
        aiConfig,
        systemPrompt,
        [{ role: "user", content: userMessage }],
        512,
      );
    } catch (err) {
      logger.warn(
        { runId: run.id, tenantId: req.auth!.tenantId, err: (err as Error).message },
        "run explain LLM call failed",
      );
      throw new AppError(502, "Couldn't reach your AI provider to generate an explanation. Try again shortly.");
    }

    // Parse the JSON the model returned; tolerate markdown fences and fall back
    // to using the raw text as the explanation if it isn't valid JSON.
    let explanation = "";
    let suggestedFix = "";
    try {
      const cleaned = result.content.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      const parsed = JSON.parse(cleaned) as { explanation?: string; suggestedFix?: string };
      explanation = (parsed.explanation ?? "").trim();
      suggestedFix = (parsed.suggestedFix ?? "").trim();
    } catch {
      explanation = result.content.trim().slice(0, 600);
    }
    if (!explanation) {
      explanation = result.content.trim().slice(0, 600) || "The AI could not produce an explanation for this error.";
    }

    await prisma.activityLog.create({
      data: {
        tenantId: req.auth!.tenantId,
        actor: req.auth!.userId,
        action: "run.explain",
        resource: "run",
        resourceId: run.id,
        details: { provider: result.provider, model: result.model },
      },
    });

    res.json({
      explanation,
      suggestedFix,
      provider: result.provider,
      model: result.model,
      generatedByAi: true,
    });
  } catch (err) { next(err); }
});

// POST /api/v1/runs/:id/stop
runRouter.post("/:id/stop", async (req, res, next) => {
  try {
    const run = await prisma.run.findUnique({
      where: { id: req.params.id },
      include: { pipeline: { include: { company: true } } },
    });
    if (!run || run.pipeline.company.tenantId !== req.auth!.tenantId) {
      throw new AppError(404, "Run not found");
    }
    if (run.status !== "RUNNING" && run.status !== "PAUSED" && run.status !== "WAITING_APPROVAL") {
      throw new AppError(400, "Run is not in a stoppable state");
    }

    await prisma.run.update({
      where: { id: run.id },
      data: { status: "CANCELLED", completedAt: new Date() },
    });

    await prisma.activityLog.create({
      data: {
        tenantId: req.auth!.tenantId,
        actor: req.auth!.userId,
        action: "run.stop",
        resource: "run",
        resourceId: run.id,
      },
    });

    res.json({ success: true, status: "CANCELLED" });
  } catch (err) { next(err); }
});

// POST /api/v1/runs/:id/pause
runRouter.post("/:id/pause", async (req, res, next) => {
  try {
    const run = await prisma.run.findUnique({
      where: { id: req.params.id },
      include: { pipeline: { include: { company: true } } },
    });
    if (!run || run.pipeline.company.tenantId !== req.auth!.tenantId) {
      throw new AppError(404, "Run not found");
    }

    await prisma.run.update({
      where: { id: run.id },
      data: { status: "PAUSED" },
    });

    res.json({ success: true, status: "PAUSED" });
  } catch (err) { next(err); }
});

// POST /api/v1/runs/:id/resume
//
// Resume must do two things: flip status back to RUNNING AND re-enqueue
// the BullMQ job. Without the re-enqueue the run sits in RUNNING forever
// because the worker that exited on PAUSED never picks it back up. Note
// that the runner currently restarts from step group 0 on a new job
// pickup — fully step-cursor-aware resumption is on the roadmap. The
// trade-off (replay a few steps vs. permanent stuck-RUNNING) is
// preferable, and the runner's per-step idempotency keys avoid duplicate
// side effects on most replayable steps.
runRouter.post("/:id/resume", async (req, res, next) => {
  try {
    const run = await prisma.run.findUnique({
      where: { id: req.params.id },
      include: { pipeline: { include: { company: true } } },
    });
    if (!run || run.pipeline.company.tenantId !== req.auth!.tenantId) {
      throw new AppError(404, "Run not found");
    }
    if (run.status !== "PAUSED" && run.status !== "WAITING_APPROVAL") {
      throw new AppError(400, "Run is not paused or waiting on approval");
    }

    await prisma.run.update({
      where: { id: run.id },
      data: { status: "RUNNING" },
    });

    await enqueueRun(run.id);

    await prisma.activityLog.create({
      data: {
        tenantId: req.auth!.tenantId,
        actor: req.auth!.userId,
        action: "run.resume",
        resource: "run",
        resourceId: run.id,
      },
    });

    res.json({ success: true, status: "RUNNING" });
  } catch (err) { next(err); }
});

// ─── Cross-model handoff (E3/T5, plan §2.3a/§2.5) ─────────

// POST /api/v1/runs/:id/handoff — request a manual handoff (§2.3a-1).
//
// RUNNING run → flip to PAUSED and open an OPEN ledger with checkpoint=NULL;
// the live agent loop freezes the checkpoint at its next turn boundary
// (claude.ts checkTurnBoundaryInterrupt) and exits gracefully. NON-RUNNING
// run (PAUSED/WAITING_APPROVAL/FAILED) → the ledger copies the frozen
// transcript from run_steps.transcript immediately (no live loop to wait on).
// Either way the operator then calls /continue to pick the takeover provider.
runRouter.post("/:id/handoff", handoffLimiter, async (req, res, next) => {
  try {
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim().slice(0, 500) : undefined;

    // Tenant-scope via relation traversal (same lightweight pattern as /steer)
    // — kept include-free so we resolve the active provider/model separately.
    const run = await prisma.run.findFirst({
      where: { id: req.params.id as string, pipeline: { company: { tenantId: req.auth!.tenantId } } },
    });
    if (!run) throw new AppError(404, "Run not found");
    if (!["RUNNING", "PAUSED", "WAITING_APPROVAL", "FAILED"].includes(run.status)) {
      throw new AppError(400, "Run is not in a handoff-able state (already finished or cancelled).");
    }

    // The provider/model that's leaving the run — the run's default AI config.
    // Best-effort: if none resolves we record UNKNOWN rather than block the
    // handoff (the takeover is what matters; fromProvider is audit context).
    let fromProvider: AIProviderType = "ANTHROPIC";
    let fromModel = "unknown";
    try {
      const cfg = await getTenantAIConfig(req.auth!.tenantId);
      fromProvider = cfg.provider;
      fromModel = cfg.model;
    } catch {
      /* leave the audit default — handoff proceeds */
    }

    // Order matters (§2.3a-1/-2): for a RUNNING run we open the ledger FIRST
    // (checkpoint=NULL) while the run is still RUNNING, so createHandoff's
    // isRunning check leaves the checkpoint to the live loop. THEN we PAUSE.
    // The loop's turn-boundary check keys on the OPEN ledger (not status), so
    // it freezes the true checkpoint at the next boundary and exits via
    // HandoffInterrupt. Doing it the other way (PAUSE first) would make
    // createHandoff see a PAUSED run and copy a possibly-stale transcript,
    // racing the live loop's authoritative freeze.
    //
    // For a non-RUNNING run there's no live loop: freezeFromTranscript copies
    // the frozen transcript straight from run_steps.transcript now.
    const wasRunning = run.status === "RUNNING";
    const ledger = await createHandoff({
      runId: run.id,
      reason: "MANUAL",
      createdBy: req.auth!.userId,
      fromProvider,
      fromModel,
      freezeFromTranscript: !wasRunning,
    });

    if (wasRunning) {
      await prisma.run.update({ where: { id: run.id }, data: { status: "PAUSED" } });
    }

    await prisma.activityLog.create({
      data: {
        tenantId: req.auth!.tenantId,
        actor: req.auth!.userId,
        action: "run.handoff_requested",
        resource: "run",
        resourceId: run.id,
        details: { handoffId: ledger.id, reason, fromStatus: run.status },
      },
    }).catch(() => { /* audit best-effort */ });

    res.status(201).json({
      success: true,
      handoffId: ledger.id,
      status: wasRunning ? "PAUSED" : run.status,
      checkpointPending: ledger.checkpoint === null,
    });
  } catch (err) { next(err); }
});

// POST /api/v1/runs/:id/continue — claim the run's OPEN handoff for a provider
// and re-enqueue (§2.5). Body: { provider, model?, baseUrl? }.
//
// Gates, in order: tenant-scope (404) → an OPEN ledger exists (400) → the
// target is valid (400: unconfigured cloud provider, or prod keyless-local
// without a baseUrl) → the checkpoint is frozen (claimHandoff 409
// CHECKPOINT_PENDING if the live loop hasn't reached a turn boundary yet; past
// the 120s stale threshold it recovers from run_steps.transcript). On success:
// ledger CLAIMED, run RUNNING, job enqueued — the takeover leg (T6) resumes
// from the checkpoint.
runRouter.post("/:id/continue", handoffLimiter, async (req, res, next) => {
  try {
    const provider = String(req.body?.provider ?? "").trim().toUpperCase() as AIProviderType;
    const model = typeof req.body?.model === "string" ? req.body.model.trim() : "";
    const baseUrl = typeof req.body?.baseUrl === "string" ? req.body.baseUrl.trim() : undefined;

    const VALID_PROVIDERS: AIProviderType[] = [
      "ANTHROPIC", "OPENAI", "GOOGLE", "MISTRAL", "GROQ", "OPENROUTER",
      "DEEPSEEK", "KIMI", "QWEN", "OLLAMA", "LMSTUDIO", "CUSTOM",
    ];
    if (!VALID_PROVIDERS.includes(provider)) {
      throw new AppError(400, `Invalid provider: ${provider || "(empty)"}`);
    }

    const run = await prisma.run.findFirst({
      where: { id: req.params.id as string, pipeline: { company: { tenantId: req.auth!.tenantId } } },
    });
    if (!run) throw new AppError(404, "Run not found");

    const ledger = await prisma.handoffLedger.findFirst({
      where: { runId: run.id, status: "OPEN" },
    });
    if (!ledger) {
      throw new AppError(400, "No open handoff to continue. Request a handoff first.");
    }

    // Target validity (B4c) — before we claim, so a bad target 400s cleanly
    // without touching the ledger.
    await assertValidTakeoverTarget(req.auth!.tenantId, provider, baseUrl);

    // Resolve the model: caller override → ledger's fromModel is NOT reused
    // (different provider) → provider default. Keep it a real string so the
    // takeover config always has a model.
    const { PROVIDER_DEFAULT_MODELS } = await import("../../services/ai-client");
    const resolvedModel = model || PROVIDER_DEFAULT_MODELS[provider];

    // Claim — 409 CHECKPOINT_PENDING while the live loop hasn't frozen the
    // checkpoint (client retries). We persist baseUrl for the takeover leg (T6)
    // by writing it into the ledger's checkpoint-adjacent claim fields via the
    // service; the service records toProvider/toModel, and the takeover reads
    // baseUrl from here.
    let claimed;
    try {
      claimed = await claimHandoff({
        handoffId: ledger.id,
        provider,
        model: resolvedModel,
        baseUrl,
        claimedBy: req.auth!.userId,
      });
    } catch (err) {
      if (err instanceof HandoffClaimError && err.code === "CHECKPOINT_PENDING") {
        throw new AppError(409, err.message);
      }
      throw err;
    }

    await prisma.run.update({ where: { id: run.id }, data: { status: "RUNNING" } });
    await enqueueRun(run.id);

    res.json({
      success: true,
      handoffId: claimed.id,
      status: "RUNNING",
      toProvider: provider,
      toModel: resolvedModel,
    });
  } catch (err) { next(err); }
});

// GET /api/v1/runs/:id/handoffs — this run's handoff ledger history, newest
// first (§2.6). Powers the HandoffPanel timeline; tolerant of the
// stepIndex-per-multiple-rows reality (B6.5) — it's a flat ledger list.
runRouter.get("/:id/handoffs", async (req, res, next) => {
  try {
    const run = await prisma.run.findFirst({
      where: { id: req.params.id, pipeline: { company: { tenantId: req.auth!.tenantId } } },
      select: { id: true },
    });
    if (!run) throw new AppError(404, "Run not found");

    const ledgers = await prisma.handoffLedger.findMany({
      where: { runId: run.id },
      orderBy: { createdAt: "desc" },
      select: {
        id: true, runId: true, stepIndex: true, status: true, reason: true,
        fromProvider: true, fromModel: true, toProvider: true, toModel: true,
        contextSummary: true, gitState: true, createdBy: true, claimedBy: true,
        createdAt: true, claimedAt: true, completedAt: true,
        // checkpoint deliberately omitted — it can be large and is not needed
        // for the timeline. The takeover leg reads it server-side.
      },
    });
    res.json({ handoffs: ledgers });
  } catch (err) { next(err); }
});

// POST /api/v1/runs/:id/steer — queue an operator steering message for a live
// run. The agent loop drains it at the top of its next turn and injects it as
// guidance (Phase 1 HITL — "steer a running agent"). Does not pause the run.
runRouter.post("/:id/steer", async (req, res, next) => {
  try {
    const content = typeof req.body?.content === "string" ? req.body.content.trim() : "";
    const targetAgentId = typeof req.body?.targetAgentId === "string" ? req.body.targetAgentId : null;
    if (!content) throw new AppError(400, "content is required");

    const run = await prisma.run.findFirst({
      where: { id: req.params.id, pipeline: { company: { tenantId: req.auth!.tenantId } } },
    });
    if (!run) throw new AppError(404, "Run not found");
    if (!["PENDING", "RUNNING", "PAUSED", "WAITING_APPROVAL"].includes(run.status)) {
      throw new AppError(400, "Run is not steerable (already finished)");
    }

    const msg = await prisma.steeringMessage.create({
      data: {
        runId: run.id,
        kind: "STEER",
        content: content.slice(0, 4000),
        targetAgentId,
        createdBy: req.auth!.userId,
      },
    });

    await prisma.activityLog.create({
      data: {
        tenantId: req.auth!.tenantId,
        actor: req.auth!.userId,
        action: "run.steer",
        resource: "run",
        resourceId: run.id,
        details: { steeringMessageId: msg.id, targetAgentId },
      },
    });

    res.status(201).json({ success: true, id: msg.id });
  } catch (err) { next(err); }
});

// GET /api/v1/runs/:id/stream — real-time SSE stream (Redis pub/sub).
//
// Replaces the former 3s Postgres polling. Subscribes to the per-run event
// channel and replays the buffered backlog after Last-Event-ID so a
// reconnecting client misses nothing. Events follow the shared RunEvent
// contract from @ai-company-os/core (same shape mobile + CLI consume).
//
// Auth: router-level authMiddleware sets req.auth. Browsers can't set the
// Authorization header on EventSource, so the UI consumes this via a
// fetch + ReadableStream reader (which can send Bearer) rather than
// `new EventSource()`.
runRouter.get("/:id/stream", async (req, res) => {
  const run = await prisma.run
    .findFirst({ where: { id: req.params.id, pipeline: { company: { tenantId: req.auth!.tenantId } } } })
    .catch(() => null);
  if (!run) return res.status(404).json({ error: "Run not found" });
  const runId = run.id;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  if (typeof (res as any).flushHeaders === "function") (res as any).flushHeaders();

  const lastEventId = Number(req.headers["last-event-id"] ?? req.query.lastEventId ?? 0) || 0;
  let closed = false;
  let maxSeqWritten = lastEventId;
  const sub = redis.duplicate();

  function cleanup() {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    sub.removeAllListeners("message");
    sub.unsubscribe(runEventChannel(runId)).catch(() => {});
    sub.quit().catch(() => {});
    try { res.end(); } catch { /* already ended */ }
  }

  const write = (ev: RunEvent) => {
    if (closed || ev.seq <= maxSeqWritten) return;
    maxSeqWritten = ev.seq;
    res.write(`id: ${ev.seq}\ndata: ${JSON.stringify(ev)}\n\n`);
    if (ev.type === "RUN_COMPLETED" || ev.type === "RUN_FAILED") {
      res.write("event: done\ndata: {}\n\n");
      cleanup();
    }
  };

  // Subscribe FIRST and buffer live messages until the backlog is flushed —
  // avoids both gaps (events published mid-fetch) and duplicates.
  const pending: RunEvent[] = [];
  let backlogFlushed = false;
  sub.on("message", (_ch: string, msg: string) => {
    try {
      const ev = JSON.parse(msg) as RunEvent;
      if (backlogFlushed) write(ev);
      else pending.push(ev);
    } catch {
      /* ignore malformed */
    }
  });

  // nginx/CDNs idle-timeout silent connections; a comment line every 25s
  // keeps the socket alive (": " prefix = ignored per the EventSource spec).
  const heartbeat = setInterval(() => {
    if (closed) return;
    try { res.write(`: keepalive ${Date.now()}\n\n`); } catch { cleanup(); }
  }, 25_000);

  req.on("close", cleanup);

  try {
    await sub.subscribe(runEventChannel(runId));
    for (const ev of await getBufferedRunEvents(runId, lastEventId)) write(ev);
    backlogFlushed = true;
    for (const ev of pending.splice(0)) write(ev);

    // Already-terminal run with nothing more coming → close after replay.
    if (!closed && (run.status === "COMPLETED" || run.status === "FAILED" || run.status === "CANCELLED")) {
      res.write("event: done\ndata: {}\n\n");
      cleanup();
    }
  } catch (err) {
    logger.warn({ runId, err: (err as Error).message }, "run stream subscribe failed");
    cleanup();
  }
});

// POST /api/v1/run-steps/:id/rollback
runRouter.post("/steps/:id/rollback", async (req, res, next) => {
  try {
    const step = await prisma.runStep.findUnique({
      where: { id: req.params.id },
      include: { run: { include: { pipeline: { include: { company: true } } } } },
    });
    if (!step || step.run.pipeline.company.tenantId !== req.auth!.tenantId) {
      throw new AppError(404, "Run step not found");
    }

    await prisma.runStep.update({
      where: { id: step.id },
      data: { status: "ROLLED_BACK" },
    });

    await prisma.activityLog.create({
      data: {
        tenantId: req.auth!.tenantId,
        actor: req.auth!.userId,
        action: "run_step.rollback",
        resource: "run_step",
        resourceId: step.id,
        details: { runId: step.runId },
      },
    });

    res.json({ success: true, status: "ROLLED_BACK" });
  } catch (err) { next(err); }
});

// POST /api/v1/run-steps/:id/rerun — re-execute a failed/rolled-back step
runRouter.post("/steps/:id/rerun", async (req, res, next) => {
  try {
    const step = await prisma.runStep.findUnique({
      where: { id: req.params.id },
      include: { run: { include: { pipeline: { include: { company: true } } } } },
    });
    if (!step || step.run.pipeline.company.tenantId !== req.auth!.tenantId) {
      throw new AppError(404, "Run step not found");
    }
    if (step.status !== "FAILED" && step.status !== "ROLLED_BACK") {
      throw new AppError(400, "Only FAILED or ROLLED_BACK steps can be rerun");
    }

    // E3/T5 rerun × handoff guard (B6.3). A rerun resets this step — so a
    // handoff frozen against it must not stay live. A CLAIMED ledger means a
    // takeover is already resuming this run: refuse the rerun (409). An OPEN
    // ledger is stale once we rerun: cancel it so it can't be claimed against a
    // reset step.
    const relatedHandoff = await prisma.handoffLedger.findFirst({
      where: { runId: step.runId, status: { in: ["OPEN", "CLAIMED"] } },
      select: { id: true, status: true },
    });
    if (relatedHandoff?.status === "CLAIMED") {
      throw new AppError(409, "A handoff is already resuming this run — cancel or complete it before rerunning the step.");
    }
    if (relatedHandoff?.status === "OPEN") {
      await cancelOpenHandoffForRun(step.runId, "rerun", req.auth!.userId);
    }

    // Reset step status to RUNNING
    await prisma.runStep.update({
      where: { id: step.id },
      data: {
        status: "RUNNING",
        error: null,
        startedAt: new Date(),
        completedAt: null,
      },
    });

    // Import and execute the step
    const { executeStep } = await import("../pipeline/executor");
    const stepDef = {
      name: step.name,
      agentRole: step.name, // Will be resolved from pipeline steps
      order: step.stepIndex,
    };

    // Get the pipeline step definition for agentRole
    const pipeline = step.run.pipeline;
    const pipelineSteps = pipeline.steps as Array<{ name: string; agentRole: string; order: number }>;
    const matchingStep = pipelineSteps.find((s) => s.name === step.name || s.order === step.stepIndex);
    if (matchingStep) {
      stepDef.agentRole = matchingStep.agentRole;
    }

    const result = await executeStep(
      step.runId,
      stepDef,
      step.stepIndex,
      step.input,
    );

    await prisma.activityLog.create({
      data: {
        tenantId: req.auth!.tenantId,
        actor: req.auth!.userId,
        action: "run_step.rerun",
        resource: "run_step",
        resourceId: step.id,
        details: { runId: step.runId, result: result.status },
      },
    });

    res.json(result);
  } catch (err) { next(err); }
});
