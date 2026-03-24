import pino from "pino";

const logger = pino({ name: "email-sender" });

export interface EmailConfig {
  apiKey: string;
  fromEmail: string;
}

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  replyTo?: string;
}

export interface EmailResult {
  messageId: string;
  status: "sent" | "failed";
  error?: string;
}

/**
 * Send an email via SendGrid.
 */
export async function sendEmail(
  config: EmailConfig,
  input: SendEmailInput,
): Promise<EmailResult> {
  const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: input.to }] }],
      from: { email: config.fromEmail },
      reply_to: input.replyTo ? { email: input.replyTo } : undefined,
      subject: input.subject,
      content: [{ type: "text/html", value: input.html }],
    }),
  });

  if (res.ok || res.status === 202) {
    const messageId = res.headers.get("x-message-id") ?? `sg_${Date.now()}`;
    logger.info({ to: input.to, messageId }, "Email sent");
    return { messageId, status: "sent" };
  }

  const errorText = await res.text();
  logger.error({ to: input.to, status: res.status, error: errorText }, "Email send failed");
  return { messageId: "", status: "failed", error: errorText };
}

/**
 * Send a batch of emails (rate-limited).
 */
export async function sendBatch(
  config: EmailConfig,
  emails: SendEmailInput[],
  delayMs = 200,
): Promise<EmailResult[]> {
  const results: EmailResult[] = [];
  for (const email of emails) {
    const result = await sendEmail(config, email);
    results.push(result);
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  }
  return results;
}
