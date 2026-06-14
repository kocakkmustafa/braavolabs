import { Router } from "express";
import { authMiddleware } from "../../middleware/auth";
import { prisma } from "../../lib/db";
import { AppError } from "../../middleware/error";
import { enqueueRun } from "../pipeline/runner";
import { z } from "zod";
import {
  type ApprovalArtifact,
  extractArtifactFromInput,
  artifactFromDraft,
} from "./artifact";

export const approvalRouter = Router();
approvalRouter.use(authMiddleware);

/**
 * Feature D5: attach the reviewable draft/content artifact to each approval so
 * the queue card can show the actual work product (email subject+body, post
 * text) instead of a one-line description. Spend-only approvals (ad_spend) get
 * `artifact: null` and render exactly as before.
 *
 * Resolution order, cheapest first:
 *   1. The pending tool input (`metadata.input`) — the content the agent is
 *      asking to act on, already tenant-scoped via the approval lookup.
 *   2. The `drafts` table — if the run that owns this approval produced drafts,
 *      surface the most recent one (tenant-scoped through the run's company).
 */
async function attachArtifacts<T extends { id: string; runId: string; metadata: unknown }>(
  approvals: T[],
): Promise<Array<T & { artifact: ApprovalArtifact | null }>> {
  // First pass: try the tool input — no extra query needed.
  const out = approvals.map((a) => {
    const meta =
      a.metadata && typeof a.metadata === "object" && !Array.isArray(a.metadata)
        ? (a.metadata as Record<string, unknown>)
        : {};
    const artifact = extractArtifactFromInput(meta.input);
    return { approval: a, artifact, runId: a.runId };
  });

  // Second pass: for approvals with no inline content, look up a draft created
  // in the same run's company. Batched by company so N approvals = ≤1 query
  // per distinct company, never one-per-approval.
  const needsDraft = out.filter((o) => !o.artifact);
  if (needsDraft.length > 0) {
    const runIds = [...new Set(needsDraft.map((o) => o.runId))];
    const runs = await prisma.run.findMany({
      where: { id: { in: runIds } },
      select: { id: true, pipeline: { select: { companyId: true } }, createdAt: true },
    });
    const runToCompany = new Map(runs.map((r) => [r.id, r.pipeline.companyId]));

    for (const o of needsDraft) {
      const companyId = runToCompany.get(o.runId);
      if (!companyId) continue;
      // Most recent pending/approved draft for this company is the best guess at
      // "the content this approval is about". Tenant isolation holds because the
      // company was reached only through this tenant's run.
      const draft = await prisma.draft.findFirst({
        where: { companyId, status: { in: ["PENDING", "APPROVED"] } },
        orderBy: { createdAt: "desc" },
        select: { type: true, title: true, channel: true, content: true },
      });
      if (draft) o.artifact = artifactFromDraft(draft);
    }
  }

  return out.map((o) => ({ ...o.approval, artifact: o.artifact }));
}

// GET /api/v1/approvals — list pending approvals for tenant
approvalRouter.get("/", async (req, res, next) => {
  try {
    const { status = "PENDING" } = req.query;
    const approvals = await prisma.approval.findMany({
      where: {
        run: { pipeline: { company: { tenantId: req.auth!.tenantId } } },
        status: status as any,
      },
      include: {
        run: { include: { pipeline: { include: { company: true } } } },
      },
      orderBy: { createdAt: "desc" },
    });
    res.json(await attachArtifacts(approvals));
  } catch (err) { next(err); }
});

const decideSchema = z.object({
  decision: z.enum(["APPROVED", "REJECTED"]),
  // Optional operator note. For INPUT approvals (agent ask_user), an APPROVED
  // note is the answer — stored as a SteeringMessage the agent loop injects
  // on resume. For SPEND it's just an audit note ("approve-with-note").
  note: z.string().max(4000).optional(),
});

// POST /api/v1/approvals/:id/decide
//
// Race-safe: two admins clicking Approve simultaneously must NOT both
// succeed. We do a tenant-scoped lookup first (404 vs cross-tenant probe)
// then guard the state transition with `updateMany({ where: { status:
// PENDING } })` — Postgres gives that statement a row-level lock, so the
// loser sees `count === 0` and we 409 cleanly. Run-status update + activity
// log are batched in a single $transaction so a partial commit can never
// leave an APPROVED approval pointing at a still-CANCELLED run.
approvalRouter.post("/:id/decide", async (req, res, next) => {
  try {
    const { decision, note } = decideSchema.parse(req.body);

    const approval = await prisma.approval.findUnique({
      where: { id: req.params.id },
      include: { run: { include: { pipeline: { include: { company: true } } } } },
    });
    if (!approval || approval.run.pipeline.company.tenantId !== req.auth!.tenantId) {
      throw new AppError(404, "Approval not found");
    }
    if (approval.status !== "PENDING") {
      throw new AppError(409, "Approval already decided");
    }

    const result = await prisma.$transaction(async (tx) => {
      // Atomic state transition — only the row that's still PENDING wins.
      const claim = await tx.approval.updateMany({
        where: { id: approval.id, status: "PENDING" },
        data: {
          status: decision,
          decidedBy: req.auth!.userId,
          decidedAt: new Date(),
        },
      });

      if (claim.count !== 1) {
        // Lost the race — another admin decided this approval first.
        return { won: false as const };
      }

      // We won — drive the run to its post-approval state.
      await tx.run.update({
        where: { id: approval.runId },
        data: decision === "APPROVED"
          ? { status: "RUNNING" }
          : { status: "CANCELLED", completedAt: new Date() },
      });

      await tx.activityLog.create({
        data: {
          tenantId: req.auth!.tenantId,
          actor: req.auth!.userId,
          action: `approval.${decision.toLowerCase()}`,
          resource: "approval",
          resourceId: approval.id,
          details: { runId: approval.runId, amountUsd: approval.amountUsd },
        },
      });

      // Operator note: persist on the approval (audit) and, for an APPROVED
      // INPUT (ask_user answer), queue it as a SteeringMessage so the agent
      // loop injects the answer when the run resumes.
      if (note && note.trim()) {
        const prevMeta =
          approval.metadata && typeof approval.metadata === "object" && !Array.isArray(approval.metadata)
            ? (approval.metadata as Record<string, unknown>)
            : {};
        await tx.approval.update({
          where: { id: approval.id },
          data: { metadata: { ...prevMeta, note: note.trim() } as any },
        });
        if (approval.type === "INPUT" && decision === "APPROVED") {
          await tx.steeringMessage.create({
            data: {
              runId: approval.runId,
              kind: "INPUT",
              content: note.trim().slice(0, 4000),
              createdBy: req.auth!.userId,
            },
          });
        }
      }

      return { won: true as const };
    });

    if (!result.won) {
      throw new AppError(409, "Approval was just decided by another admin");
    }

    // On APPROVED, the run is now back to RUNNING but no BullMQ worker is
    // listening — re-enqueue so the runner picks the resume cursor. The
    // current runner replays from step group 0; per-step idempotency keys
    // keep most external side effects safe. (REJECTED leaves the run as
    // CANCELLED — no enqueue needed.)
    if (decision === "APPROVED") {
      try {
        await enqueueRun(approval.runId);
      } catch (err) {
        // Enqueue failures are recoverable — the run sits in RUNNING but
        // operators can manually re-enqueue via /runs/:id/resume. Surface
        // the error to logs so PagerDuty can pick it up.
        const { logger } = await import("../../lib/logger");
        logger.error(
          { runId: approval.runId, err: err instanceof Error ? err.message : String(err) },
          "Failed to re-enqueue run after approval — manual resume required",
        );
      }
    }

    res.json({ success: true, decision });
  } catch (err) { next(err); }
});
