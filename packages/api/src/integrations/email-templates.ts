/**
 * Inline HTML email templates.
 *
 * Why inline strings instead of SendGrid Dynamic Templates? Two reasons:
 *   1. Source of truth lives in the repo — diff'able in code review,
 *      template changes don't drift in a separate UI.
 *   2. The send path doesn't depend on a template ID lookup, so a
 *      missing/deleted SendGrid template can't silently break welcome
 *      mails.
 *
 * All styles are inline (no <style> tag) — Gmail/Outlook strip <style>
 * blocks; inline survives. Keep widths under 600px for mobile clients.
 *
 * Switch to Dynamic Templates later if marketing wants to A/B test copy
 * without a deploy — until then, in-code is simpler.
 */

import { sendEmail } from "./email";

const APP_URL = process.env.APP_URL ?? "https://braavolabs.com";

const BASE_STYLE = `
  font-family: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', Roboto, sans-serif;
  line-height: 1.6;
  color: #2c3338;
`;

function shell(content: string, preheader: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Braavolabs</title>
</head>
<body style="margin:0;padding:0;background:#f6f8fa;${BASE_STYLE}">
  <!-- Hidden preheader (preview text) -->
  <div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:#f6f8fa;opacity:0;">
    ${escapeHtml(preheader)}
  </div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f8fa;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
          <tr>
            <td style="padding:32px 32px 24px 32px;background:linear-gradient(135deg,#00d1ff,#6d11ad);">
              <span style="font-family:-apple-system,'Inter',sans-serif;font-size:22px;font-weight:700;color:#ffffff;letter-spacing:-0.5px;">
                Braavolabs
              </span>
            </td>
          </tr>
          <tr>
            <td style="padding:32px;">
              ${content}
            </td>
          </tr>
          <tr>
            <td style="padding:24px 32px;background:#f6f8fa;border-top:1px solid #e5e8ec;font-size:12px;color:#6b7785;">
              <p style="margin:0 0 8px 0;">
                Braavolabs — your autonomous AI company, built in 10 minutes.
              </p>
              <p style="margin:0;">
                <a href="${APP_URL}" style="color:#6b7785;text-decoration:underline;">braavolabs.com</a>
                ·
                <a href="${APP_URL}/privacy" style="color:#6b7785;text-decoration:underline;">Privacy</a>
                ·
                <a href="${APP_URL}/terms" style="color:#6b7785;text-decoration:underline;">Terms</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function button(href: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0;">
    <tr>
      <td style="border-radius:10px;background:linear-gradient(135deg,#00d1ff,#6d11ad);">
        <a href="${href}" style="display:inline-block;padding:12px 28px;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;">${label}</a>
      </td>
    </tr>
  </table>`;
}

/**
 * Welcome email — sent immediately after register.
 *
 * Best-effort: if SendGrid throws (rate limit, invalid email, transient
 * failure), we log and swallow. A failed welcome email shouldn't block
 * the signup flow — the user is already in the DB and can log in.
 */
export async function sendWelcomeEmail(params: {
  to: string;
  name: string;
  tenantName: string;
}): Promise<void> {
  const { to, name, tenantName } = params;
  const firstName = name.split(/\s+/)[0] ?? name;

  const content = `
    <h1 style="margin:0 0 16px 0;font-size:24px;font-weight:700;color:#1a1f26;">
      Welcome, ${escapeHtml(firstName)} 👋
    </h1>
    <p style="margin:0 0 16px 0;font-size:15px;">
      <strong>${escapeHtml(tenantName)}</strong> is ready in your Braavolabs workspace.
      Your first AI company is just three steps away.
    </p>

    <ol style="margin:24px 0;padding-left:20px;font-size:14px;color:#4a5560;">
      <li style="margin-bottom:10px;">
        <strong style="color:#1a1f26;">Connect Claude</strong> — Settings → AI Provider.
        Bring your own Anthropic key (BYOK), pay only what you use.
      </li>
      <li style="margin-bottom:10px;">
        <strong style="color:#1a1f26;">Describe your business</strong> in plain English —
        Braavolabs auto-staffs the agents and pipelines.
      </li>
      <li style="margin-bottom:10px;">
        <strong style="color:#1a1f26;">Watch it run</strong> — every decision logged,
        every spend approval-gated, full audit trail.
      </li>
    </ol>

    ${button(`${APP_URL}/dashboard`, "Open dashboard →")}

    <p style="margin:24px 0 0 0;font-size:13px;color:#6b7785;">
      Questions? Just reply to this email — we read every one.
    </p>
  `;

  try {
    await sendEmail({
      to,
      subject: `Welcome to Braavolabs, ${firstName}`,
      body: shell(content, `Your AI workspace ${tenantName} is ready — three steps to your first run.`),
      tracking: false,
    });
  } catch (err) {
    // Swallow — welcome email is nice-to-have, not critical to signup.
    // The error is already logged in sendEmail's catch path.
    void err;
  }
}

/**
 * Password reset email — sent from forgot-password flow.
 * Token is single-use; its hash and one-hour expiry are checked server-side.
 */
export async function sendPasswordResetEmail(params: {
  to: string;
  resetUrl: string;
}): Promise<void> {
  const content = `
    <h1 style="margin:0 0 16px 0;font-size:24px;font-weight:700;color:#1a1f26;">
      Reset your password
    </h1>
    <p style="margin:0 0 16px 0;font-size:15px;color:#4a5560;">
      Someone (hopefully you) asked to reset your Braavolabs password.
      Click the button below to choose a new one.
    </p>

    ${button(params.resetUrl, "Reset password →")}

    <p style="margin:16px 0 0 0;font-size:13px;color:#6b7785;">
      This link is valid for 1 hour and can be used once.
      If you didn't request this, you can safely ignore the email — your
      password stays the same.
    </p>
    <p style="margin:16px 0 0 0;font-size:12px;color:#8a939c;word-break:break-all;">
      Or copy and paste this URL: <br>
      <code style="font-family:monospace;color:#6b7785;">${params.resetUrl}</code>
    </p>
  `;

  await sendEmail({
    to: params.to,
    subject: "Reset your Braavolabs password",
    body: shell(content, "Click the button to choose a new password — link expires in 1 hour."),
    tracking: false,
  });
}

/**
 * Email verification — sent after register. Soft gate: the user can
 * use the app immediately, but a banner nags until they verify.
 * Link is GET (single click) so it works from any mail client without
 * JS, and the API endpoint redirects to a confirmation page.
 */
export async function sendVerifyEmail(params: {
  to: string;
  verifyUrl: string;
}): Promise<void> {
  const content = `
    <h1 style="margin:0 0 16px 0;font-size:24px;font-weight:700;color:#1a1f26;">
      Verify your email
    </h1>
    <p style="margin:0 0 16px 0;font-size:15px;color:#4a5560;">
      Welcome to Braavolabs! Please confirm this is really your email
      address — it's how we'll reach you for approvals, risk alerts
      and account recovery.
    </p>

    ${button(params.verifyUrl, "Verify email →")}

    <p style="margin:16px 0 0 0;font-size:13px;color:#6b7785;">
      This link is valid for 7 days. If you didn't sign up, you can
      safely ignore this email.
    </p>
    <p style="margin:16px 0 0 0;font-size:12px;color:#8a939c;word-break:break-all;">
      Or copy and paste this URL: <br>
      <code style="font-family:monospace;color:#6b7785;">${params.verifyUrl}</code>
    </p>
  `;

  await sendEmail({
    to: params.to,
    subject: "Verify your Braavolabs email",
    body: shell(content, "Click the button to verify — link expires in 7 days."),
    tracking: false,
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
