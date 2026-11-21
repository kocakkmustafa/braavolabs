/**
 * Email adapter — SendGrid integration for outreach emails.
 */

import { logger } from "../lib/logger";
import { env } from "../config/env";
import {
  getOutboundLegalConfig,
  isOutboundFeatureEnabled,
  legalConfigMissingError,
  missingEmailLegalConfig,
} from "../lib/outbound-gates";
import { buildUnsubscribeUrl } from "../lib/unsubscribe-token";
import { appendLegalFooter } from "../lib/outbound-footer";

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
  /**
   * Set ONLY by contact-outreach callers (draft send, sequence runner). Adds
   * List-Unsubscribe / List-Unsubscribe-Post headers and refuses the send with
   * LEGAL_CONFIG_MISSING while the legal config is incomplete. Account emails
   * never set it; their payload and headers are unchanged.
   */
  outbound?: { tenantId: string };
}

/** RFC 8058 one-click headers for an outbound message, or a fail-closed refusal. */
function outboundHeaders(tenantId: string, to: string): Record<string, string> {
  const missing = missingEmailLegalConfig(getOutboundLegalConfig());
  const url = missing.length === 0 ? buildUnsubscribeUrl(tenantId, to) : null;
  if (missing.length > 0 || !url) {
    logger.warn(
      { missing: url ? missing : [...missing, "https API_PUBLIC_URL"] },
      "Outbound email refused — legal config incomplete (LEGAL_CONFIG_MISSING)",
    );
    throw legalConfigMissingError();
  }
  return {
    "List-Unsubscribe": `<${url}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

/**
 * Send an email via SendGrid.
 * Falls back to logging in development when SENDGRID_API_KEY is not set.
 */
export async function sendEmail(params: SendEmailParams): Promise<{ messageId: string }> {
  const apiKey = process.env.SENDGRID_API_KEY;
  const fromEmail = params.from ?? process.env.SENDGRID_FROM_EMAIL ?? "noreply@braavolabs.com";
  // Fail closed before anything else (also in dev/no-key mode).
  const extraHeaders = params.outbound ? outboundHeaders(params.outbound.tenantId, params.to) : undefined;

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
      headers: extraHeaders,
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
  emails: Array<SendEmailParams & { outbound?: { tenantId: string } }>,
  dailyLimit = 50,
): Promise<{ sent: number; skipped: number }> {
  if (!isOutboundFeatureEnabled("email")) {
    logger.warn({ count: emails.length }, "Batch email skipped — contact email disabled (B-06)");
    return { sent: 0, skipped: emails.length };
  }

  // Fail closed: bulk contact mail needs the legal config, and every message must
  // carry `outbound` (tenant) so it gets the opt-out headers. A message without
  // it is skipped, never sent bare.
  const missing = missingEmailLegalConfig(getOutboundLegalConfig());
  if (missing.length > 0) {
    logger.warn({ count: emails.length, missing }, "Batch email skipped — legal config incomplete (LEGAL_CONFIG_MISSING)");
    return { sent: 0, skipped: emails.length };
  }

  let sent = 0;
  let skipped = 0;

  for (const email of emails) {
    if (!email.outbound) {
      logger.warn({ to: email.to }, "Batch email skipped — message has no outbound tenant marker");
      skipped++;
      continue;
    }
    if (sent >= dailyLimit) {
      skipped++;
      continue;
    }
    try {
      await sendEmail({
        ...email,
        body: appendLegalFooter(email.body, email.outbound.tenantId, email.to),
      });
      sent++;
    } catch (err) {
      logger.error({ to: email.to, error: (err as Error).message }, "Failed to send email");
      skipped++;
    }
  }

  return { sent, skipped };
}
