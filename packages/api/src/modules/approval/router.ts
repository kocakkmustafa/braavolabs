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
      throw new AppError(400, "Approval already decided");
    }

    await prisma.approval.update({
      where: { id: approval.id },
      data: {
        status: decision,
        decidedBy: req.auth!.userId,
        decidedAt: new Date(),
      },
    });

    // If approved, resume the run
    if (decision === "APPROVED") {
      await prisma.run.update({
        where: { id: approval.runId },
        data: { status: "RUNNING" },
      });
    } else {
      await prisma.run.update({
        where: { id: approval.runId },
        data: { status: "CANCELLED", completedAt: new Date() },
      });
    }

    await prisma.activityLog.create({
      data: {
        tenantId: req.auth!.tenantId,
        actor: req.auth!.userId,
        action: `approval.${decision.toLowerCase()}`,
        resource: "approval",
        resourceId: approval.id,
        details: { runId: approval.runId, amountUsd: approval.amountUsd },
      },
    });

    res.json({ success: true, decision });
  } catch (err) { next(err); }
});
