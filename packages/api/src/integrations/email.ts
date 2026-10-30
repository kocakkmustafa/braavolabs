/**
 * Email adapter — SendGrid integration for outreach emails.
 */

import { logger } from "../lib/logger";
import { env } from "../config/env";
import { isOutboundFeatureEnabled } from "../lib/outbound-gates";

// Warn-once latch for the dev/no-key no-op path, so local logs aren't
// spammed on every send attempt.
let warnedEmailDisabled = false;

interface SendEmailParams {
  to: string;
  subject: string;
  body: string;
  from?: string;
  replyTo?: string;
  /** Transactional account messages keep token-bearing links untracked. */
  tracking?: boolean;
}

/**
 * Send an email via SendGrid.
 * Falls back to logging in development when SENDGRID_API_KEY is not set.
 */
export async function sendEmail(params: SendEmailParams): Promise<{ messageId: string }> {
  const apiKey = process.env.SENDGRID_API_KEY;
  const fromEmail = params.from ?? process.env.SENDGRID_FROM_EMAIL ?? "noreply@braavolabs.com";

  if (!apiKey) {
    // In production a missing key must surface as a FAILURE, not a fake
    // success — otherwise verification / reset / welcome emails silently
    // vanish while every caller believes they were delivered.
    // (OFFLINE_MODE is the one sanctioned exception: air-gapped
    // self-hosted deployments deliberately skip outbound SaaS calls.)
    if (env.NODE_ENV === "production" && !env.OFFLINE_MODE) {
      logger.error(
        { to: params.to, subject: params.subject },
        "EMAIL DISABLED — SENDGRID_API_KEY is not set in production; refusing to fake a successful send",
      );
      throw new Error("EMAIL DISABLED: SENDGRID_API_KEY is not configured");
    }
    // Development / offline mode — log instead of sending (warn once)
    if (!warnedEmailDisabled) {
      warnedEmailDisabled = true;
      logger.warn(
        "EMAIL DISABLED — SENDGRID_API_KEY not set; emails will be logged instead of sent",
      );
    }
    logger.info(
      { to: params.to, subject: params.subject },
      "Email would be sent (SENDGRID_API_KEY not set)",
    );
    return { messageId: `dev_${Date.now()}` };
  }

  const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      personalizations: [
        {
          to: [{ email: params.to }],
          subject: params.subject,
        },
      ],
      from: { email: fromEmail },
      reply_to: params.replyTo ? { email: params.replyTo } : undefined,
      content: [
        {
          type: "text/html",
          value: params.body,
        },
      ],
      tracking_settings: {
        click_tracking: { enable: params.tracking ?? true, enable_text: params.tracking === false ? false : undefined },
        open_tracking: { enable: params.tracking ?? true },
      },
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`SendGrid error ${response.status}: ${errorBody}`);
  }

  const messageId = response.headers.get("x-message-id") ?? `sg_${Date.now()}`;
  logger.info({ to: params.to, messageId }, "Email sent via SendGrid");

  return { messageId };
}

/**
 * Send a batch of emails (respects daily limit).
 * Bulk mail is contact outreach, so it honors the B-06 gate: while
 * OUTBOUND_EMAIL_ENABLED is not "true" nothing is sent.
 */
export async function sendBatchEmails(
  emails: SendEmailParams[],
  dailyLimit = 50,
): Promise<{ sent: number; skipped: number }> {
  if (!isOutboundFeatureEnabled("email")) {
    logger.warn({ count: emails.length }, "Batch email skipped — contact email disabled (B-06)");
    return { sent: 0, skipped: emails.length };
  }

  let sent = 0;
  let skipped = 0;

  for (const email of emails) {
    if (sent >= dailyLimit) {
      skipped++;
      continue;
    }
    try {
      await sendEmail(email);
      sent++;
    } catch (err) {
      logger.error({ to: email.to, error: (err as Error).message }, "Failed to send email");
      skipped++;
    }
  }

  return { sent, skipped };
}
