/**
 * Handoff service (E3 §2.3/§2.5) — the create/claim core of the cross-model
 * handoff ledger, shared by the MANUAL path (`POST /runs/:id/handoff`, T5) and
 * the AUTOMATIC path (executor catch on a marked provider chain-exhaustion, T3
 * §2.3b). One writer, so both surfaces produce identical ledger semantics.
 *
 * Design pins (plan §2.1/§2.3a/§2.5, adversarial B2/B3/B4/B6):
 *
 *   • The ledger is the durable, cross-session takeover record — built on
 *     runs/run_steps FKs, NEVER on packages/memory (F-005). It survives the
 *     process death that erases E2's in-memory circuits/pendingLinks.
 *
 *   • checkpoint lifecycle (§2.3a): for a RUNNING run createHandoff leaves
 *     checkpoint=NULL — the LIVE loop is the single writer and freezes it at
 *     the next turn boundary (claude.ts checkTurnBoundaryInterrupt). For a
 *     non-RUNNING run (FAILED/PAUSED/step boundary) we copy the frozen truth
 *     straight from run_steps.transcript. claim only accepts a FULL checkpoint
 *     (or a 120s-stale row recovered from run_steps.transcript) — that gate is
 *     what stops a second BullMQ job double-executing the step (B2).
 *
 *   • OPEN uniqueness (§2.3a): one OPEN ledger per run. A second create returns
 *     the existing row instead of stacking duplicates — critical because the
 *     auto trigger fires inside the executor catch that may retry.
 *
 *   • error-swallowing writes (B6.2): storeEpisodicMemory / captureGitState /
 *     activity-log / run-event failures are logged and swallowed. On the auto
 *     path the CALLER (executor) additionally swallows a createHandoff throw so
 *     the step's FAILED marking is never blocked (a throw would let BullMQ
 *     attempts:2 re-run the step).
 */

import type { AIProvider, HandoffReason, HandoffLedger } from "@prisma/client";
import { prisma } from "../../lib/db";
import { logger } from "../../lib/logger";
import { publishRunEvent } from "../../lib/runEvents";
import { storeEpisodicMemory } from "@ai-company-os/memory";
import { listTenantProviderLinks, isProviderTripped } from "../../services/provider-chain";
import { LOCAL_PROVIDERS, type AIProviderType } from "../../services/ai-client";
import type { TranscriptCheckpoint } from "../agent/claude";
import { buildContextSummary } from "./handoff-summary";

// Re-exported so existing callers/tests keep importing the mechanical summariser
// from the handoff surface; the implementation now lives in the dependency-light
// handoff-summary module (shared with claude.ts's freeze path — D-015).
export { buildContextSummary } from "./handoff-summary";

/** claim recovers a still-null checkpoint from run_steps.transcript once the
 * ledger is older than this — the "process died before the live loop could
 * freeze it" path (§2.3a-3). Below the threshold a null checkpoint means the
 * live loop is still expected to freeze it → claim 409s (CHECKPOINT_PENDING). */
export const CHECKPOINT_STALE_MS = 120_000;

/** Minimal run shape createHandoff needs — resolved once, reused everywhere. */
interface RunContext {
  runId: string;
  tenantId: string;
  companyId: string;
  status: string;
}

async function loadRunContext(runId: string): Promise<RunContext | null> {
  const run = await prisma.run.findUnique({
    where: { id: runId },
    select: {
      id: true,
      status: true,
      pipeline: { select: { company: { select: { id: true, tenantId: true } } } },
    },
  });
  if (!run) return null;
  return {
    runId: run.id,
    status: run.status,
    tenantId: run.pipeline.company.tenantId,
    companyId: run.pipeline.company.id,
  };
}

/** The interrupted step's live transcript + its stepIndex — the copy source
 * for a non-RUNNING createHandoff and the fromModel probe. Newest RUNNING/
 * PENDING/FAILED step wins (the one a takeover resumes). */
async function loadLatestStep(runId: string): Promise<{
  id: string;
  stepIndex: number;
  transcript: TranscriptCheckpoint | null;
} | null> {
  const step = await prisma.runStep.findFirst({
    where: { runId },
    orderBy: { stepIndex: "desc" },
    select: { id: true, stepIndex: true, transcript: true },
  });
  if (!step) return null;
  return {
    id: step.id,
    stepIndex: step.stepIndex,
    transcript: (step.transcript as unknown as TranscriptCheckpoint | null) ?? null,
  };
}

/**
 * Best-effort git snapshot (§2.4). Reads the company's ACTIVE GITHUB
 * integration and captures open PRs + the default branch position. EVERY error
 * is swallowed → null: a handoff is valid without git awareness (K4). Dynamic
 * imports keep the integrations dep off the hot path and let the executor-catch
 * caller stay dependency-light.
 */
export async function captureGitState(companyId: string): Promise<unknown | null> {
  try {
    const { getActiveIntegration } = await import("../integration/checker");
    const creds = await getActiveIntegration(companyId, "GITHUB");
    if (!creds) return null;

    const pat = creds.personalAccessToken ?? creds.token ?? creds.accessToken;
    const owner = creds.defaultOwner ?? creds.owner;
    const repo = creds.defaultRepo ?? creds.repo;
    if (!pat || !owner || !repo) return null;

    const { listGitHubPRs, getGitHubBranchStatus } = await import("@ai-company-os/integrations");
    const config = { personalAccessToken: pat, defaultOwner: owner };

    const prs = await listGitHubPRs(config, owner, repo, "open").catch(() => []);
    let branch: unknown = undefined;
    const branchName = creds.defaultBranch ?? creds.branch;
    if (branchName) {
      branch = await getGitHubBranchStatus(config, owner, repo, branchName).catch(() => undefined);
    }

    if (prs.length === 0 && !branch) return null;
    return {
      ...(prs.length > 0 ? { openPRs: prs } : {}),
      ...(branch ? { branch } : {}),
      capturedAt: new Date().toISOString(),
    };
  } catch (err) {
    logger.warn(
      { companyId, err: (err as Error).message },
      "captureGitState failed (non-fatal — handoff proceeds with gitState=null)",
    );
    return null;
  }
}

export interface CreateHandoffInput {
  runId: string;
  reason: HandoffReason;
  createdBy?: string; // userId | "system"
  /** Provider/model of the link that left the run — from the ProviderExhausted
   * marker on the auto path, or the run's active config on the manual path. */
  fromProvider: AIProvider;
  fromModel: string;
  /**
   * Freeze the checkpoint from run_steps.transcript NOW instead of leaving it
   * NULL for the live loop to freeze (§2.3b). Set on the AUTOMATIC path: the
   * chain is already exhausted and the loop is DEAD — no live loop will ever
   * reach a turn boundary to freeze it, so a null checkpoint would strand the
   * ledger behind the 120s stale timer. The manual RUNNING path leaves this
   * false: there the live loop is alive and is the single writer (§2.3a-2).
   */
  freezeFromTranscript?: boolean;
}

/**
 * Open (or return the existing OPEN) handoff ledger for a run. Shared by the
 * manual and automatic paths.
 *
 * RUNNING run (manual) → checkpoint LEFT NULL; the live loop freezes it at the
 *                next turn boundary (§2.3a-2). The run is expected to already be
 *                (or about to be) PAUSED by the caller.
 * dead loop (auto) / non-RUNNING → checkpoint COPIED from run_steps.transcript
 *                now (§2.3a-1/§2.3b); if there's no step/transcript it's a
 *                step-boundary handoff ({messages:[]}) — the takeover runs the
 *                next step from scratch.
 */
export async function createHandoff(input: CreateHandoffInput): Promise<HandoffLedger> {
  const ctx = await loadRunContext(input.runId);
  if (!ctx) {
    throw new Error(`createHandoff: run ${input.runId} not found`);
  }

  // OPEN uniqueness (§2.3a): never stack two OPEN ledgers on one run.
  const existing = await prisma.handoffLedger.findFirst({
    where: { runId: input.runId, status: "OPEN" },
  });
  if (existing) return existing;

  const step = await loadLatestStep(input.runId);
  // Leave the checkpoint null ONLY when a LIVE loop can still freeze it: a
  // RUNNING run whose caller did NOT ask us to freeze now (the manual path).
  // On the auto path (freezeFromTranscript) the loop is dead → always copy.
  const isRunning = ctx.status === "RUNNING" && input.freezeFromTranscript !== true;

  // Checkpoint: NULL for a RUNNING run (live loop freezes it), else copy the
  // frozen transcript. A non-RUNNING run with no captured transcript is a
  // step-boundary handoff (empty messages → takeover runs the next step).
  let checkpoint: TranscriptCheckpoint | { messages: []; stepBoundary: true } | null;
  if (isRunning) {
    checkpoint = null;
  } else if (step?.transcript) {
    checkpoint = step.transcript;
  } else {
    checkpoint = { messages: [], stepBoundary: true };
  }

  // Completed-step names for the mechanical summary — cheap, best-effort.
  const completed = await prisma.runStep
    .findMany({
      where: { runId: input.runId, status: "COMPLETED" },
      orderBy: { stepIndex: "asc" },
      select: { name: true },
    })
    .catch(() => [] as Array<{ name: string }>);
  const contextSummary = buildContextSummary(
    completed.map((s) => s.name).filter(Boolean) as string[],
    step?.transcript ?? null,
  );

  const gitState = await captureGitState(ctx.companyId);

  const ledger = await prisma.handoffLedger.create({
    data: {
      tenantId: ctx.tenantId,
      runId: input.runId,
      runStepId: step?.id ?? null,
      stepIndex: step?.stepIndex ?? 0,
      fromProvider: input.fromProvider,
      fromModel: input.fromModel,
      reason: input.reason,
      status: "OPEN",
      checkpoint: (checkpoint ?? undefined) as any,
      gitState: (gitState ?? undefined) as any,
      contextSummary,
      createdBy: input.createdBy ?? "system",
    },
  });

  // Episodic memory — the ONE memory write E3 makes (§2.5, F-005). source=runId
  // ties the record to the run. Fire-and-forget: a memory miss never blocks a
  // handoff (B6.2).
  try {
    await storeEpisodicMemory({
      companyId: ctx.companyId,
      type: "EPISODIC",
      content: `Run handed off from ${input.fromProvider}/${input.fromModel} (${input.reason}). ${contextSummary}`,
      source: input.runId,
      metadata: { handoffId: ledger.id, reason: input.reason },
    });
  } catch (err) {
    logger.warn(
      { runId: input.runId, handoffId: ledger.id, err: (err as Error).message },
      "storeEpisodicMemory failed after handoff create (non-fatal)",
    );
  }

  // Durable audit copy (run events are Redis-only — plan A5).
  try {
    await prisma.activityLog.create({
      data: {
        tenantId: ctx.tenantId,
        actor: input.createdBy ?? "system",
        action: "run.handoff_created",
        resource: "run",
        resourceId: input.runId,
        details: {
          handoffId: ledger.id,
          fromProvider: input.fromProvider,
          reason: input.reason,
          stepIndex: ledger.stepIndex,
        },
      },
    });
  } catch (err) {
    logger.warn(
      { runId: input.runId, handoffId: ledger.id, err: (err as Error).message },
      "handoff_created activity log write failed (non-fatal)",
    );
  }

  await publishRunEvent(input.runId, {
    type: "HANDOFF_CREATED",
    handoffId: ledger.id,
    fromProvider: input.fromProvider,
    reason: input.reason,
    stepIndex: ledger.stepIndex,
  });

  return ledger;
}

export interface ClaimHandoffInput {
  handoffId: string;
  provider: AIProvider;
  model: string;
  baseUrl?: string;
  claimedBy?: string;
}

export class HandoffClaimError extends Error {
  constructor(
    public readonly code: "NOT_FOUND" | "NOT_OPEN" | "CHECKPOINT_PENDING",
    message: string,
  ) {
    super(message);
    this.name = "HandoffClaimError";
  }
}

/**
 * Claim an OPEN handoff for a provider — flips OPEN → CLAIMED and records the
 * target. The re-enqueue itself lives in the caller (T5 continue / approval
 * decide) so this stays a pure ledger transition.
 *
 * Checkpoint gate (§2.3a-3, B2): a null checkpoint younger than
 * CHECKPOINT_STALE_MS means the live loop hasn't frozen it yet → 409
 * CHECKPOINT_PENDING (the client retries). Past the threshold we recover the
 * checkpoint from run_steps.transcript — the "process died before freezing"
 * path. A full checkpoint claims immediately.
 */
export async function claimHandoff(input: ClaimHandoffInput): Promise<HandoffLedger> {
  const ledger = await prisma.handoffLedger.findUnique({ where: { id: input.handoffId } });
  if (!ledger) throw new HandoffClaimError("NOT_FOUND", "Handoff not found");
  if (ledger.status !== "OPEN") {
    throw new HandoffClaimError("NOT_OPEN", `Handoff is ${ledger.status}, not claimable`);
  }

  // The checkpoint we'll carry the claim's baseUrl on (§2.5/T6). Starts as the
  // ledger's current checkpoint; the stale path overwrites it with a recovered
  // copy below.
  let checkpointForClaim = ledger.checkpoint as unknown as Record<string, unknown> | null;

  // Checkpoint readiness (B2 gate).
  if (ledger.checkpoint === null) {
    const age = Date.now() - ledger.createdAt.getTime();
    if (age < CHECKPOINT_STALE_MS) {
      throw new HandoffClaimError(
        "CHECKPOINT_PENDING",
        "Checkpoint not frozen yet — the live loop hasn't reached a turn boundary. Retry shortly.",
      );
    }
    // Stale recovery: freeze from the step's last turn-end checkpoint.
    const step = ledger.runStepId
      ? await prisma.runStep.findUnique({
          where: { id: ledger.runStepId },
          select: { transcript: true },
        })
      : null;
    const recovered = (step?.transcript as unknown as TranscriptCheckpoint | null) ?? {
      messages: [],
      stepBoundary: true,
    };
    checkpointForClaim = recovered as unknown as Record<string, unknown>;
    await prisma.handoffLedger.update({
      where: { id: ledger.id },
      data: { checkpoint: recovered as any },
    });
    logger.warn(
      { handoffId: ledger.id, ageMs: age },
      "handoff checkpoint recovered from run_steps.transcript (stale path — live loop never froze it)",
    );
  }

  // Persist the takeover baseUrl for the resume leg (§2.5/T6 — B4c). The ledger
  // has no dedicated column (single-migration invariant), so it rides on the
  // checkpoint JSON as `claimBaseUrl` — a claim-time annotation, not part of the
  // frozen transcript truth. Only written when a baseUrl was supplied (keyless-
  // local takeovers); cloud providers dial their default endpoint.
  const claimCheckpoint =
    input.baseUrl && checkpointForClaim
      ? { ...checkpointForClaim, claimBaseUrl: input.baseUrl }
      : undefined;

  const claimed = await prisma.handoffLedger.update({
    where: { id: ledger.id },
    data: {
      status: "CLAIMED",
      toProvider: input.provider,
      toModel: input.model,
      claimedBy: input.claimedBy ?? "system",
      claimedAt: new Date(),
      ...(claimCheckpoint ? { checkpoint: claimCheckpoint as any } : {}),
    },
  });

  try {
    await prisma.activityLog.create({
      data: {
        tenantId: ledger.tenantId,
        actor: input.claimedBy ?? "system",
        action: "run.handoff_claimed",
        resource: "run",
        resourceId: ledger.runId,
        details: { handoffId: ledger.id, toProvider: input.provider, toModel: input.model },
      },
    });
  } catch (err) {
    logger.warn(
      { runId: ledger.runId, handoffId: ledger.id, err: (err as Error).message },
      "handoff_claimed activity log write failed (non-fatal)",
    );
  }

  await publishRunEvent(ledger.runId, {
    type: "HANDOFF_CLAIMED",
    handoffId: ledger.id,
    toProvider: input.provider,
  });

  return claimed;
}

/**
 * Resolve a VIABLE automatic-handoff target for a tenant (§2.5/B4a). Viable =
 * a configured BYOK link whose provider differs from the one that just died AND
 * whose circuit breaker isn't tripped. Returns null when no such link exists —
 * the caller then opens the ledger WITHOUT an Approval (the operator picks a
 * provider from web/CLI; a binary mobile APPROVE can't carry a provider param).
 */
export async function resolveViableHandoffTarget(
  tenantId: string,
  fromProvider: AIProvider,
): Promise<{ provider: AIProviderType; model: string } | null> {
  let links;
  try {
    links = await listTenantProviderLinks(tenantId);
  } catch {
    return null;
  }
  const target = links.find(
    (l) => l.provider !== fromProvider && !isProviderTripped(tenantId, l.provider),
  );
  if (!target) return null;
  return { provider: target.provider, model: target.config.model };
}

/** Whether a provider is a keyless local endpoint — used by the claim/continue
 * layer (T5/T6) to enforce the prod baseUrl rule (B4c). Re-exported here so the
 * handoff surface has one import point. */
export function isKeylessLocalProvider(provider: AIProviderType): boolean {
  return LOCAL_PROVIDERS.has(provider);
}

/**
 * Cancel a run's OPEN handoff ledger (§2.5 rerun guard — B6.3). A rerun resets
 * the step the ledger was frozen against, so a stale OPEN ledger must not stay
 * claimable. CLAIMED ledgers are the caller's problem (a takeover is already in
 * flight — the caller 409s instead of calling this). Idempotent: no OPEN ledger
 * → no-op. Best-effort audit; the CANCELLED transition itself must succeed.
 */
export async function cancelOpenHandoffForRun(
  runId: string,
  reason: string,
  actor: string,
): Promise<boolean> {
  const open = await prisma.handoffLedger.findFirst({
    where: { runId, status: "OPEN" },
    select: { id: true, tenantId: true },
  });
  if (!open) return false;

  await prisma.handoffLedger.update({
    where: { id: open.id },
    data: { status: "CANCELLED", completedAt: new Date() },
  });

  try {
    await prisma.activityLog.create({
      data: {
        tenantId: open.tenantId,
        actor,
        action: "run.handoff_cancelled",
        resource: "run",
        resourceId: runId,
        details: { handoffId: open.id, reason },
      },
    });
  } catch (err) {
    logger.warn(
      { runId, handoffId: open.id, err: (err as Error).message },
      "handoff_cancelled activity log write failed (non-fatal)",
    );
  }
  return true;
}
