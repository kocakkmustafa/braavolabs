import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendEmail } = vi.hoisted(() => ({ sendEmail: vi.fn() }));
vi.mock("../email", () => ({ sendEmail }));

import { sendPasswordResetEmail, sendVerifyEmail, sendWelcomeEmail } from "../email-templates";
import { NOTIFICATION_LOCALES } from "../../lib/notificationLocale";
import { notificationText } from "../../lib/notificationCopy";

beforeEach(() => {
  sendEmail.mockReset().mockResolvedValue({ messageId: "local-template-test" });
});

describe("transactional email HTML boundaries", () => {
  it.each([
    '</div><a href="https://example.invalid">UNTRUSTED</a>',
    '<img src="https://example.invalid/pixel">',
  ])("keeps the registration tenant name as text throughout the welcome email: %s", async (tenantName) => {
    await sendWelcomeEmail({ to: "recipient@example.invalid", name: "Alex", tenantName });

    const { body } = sendEmail.mock.calls[0][0];
    expect(body).not.toContain(tenantName);
    expect(body).not.toContain('<a href="https://example.invalid">');
    expect(body).not.toContain('<img src="https://example.invalid/pixel">');
    expect(body).toContain("Your workspace &lt;");
    expect(body).toContain("Open dashboard →");
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0].tracking).toBe(false);
  });

  it("preserves ordinary welcome copy and encodes a tenant ampersand in the preview", async () => {
    await sendWelcomeEmail({ to: "recipient@example.invalid", name: "Alex Example", tenantName: "Research & Design" });

    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: "recipient@example.invalid",
      subject: "Welcome to Braavolabs, Alex",
    }));
    const { body } = sendEmail.mock.calls[0][0];
    expect(body).toContain("Welcome, Alex");
    expect(body).toContain("Your workspace Research &amp; Design has been created");
  });

  it("keeps the verification callback and seven-day expiry copy", async () => {
    const verifyUrl = "https://api.braavolabs.com/api/v1/auth/verify-email?token=local-fixture";
    await sendVerifyEmail({ to: "recipient@example.invalid", verifyUrl });
    expect(sendEmail.mock.calls[0][0].body).toContain(`href="${verifyUrl}"`);
    expect(sendEmail.mock.calls[0][0].body).toContain("valid for 7 days");
    expect(sendEmail.mock.calls[0][0].tracking).toBe(false);
  });

  it("keeps the password reset callback and one-hour expiry copy", async () => {
    const resetUrl = "https://app.braavolabs.com/reset-password?token=local-fixture";
    await sendPasswordResetEmail({ to: "recipient@example.invalid", resetUrl });
    expect(sendEmail.mock.calls[0][0].body).toContain(`href="${resetUrl}"`);
    expect(sendEmail.mock.calls[0][0].body).toContain("valid for 1 hour and can be used once");
    expect(sendEmail.mock.calls[0][0].tracking).toBe(false);
  });
});

describe("transactional email language and token-link boundaries", () => {
  it.each(NOTIFICATION_LOCALES)("renders all three templates in %s without interpreting caller HTML", async (locale) => {
    const tenantName = '<img src="https://example.invalid/pixel"> & {firstName}';
    const name = '<svg/onload=alert(1)>';
    const callback = 'https://example.invalid/callback?token=fixture&next="onmouseover="x';
    await sendWelcomeEmail({ to: "recipient@example.invalid", name, tenantName, locale });
    await sendPasswordResetEmail({ to: "recipient@example.invalid", resetUrl: callback, locale });
    await sendVerifyEmail({ to: "recipient@example.invalid", verifyUrl: callback, locale });
    const messages = sendEmail.mock.calls.map(([message]) => message);
    expect(messages).toHaveLength(3);
    expect(messages.map(message => message.subject)).toEqual([
      notificationText(locale, "welcome.subject", { firstName: name, tenantName }),
      notificationText(locale, "reset.subject"), notificationText(locale, "verify.subject"),
    ]);
    for (const message of messages) {
      expect(message.tracking).toBe(false);
      expect(message.body).toContain(`<html lang="${locale}" dir="${locale === "ar" ? "rtl" : "ltr"}">`);
      expect(message.body).not.toContain('<svg/onload=alert(1)>');
      expect(message.body).not.toContain('<img src="https://example.invalid/pixel">');
      expect(message.body).toContain(notificationText(locale, "common.privacy"));
    }
    expect(messages[0].body).toContain('&lt;svg/onload=alert(1)&gt;');
    expect(messages[0].body).toContain('&amp; {firstName}'); // parameters never expand recursively
    for (const message of messages.slice(1)) {
      expect(message.body).toContain('href="https://example.invalid/callback?token=fixture&amp;next=&quot;onmouseover=&quot;x"');
      expect(message.body).toContain('<code dir="ltr"');
      expect(message.body).not.toContain(callback);
    }
  });

  it("uses English for an unsupported script and preserves existing delivery failure behavior", async () => {
    sendEmail.mockRejectedValue(new Error("synthetic mail failure"));
    await expect(sendWelcomeEmail({ to: "a@example.invalid", name: "A", tenantName: "T", locale: "zh-Hant" })).resolves.toBeUndefined();
    expect(sendEmail.mock.calls[0][0].body).toContain('<html lang="en"');
    await expect(sendPasswordResetEmail({ to: "a@example.invalid", resetUrl: "https://example.invalid/reset", locale: "ar" })).rejects.toThrow("synthetic mail failure");
    await expect(sendVerifyEmail({ to: "a@example.invalid", verifyUrl: "https://example.invalid/verify", locale: "tr" })).rejects.toThrow("synthetic mail failure");
  });
});
