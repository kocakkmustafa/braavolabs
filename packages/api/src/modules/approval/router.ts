import { Router } from "express";
import { authMiddleware } from "../../middleware/auth";
import { prisma } from "../../lib/db";
import { AppError } from "../../middleware/error";
import { enqueueRun } from "../pipeline/runner";
import { z } from "zod";

export const approvalRouter = Router();
approvalRouter.use(authMiddleware);

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
    res.json(approvals);
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
