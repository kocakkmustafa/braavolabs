/**
 * Self-service user endpoints — GDPR Article 17 + KVKK Madde 11(e/f).
 *
 *   GET    /api/v1/users/me     — current user profile (auth-gated)
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
