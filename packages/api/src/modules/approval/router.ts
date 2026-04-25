import { Router } from "express";
import { authMiddleware } from "../../middleware/auth";
import { prisma } from "../../lib/db";
import { AppError } from "../../middleware/error";
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
    const { decision } = decideSchema.parse(req.body);

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

      return { won: true as const };
    });

    if (!result.won) {
      throw new AppError(409, "Approval was just decided by another admin");
    }

    res.json({ success: true, decision });
  } catch (err) { next(err); }
});
