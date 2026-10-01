import { Router } from "express";
import { authMiddleware } from "../../middleware/auth";
import { prisma, tenantTx } from "../../lib/db";
import { AppError } from "../../middleware/error";
import { z } from "zod";
import { notifyTenantUsers } from "../../services/push";

export const draftRouter = Router();
draftRouter.use(authMiddleware);

// CRIT-1 defense — per-tenant daily outbound email cap + recipient
// allowlist. The draft approve+send path was an open mail relay before
// these gates: any tenant could send unlimited HTML to arbitrary
// recipients via SendGrid, blowing SPF/DKIM reputation in hours.
//
// Cap is plan-tiered: FREE 20/day, paid plans 500/day. Hard ceiling —
// not configurable at the tenant level (yet). Counted in usage_meters
// under metric "emails_sent_today" with daily UTC period boundaries.
const EMAIL_DAILY_LIMITS: Record<string, number> = {
  FREE: 20,
  CREATOR: 200,
  PRO: 500,
  BUSINESS: 1000,
  ENTERPRISE: 5000,
};

async function claimEmailQuota(tenantId: string): Promise<{ ok: boolean; sent: number; limit: number }> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { plan: true },
  });
  const plan = tenant?.plan ?? "FREE";
  const limit = EMAIL_DAILY_LIMITS[plan] ?? EMAIL_DAILY_LIMITS.FREE!;

  const now = new Date();
  // Daily UTC bucket — different metric from monthly run quota.
  const periodStart = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
  ));
  const periodEnd = new Date(periodStart.getTime() + 24 * 60 * 60 * 1000);

  // Atomic: insert a fresh daily row at value=1, or increment IFF still
  // under the limit. Same TOCTOU pattern as monthly run quota.
  const rows = await tenantTx((tx) => tx.$queryRaw<Array<{ value: number }>>`
    INSERT INTO usage_meters (id, tenant_id, metric, value, period_start, period_end, created_at, updated_at)
    VALUES (gen_random_uuid()::text, ${tenantId}, 'emails_sent_today', 1, ${periodStart}, ${periodEnd}, NOW(), NOW())
    ON CONFLICT (tenant_id, metric, period_start) DO UPDATE
      SET value = usage_meters.value + 1, updated_at = NOW()
      WHERE usage_meters.value < ${limit}
    RETURNING value
  `);

  if (rows.length === 0) {
    const current = await prisma.usageMeter.findUnique({
      where: {
        tenantId_metric_periodStart: { tenantId, metric: "emails_sent_today", periodStart },
      },
      select: { value: true },
    });
    return { ok: false, sent: current?.value ?? limit, limit };
  }
  return { ok: true, sent: rows[0]!.value, limit };
}

/**
 * Verify the recipient is in the tenant's CRM and not opted-out.
 *
 * Without this gate, an attacker can send HTML email through us to any
 * address (open relay). With it, they can only mail people who are
 * already in their own CRM — which means social-engineering the CRM
 * data, an audited operation. The unsubscribe gate respects KVKK/GDPR
 * Article 21 (right to object).
 */
async function isRecipientAllowed(tenantId: string, to: string): Promise<boolean> {
  if (!to || typeof to !== "string") return false;
  const normalized = to.trim().toLowerCase();

  // Recipient must exist as a contact in this tenant's CRM.
  const contact = await prisma.contact.findFirst({
    where: {
      email: normalized,
      company: { tenantId },
    },
    select: { id: true },
  });
  if (!contact) return false;

  // And NOT have an unsubscribed enrollment in any sequence — once a
  // recipient unsubscribes from one of the tenant's sequences, the
  // tenant must stop emailing them entirely.
  const unsubscribed = await prisma.outreachEnrollment.findFirst({
    where: {
      contactId: contact.id,
      status: "UNSUBSCRIBED",
    },
    select: { id: true },
  });
  if (unsubscribed) return false;

  return true;
}

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
        ...(status && { status: status as any }),
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
        content: data.content as any,
        metadata: data.metadata as any,
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

    // Push to mobile companion app — `drafts` pref defaults to OFF
    // (signal-vs-noise) so most users won't see this. Power users can
    // toggle it on under Settings → Notifications in the mobile app.
    notifyTenantUsers(req.auth!.tenantId, "draft", {
      title: "New draft ready",
      body: data.title ?? "An AI draft is awaiting your review",
      data: { kind: "draft", id: draft.id, companyId: data.companyId },
    }).catch(() => {});

    res.status(201).json(draft);
  } catch (err) { next(err); }
});

const updateDraftSchema = z.object({
  title: z.string().optional(),
  content: z.any().optional(),
  // Approval and publication must pass through /:id/approve, where the
  // company lifecycle, recipient, quota, and delivery outcome are checked.
  status: z.enum(["REJECTED", "ARCHIVED"]).optional(),
  channel: z.string().optional(),
}).strict();

// PATCH /api/v1/drafts/:id
draftRouter.patch("/:id", async (req, res, next) => {
  try {
    const data = updateDraftSchema.parse(req.body);

    const draft = await prisma.draft.findUnique({
      where: { id: req.params.id },
      include: { company: true },
    });
    if (!draft || draft.company.tenantId !== req.auth!.tenantId) {
      throw new AppError(404, "Draft not found");
    }
    if (draft.status !== "PENDING") {
      throw new AppError(409, "Only pending drafts can be edited, rejected, or archived.");
    }

    // Edits and terminal decisions share /approve's PENDING compare-and-swap.
    // A stale edit cannot change the recorded content after send is claimed.
    const decision = await prisma.draft.updateMany({
      where: { id: draft.id, status: "PENDING", company: { tenantId: req.auth!.tenantId } },
      data,
    });
    if (decision.count !== 1) throw new AppError(409, "Draft was already decided.");
    const updated = await prisma.draft.findUnique({ where: { id: draft.id } });
    if (!updated) throw new AppError(404, "Draft not found");

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

// POST /api/v1/drafts/:id/approve — approve and optionally send a draft
draftRouter.post("/:id/approve", async (req, res, next) => {
  try {
    const draft = await prisma.draft.findUnique({
      where: { id: req.params.id },
      include: { company: true },
    });
    if (!draft || draft.company.tenantId !== req.auth!.tenantId) {
      throw new AppError(404, "Draft not found");
    }
    if (draft.status !== "PENDING") {
      throw new AppError(400, "Draft is not in PENDING status");
    }
    // The draft can remain pending after its company is paused or archived.
    // Check the company lifecycle before quota claims, external sends, or writes.
    if (draft.company.status !== "ACTIVE") {
      throw new AppError(409, "Activate the company before approving or publishing drafts.");
    }

    const { send } = z.object({ send: z.boolean().optional() }).parse(req.body ?? {});
    if (send && draft.type !== "EMAIL") {
      throw new AppError(422, "Publishing non-email drafts is unavailable until delivery is configured.");
    }

    // Reject invalid recipients before taking the one-time decision claim.
    const content = send && draft.content && typeof draft.content === "object" && !Array.isArray(draft.content)
      ? draft.content as { to?: unknown; subject?: unknown; body?: unknown }
      : null;
    if (send && !content) throw new AppError(400, "Email draft is missing to/subject/body in content");
    if (content) {
      if (typeof content.to !== "string" || !content.to.trim()
        || typeof content.subject !== "string" || !content.subject.trim()
        || typeof content.body !== "string" || !content.body.trim()) {
        throw new AppError(400, "Email draft is missing to/subject/body in content");
      }
      const allowed = await isRecipientAllowed(req.auth!.tenantId, content.to);
      if (!allowed) {
        throw new AppError(
          403,
          "Recipient is not in your CRM, or has unsubscribed. Add them as a contact first.",
        );
      }
    }

    // Only one approver can move this draft out of PENDING. Include company
    // ownership and ACTIVE state in the write so a pause/archive that won
    // before this point prevents the send as well.
    const claim = await prisma.draft.updateMany({
      where: {
        id: draft.id,
        status: "PENDING",
        company: { tenantId: req.auth!.tenantId, status: "ACTIVE" },
      },
      data: { status: "APPROVED" },
    });
    if (claim.count !== 1) throw new AppError(409, "Draft was already decided or the company is inactive.");

    let published = false;
    if (content) {
      // Quota is claimed only by the winner. If it refuses the send, restore
      // PENDING; no provider call has happened, so retry remains safe.
      try {
        const quota = await claimEmailQuota(req.auth!.tenantId);
        if (!quota.ok) {
          throw new AppError(
            429,
            `Daily outbound email cap reached (${quota.sent}/${quota.limit}). Resets at 00:00 UTC.`,
          );
        }
      } catch (quotaErr) {
        await prisma.draft.updateMany({
          where: { id: draft.id, status: "APPROVED" },
          data: { status: "PENDING" },
        });
        throw quotaErr;
      }

      try {
        const { sendEmail } = await import("../../integrations/email");
        const receipt = await sendEmail({
          to: content.to as string,
          subject: content.subject as string,
          body: content.body as string,
        });
        // The adapter deliberately returns dev_* for its offline/no-key
        // logging path. That is not external delivery and cannot be PUBLISHED.
        if (!receipt?.messageId || receipt.messageId.startsWith("dev_")) {
          throw new Error("Email adapter did not confirm provider acceptance");
        }
        published = true;
      } catch (emailErr) {
        // A provider/network error can be ambiguous: it may have accepted
        // the message. Leave APPROVED claimed so a retry cannot send twice.
        const { logger } = await import("../../lib/logger");
        logger.error({ draftId: draft.id, error: emailErr }, "Draft email delivery outcome uncertain");
      }
    }

    const updated = await prisma.draft.update({
      where: { id: draft.id },
      data: {
        status: published ? "PUBLISHED" : "APPROVED",
        ...(published && { publishedAt: new Date() }),
      },
    });

    await prisma.activityLog.create({
      data: {
        tenantId: req.auth!.tenantId,
        actor: req.auth!.userId,
        action: published ? "draft.publish" : send ? "draft.delivery_uncertain" : "draft.approve",
        resource: "draft",
        resourceId: draft.id,
      },
    });

    res.json(updated);
  } catch (err) { next(err); }
});
