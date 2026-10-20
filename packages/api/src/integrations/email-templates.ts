/** Transactional copy is local, escaped and selected per triggering request. */
import { sendEmail } from "./email";
import { notificationText, type NotificationCopyKey, type NotificationParameters } from "../lib/notificationCopy";
import { resolveNotificationLocale, type NotificationLocale } from "../lib/notificationLocale";

const APP_URL = process.env.APP_URL ?? "https://braavolabs.com";
const BASE_STYLE = "font-family:-apple-system,BlinkMacSystemFont,'Inter','Segoe UI',Roboto,sans-serif;line-height:1.6;color:#2c3338;";

function shell(content: string, preheader: string, locale: NotificationLocale): string {
  return `<!DOCTYPE html>
<html lang="${locale}" dir="${locale === "ar" ? "rtl" : "ltr"}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Braavolabs</title></head>
<body style="margin:0;padding:0;background:#f6f8fa;${BASE_STYLE}">
<div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:#f6f8fa;opacity:0;">${escapeHtml(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f8fa;padding:32px 16px;">
<tr><td align="center"><table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;">
<tr><td style="padding:32px;background:#312e81;"><span style="font-size:22px;font-weight:700;color:#ffffff;">Braavolabs</span></td></tr>
<tr><td style="padding:32px;">${content}</td></tr>
<tr><td style="padding:24px 32px;background:#f6f8fa;border-top:1px solid #e5e8ec;font-size:12px;color:#586575;">
<p>${escapeHtml(notificationText(locale, "common.tagline"))}</p>
<p><a href="${escapeHtml(APP_URL)}" style="color:#586575;">braavolabs.com</a> · <a href="${escapeHtml(APP_URL + "/privacy")}" style="color:#586575;">${escapeHtml(notificationText(locale, "common.privacy"))}</a> · <a href="${escapeHtml(APP_URL + "/terms")}" style="color:#586575;">${escapeHtml(notificationText(locale, "common.terms"))}</a></p>
</td></tr></table></td></tr></table></body></html>`;
}

function button(href: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0;"><tr><td style="border-radius:10px;background:#1d4ed8;"><a href="${escapeHtml(href)}" style="display:inline-block;padding:12px 28px;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;">${escapeHtml(label)}</a></td></tr></table>`;
}
function escapedCopy(locale: NotificationLocale) {
  return (key: NotificationCopyKey, parameters?: NotificationParameters) => escapeHtml(notificationText(locale, key, parameters));
}
function paragraph(text: string): string { return `<p style="margin:0 0 16px;font-size:15px;">${text}</p>`; }
function heading(text: string): string { return `<h1 style="margin:0 0 16px;font-size:24px;color:#1a1f26;">${text}</h1>`; }
function fallbackUrl(url: string, locale: NotificationLocale): string {
  return paragraph(`${escapeHtml(notificationText(locale, "common.copyUrl"))}<br><code dir="ltr" style="font-family:monospace;word-break:break-all;">${escapeHtml(url)}</code>`);
}

/** Best effort; delivery failure must not change completed registration. */
export async function sendWelcomeEmail(params: {
  to: string; name: string; tenantName: string; locale?: string;
}): Promise<void> {
  const { to, name, tenantName } = params;
  const locale = resolveNotificationLocale(params.locale);
  const text = escapedCopy(locale);
  const firstName = name.split(/\s+/)[0] ?? name;
  const values = { firstName, tenantName };
  const items = [
    ["welcome.providerTitle", "welcome.providerBody"],
    ["welcome.reviewTitle", "welcome.reviewBody"],
    ["welcome.monitorTitle", "welcome.monitorBody"],
  ] as const;
  const content = heading(text("welcome.heading", values)) + paragraph(text("welcome.intro", values))
    + `<ol style="margin:24px 0;padding-inline-start:20px;font-size:14px;">${items.map(([title, body]) => `<li style="margin-bottom:10px;"><strong>${text(title)}</strong> — ${text(body)}</li>`).join("")}</ol>`
    + button(`${APP_URL}/dashboard`, notificationText(locale, "welcome.cta")) + paragraph(text("welcome.help"));
  try {
    await sendEmail({ to, subject: notificationText(locale, "welcome.subject", values), body: shell(content, notificationText(locale, "welcome.preheader", values), locale), tracking: false });
  } catch { /* Existing best-effort welcome behavior. */ }
}

/** Existing token remains single-use with a one-hour server-side expiry. */
export async function sendPasswordResetEmail(params: { to: string; resetUrl: string; locale?: string }): Promise<void> {
  const locale = resolveNotificationLocale(params.locale);
  const text = escapedCopy(locale);
  const content = heading(text("reset.heading")) + paragraph(text("reset.body"))
    + button(params.resetUrl, notificationText(locale, "reset.cta")) + paragraph(text("reset.expiry")) + fallbackUrl(params.resetUrl, locale);
  await sendEmail({ to: params.to, subject: notificationText(locale, "reset.subject"), body: shell(content, notificationText(locale, "reset.preheader"), locale), tracking: false });
}

/** Existing verification callback and seven-day server-side expiry are preserved. */
export async function sendVerifyEmail(params: { to: string; verifyUrl: string; locale?: string }): Promise<void> {
  const locale = resolveNotificationLocale(params.locale);
  const text = escapedCopy(locale);
  const content = heading(text("verify.heading")) + paragraph(text("verify.body"))
    + button(params.verifyUrl, notificationText(locale, "verify.cta")) + paragraph(text("verify.expiry")) + fallbackUrl(params.verifyUrl, locale);
  await sendEmail({ to: params.to, subject: notificationText(locale, "verify.subject"), body: shell(content, notificationText(locale, "verify.preheader"), locale), tracking: false });
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}
