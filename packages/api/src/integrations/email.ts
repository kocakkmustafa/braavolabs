/**
 * Email adapter — SendGrid integration for outreach emails.
 */

import { logger } from "../lib/logger";

interface SendEmailParams {
  to: string;
  subject: string;
  body: string;
  from?: string;
  replyTo?: string;
}

/**
 * Send an email via SendGrid.
 * Falls back to logging in development when SENDGRID_API_KEY is not set.
 */
export async function sendEmail(params: SendEmailParams): Promise<{ messageId: string }> {
  const apiKey = process.env.SENDGRID_API_KEY;
  const fromEmail = params.from ?? process.env.SENDGRID_FROM_EMAIL ?? "noreply@aicompanyos.com";

  if (!apiKey) {
    // Development mode — log instead of sending
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
        click_tracking: { enable: true },
        open_tracking: { enable: true },
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
 */
export async function sendBatchEmails(
  emails: SendEmailParams[],
  dailyLimit = 50,
): Promise<{ sent: number; skipped: number }> {
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
