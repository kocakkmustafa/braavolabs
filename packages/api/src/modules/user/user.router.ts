/**
 * Self-service user endpoints — GDPR Article 17 + KVKK Madde 11(e/f).
 *
 *   GET    /api/v1/users/me     — current user profile (auth-gated)
 *   PATCH  /api/v1/users/me     — update own profile (name)
 *   DELETE /api/v1/users/me     — right to erasure
 *
 * Erasure semantics:
 *   - Removes the User row.
 *   - If this is the last user in the tenant, the tenant is also removed
 *     (cascades through Company → Agent → Pipeline → Run, ActivityLog,
 *     UsageMeter, AIConfig, AbTest — all `onDelete: Cascade` in schema).
 *   - If the tenant has other members, only the calling user is removed.
 *   - Stripe customer/subscription is NOT deleted here — operator must
 *     cancel via Stripe dashboard. Reason: programmatic delete depends on
 *     billing-state-machine (refund eligibility, audit trail, tax). Logged
 *     so the operator runbook can pick it up.
 *   - ActivityLog of the deletion is written FIRST so we keep an audit
 *     trail that the request happened, even after the row vanishes.
 *
 * The endpoint is intentionally synchronous — the user gets a 200 only
 * after the rows are gone. No "scheduled deletion" / "30-day undo" UX:
 * the spec says the right is immediate, and any delay needs an explicit
 * legal basis we don't have.
 */
import { Router } from "express";
import { z } from "zod";
import { authMiddleware } from "../../middleware/auth";
import { prisma } from "../../lib/db";
import { logger } from "../../lib/logger";
import { AppError } from "../../middleware/error";
import { getTrialStatus } from "../../services/trial-llm";
import { rateLimit } from "../../middleware/rateLimit";
import {
  USER_EXPORT_FIELDS,
  USER_EXPORT_OMITTED,
  DEVICE_EXPORT_FIELDS,
  NOTIFICATION_PREF_EXPORT_FIELDS,
  ACTIVITY_EXPORT_LIMIT,
} from "./data-export";

export const userRouter = Router();
userRouter.use(authMiddleware);

// GET /api/v1/users/me — current user profile + trial LLM status.
// Trial block is what powers the "X free runs left — subscribe to keep
// going" banner in the dashboard. We compute it here (not on the client)
// because the counter lives on the tenant row and the client doesn't have
// direct DB access.
userRouter.get("/me", async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.auth!.userId },
      select: {
        id: true,
        email: true,
        emailVerifiedAt: true,
        aiConsentAt: true,
        name: true,
        avatarUrl: true,
        role: true,
        createdAt: true,
        tenant: {
          select: { id: true, name: true, slug: true, plan: true },
        },
      },
    });
    if (!user) throw new AppError(404, "User not found");

    const trial = await getTrialStatus(user.tenant.id);

    res.json({ ...user, trial });
  } catch (err) { next(err); }
});

// PATCH /api/v1/users/me — update own profile. Only `name` is editable
// today (avatar upload doesn't exist yet; email changes would need a
// re-verification flow). Logged to activity_log like every mutation.
const updateMeSchema = z.object({
  name: z.string().trim().min(1).max(120),
});

userRouter.patch("/me", async (req, res, next) => {
  try {
    const body = updateMeSchema.parse(req.body);
    const user = await prisma.user.update({
      where: { id: req.auth!.userId },
      data: { name: body.name },
      select: { id: true, email: true, name: true, avatarUrl: true, role: true, createdAt: true },
    });

    await prisma.activityLog.create({
      data: {
        tenantId: req.auth!.tenantId,
        actor: req.auth!.userId,
        action: "user.update",
        resource: "user",
        resourceId: user.id,
      },
    });

    res.json(user);
  } catch (err) { next(err); }
});

// POST /api/v1/users/me/ai-consent — Apple 5.1.2(i) third-party AI data
// sharing consent. Explicit and revocable: granted=true stamps consent,
// granted=false clears it (run-triggering surfaces re-prompt). Always
// activity-logged so the consent trail is auditable.
const aiConsentSchema = z.object({ granted: z.boolean() });

userRouter.post("/me/ai-consent", async (req, res, next) => {
  try {
    const { granted } = aiConsentSchema.parse(req.body);
    const user = await prisma.user.update({
      where: { id: req.auth!.userId },
      data: { aiConsentAt: granted ? new Date() : null },
      select: { id: true, aiConsentAt: true },
    });

    await prisma.activityLog.create({
      data: {
        tenantId: req.auth!.tenantId,
        actor: req.auth!.userId,
        action: granted ? "user.ai_consent_granted" : "user.ai_consent_revoked",
        resource: "user",
        resourceId: user.id,
      },
    });

    res.json({ aiConsentAt: user.aiConsentAt });
  } catch (err) { next(err); }
});

// POST /api/v1/users/me/report-content — Apple 1.2 / Google Play AI-GC:
// in-app reporting of objectionable AI output. Stored in the activity
// log (auditable, reviewable by the operator); the acknowledgment is
// immediate, removal/handling is the operator runbook's job.
const reportSchema = z.object({
  target: z.string().trim().min(1).max(200),       // e.g. "run:<id>", "draft:<id>"
  reason: z.string().trim().min(1).max(120),        // category chosen in-app
  details: z.string().trim().max(2000).optional(),  // free text
});

userRouter.post("/me/report-content", async (req, res, next) => {
  try {
    const body = reportSchema.parse(req.body);

    await prisma.activityLog.create({
      data: {
        tenantId: req.auth!.tenantId,
        actor: req.auth!.userId,
        action: "content.report",
        resource: "moderation",
        resourceId: body.target.slice(0, 64),
        details: { target: body.target, reason: body.reason, details: body.details ?? null },
      },
    });

    res.status(201).json({ acknowledged: true });
  } catch (err) { next(err); }
});

// DELETE /api/v1/users/me — GDPR Article 17 right to erasure
//
// Confirmation pattern: the client must POST a body with `{confirm: "DELETE"}`
// to prevent fat-finger DELETE requests. This is a destructive irreversible
// action; a header-only flag is too easy to fire accidentally from a tool.
const deleteSchema = z.object({
  confirm: z.literal("DELETE", {
    errorMap: () => ({
      message: "To confirm erasure, send body: { \"confirm\": \"DELETE\" }",
    }),
  }),
});

/**
 * GET /api/v1/users/me/export — the subject's own data, machine-readable.
 *
 * NOTE the plural: `index.ts` mounts this router at `/users`. An earlier
 * version of this comment said `/user`, and the test stood its app up on that
 * prefix too — so the suite could never have anchored the real path.
 *
 * Art. 20 portability. The projection is an ALLOWLIST rather than deleting
 * `passwordHash` on the way out, because the failure mode here is silent: a
 * column added to `User` later would be EXPORTED by a denylist and WITHHELD
 * by an allowlist, and only one of those defaults is safe when the new column
 * might be a credential.
 */
userRouter.get(
  "/me/export",
  rateLimit({
    windowMs: 60 * 60_000,
    maxRequests: 5,
    keyPrefix: "rl:data-export",
    // Per USER, not per tenant. The default tenant bucket would let one
    // member's five exports deny nineteen colleagues their Art. 20 right for
    // the rest of the hour — a rights denial caused by a shared counter.
    identify: (req) => req.auth?.userId,
  }),
  async (req, res, next) => {
    try {
      const userId = req.auth!.userId;
      const tenantId = req.auth!.tenantId;

      const [user, devices, prefs, activity] = await Promise.all([
        prisma.user.findUnique({ where: { id: userId } }),
        prisma.device.findMany({ where: { userId } }),
        prisma.notificationPref.findUnique({ where: { userId } }),
        prisma.activityLog.findMany({
          // The subject's OWN actions. Other people's rows in the same tenant
          // are not this person's personal data to receive.
          where: { tenantId, actor: userId },
          select: { id: true, action: true, resource: true, resourceId: true, createdAt: true },
          orderBy: { createdAt: "desc" },
          take: ACTIVITY_EXPORT_LIMIT,
        }),
      ]);

      if (!user) throw new AppError(404, "User not found");

      const pick = (row: Record<string, unknown>, fields: readonly string[]) =>
        Object.fromEntries(fields.map((f) => [f, row[f] ?? null]));

      // A bulk read of personal data is itself an event worth recording, and
      // the trail is where a subject or a regulator would look for it.
      await prisma.activityLog
        .create({
          data: {
            tenantId,
            actor: userId,
            action: "user.data_export",
            resource: "user",
            resourceId: userId,
            ip: req.ip ?? null,
            result: "allowed",
            policy: "user:data-export",
            details: { activityRows: activity.length, deviceRows: devices.length },
          },
        })
        .catch((err: unknown) => logger.error({ err, userId }, "failed to record the data export"));

      res.setHeader("Content-Disposition", 'attachment; filename="braavolabs-data-export.json"');
      res.json({
        exportedAt: new Date().toISOString(),
        // Stated in the artifact itself: a subject holding this file cannot
        // otherwise tell whether something was withheld or simply absent.
        // Written FOR THE SUBJECT, in the file itself. An earlier version
        // pointed them at a source file in a private repo, which is not a
        // disclosure, and never mentioned that activity is capped.
        scope: {
          included:
            "Your account record, your registered devices, your notification " +
            "preferences, and the activity rows recording actions you took.",
          notIncluded:
            "Workspace records beyond the list above — including approval decisions you " +
            "made, which we can provide on request — and the fields listed " +
            "below. If the activity list is marked truncated, older rows exist beyond " +
            `the ${ACTIVITY_EXPORT_LIMIT}-row limit of this file — contact us for the remainder.`,
          withheldFields: USER_EXPORT_OMITTED,
        },
        account: pick(user as unknown as Record<string, unknown>, USER_EXPORT_FIELDS),
        devices: devices.map((d) => pick(d as unknown as Record<string, unknown>, DEVICE_EXPORT_FIELDS)),
        notificationPreferences: prefs
          ? pick(prefs as unknown as Record<string, unknown>, NOTIFICATION_PREF_EXPORT_FIELDS)
          : null,
        activity,
        activityTruncated: activity.length === ACTIVITY_EXPORT_LIMIT,
      });
    } catch (err) {
      next(err);
    }
  },
);

userRouter.delete("/me", async (req, res, next) => {
  try {
    deleteSchema.parse(req.body);

    const userId = req.auth!.userId;
    const tenantId = req.auth!.tenantId;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, role: true, tenant: { select: { plan: true, stripeSubscriptionId: true } } },
    });
    if (!user) throw new AppError(404, "User not found");

    // Count siblings — if this is the only user, the tenant goes too.
    const siblingCount = await prisma.user.count({
      where: { tenantId, NOT: { id: userId } },
    });
    const lastUser = siblingCount === 0;

    // Audit BEFORE delete — once the user row is gone, the foreign-key
    // reference would be the only proof and that's brittle. We use
    // `actor: "system"` after the fact so the entry survives the cascade.
    await prisma.activityLog.create({
      data: {
        tenantId,
        actor: "system",
        action: "user.delete_request",
        resource: "user",
        resourceId: userId,
        details: {
          email: user.email,
          role: user.role,
          plan: user.tenant.plan,
          lastUserInTenant: lastUser,
          stripeSubscriptionId: user.tenant.stripeSubscriptionId ?? null,
          tenantWillBeDeleted: lastUser,
          requestedAt: new Date().toISOString(),
        },
      },
    });

    if (lastUser) {
      // Tenant cascade — Companies, Agents, Pipelines, Runs, RunSteps,
      // ToolCalls, Memory, ActivityLog, UsageMeter, AIConfig, AbTests all
      // go via `onDelete: Cascade`. Stripe-side cancellation is operator's
      // responsibility (logged above for ops runbook).
      await prisma.tenant.delete({ where: { id: tenantId } });
      logger.info({ userId, tenantId, email: user.email }, "DSR: user + last-tenant erased");
    } else {
      await prisma.user.delete({ where: { id: userId } });
      logger.info({ userId, tenantId, email: user.email }, "DSR: user erased (tenant kept)");
    }

    res.json({
      success: true,
      message: lastUser
        ? "Account and tenant erased. Stripe subscription (if any) must be cancelled manually."
        : "Account erased. Tenant retained because other members exist.",
      tenantDeleted: lastUser,
      stripeRequiresManualCancellation: !!user.tenant.stripeSubscriptionId,
    });
  } catch (err) { next(err); }
});
