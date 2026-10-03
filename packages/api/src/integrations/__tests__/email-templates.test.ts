import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendEmail } = vi.hoisted(() => ({ sendEmail: vi.fn() }));
vi.mock("../email", () => ({ sendEmail }));

import { sendPasswordResetEmail, sendVerifyEmail, sendWelcomeEmail } from "../email-templates";

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
    expect(body).toContain("Your AI workspace &lt;");
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
    expect(body).toContain("Your AI workspace Research &amp; Design is ready");
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
