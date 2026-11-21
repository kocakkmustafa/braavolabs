/**
 * Public one-click unsubscribe: POST|GET /api/v1/public/unsubscribe?token=...
 *
 * No auth: the signed, expiring token (lib/unsubscribe-token.ts) is the
 * credential (no tenant context: systemScope, every query carries the token's
 * tenantId explicitly). A valid token writes the suppression row, marks the address's
 * live enrollments UNSUBSCRIBED and logs to activity_log; anything else is a
 * flat 404 (no oracle on why). Every query carries the token's tenantId.
 * Stays available whatever the outbound flags say (an opt-out is never gated).
 */
import { Router } from "express";
import { prisma } from "../../lib/db";
import { logger } from "../../lib/logger";
import { rateLimit } from "../../middleware/rateLimit";
import { systemScope } from "../../middleware/system-scope";
import { suppressEmail } from "../../lib/email-suppression";
import { verifyUnsubscribeToken } from "../../lib/unsubscribe-token";

export const unsubscribeRouter = Router();

// Per IP. Redis outage fails OPEN on purpose (not in the fail-closed list):
// an opt-out must stay reachable.
const unsubscribeLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  maxRequests: 30,
  keyPrefix: "rl:public:unsubscribe",
});

async function handle(req: any, res: any, next: (error?: unknown) => void) {
  try {
    const verified = verifyUnsubscribeToken(req.query?.token);
    if (!verified) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const { tenantId, email } = verified;

    try {
      await suppressEmail(tenantId, email, "UNSUBSCRIBE");
    } catch (err) {
      // Signed token for a tenant that no longer exists (FK): nothing to do.
      if ((err as { code?: string }).code === "P2003") {
        res.status(404).json({ error: "Not found" });
        return;
      }
      throw err;
    }

    const updated = await prisma.outreachEnrollment.updateMany({
      where: {
        status: { in: ["ACTIVE", "PAUSED"] },
        contact: { email: { equals: email, mode: "insensitive" }, company: { tenantId } },
      },
      data: { status: "UNSUBSCRIBED", unsubscribedAt: new Date() },
    });

    await prisma.activityLog.create({
      data: {
        tenantId,
        actor: "recipient",
        action: "outreach.unsubscribe_public",
        resource: "email_suppression",
        details: { email, enrollmentsUnsubscribed: updated.count },
      },
    });

    logger.info({ tenantId, enrollments: updated.count }, "Recipient unsubscribed via signed link");
    res.status(200).json({ success: true });
  } catch (err) {
    next(err);
  }
}

unsubscribeRouter.get("/", systemScope("route:public-unsubscribe"), unsubscribeLimit, handle);
unsubscribeRouter.post("/", systemScope("route:public-unsubscribe"), unsubscribeLimit, handle);
