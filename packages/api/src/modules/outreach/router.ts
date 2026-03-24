import { Router } from "express";
import { authMiddleware } from "../../middleware/auth";
import { prisma } from "../../lib/db";
import { AppError } from "../../middleware/error";
import { z } from "zod";
import { logger } from "../../lib/logger";

export const outreachRouter = Router();
outreachRouter.use(authMiddleware);

const createSequenceSchema = z.object({
  companyId: z.string(),
  name: z.string().min(1),
  channel: z.enum(["EMAIL", "LINKEDIN", "TWITTER", "TIKTOK"]),
  steps: z.array(z.object({
    order: z.number(),
    channel: z.enum(["EMAIL", "LINKEDIN", "TWITTER", "TIKTOK"]),
    template: z.string(),
    delayHours: z.number().min(0),
    subject: z.string().optional(),
  })),
});

// GET /api/v1/outreach/sequences?companyId=xxx
outreachRouter.get("/sequences", async (req, res, next) => {
  try {
    const { companyId } = req.query;
    const company = await prisma.company.findFirst({
      where: { id: companyId as string, tenantId: req.auth!.tenantId },
    });
    if (!company) throw new AppError(404, "Company not found");

    const sequences = await prisma.outreachSequence.findMany({
      where: { companyId: company.id },
      include: { _count: { select: { enrollments: true } } },
      orderBy: { createdAt: "desc" },
    });
    res.json(sequences);
  } catch (err) { next(err); }
});

// POST /api/v1/outreach/sequences
outreachRouter.post("/sequences", async (req, res, next) => {
  try {
    const data = createSequenceSchema.parse(req.body);
    const company = await prisma.company.findFirst({
      where: { id: data.companyId, tenantId: req.auth!.tenantId },
    });
    if (!company) throw new AppError(404, "Company not found");

    const sequence = await prisma.outreachSequence.create({
      data: {
        companyId: data.companyId,
        name: data.name,
        channel: data.channel,
        steps: data.steps as any,
      },
    });

    await prisma.activityLog.create({
      data: {
        tenantId: req.auth!.tenantId,
        actor: req.auth!.userId,
        action: "outreach.sequence_create",
        resource: "outreach_sequence",
        resourceId: sequence.id,
      },
    });

    res.status(201).json(sequence);
  } catch (err) { next(err); }
});

// POST /api/v1/outreach/sequences/:id/enroll — enroll a contact
outreachRouter.post("/sequences/:id/enroll", async (req, res, next) => {
  try {
    const { contactId } = z.object({ contactId: z.string() }).parse(req.body);

    const sequence = await prisma.outreachSequence.findUnique({
      where: { id: req.params.id },
      include: { company: true },
    });
    if (!sequence || sequence.company.tenantId !== req.auth!.tenantId) {
      throw new AppError(404, "Sequence not found");
    }

    // Spam protection: check unanswered outreach count
    const existingEnrollments = await prisma.outreachEnrollment.count({
      where: {
        contactId,
        status: "ACTIVE",
        repliedAt: null,
      },
    });

    if (existingEnrollments >= 3) {
      throw new AppError(
        429,
        "Spam protection: contact has 3+ unanswered active sequences. Wait for a reply or remove existing enrollments.",
      );
    }

    const enrollment = await prisma.outreachEnrollment.create({
      data: {
        sequenceId: sequence.id,
        contactId,
        status: "ACTIVE",
        currentStep: 0,
      },
    });

    await prisma.activityLog.create({
      data: {
        tenantId: req.auth!.tenantId,
        actor: req.auth!.userId,
        action: "outreach.enroll",
        resource: "outreach_enrollment",
        resourceId: enrollment.id,
        details: { sequenceId: sequence.id, contactId },
      },
    });

    logger.info({ enrollmentId: enrollment.id, contactId }, "Contact enrolled in sequence");
    res.status(201).json(enrollment);
  } catch (err) { next(err); }
});

// GET /api/v1/outreach/enrollments?sequenceId=xxx
outreachRouter.get("/enrollments", async (req, res, next) => {
  try {
    const { sequenceId, status } = req.query;

    const enrollments = await prisma.outreachEnrollment.findMany({
      where: {
        sequenceId: sequenceId as string,
        ...(status && { status: status as string }),
        sequence: { company: { tenantId: req.auth!.tenantId } },
      },
      include: { contact: true },
      orderBy: { createdAt: "desc" },
    });

    res.json(enrollments);
  } catch (err) { next(err); }
});

// POST /api/v1/outreach/enrollments/:id/reply — mark contact as replied
outreachRouter.post("/enrollments/:id/reply", async (req, res, next) => {
  try {
    const enrollment = await prisma.outreachEnrollment.findUnique({
      where: { id: req.params.id },
      include: { sequence: { include: { company: true } } },
    });
    if (!enrollment || enrollment.sequence.company.tenantId !== req.auth!.tenantId) {
      throw new AppError(404, "Enrollment not found");
    }

    await prisma.outreachEnrollment.update({
      where: { id: enrollment.id },
      data: { repliedAt: new Date(), status: "COMPLETED" },
    });

    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /api/v1/outreach/enrollments/:id/unsubscribe
outreachRouter.post("/enrollments/:id/unsubscribe", async (req, res, next) => {
  try {
    const enrollment = await prisma.outreachEnrollment.findUnique({
      where: { id: req.params.id },
      include: { sequence: { include: { company: true } } },
    });
    if (!enrollment || enrollment.sequence.company.tenantId !== req.auth!.tenantId) {
      throw new AppError(404, "Enrollment not found");
    }

    await prisma.outreachEnrollment.update({
      where: { id: enrollment.id },
      data: { unsubscribedAt: new Date(), status: "UNSUBSCRIBED" },
    });

    res.json({ success: true });
  } catch (err) { next(err); }
});
