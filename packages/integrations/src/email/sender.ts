/**
 * Email Sender — Faz 3
 *
 * SendGrid / Amazon SES adapter for outreach emails.
 */

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

export async function sendEmail(
  _config: EmailConfig,
  _input: SendEmailInput,
): Promise<{ messageId: string }> {
  // TODO: Faz 3
  throw new Error("Not implemented — Faz 3");
}
