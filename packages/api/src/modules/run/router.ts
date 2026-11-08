import { Router } from "express";
import { authMiddleware } from "../../middleware/auth";
import { prisma, tenantTx } from "../../lib/db";
import { AppError } from "../../middleware/error";
import { rateLimit } from "../../middleware/rateLimit";
import { logger } from "../../lib/logger";
import { redis } from "../../lib/redis";
import { runEventChannel, getBufferedRunEvents } from "../../lib/runEvents";
import { enqueueRun } from "../pipeline/runner";
import { chatCompletion, getTenantAIConfig, LOCAL_PROVIDERS, type AIProviderType } from "../../services/ai-client";
// D-013: resolveTenantCompletionLink is used ONLY for the /:id/explain
// single-completion call below — it honors the same D-009 policy the run
// loop does (BYOK → counted trial → opt-in/PAID system → honest error). The
// /:id/handoff route's getTenantAIConfig call is a best-effort AUDIT lookup
// (records fromProvider on the ledger, never dials the LLM) and stays on the
// plain getTenantAIConfig import.
import { listTenantProviderLinks, resolveTenantCompletionLink, commitTrialCompletion, refundTrialCompletion } from "../../services/provider-chain";
import { assertKeylessLocalBaseUrl } from "../../services/takeover-config";
import { createHandoff, claimHandoff, HandoffClaimError, cancelOpenHandoffForRun, reopenClaimedHandoff } from "./handoff.service";
import { hasOpenApproval } from "../approval/exact-action";
import { transitionRun, isJobStateDualWriteEnabled, currentJobState } from "./transition";
import { assertTransitioned, resumeToRunning, AlreadyRunningError, revertRunAfterEnqueueFailure } from "./resume";
import { decideResume, type JobState } from "./job-state";
import { env } from "../../config/env";
import { toPublicCompany } from "../company/redact";
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
    // default is Lightsail's own loopback (orchestration-only violation). The
    // rule lives in ONE place (takeover-config) so the claim boundary here and
    // the resume boundary (T6) enforce it identically; translate its throw into
    // the HTTP 400 this endpoint contracts.
    try {
      assertKeylessLocalBaseUrl(provider, baseUrl);
    } catch (err) {
      throw new AppError(400, (err as Error).message);
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
    // BRA-SEC-01: tenant check above used the raw row; strip company secrets from the response.
    res.json({ ...run, pipeline: { ...run.pipeline, company: toPublicCompany(run.pipeline.company) } });
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

    // Resolve the tenant's D-009 chain head (BYOK → counted trial → opt-in/
    // PAID system → honest error). If NOTHING may serve (BYOK-less FREE with a
    // spent trial, unusable-key tenant that never opted into system fallback,
    // etc.) return a friendly 400 instead of a 500 — the feature is optional,
    // and a keyless tenant never silently reaches the shared system key here.
    let link;
    try {
      link = await resolveTenantCompletionLink(req.auth!.tenantId);
    } catch {
      throw new AppError(
        400,
        "No AI provider configured. Add one in Settings → AI Provider to use AI explanations.",
      );
    }
    const aiConfig = link.config;

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
      // Refund an unused hosted-trial cost reservation before rethrowing —
      // symmetric with the commit below (exactly one of the two must fire).
      await refundTrialCompletion(req.auth!.tenantId, link.source);
      throw new AppError(502, "Couldn't reach your AI provider to generate an explanation. Try again shortly.");
    }
    // Count the trial slot only after a successful serve (D-009/D-013 parity).
    await commitTrialCompletion(req.auth!.tenantId, link.source, result);

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
    // ADR-0001 table: with JOB_STATE_DUAL_WRITE on, a not-yet-started (PENDING)
    // run can be cancelled too; off, PENDING is still a 400 as before.
    const stoppable =
      run.status === "RUNNING" || run.status === "PAUSED" || run.status === "WAITING_APPROVAL" ||
      (run.status === "PENDING" && isJobStateDualWriteEnabled());
    if (!stoppable) {
      throw new AppError(400, "Run is not in a stoppable state");
    }

    await tenantTx(async (tx) => {
      const o = await transitionRun(tx, run.id, "CANCELLED", {
        tenantId: req.auth!.tenantId,
        extra: { completedAt: new Date() },
        legacyUnchecked: true,
      });
      assertTransitioned(o, { status: 400, message: "Run is not in a stoppable state" });
      if (o.ok && o.noop) return;
      await tx.activityLog.create({
        data: {
          tenantId: req.auth!.tenantId,
          actor: req.auth!.userId,
          action: "run.stop",
          resource: "run",
          resourceId: run.id,
        },
      });
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

    // Off: unconditional status write as before. On: a finished run
    // (COMPLETED/FAILED/CANCELLED) is refused with 409 (ADR-0001 table).
    await tenantTx(async (tx) => {
      const o = await transitionRun(tx, run.id, "PAUSED", { tenantId: req.auth!.tenantId, legacyUnchecked: true });
      assertTransitioned(o, { status: 409, message: "Run is finished and cannot be paused" });
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
    // BRA-P0-05 bypass guard: resume must never stand in for the decision. An
    // undecided approval is answered via POST /approvals/:id/decide, which
    // needs approval:decide (fail-closed, also for not-yet-expired-by-cron rows).
    if (await hasOpenApproval(prisma, run.id)) {
      throw new AppError(409, "Run has an undecided approval; decide it via /approvals/:id/decide");
    }

    let startedFrom: JobState = "PAUSED";
    try {
      await tenantTx(async (tx) => {
        startedFrom = (await resumeToRunning(tx, run.id, req.auth!.tenantId, { rejectIfAlreadyRunning: true })).from;
        await tx.activityLog.create({
          data: {
            tenantId: req.auth!.tenantId,
            actor: req.auth!.userId,
            action: "run.resume",
            resource: "run",
            resourceId: run.id,
          },
        });
      });
    } catch (err) {
      // Duplicate resume that lost to a concurrent one: same answer as the
      // up-front status check gives a duplicate today (400), nothing written/enqueued.
      if (err instanceof AlreadyRunningError) throw new AppError(400, "Run is not paused or waiting on approval");
      throw err;
    }

    // Only after the CAS won (a lost race threw above): exactly one enqueue. If
    // it fails the run is already committed RUNNING with no job (and /resume would
    // answer 400): put it back where this request found it, but only while the run
    // is still RUNNING (never revives a run /stop, completion or failure moved on).
    try {
      await enqueueRun(run.id);
    } catch (err) {
      await tenantTx((tx) => revertRunAfterEnqueueFailure(tx, run.id, req.auth!.tenantId, startedFrom)).catch(() => undefined);
      throw err;
    }

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
      try {
        await tenantTx(async (tx) => {
          const o = await transitionRun(tx, run.id, "PAUSED", { tenantId: req.auth!.tenantId, legacyUnchecked: true });
          assertTransitioned(o, { status: 409, message: "Run is no longer running; handoff not started" });
        });
      } catch (err) {
        // The run moved under us (finished / paused by someone else): the OPEN
        // ledger just created must not outlive a handoff that did not start.
        await cancelOpenHandoffForRun(run.id, "pause lost race", req.auth!.userId).catch(() => { /* best-effort */ });
        throw err;
      }
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

    // BRA-P0-05 bypass guard: /handoff + /continue must not flip a run to
    // RUNNING while an approval it is waiting on is still undecided. Checked
    // BEFORE any claim/ledger write so a refusal has no side effect.
    if (await hasOpenApproval(prisma, run.id)) {
      throw new AppError(409, "Run has an undecided approval; decide it via /approvals/:id/decide");
    }

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

    // JOB_STATE_DUAL_WRITE on: decide from the state machine BEFORE claiming, so a
    // finished run is refused (409) with the ledger untouched, and a run that is
    // already RUNNING/RESUMING is "already": claimed as before but NOT enqueued a
    // second time (ADR-0001 table). Off: no state check, legacy behaviour.
    // This up-front read is only a cheap early refusal and may be stale: the
    // binding decision ("already" / illegal) is taken from the in-tx fresh read.
    const dual = isJobStateDualWriteEnabled();
    if (dual) {
      const cur: JobState = currentJobState(run.status, run.state);
      if (decideResume(cur, "retry") === "reject") throw new AppError(409, "Run cannot be continued from its current state");
    }

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
      if (err instanceof HandoffClaimError && (err.code === "CHECKPOINT_PENDING" || err.code === "NOT_OPEN")) {
        // CHECKPOINT_PENDING: client retries. NOT_OPEN: a concurrent /continue
        // claimed it first (the up-front OPEN lookup passed, the atomic claim lost).
        throw new AppError(409, err.message);
      }
      throw err;
    }

    let alreadyRunning = false;
    let startedFrom: JobState = "PAUSED";
    try {
      startedFrom = (await tenantTx((tx) => resumeToRunning(tx, run.id, req.auth!.tenantId, { rejectIfAlreadyRunning: dual }))).from;
    } catch (err) {
      if (err instanceof AlreadyRunningError) {
        alreadyRunning = true; // dual write on only: claimed as before, no second enqueue
      } else {
        // The run did not start (lost CAS / finished meanwhile): give the ledger
        // back so the operator can retry /continue instead of "No open handoff".
        await reopenClaimedHandoff(claimed.id, claimed.claimedAt as Date).catch((e) =>
          logger.warn({ runId: run.id, handoffId: claimed.id, err: (e as Error).message }, "handoff reopen after lost /continue failed"));
        throw err;
      }
    }
    // BRA-P0-02c-3 (flag on): the takeover is done, so a still-PENDING HANDOFF
    // proposal for this run is obsolete — close it (REJECTED by "system:continue";
    // the enum has no CANCELLED and 02c adds no migration). Otherwise a later
    // `decide` on it would act on a run that is already running. Best-effort:
    // `decide`'s run-state guard covers the gap if this write fails.
    if (dual) {
      await tenantTx(async (tx) => {
        const open = (await tx.approval.findMany({
          where: { runId: run.id, type: "HANDOFF", status: "PENDING" },
          select: { id: true },
        })) as Array<{ id: string }>;
        for (const a of open) {
          const closed = await tx.approval.updateMany({
            where: { id: a.id, status: "PENDING" },
            data: { status: "REJECTED", decidedBy: "system:continue", decidedAt: new Date() },
          });
          if (closed.count !== 1) continue;
          // Rule #9: the system decision is logged like approval.rejected / approval.expired.
          await tx.activityLog.create({
            data: {
              tenantId: req.auth!.tenantId,
              actor: req.auth!.userId,
              action: "approval.closed_by_continue",
              resource: "approval",
              resourceId: a.id,
              details: { runId: run.id, handoffId: claimed.id },
            },
          });
        }
      }).catch((e) =>
        logger.warn({ runId: run.id, err: (e as Error).message }, "close pending HANDOFF approval after /continue failed"));
    }

    if (!alreadyRunning) {
      try {
        await enqueueRun(run.id);
      } catch (err) {
        // 02c-3: the run was committed RUNNING and the ledger CLAIMED; without a job
        // neither can be recovered by /resume or /continue. Put the run back to where
        // THIS request found it (only while it is still RUNNING and only if our own
        // transition started it) and, ONLY if that happened, give the ledger back by
        // our own claim token. A run that was already RUNNING / moved on is left alone.
        const reverted = await tenantTx((tx) => revertRunAfterEnqueueFailure(tx, run.id, req.auth!.tenantId, startedFrom)).catch(() => false);
        if (reverted) {
          await reopenClaimedHandoff(claimed.id, claimed.claimedAt as Date).catch((e) =>
            logger.warn({ runId: run.id, handoffId: claimed.id, err: (e as Error).message }, "handoff reopen after enqueue failure failed"));
        }
        throw err;
      }
    }

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
// channel and replays the capped backlog after Last-Event-ID. Long gaps can
// require a fresh run snapshot; replay is not an unlimited delivery ledger.
// Events follow the shared RunEvent
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
  let maxSeqAccepted = lastEventId;
  let backpressured = false;
  let endRequested = false;
  let drainDeadline: ReturnType<typeof setTimeout> | undefined;
  const sub = redis.duplicate();
  const MAX_PENDING_EVENTS = 250; // same event-count bound as Redis replay
  const MAX_PENDING_BYTES = 1024 * 1024;
  const DRAIN_TIMEOUT_MS = 10_000;
  const outgoing: string[] = [];
  let outgoingBytes = 0;
  const pending: RunEvent[] = [];
  let pendingBytes = 0;

  function cleanup(disconnect = false) {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    clearTimeout(drainDeadline);
    res.removeListener("drain", onDrain);
    res.removeListener("close", onClientClose);
    res.removeListener("error", onClientClose);
    req.removeListener("close", onClientClose);
    outgoing.length = 0;
    pending.length = 0;
    outgoingBytes = pendingBytes = 0;
    sub.removeAllListeners("message");
    sub.unsubscribe(runEventChannel(runId)).catch(() => {});
    sub.quit().catch(() => {});
    try {
      if (disconnect) res.destroy();
      else res.end();
    } catch { /* already ended */ }
  }

  function onClientClose() { cleanup(true); }

  function requestEnd() {
    endRequested = true;
    if (!backpressured && outgoing.length === 0) cleanup();
  }

  function sendFrame(frame: string): boolean {
    try {
      // false means this frame was accepted, but later writes must await drain.
      // It is normal for a healthy frame larger than the writable high-water mark.
      if (res.write(frame) === false) {
        backpressured = true;
        res.once("drain", onDrain);
        drainDeadline = setTimeout(() => cleanup(true), DRAIN_TIMEOUT_MS);
      }
      return true;
    } catch {
      cleanup(true);
      return false;
    }
  }

  function onDrain() {
    if (closed) return;
    clearTimeout(drainDeadline);
    drainDeadline = undefined;
    backpressured = false;
    while (!closed && !backpressured && outgoing.length > 0) {
      const frame = outgoing.shift()!;
      outgoingBytes -= Buffer.byteLength(frame, "utf8");
      sendFrame(frame);
    }
    if (!closed && endRequested && !backpressured && outgoing.length === 0) cleanup();
  }

  // Keep only a bounded application queue while the response drains. The
  // response may also retain its one accepted frame; this is not a total RSS
  // cap. On overflow/deadline, reconnect uses the client's last parsed SSE id.
  const writeFrame = (frame: string): boolean => {
    if (closed) return false;
    if (backpressured) {
      const bytes = Buffer.byteLength(frame, "utf8");
      if (outgoing.length >= MAX_PENDING_EVENTS || outgoingBytes + bytes > MAX_PENDING_BYTES) {
        cleanup(true);
        return false;
      }
      outgoing.push(frame);
      outgoingBytes += bytes;
      return true;
    }
    return sendFrame(frame);
  };
  const write = (ev: RunEvent) => {
    if (closed || endRequested || ev.seq <= maxSeqAccepted) return;
    if (!writeFrame(`id: ${ev.seq}\ndata: ${JSON.stringify(ev)}\n\n`)) return;
    maxSeqAccepted = ev.seq;
    if (ev.type === "RUN_COMPLETED" || ev.type === "RUN_FAILED") {
      writeFrame("event: done\ndata: {}\n\n");
      requestEnd();
    }
  };

  // Subscribe FIRST and buffer live messages until the backlog is flushed —
  // avoids both gaps (events published mid-fetch) and duplicates.
  let backlogFlushed = false;
  sub.on("message", (_ch: string, msg: string) => {
    if (closed || endRequested) return;
    try {
      if (!backlogFlushed && (pending.length >= MAX_PENDING_EVENTS ||
        pendingBytes + Buffer.byteLength(msg, "utf8") > MAX_PENDING_BYTES)) {
        cleanup(true);
        return;
      }
      const ev = JSON.parse(msg) as RunEvent;
      if (backlogFlushed) write(ev);
      else {
        pending.push(ev);
        pendingBytes += Buffer.byteLength(msg, "utf8");
      }
    } catch {
      /* ignore malformed */
    }
  });

  // nginx/CDNs idle-timeout silent connections; a comment line every 25s
  // keeps the socket alive (": " prefix = ignored per the EventSource spec).
  const heartbeat = setInterval(() => {
    if (closed || endRequested || backpressured) return;
    writeFrame(`: keepalive ${Date.now()}\n\n`);
  }, 25_000);

  req.once("close", onClientClose);
  res.once("close", onClientClose);
  res.once("error", onClientClose);

  try {
    await sub.subscribe(runEventChannel(runId));
    for (const ev of await getBufferedRunEvents(runId, lastEventId)) write(ev);
    backlogFlushed = true;
    for (const ev of pending.splice(0)) write(ev);
    pendingBytes = 0;

    // Already-terminal run with nothing more coming → close after replay.
    if (!closed && !endRequested && (run.status === "COMPLETED" || run.status === "FAILED" || run.status === "CANCELLED")) {
      writeFrame("event: done\ndata: {}\n\n");
      requestEnd();
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
