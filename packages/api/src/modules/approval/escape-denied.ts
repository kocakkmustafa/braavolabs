/**
 * BRA-P2-02c — SANDBOX_ESCAPE denial (human REJECT and the 24h expiry cron share this).
 *
 * Tells the agent once per approval (SteeringMessage INPUT carrying the approval id,
 * de-duplicated on unconsumed messages) and resumes the run ONLY when it is really
 * WAITING_APPROVAL and no other gating approval is open. The transition is pinned with
 * `onlyIfStatus`, so a CANCELLED/COMPLETED/FAILED/PAUSED run is never revived (also with
 * JOB_STATE_DUAL_WRITE off, where `legacyUnchecked` would otherwise skip the state graph).
 * A finished run gets no message (nobody would read it). Returns whether the caller must
 * enqueue (exactly once, after commit when inside a transaction).
 */
import { AppError } from "../../middleware/error";
import { transitionRun, isJobStateDualWriteEnabled, currentJobState, type RunTransitionClient } from "../run/transition";
import { assertTransitioned } from "../run/resume";
import type { JobState } from "../run/job-state";
import { sandboxEscapeDeniedMessage } from "./sandbox-escape";

/** A transaction client or the plain prisma client (cron). */
export type EscapeDeniedClient = RunTransitionClient & {
  approval: { findFirst(args: any): PromiseLike<{ id: string } | null> }; // eslint-disable-line @typescript-eslint/no-explicit-any
  steeringMessage: {
    findFirst(args: any): PromiseLike<{ id: string } | null>; // eslint-disable-line @typescript-eslint/no-explicit-any
    create(args: any): PromiseLike<unknown>; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
};

type LegacyStatus = Parameters<typeof currentJobState>[0];

export async function resumeAfterEscapeDenied(
  client: unknown,
  approvalId: string,
  runId: string,
  tenantId: string,
  userId: string,
  metadata: unknown,
): Promise<{ enqueue: boolean; from: JobState }> {
  const tx = client as EscapeDeniedClient & { $queryRaw?: (...a: any[]) => PromiseLike<unknown> }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const row = (await tx.run.findFirst({
    where: { id: runId, pipeline: { company: { tenantId } } },
    select: { status: true },
  })) as { status: string } | null;
  if (!row) throw new AppError(404, "Run not found");
  const unchanged = { enqueue: false, from: currentJobState(row.status as LegacyStatus, null) };
  if (row.status === "COMPLETED" || row.status === "FAILED" || row.status === "CANCELLED") return unchanged;

  const content = sandboxEscapeDeniedMessage(metadata, approvalId);
  const dup = await tx.steeringMessage.findFirst({
    where: { runId, kind: "INPUT", content, consumedAt: null },
    select: { id: true },
  });
  if (!dup) {
    await tx.steeringMessage.create({ data: { runId, kind: "INPUT", content, createdBy: userId } });
  }
  if (row.status !== "WAITING_APPROVAL") return unchanged;

  if (typeof tx.$queryRaw === "function") {
    await (tx as unknown as { $queryRaw: (s: TemplateStringsArray, ...v: unknown[]) => PromiseLike<unknown> }).$queryRaw`SELECT id FROM runs WHERE id = ${runId} FOR UPDATE`;
  }
  const otherGate = await tx.approval.findFirst({
    where: { runId, id: { not: approvalId }, status: "PENDING", type: { not: "HANDOFF" } },
    select: { id: true },
  });
  if (otherGate) return { enqueue: false, from: "NEEDS_APPROVAL" };
  const first = await transitionRun(tx, runId, "RESUMING", { tenantId, legacyUnchecked: true, onlyIfStatus: ["WAITING_APPROVAL"] });
  if (!first.ok) {
    if (first.reason === "not_found") throw new AppError(404, "Run not found");
    return { enqueue: false, from: "NEEDS_APPROVAL" };
  }
  if (isJobStateDualWriteEnabled()) {
    assertTransitioned(await transitionRun(tx, runId, "RUNNING", { tenantId }), { status: 409, message: "Run cannot be resumed from its current state" });
  }
  return { enqueue: true, from: first.from };
}
