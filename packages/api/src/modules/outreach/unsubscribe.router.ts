/**
 * Public one-click unsubscribe: POST|GET /api/v1/public/unsubscribe?token=...
 *
 * GET changes NOTHING (mail scanners and link prefetchers GET links): it returns
 * a static confirmation page whose form POSTs back. Only POST changes state; the
 * RFC 8058 one-click POST carries the token in the query string, the page's form
 * in a hidden body field; both are accepted. An invalid token is 404 on both.
 *
 * No auth: the signed, expiring token (lib/unsubscribe-token.ts) is the
 * credential (no tenant context: systemScope, every query carries the token's
 * tenantId explicitly). A valid token writes the suppression row, marks the address's
 * live enrollments UNSUBSCRIBED and logs to activity_log; anything else is a
 * flat 404 (no oracle on why). Every query carries the token's tenantId.
 * Stays available whatever the outbound flags say (an opt-out is never gated).
 */
import express, { Router } from "express";
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

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Neutral, self-contained page: independent of the configured unsubscribe text. */
function confirmPage(token: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="robots" content="noindex"><title>Confirm unsubscribe</title></head>` +
    `<body><h1>Confirm unsubscribe</h1>` +
    `<p>Press the button to stop receiving these emails.</p>` +
    `<form method="post" action="/api/v1/public/unsubscribe">` +
    `<input type="hidden" name="token" value="${escapeHtml(token)}">` +
    `<button type="submit">Confirm unsubscribe</button></form></body></html>`;
}

async function showConfirmation(req: any, res: any, next: (error?: unknown) => void) {
  try {
    const token = req.query?.token;
    if (!verifyUnsubscribeToken(token)) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.setHeader?.("Cache-Control", "no-store");
    res.status(200).type("html").send(confirmPage(token as string));
  } catch (err) {
    next(err);
  }
}

async function handle(req: any, res: any, next: (error?: unknown) => void) {
  try {
    const bodyToken = typeof req.body?.token === "string" ? req.body.token : undefined;
    const verified = verifyUnsubscribeToken(req.query?.token ?? bodyToken);
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

unsubscribeRouter.get("/", systemScope("route:public-unsubscribe"), unsubscribeLimit, showConfirmation);
unsubscribeRouter.post(
  "/",
  systemScope("route:public-unsubscribe"),
  unsubscribeLimit,
  express.urlencoded({ extended: false, limit: "4kb" }),
  handle,
);
