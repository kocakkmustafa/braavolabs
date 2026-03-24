import { Router } from "express";
import { authMiddleware } from "../../middleware/auth";
import { prisma } from "../../lib/db";
import { AppError } from "../../middleware/error";
import { z } from "zod";

export const draftRouter = Router();
draftRouter.use(authMiddleware);

const createSchema = z.object({
  companyId: z.string(),
  type: z.enum(["SOCIAL_POST", "EMAIL", "BLOG_POST", "AD_COPY", "VIDEO_SCRIPT"]),
  title: z.string().min(1),
  content: z.record(z.unknown()),
  channel: z.string().optional(),
  scheduledAt: z.string().datetime().optional(),
  metadata: z.record(z.unknown()).optional(),
});

// GET /api/v1/drafts?companyId=xxx
draftRouter.get("/", async (req, res, next) => {
  try {
    const { companyId, status } = req.query;
    const company = await prisma.company.findFirst({
      where: { id: companyId as string, tenantId: req.auth!.tenantId },
    });
    if (!company) throw new AppError(404, "Company not found");

    const drafts = await prisma.draft.findMany({
      where: {
        companyId: company.id,
        ...(status && { status: status as string }),
      },
      orderBy: { createdAt: "desc" },
    });
    res.json(drafts);
  } catch (err) { next(err); }
});

// POST /api/v1/drafts
draftRouter.post("/", async (req, res, next) => {
  try {
    const data = createSchema.parse(req.body);
    const company = await prisma.company.findFirst({
      where: { id: data.companyId, tenantId: req.auth!.tenantId },
    });
    if (!company) throw new AppError(404, "Company not found");

    const draft = await prisma.draft.create({
      data: {
        ...data,
        scheduledAt: data.scheduledAt ? new Date(data.scheduledAt) : undefined,
      },
    });

    await prisma.activityLog.create({
      data: {
        tenantId: req.auth!.tenantId,
        actor: req.auth!.userId,
        action: "draft.create",
        resource: "draft",
        resourceId: draft.id,
      },
    });

    res.status(201).json(draft);
  } catch (err) { next(err); }
});

// PATCH /api/v1/drafts/:id
draftRouter.patch("/:id", async (req, res, next) => {
  try {
    const draft = await prisma.draft.findUnique({
      where: { id: req.params.id },
      include: { company: true },
    });
    if (!draft || draft.company.tenantId !== req.auth!.tenantId) {
      throw new AppError(404, "Draft not found");
    }

    const updated = await prisma.draft.update({
      where: { id: draft.id },
      data: req.body,
    });

    await prisma.activityLog.create({
      data: {
        tenantId: req.auth!.tenantId,
        actor: req.auth!.userId,
        action: "draft.update",
        resource: "draft",
        resourceId: draft.id,
      },
    });

    res.json(updated);
  } catch (err) { next(err); }
});
